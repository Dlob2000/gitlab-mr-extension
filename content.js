// Content script: MR checkboxes, approval counts, floating panel, templates, clipboard, Slack.
(() => {
  "use strict";

  // Guard against double injection (e.g. re-registration
  // via chrome.scripting when settings change).
  if (window.__glmrLoaded) return;
  window.__glmrLoaded = true;

  const log = (...args) => console.log("[GLMR]", ...args);
  const warn = (...args) => console.warn("[GLMR]", ...args);

  const LIST_SELECTOR = "#content-body div.merge-requests-holder ul";
  const MR_LINK_SELECTOR = "div.issuable-main-info .merge-request-title a, .merge-request-title.title a";
  const CHECK_CLASS = "glmr-check";
  const WRAP_CLASS = "glmr-check-wrap";
  const APPROVAL_CLASS = "glmr-approvals";
  const APPROVAL_WRAP_CLASS = "glmr-approvals-wrap";
  const APPROVAL_CACHE_MS = 60_000;
  const APPROVAL_REQUEST_LIMIT = 4;
  const APPROVAL_TIMEOUT_MS = 15_000;
  const SELECT_ALL_ID = "glmr-select-all";
  const SELECT_ALL_WRAP_ID = "glmr-select-all-wrap";
  // DOM event used to hand the page over from an orphaned copy of this script
  // (left behind after an extension reload) to a freshly injected one.
  const TAKEOVER_EVENT = "glmr:takeover";
  let disposed = false;

  // ---------- Checkbox styles (outside Shadow DOM, but prefixed with glmr-) ----------

  function injectCheckboxStyles() {
    if (document.getElementById("glmr-styles")) return;
    const style = document.createElement("style");
    style.id = "glmr-styles";
    style.textContent = `
      .${WRAP_CLASS} {
        display: inline-flex;
        align-items: center;
        align-self: center;
        margin-right: 8px;
        flex-shrink: 0;
      }
      .${WRAP_CLASS} input.${CHECK_CLASS} {
        width: 16px;
        height: 16px;
        margin: 0;
        cursor: pointer;
      }
      #${SELECT_ALL_WRAP_ID} {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        font-size: 13px;
        cursor: pointer;
        user-select: none;
      }
      #${SELECT_ALL_WRAP_ID} input {
        width: 16px;
        height: 16px;
        margin: 0;
        cursor: pointer;
      }
      .${APPROVAL_CLASS} {
        white-space: nowrap;
      }
      .${APPROVAL_CLASS}[data-state="loading"],
      .${APPROVAL_CLASS}[data-state="error"] {
        opacity: 0.7;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------- Checkboxes ----------

  let listWasMissing = true;

  // Checkboxes make sense only on the "Open" tab: GitLab puts the tab state
  // into the URL as ?state=opened (no param means the default Open tab).
  function isOpenState() {
    const state = new URLSearchParams(location.search).get("state");
    return state === null || state === "opened" || state === "open";
  }

  function removeCheckboxes() {
    const selectAllWrap = document.getElementById(SELECT_ALL_WRAP_ID);
    if (selectAllWrap) selectAllWrap.remove();
    const wraps = document.querySelectorAll(`.${WRAP_CLASS}`);
    if (!wraps.length) return;
    for (const wrap of wraps) wrap.remove();
    log(`checkboxes removed: ${wraps.length} (state is not "open")`);
    updatePanel();
  }

  function ensureSelectAll(list) {
    if (document.getElementById(SELECT_ALL_WRAP_ID)) return;
    const wrap = document.createElement("label");
    wrap.id = SELECT_ALL_WRAP_ID;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = SELECT_ALL_ID;
    cb.title = "Select all MRs";
    cb.addEventListener("change", () => {
      const on = cb.checked;
      for (const box of getAllBoxes()) box.checked = on;
      updatePanel();
    });
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode("Select all"));
    list.parentElement.insertBefore(wrap, list);
    log("select-all checkbox added");
  }

  function syncSelectAll() {
    const master = document.getElementById(SELECT_ALL_ID);
    if (!master) return;
    const total = getAllBoxes().length;
    const checked = getCheckedBoxes().length;
    master.checked = total > 0 && checked === total;
    master.indeterminate = checked > 0 && checked < total;
  }

  function addCheckboxes() {
    if (!isOpenState()) {
      removeCheckboxes();
      return;
    }
    const list = document.querySelector(LIST_SELECTOR);
    if (!list) {
      if (!listWasMissing) {
        log("MR list disappeared from the DOM (selector:", LIST_SELECTOR + ")");
        listWasMissing = true;
      }
      return;
    }
    if (listWasMissing) {
      log("MR list found:", LIST_SELECTOR);
      listWasMissing = false;
    }
    const items = list.querySelectorAll('li[id^="merge_request_"]');
    let added = 0;
    for (const li of items) {
      if (li.querySelector(`.${CHECK_CLASS}`)) continue;
      added++;
      const wrap = document.createElement("span");
      wrap.className = WRAP_CLASS;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = CHECK_CLASS;
      cb.title = "Select MR";
      // Keep the checkbox click from bubbling up to the MR row handlers.
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", updatePanel);
      wrap.appendChild(cb);
      li.prepend(wrap);
      if (getComputedStyle(li).display !== "flex") {
        li.style.display = "flex";
      }
    }
    if (added > 0) {
      log(`checkboxes added: +${added} (total MR items: ${items.length})`);
    }
    if (items.length > 0) {
      ensureSelectAll(list);
      syncSelectAll();
    }
  }

  function getAllBoxes() {
    return Array.from(document.querySelectorAll(`input.${CHECK_CLASS}`));
  }

  function getCheckedBoxes() {
    return Array.from(document.querySelectorAll(`input.${CHECK_CLASS}:checked`));
  }

  function clearSelection() {
    for (const cb of getCheckedBoxes()) cb.checked = false;
    updatePanel();
  }

  // ---------- Approval counts ----------

  const approvalCache = new Map();
  const approvalQueue = [];
  const approvalControllers = new Set();

  function getApprovalApiUrl(link) {
    try {
      const url = new URL(link.getAttribute("href"), location.href);
      if (url.origin !== location.origin) return null;
      const match = /^\/(.+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/.exec(url.pathname);
      if (!match) return null;
      const project = encodeURIComponent(decodeURIComponent(match[1]));
      return `${url.origin}/api/v4/projects/${project}/merge_requests/${match[2]}/approvals`;
    } catch (_) {
      return null;
    }
  }

  async function fetchApprovals(apiUrl, entry, controller) {
    const timeout = setTimeout(() => controller.abort(), APPROVAL_TIMEOUT_MS);
    try {
      // GitLab's REST API accepts the existing browser session cookie.
      const response = await fetch(apiUrl, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.approved_by)) {
        throw new Error("Invalid approval response");
      }
      // Count actual approvers, not approvals_required - approvals_left:
      // a user can satisfy multiple rules, or approve outside the rules.
      entry.approvalsGiven = data.approved_by.length;
      entry.approvalsRequired = Number.isInteger(data.approvals_required)
        ? data.approvals_required : null;
      entry.status = "ready";
    } catch (e) {
      entry.status = "error";
      entry.error = e.name === "AbortError" ? "Request timed out" : e.message;
      if (!disposed) warn("approval count unavailable:", apiUrl, entry.error);
    } finally {
      clearTimeout(timeout);
      entry.expiresAt = Date.now() + APPROVAL_CACHE_MS;
      approvalControllers.delete(controller);
      if (!disposed) {
        scheduleScan();
        runApprovalQueue();
      }
    }
  }

  function runApprovalQueue() {
    while (!disposed && approvalQueue.length && approvalControllers.size < APPROVAL_REQUEST_LIMIT) {
      const { apiUrl, entry } = approvalQueue.shift();
      const controller = new AbortController();
      approvalControllers.add(controller);
      void fetchApprovals(apiUrl, entry, controller);
    }
  }

  function updateApprovalCounts() {
    const list = document.querySelector(LIST_SELECTOR);
    if (!list || disposed) return;
    for (const li of list.querySelectorAll('li[id^="merge_request_"]')) {
      const link = li.querySelector(MR_LINK_SELECTOR);
      const apiUrl = link && getApprovalApiUrl(link);
      const controls = li.querySelector("ul.controls");
      if (!apiUrl || !controls) continue;

      let badge = li.querySelector(`.${APPROVAL_CLASS}`);
      if (!badge) {
        badge = document.createElement("span");
        badge.className = APPROVAL_CLASS;
      }
      let badgeItem = controls.querySelector(`.${APPROVAL_WRAP_CLASS}`);
      if (!badgeItem) {
        badgeItem = document.createElement("li");
        badgeItem.className = `${APPROVAL_WRAP_CLASS} gl-display-flex gl-mr-0!`;
      }
      if (badge.parentElement !== badgeItem) badgeItem.appendChild(badge);

      // Keep the count beside GitLab's approval status, using its native badge
      // styles so size, colors, and dark mode stay consistent with the page.
      const nativeBadge = controls.querySelector('[data-testid="mr-appovals"], [data-testid="mr-approvals"]');
      const nativeItem = nativeBadge?.closest("li");
      if (nativeItem?.parentElement === controls) {
        if (nativeItem.nextElementSibling !== badgeItem) nativeItem.after(badgeItem);
      } else if (badgeItem.parentElement !== controls) {
        controls.appendChild(badgeItem);
      }

      let entry = approvalCache.get(apiUrl);
      if (!entry || (entry.status !== "loading" && entry.expiresAt <= Date.now())) {
        entry = { status: "loading" };
        approvalCache.set(apiUrl, entry);
        approvalQueue.push({ apiUrl, entry });
      }

      let text = "Approvals: …";
      let title = "Loading approvals…";
      if (entry.status === "ready") {
        text = `Approvals: ${entry.approvalsGiven}`;
        title = `${entry.approvalsGiven} approval${entry.approvalsGiven === 1 ? "" : "s"} received`;
      } else if (entry.status === "error") {
        text = "Approvals: —";
        title = `Approval count unavailable (${entry.error}). Reload the page to retry.`;
      }
      const variant = entry.status === "ready" && nativeBadge?.classList.contains("badge-success")
        ? "badge-success" : "badge-muted";
      const badgeClasses = `${APPROVAL_CLASS} gl-badge badge badge-pill ${variant} sm`;
      // Idempotent writes keep our own MutationObserver from triggering a loop.
      if (badge.className !== badgeClasses) badge.className = badgeClasses;
      if (badge.textContent !== text) badge.textContent = text;
      if (badge.title !== title) badge.title = title;
      if (badge.dataset.state !== entry.status) badge.dataset.state = entry.status;
    }
    runApprovalQueue();
  }

  function refreshApprovalsOnReturn() {
    if (!document.hidden) scheduleScan();
  }

  // ---------- Parsing MR data from the DOM ----------

  function parseMr(li) {
    const link = li.querySelector(MR_LINK_SELECTOR);
    if (!link) {
      warn("MR link/title not found in item:", li.id || li);
      return null;
    }

    const title = link.textContent.trim();
    let url = link.getAttribute("href") || "";
    try {
      url = new URL(url, location.origin).href; // make absolute
    } catch (_) {
      /* keep as is */
    }

    const refLink = li.querySelector("span.project-ref-path a");
    const version = refLink ? refLink.textContent.trim() : "";
    if (!refLink) {
      warn("target version not found (span.project-ref-path a) in:", li.id || li);
    }

    const approval = approvalCache.get(getApprovalApiUrl(link));
    const approvalsGiven = approval?.status === "ready" ? approval.approvalsGiven : null;
    const approvalsRequired = approval?.status === "ready" ? approval.approvalsRequired : null;

    return { title, url, version, approvalsGiven, approvalsRequired };
  }

  function collectSelectedMrs() {
    const mrs = [];
    for (const cb of getCheckedBoxes()) {
      const li = cb.closest("li");
      if (!li) continue;
      const mr = parseMr(li);
      if (mr) mrs.push(mr);
    }
    log("collected data of selected MRs:", mrs);
    return mrs;
  }

  // ---------- Floating panel (Shadow DOM) ----------

  let panelHost = null;
  let panelRefs = null;
  let noticeTimer = null;

  function buildPanel() {
    if (panelHost) return;
    panelHost = document.createElement("div");
    panelHost.id = "glmr-panel-host";
    Object.assign(panelHost.style, {
      position: "fixed",
      top: "64px",
      right: "16px",
      zIndex: "2147483000",
      display: "none"
    });

    const shadow = panelHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { color-scheme: light; }
        .panel {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          background: #fff;
          color: #303030;
          border: 1px solid #dcdcde;
          border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
          padding: 12px;
          min-width: 240px;
        }
        .head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
          font-weight: 600;
        }
        .clear {
          background: none;
          border: none;
          color: #737278;
          cursor: pointer;
          font-size: 12px;
          padding: 2px 4px;
        }
        .clear:hover { color: #303030; text-decoration: underline; }
        .btns { display: flex; flex-direction: column; gap: 6px; }
        button.action {
          border: 1px solid #dcdcde;
          border-radius: 4px;
          background: #fff;
          color: #303030;
          padding: 6px 10px;
          cursor: pointer;
          font-size: 13px;
          text-align: center;
          font-family: inherit;
        }
        button.action:hover { background: #f0f0f0; }
        button.action.primary {
          background: #1f75cb;
          border-color: #1f75cb;
          color: #fff;
        }
        button.action.primary:hover { background: #1a63ac; }
        button.action:disabled { opacity: 0.6; cursor: default; }
        .notice {
          margin-top: 8px;
          font-size: 12px;
          display: none;
          border-radius: 4px;
          padding: 5px 8px;
        }
        .notice.ok { display: block; background: #ecf4ee; color: #24663b; }
        .notice.err { display: block; background: #fdd4cd; color: #ae1800; }
      </style>
      <div class="panel">
        <div class="head">
          <span>Selected MRs: <span id="count">0</span></span>
          <button class="clear" id="clear" title="Uncheck all checkboxes">Reset</button>
        </div>
        <div class="btns">
          <button class="action primary" id="send">Send to Slack</button>
          <button class="action" id="copy">Copy</button>
          <button class="action" id="copyAlt">Copy (alt. template)</button>
        </div>
        <div class="notice" id="notice"></div>
      </div>
    `;

    panelRefs = {
      count: shadow.getElementById("count"),
      notice: shadow.getElementById("notice"),
      send: shadow.getElementById("send")
    };
    shadow.getElementById("clear").addEventListener("click", clearSelection);
    shadow.getElementById("send").addEventListener("click", onSendToSlack);
    shadow.getElementById("copy").addEventListener("click", () => onCopy("templateMain"));
    shadow.getElementById("copyAlt").addEventListener("click", () => onCopy("templateAlt"));

    document.documentElement.appendChild(panelHost);
  }

  function updatePanel() {
    buildPanel();
    const count = getCheckedBoxes().length;
    if (panelRefs.count.textContent !== String(count)) panelRefs.count.textContent = String(count);
    panelHost.style.display = count > 0 ? "block" : "none";
    syncSelectAll();
  }

  function showNotice(text, ok) {
    if (!panelRefs) return;
    panelRefs.notice.textContent = text;
    panelRefs.notice.className = "notice " + (ok ? "ok" : "err");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      panelRefs.notice.className = "notice";
    }, 3000);
  }

  // ---------- Actions ----------

  // After the extension is reloaded/updated, the old content script loses
  // access to chrome.* ("extension context invalidated") — the page needs an F5.
  function contextAlive() {
    return Boolean(chrome.runtime && chrome.runtime.id && chrome.storage);
  }

  async function renderMessage(templateKey, style) {
    if (!contextAlive()) {
      warn("extension context invalidated (extension was reloaded)");
      showNotice("Extension was updated — reload the page (F5)", false);
      return null;
    }
    const settings = await glmrGetSettings();
    const mrs = collectSelectedMrs();
    if (!mrs.length) {
      showNotice("Failed to extract data of the selected MRs", false);
      return null;
    }
    const oneApprover = new Set(glmrParseList(settings.oneApproverList));
    const text = glmrRenderTemplate(settings[templateKey], mrs, oneApprover, style);
    if (!text || !text.trim()) {
      warn(`rendered message is empty (${templateKey}, ${style}) — nothing to send/copy`);
      showNotice("Message is empty — check the template in settings", false);
      return null;
    }
    log(`message (${templateKey}, ${style}), 1-approver:`, [...oneApprover], "\n" + text);
    return { settings, text, mrs };
  }

  async function onCopy(templateKey) {
    const res = await renderMessage(templateKey, "plain");
    if (!res) return;
    try {
      await navigator.clipboard.writeText(res.text);
      log("copied to clipboard,", res.text.length, "characters");
      showNotice("Copied", true);
    } catch (e) {
      warn("copy error:", e);
      showNotice("Copy error: " + e.message, false);
    }
  }

  async function onSendToSlack() {
    const res = await renderMessage("templateMain", "slack");
    if (!res) return;
    if (!res.settings.webhookUrl) {
      warn("Webhook URL is not set — cannot send");
      showNotice("Webhook URL is not set — open the extension settings", false);
      chrome.runtime.sendMessage({ type: "glmr:openOptions" });
      return;
    }
    panelRefs.send.disabled = true;
    log("sending to Slack via background…");
    try {
      const reply = await chrome.runtime.sendMessage({
        type: "glmr:sendToSlack",
        text: res.text,
        urls: res.mrs.map((mr) => mr.url)
      });
      log("background reply:", reply);
      if (reply && reply.ok) {
        showNotice("Sent to Slack", true);
      } else {
        showNotice("Send error: " + (reply && reply.error ? reply.error : "no response"), false);
      }
    } catch (e) {
      warn("send error:", e);
      showNotice("Send error: " + e.message, false);
    } finally {
      panelRefs.send.disabled = false;
    }
  }

  // ---------- DOM observation (SPA navigation, filters) ----------

  let scanFrame = null;

  function scheduleScan() {
    if (disposed || scanFrame !== null) return;
    scanFrame = requestAnimationFrame(() => {
      scanFrame = null;
      if (disposed) return;
      addCheckboxes();
      updateApprovalCounts();
      // The list may have been re-rendered — refresh the counter/panel visibility.
      if (panelHost) updatePanel();
    });
  }

  log("content script loaded on", location.href);

  // If an orphaned copy from a previous extension load is still running in
  // this tab, make it remove its UI and observers before we add ours
  // (dispatch is synchronous, so the DOM is clean by the next line).
  document.dispatchEvent(new Event(TAKEOVER_EVENT));

  injectCheckboxStyles();
  addCheckboxes();
  updateApprovalCounts();

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("focus", refreshApprovalsOnReturn);
  document.addEventListener("visibilitychange", refreshApprovalsOnReturn);

  document.addEventListener(
    TAKEOVER_EVENT,
    () => {
      log("newer content script took over — cleaning up this copy");
      disposed = true;
      observer.disconnect();
      if (scanFrame !== null) cancelAnimationFrame(scanFrame);
      clearTimeout(noticeTimer);
      window.removeEventListener("focus", refreshApprovalsOnReturn);
      document.removeEventListener("visibilitychange", refreshApprovalsOnReturn);
      approvalQueue.length = 0;
      for (const controller of approvalControllers) controller.abort();
      approvalCache.clear();
      const styles = document.getElementById("glmr-styles");
      if (styles) styles.remove();
      const selectAllWrap = document.getElementById(SELECT_ALL_WRAP_ID);
      if (selectAllWrap) selectAllWrap.remove();
      for (const wrap of document.querySelectorAll(`.${WRAP_CLASS}`)) wrap.remove();
      for (const item of document.querySelectorAll(`.${APPROVAL_WRAP_CLASS}`)) item.remove();
      for (const badge of document.querySelectorAll(`.${APPROVAL_CLASS}`)) badge.remove();
      if (panelHost) panelHost.remove();
    },
    { once: true }
  );
})();

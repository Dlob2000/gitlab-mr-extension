// Content script: MR checkboxes, floating panel, DOM parsing, templates, clipboard, Slack.
(() => {
  "use strict";

  // Guard against double injection (e.g. re-registration
  // via chrome.scripting when settings change).
  if (window.__glmrLoaded) return;
  window.__glmrLoaded = true;

  const log = (...args) => console.log("[GLMR]", ...args);
  const warn = (...args) => console.warn("[GLMR]", ...args);

  const LIST_SELECTOR = "#content-body div.merge-requests-holder ul";
  const CHECK_CLASS = "glmr-check";
  const WRAP_CLASS = "glmr-check-wrap";

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
    const wraps = document.querySelectorAll(`.${WRAP_CLASS}`);
    if (!wraps.length) return;
    for (const wrap of wraps) wrap.remove();
    log(`checkboxes removed: ${wraps.length} (state is not "open")`);
    updatePanel();
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
  }

  function getCheckedBoxes() {
    return Array.from(document.querySelectorAll(`.${CHECK_CLASS}:checked`));
  }

  function clearSelection() {
    for (const cb of getCheckedBoxes()) cb.checked = false;
    updatePanel();
  }

  // ---------- Parsing MR data from the DOM ----------

  function parseMr(li) {
    const link = li.querySelector(
      "div.issuable-main-info .merge-request-title a, .merge-request-title.title a"
    );
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

    // The "Approved" badge may be absent — that is a valid state (0 approvals).
    let approvalsGiven = 0;
    let approvalsRequired = null;
    const badge = li.querySelector('div.issuable-meta [data-testid="mr-appovals"], [data-testid="mr-appovals"]');
    if (badge) {
      const m = /\((\d+)\s+of\s+(\d+)\s+given\)/.exec(badge.getAttribute("title") || "");
      if (m) {
        approvalsGiven = Number(m[1]);
        approvalsRequired = Number(m[2]);
      }
    }

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
    panelRefs.count.textContent = String(count);
    panelHost.style.display = count > 0 ? "block" : "none";
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

  let scanScheduled = false;

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      addCheckboxes();
      // The list may have been re-rendered — refresh the counter/panel visibility.
      if (panelHost) updatePanel();
    });
  }

  log("content script loaded on", location.href);
  injectCheckboxStyles();
  addCheckboxes();

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
})();

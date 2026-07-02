// Background service worker: sends to the Slack Webhook (bypasses content script CORS)
// and dynamically registers the content script for the configured GitLab hosts.

importScripts("common.js"); // GLMR_DEFAULTS, glmrParseList, GLMR_URL_SEPARATOR

const CS_ID = "glmr-content";

const log = (...args) => console.log("[GLMR bg]", ...args);
const warn = (...args) => console.warn("[GLMR bg]", ...args);

// ---------- Registration for GitLab hosts from settings ----------
// No hosts are hardcoded: the content script and the DNR intercept rule
// are built from the gitlabHosts setting (only hosts with a granted permission).

async function grantedHosts() {
  const { gitlabHosts } = await chrome.storage.sync.get({ gitlabHosts: GLMR_DEFAULTS.gitlabHosts });
  const hosts = glmrParseHosts(gitlabHosts);
  log("hosts from settings:", hosts);
  const granted = [];
  for (const host of hosts) {
    try {
      // The permission is requested on the options page when saving.
      if (await chrome.permissions.contains({ origins: [`*://${host}/*`] })) {
        granted.push(host);
      } else {
        warn("no host permission for", host, "— save the settings again and confirm access");
      }
    } catch (e) {
      warn("invalid host in settings:", host, "-", e.message);
    }
  }
  return granted;
}

async function syncRegistrations() {
  const hosts = await grantedHosts();

  // Content script.
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CS_ID] });
  } catch (_) {
    // Not registered yet.
  }
  if (hosts.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: CS_ID,
        matches: hosts.map((h) => `*://${h}/*`),
        js: ["common.js", "content.js"],
        runAt: "document_idle",
        persistAcrossSessions: true
      }
    ]);
    log("content script registered for:", hosts);
  } else {
    warn("content script NOT registered: no hosts with a granted permission");
  }

  await registerOpenRule(hosts);
}

// ---------- Marker URL interception (opening a set of tabs) ----------

// Navigation to https://<any configured host>/-/glmr/open?... is intercepted
// BEFORE the request reaches the server and redirected to the extension's open.html
// (the query is preserved). open.html opens tabs from the parameters and closes itself.
const OPEN_RULE_ID = 1;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function registerOpenRule(hosts) {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [OPEN_RULE_ID] });
  if (!hosts.length) {
    warn("DNR intercept rule not registered: no hosts");
    return;
  }
  const hostAlternatives = hosts.map(escapeRegex).join("|");
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        id: OPEN_RULE_ID,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            regexSubstitution: chrome.runtime.getURL("open.html") + "\\1"
          }
        },
        condition: {
          regexFilter: `^https?://(?:${hostAlternatives})(?::\\d+)?/-/glmr/open(\\?.*)?$`,
          resourceTypes: ["main_frame"]
        }
      }
    ]
  });
  log("DNR intercept rule for /-/glmr/open registered for:", hosts);
}

// ---------- Sending to Slack ----------

async function sendToSlack(text, urls) {
  const { webhookUrl } = await chrome.storage.sync.get({ webhookUrl: "" });
  if (!webhookUrl) {
    warn("send rejected: webhook URL is not set");
    return { ok: false, error: "Webhook URL is not set" };
  }
  // The webhook URL is a secret: never log it or include it in errors.
  log("POST to webhook, text length:", text.length, "MR links:", (urls || []).length);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Endpoint format: content — the message text,
      // urls — MR links joined with GLMR_URL_SEPARATOR (same format as the /-/glmr/open params).
      body: JSON.stringify({
        content: text,
        urls: (urls || []).join(GLMR_URL_SEPARATOR)
      })
    });
    log("Slack response: HTTP", res.status);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Slack puts the reason into the response body: invalid_payload, no_service, etc.
      warn("Slack error:", res.status, body.slice(0, 200));
      return { ok: false, error: `HTTP ${res.status}${body ? " (" + body.slice(0, 100) + ")" : ""}` };
    }
    return { ok: true };
  } catch (e) {
    warn("webhook unreachable:", e.message);
    return { ok: false, error: "webhook unreachable (" + e.message + ")" };
  }
}

// ---------- Events ----------

chrome.runtime.onInstalled.addListener(async () => {
  log("onInstalled");
  // Default values on first run (do not overwrite existing ones).
  const current = await chrome.storage.sync.get(null);
  const seed = {};
  for (const [key, value] of Object.entries(GLMR_DEFAULTS)) {
    if (!(key in current)) seed[key] = value;
  }
  if (Object.keys(seed).length) {
    await chrome.storage.sync.set(seed);
  }
  await syncRegistrations();
});

chrome.runtime.onStartup.addListener(syncRegistrations);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.gitlabHosts) {
    syncRegistrations();
  }
});

chrome.permissions.onAdded.addListener(syncRegistrations);
chrome.permissions.onRemoved.addListener(syncRegistrations);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  log("message:", msg && msg.type);
  if (msg && msg.type === "glmr:sendToSlack") {
    sendToSlack(msg.text, msg.urls).then(sendResponse);
    return true; // async response
  }
  if (msg && msg.type === "glmr:openOptions") {
    chrome.runtime.openOptionsPage();
  }
});

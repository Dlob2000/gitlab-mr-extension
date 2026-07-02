// Options page: read/write chrome.storage.sync, request host permissions.

const FIELDS = ["webhookUrl", "templateMain", "templateAlt", "oneApproverList", "gitlabHosts"];

const log = (...args) => console.log("[GLMR options]", ...args);

const statusEl = document.getElementById("status");
let statusTimer = null;

function showStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "err";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "";
  }, 4000);
}

async function load() {
  const settings = await glmrGetSettings();
  for (const field of FIELDS) {
    document.getElementById(field).value = settings[field];
  }
}

async function save() {
  const settings = {};
  for (const field of FIELDS) {
    settings[field] = document.getElementById(field).value.trim();
  }

  const perm = await glmrEnsureWebhookPermission(settings.webhookUrl);
  if (!perm.ok) {
    log("webhook permission:", perm.error);
    showStatus(perm.error, false);
    return;
  }

  // Normalize the hosts (the user may have pasted a URL with a scheme/path)
  // and store them in clean form.
  const hosts = glmrParseHosts(settings.gitlabHosts);
  settings.gitlabHosts = hosts.join("\n");
  document.getElementById("gitlabHosts").value = settings.gitlabHosts;
  const origins = hosts.map((h) => `*://${h}/*`);
  log("saving; hosts:", hosts, "webhook set:", Boolean(settings.webhookUrl));

  if (origins.length) {
    let granted = false;
    try {
      // Must be called from a click handler (user gesture).
      granted = await chrome.permissions.request({ origins });
    } catch (e) {
      log("permission request error:", e.message);
      showStatus("Invalid host: " + e.message, false);
      return;
    }
    log("host permissions granted:", granted, origins);
    if (!granted) {
      showStatus("Access to GitLab hosts not granted — the extension will not activate", false);
      return;
    }
  }

  await chrome.storage.sync.set(settings);
  log("settings saved");
  showStatus("Saved", true);
}

document.getElementById("save").addEventListener("click", save);
load();

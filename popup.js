// Popup: quick setup of the webhook endpoint, message templates, and the 1-approver list.
// Full settings (incl. GitLab hosts) are on the options page.

const FIELDS = ["webhookUrl", "templateMain", "templateAlt", "oneApproverList"];

const log = (...args) => console.log("[GLMR popup]", ...args);

const statusEl = document.getElementById("status");
let statusTimer = null;

function showStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "err";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "";
  }, 3000);
}

async function load() {
  const settings = await glmrGetSettings();
  for (const field of FIELDS) {
    document.getElementById(field).value = settings[field];
  }
  log("settings loaded");
}

async function save() {
  const settings = {};
  for (const field of FIELDS) {
    settings[field] = document.getElementById(field).value;
  }
  settings.webhookUrl = settings.webhookUrl.trim();

  const perm = await glmrEnsureWebhookPermission(settings.webhookUrl);
  if (!perm.ok) {
    log("webhook permission:", perm.error);
    showStatus(perm.error, false);
    return;
  }

  // GitLab hosts are not touched here — they live on the options page.
  await chrome.storage.sync.set(settings);
  log("settings saved, webhook set:", Boolean(settings.webhookUrl));
  showStatus("Saved", true);
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
load();

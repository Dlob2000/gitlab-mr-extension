// Shared code for the content script and the options page (included via plain <script>/js array).

// Separator for the MR link list: used in the `urls` field of the webhook payload
// and in the `urls` query parameter of the marker URL (/-/glmr/open) — same format everywhere.
const GLMR_URL_SEPARATOR = "|";

const GLMR_DEFAULTS = {
  webhookUrl: "",
  templateMain: "Hi! Please approve these MRs:\n$list_formatted\nThanks!",
  templateAlt: "MRs for review:\n$list",
  oneApproverList: "",
  // GitLab hosts are set by the user in the settings; nothing is hardcoded.
  gitlabHosts: ""
};

// Validates the webhook URL and requests a host permission for its domain if needed.
// hooks.slack.com is covered by a static permission in the manifest; a custom endpoint
// (proxy etc.) needs a dynamic one. Must be called from a user gesture (the Save click).
async function glmrEnsureWebhookPermission(webhookUrl) {
  if (!webhookUrl) return { ok: true };
  let url;
  try {
    url = new URL(webhookUrl);
  } catch (_) {
    return { ok: false, error: "invalid webhook URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "webhook URL must be http(s)" };
  }
  if (url.hostname === "hooks.slack.com") return { ok: true };
  const origin = `${url.protocol}//${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  return granted
    ? { ok: true }
    : { ok: false, error: "access to " + url.hostname + " not granted — sending will not work" };
}

function glmrGetSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(GLMR_DEFAULTS, resolve);
  });
}

// Parses a multiline/comma-separated field into a list of non-empty values.
function glmrParseList(text) {
  return String(text || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Normalizes the GitLab host list: strips scheme, path, port, and lowercases.
// "https://git.example.com:8080/group/" → "git.example.com".
// The port is stripped because Chrome match patterns do not support ports
// (a host permission applies to any port).
function glmrParseHosts(text) {
  return glmrParseList(text)
    .map((s) =>
      s
        .replace(/^[a-z]+:\/\//i, "")
        .split("/")[0]
        .split(":")[0]
        .toLowerCase()
    )
    .filter(Boolean);
}

function glmrEscapeSlack(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Format of a single list item.
// style: "plain" — for the clipboard: `<title> (<target branch>) <url>`;
// style: "slack" — for the webhook: only the link and the target branch in parentheses.
function glmrFormatItem(mr, style) {
  const version = mr.version || "?";
  if (style === "slack") {
    return `${mr.url} (${version})`;
  }
  return `${mr.title} (${version}) ${mr.url}`;
}

// Substitutes $list / $list_formatted into the template.
// oneApproverSet — Set of target version values for which a single approval is enough.
function glmrRenderTemplate(template, mrs, oneApproverSet, style) {
  const plain = mrs.map((mr) => glmrFormatItem(mr, style));
  const formatted = mrs.map((mr, i) =>
    oneApproverSet.has(mr.version) ? plain[i] : plain[i] + " (2 approvers)"
  );
  // $list_formatted first: $list is its prefix.
  return String(template)
    .replaceAll("$list_formatted", formatted.join("\n"))
    .replaceAll("$list", plain.join("\n"));
}

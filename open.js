// Interceptor page: the DNR rule redirects the marker URL here —
// https://<configured-gitlab-host>/-/glmr/open?... (the query is preserved).
// Opens tabs from the query parameters and closes its own tab.
//
// Supported query formats:
//   ?urls=<url1>|<url2>                — list joined with GLMR_URL_SEPARATOR;
//                                        same format as the `urls` field of the webhook payload
//   ?u=<encoded-url>&u=<encoded-url>   — repeated parameter (alternative)

const log = (...args) => console.log("[GLMR open]", ...args);

function collectUrls() {
  const params = new URLSearchParams(location.search);
  const raw = [
    ...params.getAll("u"),
    ...(params.get("urls") || "").split(GLMR_URL_SEPARATOR)
  ];
  const urls = [];
  for (const item of raw) {
    const s = item.trim();
    if (!s) continue;
    try {
      const url = new URL(s);
      if (url.protocol === "https:" || url.protocol === "http:") {
        urls.push(url.href);
      } else {
        log("skipped non-http(s) URL:", s);
      }
    } catch (_) {
      log("skipped invalid URL:", s);
    }
  }
  return urls;
}

async function run() {
  const urls = collectUrls();
  log("URLs from query:", urls);

  const msg = document.getElementById("msg");
  if (!urls.length) {
    msg.className = "err";
    msg.innerHTML =
      "No valid URLs in the query parameters. Formats: " +
      "<code>?urls=&lt;url1&gt;|&lt;url2&gt;</code> or <code>?u=&lt;encoded-url&gt;&amp;u=…</code>";
    return; // keep the tab open so the user sees the hint
  }

  const current = await chrome.tabs.getCurrent();
  for (let i = 0; i < urls.length; i++) {
    // The first opened tab becomes active, the rest open in the background.
    const props = { url: urls[i], active: i === 0 };
    if (current) props.index = current.index + i + 1; // tabs in order, next to the marker tab
    await chrome.tabs.create(props);
  }
  log("tabs opened:", urls.length, "— closing my own");
  if (current) {
    chrome.tabs.remove(current.id);
  } else {
    window.close();
  }
}

run();

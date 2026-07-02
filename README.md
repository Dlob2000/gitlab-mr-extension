# GitLab MR → Slack

Chrome extension (Manifest V3): adds checkboxes to the GitLab Merge Request list page,
lets you select MRs and send a templated message to Slack (Incoming Webhook)
or copy it to the clipboard.

Detailed requirements: [REQUIREMENTS.md](REQUIREMENTS.md).

## Installation (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the project folder.
3. Open the extension settings (Details → Extension options):
   - set the **GitLab host(s)** — your GitLab domains, one per line;
   - paste the **Slack Webhook URL** (how to create one — [SLACK_WEBHOOK.md](SLACK_WEBHOOK.md));
   - edit the templates and the **1-approver list** if needed;
   - click **Save** — Chrome will request access to the specified hosts, confirm it
     (the extension will not activate without it).

## Usage

1. Open the MR list: `https://<gitlab-host>/<group>/<project>/-/merge_requests`.
2. Check the MRs you need — a panel with a counter appears in the top-right corner.
3. Panel buttons:
   - **Send to Slack** — main template, links in Slack markup `<url|title>`;
   - **Copy** — main template, plain text `title (version) url`;
   - **Copy (alt. template)** — alternative template;
   - **Reset** — uncheck all checkboxes.

## Message setup

Click the extension icon in the toolbar — a popup opens with a form: webhook endpoint,
main template, alternative template, 1-approver list. The "All settings →" button
leads to the full settings page (additional GitLab hosts and everything else).

The endpoint is usually a Slack Incoming Webhook (`https://hooks.slack.com/…`), but you can
set your own (a proxy etc.): for a domain other than `hooks.slack.com` Chrome will request
access when saving.

Payload format: `POST` with JSON:

```json
{
  "content": "<message rendered from the template>",
  "urls": "<mr-url-1>|<mr-url-2>|<mr-url-3>"
}
```

`urls` — links of the selected MRs joined with the `|` separator; the marker URL accepts
the same format in its `urls` parameter (see below) — the endpoint may return the list as is.
(A native Slack Incoming Webhook expects a `text` field — for direct sending
to hooks.slack.com change the format in `background.js`.)

## Templates

Variables:

- `$list` — the selected MRs, one per line: `<title> (<target version>) <url>`;
- `$list_formatted` — same, but MRs whose target version is missing from the
  1-approver list get the ` (2 approvers)` suffix.

## Marker URL: opening a set of tabs

Navigation to `https://<gitlab-host>/-/glmr/open?<params>` (any host from the settings)
is intercepted by the extension **before the request reaches the server** (declarativeNetRequest):
the tab with the marker URL is closed and tabs from the query parameters open instead.

Query formats (can be combined):

```
?urls=<url1>|<url2>|<url3>           # | separator — same format as the urls field of the webhook payload
?u=<encoded-url>&u=<encoded-url>     # repeated parameter, URL-encoded (alternative)
```

Example:

```
https://<gitlab-host>/-/glmr/open?urls=https://<gitlab-host>/a/b/-/merge_requests/1|https://<gitlab-host>/a/b/-/merge_requests/2
```

Non-http(s) and invalid URLs are skipped (logged in the open.html page console).

## Debugging

All logs are prefixed with `[GLMR]`. The webhook URL never appears in the logs.

| What to check | Where |
|---|---|
| Content script: checkboxes, MR parsing, templates | DevTools (F12) on the GitLab page → Console, filter `[GLMR]` |
| Background: host registration, sending to Slack | `chrome://extensions` → extension card → **service worker** ("Inspect views" link) |
| Options page: saving, permissions | F12 on the settings page |

After editing the code: `chrome://extensions` → ⟳ (Reload) button on the extension card,
then reload the GitLab page.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `content.js` | checkboxes, panel (Shadow DOM), MR parsing, templates, clipboard |
| `background.js` | POST to the Slack Webhook; dynamic content script registration for the configured hosts |
| `common.js` | shared settings/template rendering (content script + options) |
| `options.html` / `options.js` | settings page |
| `popup.html` / `popup.js` | toolbar icon popup: quick message template setup |

# How to create a Slack Incoming Webhook

An Incoming Webhook is a URL; a POST request to it publishes a message in the chosen
Slack channel. No OAuth and no tokens: create the URL → paste it into the extension settings.

## Step 1. Create a Slack App

1. Open https://api.slack.com/apps (sign in to your workspace if asked).
2. Click **Create New App**.
3. Choose **From scratch**.
4. Fill in:
   - **App Name** — anything, e.g. `GitLab MR Bot` (this name will be the message sender);
   - **Pick a workspace** — your work workspace.
5. Click **Create App**.

> If app creation in the workspace is restricted by an admin, the button leads to
> a request form — you will have to wait for the administrator's approval.

## Step 2. Enable Incoming Webhooks

1. In the left menu open **Incoming Webhooks** (the *Features* section).
2. Switch the **Activate Incoming Webhooks** toggle to **On**.

## Step 3. Create a webhook for a channel

1. At the bottom of the same page click **Add New Webhook to Workspace**.
2. Slack asks where the app is allowed to post — choose a channel
   (e.g. `#code-review`) or direct messages.
3. Click **Allow**.
4. A URL like this appears in the **Webhook URLs for Your Workspace** table:

   ```
   https://hooks.slack.com/services/T…/B…/…
   ```

5. Click **Copy** next to it.

One webhook = one channel. Need another channel — repeat step 3 to get a second URL.

## Step 4. Test (optional)

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"text": "Webhook test"}' \
  https://hooks.slack.com/services/T…/B…/…
```

The response `ok` means it works and the message appeared in the channel. Possible errors
in the response body:

| Response | Cause |
|---|---|
| `invalid_payload` | broken JSON or missing `text` field |
| `channel_not_found` / `channel_is_archived` | channel deleted or archived |
| `no_service` / `no_service_id` | webhook revoked or URL copied incompletely |
| `action_prohibited` | workspace admin disallowed webhooks |

## Step 5. Paste into the extension

1. Click the **GitLab MR → Slack** extension icon in the Chrome toolbar.
2. The **Webhook URL (endpoint)** field → paste the copied URL.
3. **Save**.

## Security

- **The webhook URL is a secret.** Anyone who has it can post to the channel on behalf
  of the app. Do not commit it and do not share it in public chats.
- If it leaks — revoke it: the app page → Incoming Webhooks → delete the URL
  (or uninstall the app from the workspace) → create a new one.
- The extension stores the URL only in `chrome.storage` and never writes it to logs.

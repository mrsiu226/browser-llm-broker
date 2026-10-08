# Usage guide

How to use the broker once it is running (see the [README](../README.md) quick start or [DEPLOYMENT.md](DEPLOYMENT.md)). The same content is available inside the app at **`/#docs`** (Vietnamese by default, English at `/#docs/en`).

## 1. Connect a Chrome browser (once per browser/profile)

1. Download the extension from the dashboard docs page (`/#docs` → *Download extension*) and unzip it somewhere permanent.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select the unzipped folder.
3. Log in to **https://chatgpt.com** in that same Chrome profile.
4. Dashboard → **Devices → Add device** → copy the pairing code (valid 10 minutes, single use).
5. Open the extension's options page (it opens after install, or click its toolbar icon). Enter:
   - **Server URL** — your broker, e.g. `https://broker.example.com`
   - **Pairing code**
   - a **name** for this browser (e.g. "Work laptop")
6. Click **Connect**. The toolbar badge shows **ON** and the device appears as *online* in the dashboard.

Badge states: **ON** connected · **OFF** disconnected (retries automatically) · **SET** not paired yet · **AUTH** the token was rejected (re-pair).

The options page also shows the live connection status, a **Reconnect now** button, and the run mode (below).

**Requirements while jobs run:** Chrome is open, the computer is awake, and the profile is logged in to ChatGPT. The extension reconnects by itself when Chrome starts.

### Run mode
- **Background tab (default)** — the job runs in a tab that is not activated; your windows are not touched. If ChatGPT refuses to accept the prompt in a background tab, that job is retried once with Chrome in the foreground.
- **Foreground** — Chrome is brought to the front while a job runs (most reliable, but visible).

### Offline device?
- Chrome was just restarted or lost network → options page → **Reconnect now**.
- Token invalid / badge **AUTH** → dashboard → **Devices → Re-pair** on that device (keeps its name, tags and history), then in the extension press **Disconnect this browser** and connect again with the new code.

## 2. Jobs

Dashboard → **Jobs → New job**.

| Field | Meaning |
|---|---|
| Prompt | Message sent to ChatGPT |
| Mode | `image` waits for a generated image (error if none) · `text` returns only the text · `auto` returns images if ChatGPT generated any, else the text |
| Existing conversation URL | Paste a `https://chatgpt.com/c/...` URL to send the prompt **into that conversation** (its memory/context is kept). Empty = new chat |
| Target device / tag | Which Chrome runs it (default: any free, online device of yours) |
| Also send the result to | A notification channel (Telegram/webhook) |

Your last choices are remembered in the browser. Open a job to see the formatted result (Markdown, tables, code, math), images, and the execution log (at the bottom).

- **Continue this conversation** — once a job has a result, send a follow-up in the same ChatGPT conversation (runs on the same browser when possible). The box is disabled while the job is still running.
- **Delete** removes a job and its stored result/images. Running jobs are cancelled first.

Pictures that ChatGPT shows from web search are **not** treated as generated images.

## 3. Choosing which browser answers

Name your browsers (Devices → Edit) and optionally add tags such as `art` or `fast`.

- Dashboard: *Target device* / *Target tag*.
- REST: `"target": {"device": "Work laptop"}` (name or id, case-insensitive) or `{"tag": "art"}`.
- MCP tools: `device` / `tag` parameters; `list_devices` shows names and status.
- No target → a free, online device of **yours** (least recently used first). Jobs never run on another user's browser.
- A targeted device that is offline, busy, paused or at its usage limit makes the job wait in the queue (default 10 minutes) and then fail.

A browser that reports ChatGPT's *usage limit* is marked **limited** until the reset time and the job moves to another of your devices.

## 4. Schedules

Dashboard → **Schedules → Create**:

- **Daily** at a time (with timezone) or **every N minutes** (optionally only inside an active window).
- Prompt, optional **existing conversation URL** (the prompt is posted into that conversation — useful for a chat that already has memory/instructions), device/tag, mode.
- Notification channel; for text results: *skip if unchanged* and *skip if text matches regex* (e.g. `no new data`) avoid repeated or empty notifications.
- **Run now** tests a schedule immediately.

A schedule needs an online browser of yours; otherwise the job waits (30 minutes) and then fails (and you are notified through the channel). A daily schedule missed while the server was down still runs if it is within `CATCH_UP_MINUTES` (default 120). Image generation counts against your ChatGPT limits — keep frequent schedules text-only.

## 5. Channels (where results are delivered)

**Telegram:** create a bot with @BotFather (token); message the bot once, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to read your `chat id`. Add the channel in the dashboard and press **Test**. Images go as photos (or documents for full quality), text keeps formatting.

**Webhook (any HTTP API):** URL, method, custom headers (values are encrypted and never shown again), optional HMAC signing secret, images as links/base64/none, optional body template. Payload format, signature scheme and template variables are in [API.md](API.md#webhooks). Failed deliveries are retried up to 3 times. Private/internal addresses are blocked unless `WEBHOOK_ALLOW_PRIVATE=1`.

A channel can be selected on a schedule, on a job (dashboard, REST `channelId`) and from MCP (`channel` parameter, by name or id).

## 6. Use it from Claude (MCP)

1. Dashboard → **API Keys → Create** (copy the key now; it is shown only once).
2. Register the server:

```bash
claude mcp add --scope user --transport http llm-broker https://YOUR-BROKER/mcp \
  --header "Authorization: Bearer ck_XXXXXXXX"
```

3. Start a **new** Claude session (or `/mcp` → Reconnect). Tools:

| Tool | Purpose |
|---|---|
| `generate_image` | Generate an image (`prompt`, optional `device`, `tag`, `channel`, `conversationUrl`) |
| `ask_chatgpt` | Ask anything; `mode` text/auto/image |
| `continue_chat` | Follow-up in the same conversation as a previous job (`jobId`, `prompt`) |
| `get_job` | Fetch a result later (long jobs return a job id after ~90 s) |
| `list_devices`, `list_channels` | See your browsers and channels |

Examples: *"Use ask_chatgpt (text) to … and print the result verbatim."* · *"Use generate_image on device Home PC to draw …, send it to channel Team Telegram."* · *"Use continue_chat with job id … and ask: …"*. Claude may paraphrase long replies when displaying them; ask for "verbatim" or use the REST API / channels for exact text.

## 7. Users and admin

Admins (Dashboard → **Admin**) create, disable and delete users, and see simple stats. Each user has their own devices, jobs, schedules, channels and API keys; nobody can see or use another user's browsers.

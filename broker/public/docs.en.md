# Browser LLM Broker — quick guide

Send requests to **ChatGPT through your own logged-in Chrome browsers** — from the dashboard, Claude (MCP), a REST API or a schedule — and get back formatted text, math and images. Results can also be pushed to Telegram or any webhook.

> Unofficial project, not affiliated with OpenAI. Automating chatgpt.com may violate OpenAI's Terms of Use and can get an account limited. Use only your own account and read the full disclaimer in the repository README.

## 1. Install the extension in Chrome

Do this once for every Chrome profile you want to use.

1. Click **Download extension (.zip)** at the top of this page and **unzip** it. Keep the folder where it is (do not delete it after installing).
2. Open `chrome://extensions`, switch on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder.
4. In that same Chrome, open **https://chatgpt.com** and **log in**.

> To update later: download the new zip, unzip it over the old folder, then press the reload icon (⟳) of the extension in `chrome://extensions`.

## 2. Pair this Chrome with your account

1. Sign in to this dashboard → **Devices → Add device** to get a code like `ABCD-1234` (valid 10 minutes, single use).
2. Open the extension's options page (opens after install, or click its toolbar icon). Enter **Server URL** `{{ORIGIN}}`, the code and a name for this browser → **Connect**.
3. The toolbar badge turns **ON** and the device shows as *online* in **Devices**.

Badge: **ON** connected · **OFF** disconnected (retries) · **SET** not paired yet · **AUTH** token rejected, pair again.

You can pair several Chrome profiles. Rename, tag, pause or delete them in **Devices**. The options page shows live status, a **Reconnect now** button and the run mode.

**Device offline?** Chrome was just restarted or lost network → **Reconnect now** in the options page. Token invalid → **Devices → Re-pair** on that device (keeps name, tags and history), then *Disconnect this browser* in the extension and connect again with the new code.

**Needed while jobs run:** Chrome open, computer awake, logged in to ChatGPT.

**Run mode** (extension options, *When a job runs*): **background tab** (default; Chrome stays where it is, with an automatic foreground retry if ChatGPT does not accept the prompt) or **bring Chrome to the front**.

## 3. Create a job

**Jobs → New job**:

- **Prompt** — the message for ChatGPT.
- **Mode** — `image` (wait for an image), `text` (text only), `auto` (images if ChatGPT generated any, otherwise text).
- **Existing conversation URL** (optional) — paste a `https://chatgpt.com/c/...` URL to send the prompt into that conversation and keep its memory/context. Empty = new chat.
- **Target device / tag** — which Chrome runs it (default: any free online one of yours). Your last choices are remembered.
- **Also send the result to** — a Telegram/webhook channel.

Open a job to see the formatted result (headings, lists, tables, code, math), images and the execution log (at the bottom).

**Continue this conversation:** once a job has a result, type the next message in the box and press **Send** — it goes into the same ChatGPT conversation, preferably on the same Chrome. The box is disabled while the job is still running. **Delete** removes a job and its result.

## 4. Schedules

**Schedules → Create**: *Daily* (time + timezone) or *Interval* (every N minutes, optional active window); prompt and optional existing conversation URL (copy it from the browser's address bar), device/tag, mode, channel. For text results you can *skip if unchanged* or *skip if it matches a regex* (e.g. `no new data`). **Run now** tests it immediately. A schedule needs one of your Chrome browsers online (otherwise it waits up to 30 minutes, then fails).

## 5. Channels

**Telegram** — create a bot with @BotFather; message it once, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to get your chat id; add the channel and press **Test**.

**External API (webhook)** — URL, method, custom headers, optional HMAC signing secret, images as links/base64/none, optional body template (`{{text}} {{markdown}} {{prompt}} {{error}} {{state}} {{jobId}} {{scheduleName}} {{event}}`, `{{json}}`). Requests carry `X-Broker-Event`; with a secret also `X-Broker-Timestamp` and `X-Broker-Signature: sha256=HMAC(secret, timestamp + "." + body)`. Retried up to 3 times; internal addresses are blocked by default.

## 6. Use it from Claude (MCP)

1. **API Keys → Create** and copy the key (shown once).
2. Run:

```
claude mcp add --scope user --transport http llm-broker {{ORIGIN}}/mcp --header "Authorization: Bearer ck_XXXX"
```

3. Start a **new** Claude session. Tools: `generate_image`, `ask_chatgpt`, `continue_chat`, `get_job`, `list_devices`, `list_channels`.

Examples: "Use ask_chatgpt (text) to …, print the result verbatim." · "Use ask_chatgpt on device *Work laptop* …" (`device`, `tag`) · "… send the result to channel *Team Telegram*" (`channel`) · "Use continue_chat with job id … and ask …". Claude may shorten long replies when displaying them — ask for "verbatim".

## 7. REST API

```
curl -s -X POST "{{ORIGIN}}/v1/jobs?wait=120&inline=1" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"prompt":"Explain the Pythagorean theorem with formulas","mode":"text"}'
```

`POST /v1/jobs` (`prompt`, `mode`, `conversationUrl?`, `target?` = `{"device":"name or id"}` or `{"tag":"…"}`, `channelId?` = id or name, `timeoutMs?`; without `wait` returns `202 {id}`) · `GET /v1/jobs/:id` · `POST /v1/jobs/:id/followup` · `POST /v1/jobs/:id/cancel` · `DELETE /v1/jobs/:id` · `GET /v1/devices`. Full reference: `docs/API.md` in the repository.

## 8. Troubleshooting

- **OFF / offline** — check `{{ORIGIN}}/healthz`, then **Reconnect now**; update the extension to the latest version.
- **AUTH** — **Re-pair** the device (section 2).
- **Job stays *queued*** — no free online Chrome of yours (closed, paused, at usage limit, wrong target); fails after 10 minutes.
- **"Prompt was not sent to ChatGPT"** — the window was hidden/minimized; keep Chrome open or switch the run mode to *foreground*.
- **"Usage limit reached"** — ChatGPT plan limit (usually images); that Chrome is *limited* until the reset time and the job moves to another of your browsers if you have one.
- **Odd or empty text** — ChatGPT's page may have changed; update the extension and report an issue with the job's error text.

## 9. Notes

- Use only **your own** ChatGPT account on **your own** browser; never share or pool accounts.
- The server relays your prompts and replies, so its operator can read them; jobs and images are deleted after a retention period.
- One job at a time per Chrome; pair more Chrome profiles for more throughput.

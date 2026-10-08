# Architecture

## Components

```
┌────────────┐  HTTP/MCP/REST   ┌───────────────────────────────┐  WebSocket   ┌───────────────────────┐
│ Claude,    │ ───────────────▶ │ BROKER (Node, SQLite)         │ ◀──────────▶ │ Chrome extension (MV3)│
│ scripts,   │                  │  • HTTP server + dashboard    │   /ws        │  background.js        │
│ dashboard  │ ◀─────────────── │  • job queue + dispatcher     │              │  content.js (page)    │
└────────────┘     results      │  • scheduler, notifier        │              └──────────┬────────────┘
                                │  • device registry, auth      │                         │ drives the page
                                └───────────────┬───────────────┘                         ▼
                                                │ Telegram / webhooks                 chatgpt.com
                                                ▼                                  (user's own session)
```

- **Broker** (`broker/src`, TypeScript, plain `node:http`): one process. SQLite via `better-sqlite3` (`DATA_DIR/broker.db`), images on disk (`DATA_DIR/images/<jobId>/`).
- **Dashboard** (`broker/public`): dependency-free ES modules, hash router, polling (3 s) — no build step. KaTeX is vendored for math.
- **Extension** (`extension/`): Manifest V3. `background.js` (service worker) keeps the WebSocket to the broker, opens the ChatGPT tab and hands the job to `content.js`; `content.js` fills the prompt, waits for the reply and extracts Markdown/images.

| File | Role |
|---|---|
| `src/index.ts` | HTTP server, static files, extension zip download, WebSocket upgrade/auth, startup |
| `src/routes.ts` | Dashboard API (`/api`), public API (`/v1`), pairing, files |
| `src/engine.ts` | Device connections, job lifecycle, dispatcher, retries, housekeeping |
| `src/mcp.ts` | MCP tools (stateless streamable-HTTP) |
| `src/scheduler.ts` | Daily / interval schedules |
| `src/notify.ts`, `src/webhook.ts` | Telegram and webhook delivery (HMAC, retries, SSRF guard) |
| `src/db.ts` | Schema + lightweight migrations |
| `src/util.ts` | Crypto (scrypt, AES-GCM, HMAC), rate limit, HTTP helpers |
| `src/zip.ts` | Builds the downloadable extension zip from `extension/` |

## Data model (SQLite)

`users` · `sessions` · `api_keys` (hashed) · `devices` (hashed token, tags, paused, `limited_until`) · `pairing_codes` · `jobs` (state, mode, prompt, `conversation_url`, `chat_url`, `markdown`, `text`, `progress`, `parent_id`, `channel_id`, …) · `job_images` · `schedules` · `channels` (config encrypted with `SECRET_KEY`).

## Job lifecycle

`queued → running → succeeded | failed | canceled`

1. A job is created (dashboard / `/v1` / MCP / schedule) and stored as `queued`.
2. The **dispatcher** picks, for each queued job, an eligible connected device: same user, not paused, not usage-limited, idle, matching the target (device id or tag) — least recently used first. The job becomes `running` and a `generate_image` message is sent to that device.
3. The extension answers `started` → `progress`* → `result` (text, markdown, images, conversation URL) or `error`.
4. On `usage_limit` errors the device is marked *limited* until the reset time and the job is re-queued for another device (max 3 attempts).
5. If the device disconnects **before** `started`, the job is re-queued; **after** `started` it fails (never auto-retried, to avoid duplicate generations).
6. Housekeeping: heartbeat pings, queue timeout (10 min; schedules 30 min), per-job timeout, retention cleanup. Jobs left `running` by a crashed process are failed at startup.

## Extension ↔ broker protocol (WebSocket `/ws`)

The extension connects with `Origin: chrome-extension://…`, then must authenticate within 8 s.

| Direction | Message |
|---|---|
| ext → broker | `{"type":"auth","token":"dt_…","version":"0.5.0"}` |
| broker → ext | `{"type":"auth_ok","deviceId","label"}` or `{"type":"auth_error"}` (then closes) |
| broker → ext | `{"type":"generate_image","id","prompt","timeoutMs","conversationUrl?","mode":"image\|text\|auto"}` |
| ext → broker | `{"type":"started","id"}` · `{"type":"progress","id","message"}` |
| ext → broker | `{"type":"result","id","text","markdown","images":[{"mime","base64"}],"conversationUrl"}` |
| ext → broker | `{"type":"error","id","message","code?":"usage_limit","resetsAt?"}` |
| both | `{"type":"ping"}` / `{"type":"pong"}`; the broker also sends WebSocket pings and drops silent peers after ~70 s |

Pairing: dashboard creates a one-time code (10 min); the extension calls `POST /api/device/pair {code,label,version}` and receives `{deviceId, deviceToken}` (only a hash is stored). **Re-pairing** an existing device rotates its token and closes any connection using the old one.

## How the extension drives ChatGPT

ChatGPT's web UI is not an API and changes without notice, so the content script avoids brittle CSS classes:

- **Turns** are located through the invisible "You said:" / "ChatGPT said:" labels; a baseline count taken before sending lets it read only the new reply (works in long existing conversations).
- **Completion**: the stop button appears and then disappears for ~3 s (text mode also accepts stable text); a usage-limit banner is detected and reported with its reset time.
- **Text → Markdown**: the reply DOM (`[data-markdown-text-style="assistant-message"]`) is converted to Markdown; KaTeX nodes are replaced by their TeX source (`data-math-source`).
- **Images**: only images hosted by ChatGPT/OpenAI (not `/static-rsc` web-search thumbnails) count as generated images; they are fetched (content script, with a background-worker fallback) and returned as base64.
- **Submitting**: fill via `execCommand`/paste simulation, verify the editor holds the text, click send (form submit/Enter fallbacks), and confirm a new user turn appeared; retry, then fall back to a foreground tab.
- Every failure carries page diagnostics (visible buttons/editors) in its error text to make selector fixes quick.

## Security design

- Passwords: scrypt. API keys and device tokens: only SHA-256 hashes stored. Sessions: random id, hash stored, HttpOnly SameSite=Lax cookie; state-changing requests need `X-Requested-With`.
- Channel secrets (Telegram token, webhook headers/secret): AES-256-GCM with a key derived from `SECRET_KEY`.
- Tenant isolation: every query is scoped by `user_id`; devices only ever receive their owner's jobs.
- Webhooks: SSRF guard (private ranges blocked), no redirects followed, timeouts, HMAC signatures.
- Rate limits on login and pairing; CSP and security headers on the dashboard.
- The operator can read prompts/replies (the broker relays them) — see [SECURITY.md](../SECURITY.md).

## Design decisions and non-goals

- **SQLite + one process**: simple to run and back up; fits teams of tens of users. Scaling out would need a shared database and a pub/sub layer for device sockets.
- **Browser automation instead of an API**: the point is to use the user's own logged-in ChatGPT; for production workloads prefer OpenAI's official API.
- **No remote code**: the extension only executes its fixed command set on chatgpt.com.
- Possible future work: provider abstraction (official API fallback), more tests with recorded DOM fixtures for the extractor, i18n of the dashboard.

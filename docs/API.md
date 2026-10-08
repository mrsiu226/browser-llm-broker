# API reference

Three ways in: **REST with an API key** (`/v1/*`), **MCP** (`/mcp`), and the **dashboard API** (`/api/*`, cookie session — used by the web UI). Errors are JSON `{"error": "message"}` with a 4xx/5xx status.

## Authentication

- **API key** — create it in the dashboard (**API Keys**). Send `Authorization: Bearer ck_...` to `/v1/*` and `/mcp`. Keys act as the user who created them.
- **Dashboard** — session cookie from `POST /api/auth/login`; every non-GET request must also send `X-Requested-With: dashboard`.
- **Extensions** — per-device token over WebSocket (see [ARCHITECTURE.md](ARCHITECTURE.md)).

## REST (`/v1`, API key)

### `POST /v1/jobs`
Create a job. Query: `wait=<seconds ≤180>` waits for the result and returns it (200); without it returns `202 {"id": "..."}`. `inline=1` embeds images as base64.

```json
{
  "prompt": "Explain the Pythagorean theorem with formulas",
  "mode": "text",                       // "image" | "text" | "auto" (default auto)
  "conversationUrl": "https://chatgpt.com/c/…",   // optional: send into an existing conversation
  "target": { "device": "Work laptop" },          // optional: {"device": name|id} or {"tag": "art"}
  "channelId": "Team Telegram",                   // optional: channel id or name to also deliver to
  "timeoutMs": 240000                              // optional (30 000 – 900 000)
}
```

### `GET /v1/jobs/:id`
```json
{
  "id": "…", "state": "succeeded",       // queued | running | succeeded | failed | canceled
  "mode": "text", "prompt": "…", "error": null,
  "text": "plain text", "markdown": "## full formatting, $math$ …",
  "images": [ { "mime": "image/png", "url": "/files/…?exp=…&sig=…", "base64": "…(only with inline=1)" } ],
  "chatUrl": "https://chatgpt.com/c/…",  // conversation of this job (used for follow-ups)
  "parentId": null, "progress": [ { "ts": "…", "message": "…" } ],
  "createdAt": "…", "startedAt": "…", "finishedAt": "…", "deviceLabel": "Work laptop", "source": "api"
}
```
Image `url`s are signed and valid for one hour (no cookie needed).

### Other endpoints
| Method & path | Purpose |
|---|---|
| `POST /v1/jobs/:id/followup` | Send another message in the job's conversation. Body `{prompt, mode?, channelId?, timeoutMs?}`; supports `?wait=` / `?inline=1`. Runs on the same device when possible. |
| `POST /v1/jobs/:id/cancel` | Cancel a queued/running job |
| `DELETE /v1/jobs/:id` | Delete a job and its stored result |
| `GET /v1/devices` | Your browsers: `id, label, tags, status (online/offline/paused/limited), lastSeenAt…` |

Example:
```bash
curl -s -X POST "https://BROKER/v1/jobs?wait=120" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"prompt":"Say hi in French","mode":"text"}'
```

## MCP (`/mcp`)

Streamable-HTTP MCP server (stateless). Register with `claude mcp add --transport http NAME URL --header "Authorization: Bearer ck_…"`.

| Tool | Arguments |
|---|---|
| `generate_image` | `prompt`, `timeoutMs?`, `conversationUrl?`, `device?`, `tag?`, `channel?` |
| `ask_chatgpt` | `prompt`, `mode?` (text/auto/image), `conversationUrl?`, `device?`, `tag?`, `channel?`, `timeoutMs?` |
| `continue_chat` | `jobId`, `prompt`, `mode?`, `channel?`, `timeoutMs?` |
| `get_job` | `id` |
| `list_devices`, `list_channels` | — |

`device` / `channel` accept a name or an id. Tools wait up to `MCP_WAIT_MS` (default 90 s); longer jobs return a job id for `get_job`. Every reply ends with `[job id: …]` so `continue_chat` can refer to it.

## Webhooks

A *webhook channel* (dashboard → Channels) delivers `job.finished` events for jobs/schedules that selected it, and `channel.test` when you press **Test**.

Standard body (when no custom template is set):
```json
{
  "event": "job.finished",
  "sentAt": "2026-10-06T10:00:00.000Z",
  "job": { "id": "…", "state": "succeeded", "mode": "auto", "prompt": "…", "error": null,
           "source": "schedule", "createdAt": "…", "finishedAt": "…", "device": "Work laptop" },
  "schedule": { "id": "…", "name": "daily-art" },
  "result": { "text": "…", "markdown": "…",
              "images": [ { "mime": "image/png", "url": "https://…/files/…?exp=…&sig=…" } ] }
}
```
`images` items carry `url` (signed link, 7 days), `base64`, or the array is empty, depending on the channel's *Images in payload* setting. Failed jobs are delivered too (`job.state: "failed"`, `job.error` set).

**Custom body template** — replace the payload with your own text. Placeholders (JSON-string-escaped): `{{text}} {{markdown}} {{prompt}} {{error}} {{state}} {{jobId}} {{scheduleName}} {{event}}`; and `{{json}}` = the whole standard payload. Example for Slack: `{"text": "{{markdown}}"}`.

**Headers sent:** `X-Broker-Event`, your custom headers, and — when a signing secret is set — `X-Broker-Timestamp` (unix seconds) and `X-Broker-Signature: sha256=<hex>` where the value is `HMAC_SHA256(secret, timestamp + "." + rawBody)`. Verify the signature and reject old timestamps:

```js
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
```

**Delivery:** success = any 2xx. Network errors, 5xx and 429 are retried (3 attempts: now, +2 s, +10 s); other 4xx and redirects are not. Private/loopback/link-local targets are blocked unless `WEBHOOK_ALLOW_PRIVATE=1`.

## Dashboard API (`/api/*`)

Used by the web UI; listed for completeness. Session cookie + `X-Requested-With: dashboard`.

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`, `POST /api/me/password` |
| Devices | `GET /api/devices`, `POST /api/devices/pairing`, `POST /api/devices/:id/pairing` (re-pair), `PATCH/DELETE /api/devices/:id` |
| Extension pairing (no auth, CORS open) | `POST /api/device/pair` `{code, label?, version?}` → `{deviceId, deviceToken}` |
| Jobs | `GET/POST /api/jobs`, `GET/DELETE /api/jobs/:id`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/followup` |
| Schedules | `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/:id`, `POST /api/schedules/:id/run` |
| Channels | `GET/POST /api/channels`, `PATCH/DELETE /api/channels/:id`, `POST /api/channels/:id/test` |
| API keys | `GET/POST /api/keys`, `DELETE /api/keys/:id` |
| Admin | `GET/POST /api/admin/users`, `PATCH/DELETE /api/admin/users/:id`, `GET /api/admin/stats` |
| Misc | `GET /healthz`, `GET /download/extension.zip`, `GET /download/extension.json`, `GET /files/:jobId/:n` (cookie or signed link) |

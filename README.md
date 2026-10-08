# Browser LLM Broker

> 🇻🇳 Tiếng Việt: [README.vi.md](README.vi.md) · Hướng dẫn đầy đủ: [docs/vi/HUONG-DAN.md](docs/vi/HUONG-DAN.md)

Let **Claude (MCP), a REST API, a dashboard, or a schedule** talk to **ChatGPT through the Chrome browsers you already have logged in** — and get back formatted text, math and images. Results can be pushed to **Telegram** or any **webhook**.

A small self-hosted server (the *broker*) keeps a queue of jobs. A Chrome extension on each of your browsers picks jobs up, drives chatgpt.com in your own logged-in session, and returns the reply. One person can connect several Chrome profiles; a team can share one broker (every user only ever uses their own browsers).

> ⚠️ **Unofficial and unaffiliated.** This project is not made, endorsed or supported by OpenAI. It automates the chatgpt.com web UI, which may violate OpenAI's Terms of Use and can get an account limited or banned. Read [the disclaimer](#disclaimer-read-this) before using it.

```
 Claude (MCP) ─┐
 REST API ─────┤                                         ┌──────────────────────────┐
 Dashboard ────┼──▶  BROKER (Docker, SQLite)  ◀─ WSS ──▶ │ Chrome + extension       │──▶ chatgpt.com
 Schedules ────┘     jobs · devices · users              │ (one per browser/profile)│     (your login)
                          │                              └──────────────────────────┘
                          └──▶ Telegram / webhook (results)
```

## Features

- **MCP server over HTTP** — tools `generate_image`, `ask_chatgpt`, `continue_chat`, `get_job`, `list_devices`, `list_channels`.
- **REST API** with API keys (`/v1/jobs`, follow-ups, devices) — see [docs/API.md](docs/API.md).
- **Dashboard** — devices, jobs (live), schedules, notification channels, API keys, user admin, built-in docs (`/#docs`) and extension download.
- **Many users, many browsers** — each user pairs several Chrome profiles; jobs are routed to a free, online browser of the same user (least-recently-used), or to one you choose by name/tag.
- **Real ChatGPT output** — Markdown (headings, lists, tables, code), **math (KaTeX)**, generated **images**; continue the same conversation; use an existing conversation (keeps its memory).
- **Schedules** — daily or every N minutes, into a new or existing conversation, with "skip if unchanged / matches regex".
- **Channels** — Telegram bot, or **any HTTP API (webhook)** with custom headers, HMAC signature, body template, retries.
- **Safety** — usage-limit aware (fails over to another browser), SSRF-guarded webhooks, hashed passwords/keys/tokens, encrypted channel secrets, rate limits, data retention.

## Quick start (Docker, ~5 minutes)

Requirements: Docker + Docker Compose, Google Chrome, a ChatGPT account.

```bash
git clone https://github.com/mrsiu226/browser-llm-broker.git
cd browser-llm-broker/broker

cp .env.example .env
# edit .env: set SECRET_KEY (openssl rand -hex 32), ADMIN_EMAIL, ADMIN_PASSWORD

# Local test, no domain/HTTPS needed (dashboard on http://127.0.0.1:8088):
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build broker
```

1. Open **http://127.0.0.1:8088**, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. Open the in-app docs at **`/#docs`** → *Download extension (.zip)*, unzip it.
3. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the unzipped folder. Log in to **chatgpt.com** in that Chrome.
4. Dashboard → **Devices → Add device** → copy the pairing code. In the extension's options page enter the server URL (`http://127.0.0.1:8088`) and the code → **Connect** (badge turns **ON**).
5. Dashboard → **Jobs → New job**, type a prompt, pick *text*, and watch the answer arrive.

Use it from Claude Code:

```bash
# create an API key in the dashboard (API Keys), then:
claude mcp add --scope user --transport http llm-broker http://127.0.0.1:8088/mcp \
  --header "Authorization: Bearer ck_XXXXXXXX"
```

Then ask Claude: *"Use ask_chatgpt (mode text) to explain the Pythagorean theorem, with formulas."* Open a **new** Claude session after adding the MCP server.

For a real server with HTTPS and a domain, see **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | Dashboard, job modes, choosing a browser, schedules, channels, MCP |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production setup, HTTPS, env vars, backups, upgrades, rotating secrets |
| [docs/API.md](docs/API.md) | REST API, MCP tools, webhook payload and signature |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data model, extension ↔ broker protocol, design decisions |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms and fixes |
| [docs/vi/HUONG-DAN.md](docs/vi/HUONG-DAN.md) | Full guide in Vietnamese |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CHANGELOG.md](CHANGELOG.md) | Project meta |

## Repository layout

```
broker/      server (TypeScript/Node, SQLite) + dashboard (broker/public) + Dockerfile + tests
extension/   Chrome extension (Manifest V3, plain JavaScript, no build step)
docs/        documentation
```

## Status and limitations

- Pre-1.0. It works end to end, but **ChatGPT's web UI changes often**; extraction (`extension/content.js`) may break and need updates. Issues with the job's error text (it contains page diagnostics) are the fastest way to get a fix.
- One job at a time per browser; add more browsers for more throughput.
- A Chrome window must be open (it may stay in the background) and logged in to ChatGPT; the machine must not sleep.
- Image generation is subject to your ChatGPT plan's limits; the broker detects "usage limit reached" and moves the job to another browser.
- SQLite, single server process: fine for a team of tens of people, not designed for horizontal scaling.

## Disclaimer (read this)

- **No affiliation.** "ChatGPT" and "OpenAI" are trademarks of OpenAI. This is an independent community project.
- **Terms of Service.** Automating chatgpt.com through a browser may violate OpenAI's Terms of Use. You are solely responsible for how you use this software. Use only your **own** accounts, do not share or pool accounts, keep the request rate modest, and prefer OpenAI's official API for production or commercial workloads.
- **Privacy.** The broker relays and stores prompts and replies (until `RETENTION_DAYS`). Operators can read them. Tell your users.
- **No warranty.** Provided "as is" under the [MIT License](LICENSE). The authors are not liable for account actions, data loss, or any other damages.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Run `cd broker && npm ci && npm run build && npm test` before sending a PR.

## License

[MIT](LICENSE) © 2026 Mr. Siu. Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

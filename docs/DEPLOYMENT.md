# Deployment guide

The broker is one Node.js process with an embedded SQLite database. Docker Compose is the supported way to run it. A VPS with 1 vCPU / 1–2 GB RAM is enough for a team of ~20.

> Remember: the broker relays **everything** your users ask ChatGPT and stores it until `RETENTION_DAYS`. Protect the server accordingly, and read the disclaimer in the [README](../README.md#disclaimer-read-this).

## 1. Prerequisites

- A server with Docker and Docker Compose (Ubuntu 22.04/24.04 works well): `curl -fsSL https://get.docker.com | sh`
- A domain name whose **A record** points at the server (for HTTPS).
- Ports **80** and **443** open (and SSH). Do **not** expose port 8080 directly.
  ```bash
  sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
  ```

## 2. Get the code and configure

```bash
git clone https://github.com/mrsiu226/browser-llm-broker.git
cd browser-llm-broker/broker
cp .env.example .env
nano .env
```

Set at least:

| Variable | Meaning |
|---|---|
| `SECRET_KEY` | **Required.** Random secret (`openssl rand -hex 32`). Encrypts stored channel credentials and signs image links. Back it up — losing it makes stored channels unreadable. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin, created only when the database is empty. Leave the password empty to get a random one in the log. |
| `DOMAIN` | Your host name; the bundled Caddy obtains a TLS certificate for it automatically. |
| `COOKIE_SECURE=1`, `TRUST_PROXY=1` | Keep both at `1` behind HTTPS/Caddy. |

All variables:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Inside the container |
| `DATA_DIR` | `/data` (Docker) | SQLite file + images live here (the `broker-data` volume) |
| `RETENTION_DAYS` | `14` | Finished jobs and their images are deleted after this many days |
| `BASE_URL` | `https://$DOMAIN` | Used to build image links inside webhook payloads |
| `WEBHOOK_ALLOW_PRIVATE` | unset | `1` allows webhooks to private/internal addresses (default blocks them: SSRF guard) |
| `MCP_WAIT_MS` | `90000` | How long an MCP tool waits before returning a job id |
| `QUEUE_TIMEOUT_MS` | `600000` | Queued job fails after this long without a free device (schedules: 30 min) |
| `CATCH_UP_MINUTES` | `120` | A missed daily schedule still runs if within this window |
| `EXTENSION_DIR` | auto | Folder packaged as the downloadable extension zip |

## 3. Run

```bash
docker compose up -d --build
docker compose logs -f broker
```

Open `https://<DOMAIN>/`, sign in as the admin, create users (**Admin → Add user**), and send everyone to **`https://<DOMAIN>/#docs`** (public page with install steps and the extension download).

No domain yet (LAN or local test)? Use the local override, which publishes port 8088 and disables the secure-cookie flag:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build broker
```

> The Docker build context is the **repository root** (so the image can package `extension/`). Run compose from `broker/` as shown and keep the folder layout.

### Behind your own reverse proxy
Remove the `caddy` service, publish the broker on localhost (add `ports: ["127.0.0.1:8080:8080"]`), set `TRUST_PROXY=1`, and make sure **WebSocket upgrades on `/ws`** are forwarded. nginx example:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 3600s;
}
```

### Without Docker
Node 20+ and a C/C++ toolchain (for `better-sqlite3`, usually a prebuilt binary is used):

```bash
cd broker && npm ci && npm run build
PORT=8080 DATA_DIR=./data SECRET_KEY=$(openssl rand -hex 32) ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' node dist/index.js
```
Run it under systemd/pm2 and put HTTPS in front.

## 4. Operations

| Task | Command |
|---|---|
| Status / logs | `docker compose ps` · `docker compose logs -f broker` |
| Restart | `docker compose restart broker` |
| **Upgrade** | `git pull && docker compose up -d --build` (database migrates itself) |
| Stop | `docker compose down` (data stays in the volume) |
| Health check | `curl https://<DOMAIN>/healthz` → `{"ok":true}` |

After an upgrade that changes the extension, users download the new zip from `/#docs`, unzip over the old folder and reload the extension in `chrome://extensions`.

### Backup and restore
Data = SQLite database + images in the `broker-data` volume (find the exact name with `docker volume ls`, usually `broker_broker-data`).

```bash
docker compose stop broker
docker run --rm -v broker_broker-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/broker-data-$(date +%F).tgz -C /data .
docker compose start broker
```
Store your `.env` (especially `SECRET_KEY`) separately and securely. Restore by extracting the archive back into the volume while the broker is stopped.

### Rotating `SECRET_KEY` (e.g. after a leak)
Stored channel credentials are encrypted with the key, so changing it needs a re-encryption step:

```bash
docker compose stop broker
docker compose run --rm --no-deps \
  -e OLD_SECRET_KEY='<current key>' -e SECRET_KEY='<new key>' \
  broker node scripts/rotate-secret.mjs
# put the new SECRET_KEY in .env, then:
docker compose up -d
```
(Without Docker: `OLD_SECRET_KEY=… SECRET_KEY=… DATA_DIR=./data npm run rotate-secret` from `broker/`.) Signed image links made with the old key stop working; sessions and API keys are unaffected. Also change the admin password in the dashboard if it was exposed.

## 5. Security checklist
- HTTPS only (`COOKIE_SECURE=1`); no direct exposure of port 8080.
- Strong `SECRET_KEY` and admin password; admins limited to people you trust.
- `.env` is git-ignored — never commit it. If a secret was committed, rotate it (see [SECURITY.md](../SECURITY.md)).
- Set `RETENTION_DAYS` to your privacy policy; tell users the operator can read their prompts and replies.
- Keep the system, Docker and the broker updated.

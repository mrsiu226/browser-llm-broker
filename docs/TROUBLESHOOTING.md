# Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Extension badge **OFF** / device offline | Wrong server URL, server down, reverse proxy not forwarding WebSockets (`/ws`), or Chrome just restarted. Check `https://HOST/healthz` returns `{"ok":true}`; open the extension options → **Reconnect now**. |
| Badge **SET** | The browser is not paired yet → pair it (options page). |
| Badge **AUTH** | The device was deleted or the token replaced → **Re-pair** (see USAGE.md). |
| "invalid or expired pairing code" | Codes last 10 minutes and work once → create a new one. |
| Cannot log in to the dashboard | Check `ADMIN_EMAIL`/`ADMIN_PASSWORD` (only applied on the very first start, when the DB is empty). Too many attempts lock you out for 15 minutes. Over plain HTTP set `COOKIE_SECURE=0`. |
| Server exits immediately | `SECRET_KEY` or `ADMIN_PASSWORD` is empty/short/placeholder — see the message in `docker compose logs broker`. |
| Job stays *queued* | No online, free browser of yours (Chrome closed, paused, at usage limit, or wrong target). It fails after 10 minutes (30 for schedules). |
| "Prompt was not sent to ChatGPT" | The tab/window was hidden or not ready. Keep a Chrome window open (not minimized), or set run mode to *Foreground* in the extension options. |
| "ChatGPT usage limit reached" | Your ChatGPT plan's limit (usually image generation). The browser is marked *limited* until the reset time; the job moves to another of your browsers if you have one. |
| Reply is empty or has odd text | ChatGPT's page changed. Update the extension (`git pull`, reload it) and open an issue with the job's error text (it includes page diagnostics). |
| Images missing in `auto` mode | Pictures ChatGPT embeds from web search are ignored on purpose. If a generated image could not be read, `auto` returns the text instead; `image` mode reports an error. |
| Telegram message not received | Use **Test** on the channel; check token/chat id and that you messaged the bot first. See the schedule's *last status* for errors. |
| Webhook "resolves to a private/loopback address" | SSRF guard. Use a public URL or set `WEBHOOK_ALLOW_PRIVATE=1` (trusted users only). |
| Channels stopped working after changing `SECRET_KEY` | Stored credentials are encrypted with the old key. Use `npm run rotate-secret` (docs/DEPLOYMENT.md) instead of just editing `.env`; or recreate the channels. |
| Mac sleeps and jobs stop | Keep the machine awake (`caffeinate -s`, or Energy Saver settings). |
| `docker compose` fails to build | The build context is the repository root (it packages `extension/`); run it from `broker/` as documented and do not move the folders. |

Still stuck? Open an issue with: broker commit/version, extension version, how you deploy, `docker compose logs broker` (secrets removed), and the failing job's error text.

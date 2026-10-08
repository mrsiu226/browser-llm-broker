# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub's
["Report a vulnerability"](../../security/advisories/new) (Security tab → Advisories), or by contacting the maintainer directly.
Include what you found, how to reproduce it, and the impact. You will get an acknowledgement within a few days.

## Supported versions

Only the latest release on `main` receives fixes (the project is pre-1.0).

## Security model (what to expect)

- The broker authenticates users with a password (scrypt hashes) and a session cookie, API clients with hashed API keys, and browser extensions with per-device tokens (hashed). Channel credentials are encrypted at rest with `SECRET_KEY` (AES-256-GCM).
- The broker **can read the prompts and replies** of every job, because it relays them. Run it only for people who trust the operator, and set `RETENTION_DAYS` to match your policy.
- The extension executes a fixed set of commands on chatgpt.com in the user's own logged-in session; the server cannot run arbitrary code in the browser.
- Outbound webhooks block private/loopback/link-local addresses by default (SSRF guard); `WEBHOOK_ALLOW_PRIVATE=1` turns that off.
- Serve the broker over HTTPS only (see `docs/DEPLOYMENT.md`).

## If you accidentally committed secrets

Treat them as compromised: rotate `SECRET_KEY` (`npm run rotate-secret`, see docs/DEPLOYMENT.md), change admin passwords, revoke API keys and device tokens, and remove the secret from git history before publishing.

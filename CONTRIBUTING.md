# Contributing

Thanks for helping! Bug reports, docs fixes, and pull requests are all welcome.

## Development setup

```bash
cd broker
npm ci
npm run build          # TypeScript → dist/
npm test               # integration tests (spawns the broker + a fake Chrome extension)

# run locally
PORT=8090 DATA_DIR=./data SECRET_KEY=$(openssl rand -hex 32) \
  ADMIN_EMAIL=dev@example.com ADMIN_PASSWORD=devpassword1 node dist/index.js
```
The dashboard is static (`broker/public`, no build); reload the page after edits. For the extension, load `extension/` unpacked and reload it in `chrome://extensions` after changes (the version in `manifest.json` is shown in the dashboard).

Node 20+ is required. Docker: `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build broker` from `broker/`.

## Guidelines

- Keep the extension dependency-free (plain JS) and the dashboard build-free; keep broker dependencies minimal.
- **Never commit secrets** — `.env`, tokens, real conversation content, screenshots with personal data. CI rejects tracked `.env`, `node_modules/` and `dist/`.
- Add or update an integration test in `broker/test/` for broker behavior changes (see `test/api-core.test.mjs` for the helpers; tests print `PASS`/`FAIL` lines that `test/run.mjs` counts).
- Extension/ChatGPT-UI changes cannot be fully tested automatically: describe what you tried in the PR, and include the job error text/diagnostics if you fixed a selector. Fixtures of the reply HTML are very welcome.
- Update the docs and `CHANGELOG.md` (under *Unreleased*) when behavior changes. English docs are authoritative; Vietnamese docs in `docs/vi/` are kept in sync on a best-effort basis.
- Small, focused PRs with a clear description are easiest to review. Use conventional-style commit messages (`feat:`, `fix:`, `docs:`…).

## Reporting issues

Use the issue templates. For security problems follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing you agree that your contributions are licensed under the project's [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).

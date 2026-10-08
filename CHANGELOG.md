# Changelog

All notable changes to this project. The project is pre-1.0: interfaces may still change.

## [Unreleased]
### Added
- Open-source preparation: MIT license, English documentation (`README.md`, `docs/`), contribution and security guides, CI, integration test suite (`npm test`), `rotate-secret` tool.
### Changed
- Renamed the project to **Browser LLM Broker** (neutral name; it still drives chatgpt.com). Extension zip is now `browser-llm-broker-extension-v*.zip`.
- The extension no longer falls back to a local unauthenticated server when not paired (badge shows `SET`).
- The server refuses to start with a placeholder `SECRET_KEY` or `ADMIN_PASSWORD`.
- Removed the legacy single-user server and install scripts from the repository.

## 0.4.x – 0.5.0 (extension)
- Background-tab execution with automatic foreground fallback, follow-up messages in the same conversation, device re-pairing, extension icons and status page, notification channels (Telegram, webhook) usable from MCP.

## Earlier
- Multi-user broker with dashboard, devices, schedules, API keys, MCP over HTTP; Markdown/KaTeX rendering of replies; image and text extraction from chatgpt.com.

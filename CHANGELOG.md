# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.6.2] - 2026-11-12

### Fixed

- Input typed while a budget or a peak window is stopping the session used to be discarded: the turn cancel cleared the inbox and every rejected step dropped the messages it had already claimed. The cancel now keeps the inbox (`keepInbox: true`), rejected steps put their claimed messages back at the front of the inbox (goal-round messages and per-step runtime context are skipped), so the composer keeps showing them as queued.
- When the limit lifts — reset, a larger budget, `/budget off`, or the start of the valley — the plugin now wakes the idle agent (`wakeDriver`) so the queued input runs without being re-sent; a text typed during peak no longer waits for a manual 继续.
## [1.6.1] - 2026-11-11

### Fixed

- A peak-time pause interrupted a plain running turn without an active goal (or with a goal that was already complete), and nothing continued it in the valley: the session needed a manual 继续. The plugin now remembers the interruption and, at the first valley tick where the agent is idle, re-queues one user-role follow-up message (`source.kind = 'session-budget'`) so the interrupted work continues on its own.
- The pending auto-continue is dropped when a human message arrives, when a budget keeps the session stopped, and after 12 hours; it is persisted (`resume` in `budgets.json`, store version 5) so an interrupted session that is reopened during the valley also continues.
## [1.6.0] - 2026-11-10

### Added

- Automatic sync of the inputs the schedule needs, from the Settings page:
  - "Fetch DeepSeek pricing" reads the official price table (`/zh-cn/...` for a `CNY` budget, the English page for `USD`), picks the `pricingModel` column and the `pricingPeriod` (peak or off-peak), and fills the four per-million prices. Cache writes are charged at the cache-miss input price.
  - "Sync holiday calendar" reads the public holiday-cn calendar (timor.tech as fallback) and treats the legal holidays as off-peak days without overwriting hand-written `peakSkipDates` entries.
  - New fields `autoSync`, `syncIntervalHours`, `pricingModel`, `pricingPeriod`, `holidayAutoSkip`. A sync runs on start and then every `syncIntervalHours` (minimum 1 hour) while `autoSync` is on; a failed fetch keeps the last good result and reports the error on the page.
- `GET /session-budget/sync` returns the last sync state, `POST /session-budget/sync` takes `{pricing:true}`, `{holidays:true}` or `{all:true}`.

### Changed

- The store payload is now `version: 4` (`sessions`, `peak`, `paused`, `config`, `sync`); files written by earlier versions load unchanged.
- The plugin now contacts the network, but only for the two documented sources and only when a sync runs.

## [1.5.3] - 2026-11-10

### Fixed

- The HTTP routes (and the `/budget` command) now mount through `ctx.inject(['webServer'], …)` / `ctx.inject(['commands'], …)` instead of sampling `ctx.get(...)` once at apply time. When the web server happened to mount after this plugin, no route under `/session-budget` was registered and every request returned 404 — the settings page could not load or save, so peak windows were uneditable. `ctx.inject` waits for the service, so mount order no longer matters.

## [1.5.2] - 2026-11-10

### Fixed

- Composer strip now follows the shipped dock contract exactly (the same geometry the queue dock uses): width subtracts `var(--dsh-composer-side-clearance)` twice and its own `var(--dsh-composer-dock-inset)`, `max-width` caps at `var(--dsh-composer-card-max-width)` minus that inset, and `margin: … auto` centers it — so the strip lines up with the input card instead of overflowing it. This supersedes the 1.5.1 attempt, which reproduced the input card's own padding but not the dock inset.

## [1.5.1] - 2026-11-10

### Fixed

- Composer strip no longer grows wider than the input card: `conversation.input.dock` renders into a bare column flex, so the strip now reproduces the composer geometry itself — a wrapper padded by `var(--dsh-composer-side-clearance)` around a card capped at `var(--dsh-composer-card-max-width)` — instead of stretching to the full stack width.

## [1.5.0] - 2026-11-10

First public release.

### Added

- Per-session **token / money / wall-clock** budgets with hard enforcement: `agent/pre-step` rejection, goal `block`/`pause`, and `agent.cancel({kind:'hook'})` on the running turn.
- Usage back-fill from the session log when a budget is set mid-session.
- DeepSeek **peak / off-peak** schedule enabled by default (09:00–12:00, 14:00–18:00 Asia/Shanghai, Monday–Friday): pause at peak, cancel the running turn, resume the goal when the valley starts.
- `peakWeekdays` weekday filter and `peakSkipDates` holiday list (`YYYY-MM-DD`).
- Per-session peak policy: `/budget peak on|off|auto`.
- Settings page registered in three seats (settings sidebar, bundle page, row config) editing the plugin defaults through the plugin's own store, with field descriptions instead of in-field samples.
- Composer strip: one line, framed card, chips + hairline meters, peak tag, inline editor.
- `/budget` command: `status`, `set`, `peak`, `reset`, `off`.
- Same-origin HTTP surface under `/session-budget`: status, per-session update, config read/write.
- Offline test suites for host and browser halves (no DSH, no dependencies).
- Bilingual README, CONTRIBUTING, MIT license, GitHub Actions CI.

### Notes

- Money accounting needs the four per-million prices; with every price at `0` money never accumulates and the UI warns.
- The plugin does not fetch holiday calendars; list Chinese public holidays in `peakSkipDates`.
- State is local only: `~/.dsh/session-budget/budgets.json` (schema version 3).

## [1.4.0]

- Settings page with config read/write route; config override layer in the store (`version: 3`).

## [1.2.0]

- Framed compact strip; peak window pause / valley auto-resume.

## [1.1.0]

- Single-line composer strip with inline editor.

## [1.0.0]

- Initial budgets, enforcement, `/budget` command, HTTP status route.

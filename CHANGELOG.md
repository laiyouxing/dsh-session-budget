# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

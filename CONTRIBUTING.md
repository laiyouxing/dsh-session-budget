# Contributing

Thanks for helping. This is a small plugin — most changes are a few lines in `index.js` (host) or `client.js` (browser artifact), plus a test.

## Ground rules

- **No build step, no runtime dependencies.** The host half runs straight from `index.js`; the browser half is a plain `window.__ModuleLoader__` artifact that only uses `react` from the host's module table. Do not add a bundler, TypeScript, or a dependency the host does not already provide.
- **The browser half must stay dependency-free.** Never import Harness Client packages (`@deepseek-ai/dsh-client-ui-*`) or primitives; copy host markup and style with `--dsw-alias-*` theme tokens. This keeps the plugin working across host versions.
- **Do not write new session event types.** Derive usage from existing `assistant/message` events; anything the plugin needs to remember goes into its own JSON store.
- **Keep the strip one line.** The composer area is tight: no wrapping, no fixed widths, truncate instead of pushing the composer.

## Development

```sh
git clone https://github.com/laiyouxing/dsh-session-budget
cd dsh-session-budget
node test/run.mjs
```

The two suites run against the real `index.js` / `client.js` with fake cordis contexts and a stubbed `@deepseek-ai/schemastery`, so nothing needs to be installed:

- `test/host.test.mjs` — budgets, usage seeding, enforcement (pre-step reject, goal block/pause, hook cancel), reset/resume, peak windows, weekday and holiday filters, config route, store payload.
- `test/client.test.mjs` — slot registrations, locale dictionaries, strip layout contract, settings page rendering.

If you add behaviour, add an assertion to the matching suite. Both suites must pass before a PR is merged, and CI runs them on Node 22.

## Trying your change inside DSH

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-session-budget
```

Host-side changes need a remove + re-add cycle (the host does not hot-reload plugin code); browser-side changes re-register themselves after a page refresh.

## Pull requests

- One topic per PR. Keep diffs focused and explain the user-visible effect.
- Update `README.md` and `CHANGELOG.md` when behaviour or defaults change.
- Describe what you tested, on which DSH version.
- Bump the version only in a release PR (see below).

## Releases

1. Update `CHANGELOG.md` and `package.json` `version`.
2. `node test/run.mjs` green.
3. Commit, tag `vX.Y.Z`, push, create a GitHub release with the changelog section.

## Reporting bugs

Please include: DSH version, plugin version, the limits you set (tokens / money / minutes), what the strip and `/budget status` showed, and whether the session was in goal mode. A redacted copy of `~/.dsh/session-budget/budgets.json` (session ids removed) is often enough to reproduce.

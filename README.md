# dsh-session-budget

English | [中文](#中文说明)

[![CI](https://github.com/laiyouxing/dsh-session-budget/actions/workflows/ci.yml/badge.svg)](https://github.com/laiyouxing/dsh-session-budget/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/laiyouxing/dsh-session-budget)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-informational)](package.json)

Per-session **token / cost / wall-clock budgets** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Reaching any limit stops the model session instead of silently burning a goal-mode run, and an optional DeepSeek **peak / off-peak schedule** pauses work at peak hours and resumes it in the valley.

Built for goal mode: DSH's goal round driver keeps starting new rounds until the goal completes. Its own docs say the round cap is "not a resource budget — token, currency, time, and provider quota policies remain independent". This plugin is that missing policy layer.

## Features

- **Three independent limits per session** — tokens, money, and wall-clock minutes. Set any combination; a field left at `0` is simply not limited.
- **Hard stop, not a warning** — a breach cancels the running turn (`agent.cancel({kind:'hook'})`), blocks or pauses the session's goal so goal mode cannot auto-continue, and rejects every further `agent/pre-step` until you reset or raise the limit.
- **DeepSeek peak / off-peak aware** — ships DeepSeek's official schedule as the default (09:00–12:00 and 14:00–18:00, Monday–Friday, Asia/Shanghai; weekends and holidays are off-peak). At peak the session is paused and the running turn cancelled; when the valley starts the goal is resumed automatically.
- **Usage is back-filled** — setting a budget mid-session folds the usage already recorded in that session's log, so the limit applies to the whole session rather than only to what happens after you set it.
- **Three surfaces** — a compact one-line strip above the composer, a `/budget` command, and a full settings page (Settings → 会话用量预算, also shown on the plugin's own page under Plugins).
- **Local and private** — no network calls, no telemetry. State lives in one JSON file under `~/.dsh`.

## Requirements

- DSH with the web UI (`dsh web` or DSH Desktop).
- Node.js 22+ (the tests run on plain Node, no build step, no dependencies to install).
- `@deepseek-ai/schemastery` is provided by the host as a peer dependency — nothing extra to install.

## Install

Through the in-app plugin manager, add this spec:

```sh
dsh plugin --profile <profile> add github:laiyouxing/dsh-session-budget
```

- **DSH Desktop:** use the app's own plugin manager (Settings → Plugins), not a terminal against the `web` profile — Desktop manages its own profile. Paste `github:laiyouxing/dsh-session-budget` as the source.
- **Plain `dsh web`:** run the command above, then restart `dsh web`.
- **Local checkout:** `dsh plugin --profile <profile> add /absolute/path/to/dsh-session-budget`.

After installing, refresh the page. The strip appears above the composer, and 设置 → 会话用量预算 appears in the settings sidebar.

## Use

### Composer strip

One line above the input box:

```
[dot] 预算 3.2M / 50M · ¥1.40 / ¥5 · 42m / 3h   [峰值暂停 · 12 分钟后恢复]   [设置上限]
```

- Each configured dimension shows `used / limit` and a hairline meter.
- A stop tag appears once a limit is reached; a peak tag appears while a peak window is pausing the session.
- `设置上限` opens an inline editor for the three limits, with reset and clear.
- Sample values live in the hint line above the fields, not as input placeholders.

### `/budget` command

| Command | Effect |
| --- | --- |
| `/budget` or `/budget status` | Show limits, usage, remaining budget, and the peak schedule |
| `/budget set tokens=500k money=5 time=120` | Set any subset; accepts `200k` / `1.5m` suffixes for tokens, an amount for money, minutes for time |
| `/budget peak on` / `off` / `auto` | Per-session peak policy: follow the schedule, never pause at peak, or inherit the plugin default |
| `/budget reset` | Keep the limits, restart usage counting from zero |
| `/budget off` | Remove the session's budget and resume a goal this plugin stopped |

### Settings page

The same page is registered in three seats: the settings sidebar (会话用量预算), the plugin's package page, and the row config for its patch row. It edits the plugin defaults — limits, prices, currency, breach action, peak windows/zone/weekdays/holiday skips, tick interval, data file — and shows today's peak state. Writes go to the plugin's own store, so saving does not restart the host.

## Limits and accounting

| Dimension | What counts | Notes |
| --- | --- | --- |
| `tokens` | `uncachedInput + cacheRead + cacheWrite + output` of every `assistant/message` in the session | Same turn/step samples replace each other, so a retried step is not double counted |
| `money` | Those four buckets × the four per-million prices in the settings | Set all four prices, or money never accumulates; the strip and `/budget status` warn when a money limit exists but prices are all `0` |
| `time` | Wall-clock minutes since the budget was set | Independent of token usage; checked on the plugin's interval timer |

A budget record starts at the moment it is set. `reset` restarts the clock and the counters; `off` deletes the record.

## How enforcement works

1. `agent/pre-step` — before each model step, an exhausted budget or an active peak window returns `{ kind: 'reject' }`. The jump to the model never happens, and the turn ends as `blocked`.
2. Goal stop — the session's goal is blocked (`blockedReason.code = budget-exhausted`) or paused (`onExceed: pause`), and `peak-hours` for peak pauses. DSH's round driver only continues an active, armed goal, so goal mode stops auto-continuing.
3. Turn cancel — a running turn is cancelled with `agent.cancel({ kind: 'hook', reason })`, which the chat UI renders as an aborted turn.
4. Resume — raising the limit, resetting, or the start of the valley clears the plugin's stop and resumes the goal it blocked itself; goals blocked for another reason (`round-limit`, user edits) are never resumed by this plugin.

## Peak / off-peak schedule

Defaults follow [DeepSeek's published pricing hours](https://api-docs.deepseek.com/quick_start/pricing): peak is **01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding Chinese public holidays**; everything else is off-peak and priced at half the peak rate. In Asia/Shanghai that is 09:00–12:00 and 14:00–18:00, Monday–Friday.

| Setting | Default | Meaning |
| --- | --- | --- |
| `peakWindows` | `09:00-12:00,14:00-18:00` | `HH:MM-HH:MM`, comma separated; a window that crosses midnight is supported |
| `peakTimezone` | `Asia/Shanghai` | IANA zone used to evaluate the windows |
| `peakWeekdays` | `mon-fri` | `mon-fri`, `mon,wed,fri`, `周一-周五`, `daily` … empty means every day |
| `peakSkipDates` | *(empty)* | `YYYY-MM-DD` list treated as off-peak all day; the synced holiday calendar joins it automatically |
| `peakAutoResume` | `true` | Plugin default for new sessions; `/budget peak off` opts one session out |

During a peak window the session is paused and its running turn cancelled. When the valley begins the goal is resumed, unless it is complete, already active, or blocked for a reason this plugin does not own.

If the interrupted work had no removable goal (no goal, or a goal that is already complete), the plugin still picks the work back up: at the first valley tick where the agent is idle it re-queues one user-role follow-up message (`source.kind = 'session-budget'`) asking the model to continue the interrupted work, so no manual 继续 is needed. A pending auto-continue is dropped when a human message arrives, when a budget keeps the session stopped, or after 12 hours; it survives an app restart because it is stored in `budgets.json`.

## Automatic sync of prices and holidays

The settings page can fetch both inputs instead of asking you to type them:

- **DeepSeek pricing** — reads the official price table (`/zh-cn/…` for a `CNY` budget, the English page for `USD`), picks the `pricingModel` column (`deepseek-flash` or `deepseek-v4-pro`) and the `pricingPeriod` (`peak` is conservative, `offpeak` matches real off-peak spending), then writes the four per-million prices into the settings layer. Cache writes are charged at the cache-miss input price.
- **Holiday calendar** — reads the public [holiday-cn](https://github.com/NateScarlet/holiday-cn) calendar (falling back to `timor.tech`), and adds the legal holidays to the days treated as off-peak. Hand-written `peakSkipDates` entries are kept.

Both run when the plugin starts and then every `syncIntervalHours` while `autoSync` is on; a failed fetch keeps the previous values and shows the error on the page. The two buttons fetch immediately.

## Settings reference

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch for enforcement |
| `defaultTokens` | `0` | New-session token limit (`0` = off) |
| `defaultMoney` | `0` | New-session money limit (`0` = off) |
| `defaultMinutes` | `0` | New-session wall-clock limit in minutes (`0` = off) |
| `priceInputPerMillion` | `0` | Price per 1M uncached input tokens (filled by the pricing sync) |
| `priceCacheReadPerMillion` | `0` | Price per 1M cache-read tokens |
| `priceCacheWritePerMillion` | `0` | Price per 1M cache-write tokens |
| `priceOutputPerMillion` | `0` | Price per 1M output tokens |
| `currency` | `CNY` | Label used in the strip, status text, and alerts; also selects the pricing page |
| `onExceed` | `block` | `block` blocks the goal, `pause` pauses it (both disarm auto-continuation) |
| `autoSync` | `true` | Fetch prices and holidays on start and on the interval below |
| `syncIntervalHours` | `24` | Minimum 1; manual buttons ignore it |
| `pricingModel` | `deepseek-flash` | Which price column the pricing sync adopts |
| `pricingPeriod` | `peak` | `peak` over-estimates cost on purpose; `offpeak` matches off-peak spending |
| `holidayAutoSkip` | `true` | Treat the synced legal holidays as off-peak days |
| `checkIntervalMs` | `5000` | Tick for time limits and the peak sweep (minimum 1000) |
| `dataFile` | *(empty)* | Override the store path; empty means `~/.dsh/session-budget/budgets.json` |

## Data and privacy

- Store: `~/.dsh/session-budget/budgets.json` (`{ version: 5, sessions, peak, paused, resume, config, sync }`), written atomically (temp file + rename) with a short debounce.
- The plugin only contacts the network for the two documented sources (the DeepSeek pricing docs page and a public holiday calendar), and only when a sync runs. The peak calculation itself is local time arithmetic.
- HTTP surface, same-origin only: `GET /session-budget/status?session=…`, `POST /session-budget/update`, `GET /session-budget/config`, `POST /session-budget/config`, `GET /session-budget/sync`, `POST /session-budget/sync` (`{pricing:true}` / `{holidays:true}` / `{all:true}`).

## Development

No build step, no runtime dependencies:

```sh
node test/run.mjs        # both suites
node test/host.test.mjs  # host: budgets, seeding, enforcement, peak windows, config route
node test/client.test.mjs # browser artifact: registrations, strip layout, settings page
node --check index.js
node --check client.js
```

Layout:

```
index.js        Host half: Config, store, usage fold, enforcement, peak sweep, routes, /budget
client.js       Browser artifact: composer strip + settings page (plain browser script, no bundler)
cordis.patch.yml Patch row that mounts the plugin
locale/         Package display metadata (en, zh)
test/           Offline suites with fake cordis contexts — no DSH needed
```

The tests run against the real files with a stubbed `@deepseek-ai/schemastery`, so they work on a clean clone.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports are most useful with the DSH version, the plugin version, the exact limit you set, and what the strip showed.

## License

[MIT](LICENSE) © 2026 laiyouxing

---

## 中文说明

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）做**按会话的 token / 金额 / 时长预算**插件。任一上限到达就真正停止与模型的会话，而不是让目标模式继续空转；另外可以按 DeepSeek 的峰谷时段在峰时暂停、谷时自动继续。

### 为什么需要它

目标模式下 DSH 的轮次驱动会一直开新一轮，直到目标完成。它自己的文档写明轮次上限「不是资源预算——token、货币、时间与供应商配额策略相互独立」。这个插件补的就是这层策略。

### 功能

- **三种独立上限**：token、金额、时长（分钟），可任意组合，填 `0` 表示该项不限制。
- **硬停止**：到达上限会取消正在跑的这一步（`agent.cancel({kind:'hook'})`）、把会话目标 block 或 pause（目标模式因此不会再自动开新一轮），并在之后每一步前直接 reject，直到你重置或提高上限。
- **峰谷感知**：默认就是 DeepSeek 官方时段（北京时间周一至周五 09:00–12:00、14:00–18:00 为峰时，周末与节假日全天谷时）。峰时暂停并取消当前步，进入谷时自动恢复；即使没有目标（或目标已完成）而只是普通一轮被打断，也会在谷时自动补一条「继续」把活接着干，不用你手动再发。
- **补算历史用量**：会话中途设置预算，会把该会话日志里已有的用量折算进来，上限覆盖整场会话而不是只算设置之后。
- **三个入口**：输入框上方的单行预算条、`/budget` 命令、完整设置页（设置 → 会话用量预算，插件页里也有）。
- **自动同步**：设置页可一键查询 DeepSeek 官方定价（按币种选中文/英文页，可选 `deepseek-flash` / `deepseek-v4-pro` 与峰时/谷时价格），并同步公开的法定节假日日历；默认开启，每 24 小时自动刷新一次，失败时保留上次结果。

### 安装

```sh
dsh plugin --profile <profile> add github:laiyouxing/dsh-session-budget
```

DSH 桌面版请在应用内的插件管理里添加 `github:laiyouxing/dsh-session-budget`（桌面版有自己的 profile，不要用终端装到 `web` 上）。装完刷新页面。

### 配置项

见上方英文 Settings reference 表格。金额维度需要先把四个每百万 token 单价填上，否则金额不会累计（预算条和 `/budget status` 会提示）。

### 峰谷

默认已经按 DeepSeek 官方峰谷设置好：`peakWindows = 09:00-12:00,14:00-18:00`、`peakTimezone = Asia/Shanghai`、`peakWeekdays = mon-fri`、`peakSkipDates` 留空。设置页「自动同步」里的「同步节假日日历」会把公开法定节假日自动加进来（`holidayAutoSkip` 打开时生效，手填的 `peakSkipDates` 仍然保留）；也可以手动写 `peakSkipDates`（`YYYY-MM-DD`，逗号分隔）。

### 命令

`/budget`、`/budget set tokens=500k money=5 time=120`、`/budget peak on|off|auto`、`/budget reset`、`/budget off`。

### 数据

只写本地 `~/.dsh/session-budget/budgets.json`（`{ version: 5, sessions, peak, paused, resume, config, sync }`），无遥测。联网只发生在你点了「查询定价 / 同步节假日」或自动同步到点时，目标是 DeepSeek 官方文档页与公开节假日日历；抓取结果缓存在同一个文件里。

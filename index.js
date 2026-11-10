/**
 * session-budget — per-session token, cost, and wall-clock budgets.
 *
 * The plugin folds the usage the provider already reports on durable
 * `assistant/message` events, compares it with the limits stored for that
 * session, and when a limit is reached it stops the model session: the active
 * goal is blocked (or paused) so goal mode stops auto-continuing, a running
 * turn is cancelled, and every further step is rejected from `agent/pre-step`
 * until the budget is raised or reset.
 *
 * Per-session limits live in a small JSON store under the DSH home directory;
 * the current window is also exposed to the Web UI through a same-origin JSON
 * route so the composer strip can show and edit it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'session-budget'

/** Services are all optional: the plugin degrades instead of failing to mount. */
export const inject = []

const ZERO_BUCKETS = () => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const ROUTE_PREFIX = '/session-budget'

/**
 * Every tunable in one table.
 *
 * The settings page, the JSON route and the schema are all generated from this
 * list, so a field can never exist in one of them and be missing from another.
 * `editable: false` means "takes effect after the plugin restarts", which the
 * page shows as read-only instead of silently ignoring a write.
 */
const CONFIG_FIELDS = [
  {
    key: 'enabled',
    group: 'general',
    kind: 'boolean',
    value: true,
    label: '总开关',
    description: '关闭后既不统计用量，也不执行峰时暂停。',
  },
  {
    key: 'onExceed',
    group: 'general',
    kind: 'string',
    value: 'block',
    label: '达到上限后',
    description: 'block：阻断目标并停止本次会话（goal 会进入 blocked）；pause：只暂停目标，可手动恢复。',
    options: [
      { value: 'block', label: '阻断并停止（block）' },
      { value: 'pause', label: '暂停目标（pause）' },
    ],
  },
  {
    key: 'defaultTokens',
    group: 'budget',
    kind: 'number',
    value: 0,
    label: '默认 token 上限',
    description: '新会话默认的 token 上限；0 表示不限制，单个会话可以用 /budget set 覆盖。',
  },
  {
    key: 'defaultMoney',
    group: 'budget',
    kind: 'number',
    value: 0,
    label: '默认金额上限',
    description: '按下方每百万 token 单价折算；0 表示不限制。',
  },
  {
    key: 'defaultMinutes',
    group: 'budget',
    kind: 'number',
    value: 0,
    label: '默认时长上限',
    description: '从会话开始计时，单位分钟；0 表示不限制。',
  },
  {
    key: 'priceInputPerMillion',
    group: 'pricing',
    kind: 'number',
    value: 0,
    label: '输入单价（未命中缓存）',
    description: '每百万未命中缓存的输入 token 单价；四项单价全为 0 时金额不会累计。',
  },
  {
    key: 'priceCacheReadPerMillion',
    group: 'pricing',
    kind: 'number',
    value: 0,
    label: '输入单价（命中缓存）',
    description: '每百万缓存命中的输入 token 单价。',
  },
  {
    key: 'priceCacheWritePerMillion',
    group: 'pricing',
    kind: 'number',
    value: 0,
    label: '缓存写入单价',
    description: '每百万缓存写入 token 的单价。',
  },
  {
    key: 'priceOutputPerMillion',
    group: 'pricing',
    kind: 'number',
    value: 0,
    label: '输出单价',
    description: '每百万输出 token 的单价。',
  },
  {
    key: 'currency',
    group: 'pricing',
    kind: 'string',
    value: 'CNY',
    label: '币种',
    description: '金额显示币种，例如 CNY 或 USD。',
  },
  {
    key: 'peakWindows',
    group: 'peak',
    kind: 'string',
    value: '09:00-12:00,14:00-18:00',
    label: '峰时时段',
    description: '格式 HH:MM-HH:MM，逗号分隔多个时段；默认跟随 DeepSeek 峰时 09:00-12:00、14:00-18:00（北京时间）。',
  },
  {
    key: 'peakTimezone',
    group: 'peak',
    kind: 'string',
    value: 'Asia/Shanghai',
    label: '峰时时区',
    description: '峰时时段使用的时区，例如 Asia/Shanghai；留空表示使用本机时区。',
  },
  {
    key: 'peakWeekdays',
    group: 'peak',
    kind: 'string',
    value: 'mon-fri',
    label: '峰时生效的星期',
    description: '例如 mon-fri、mon,wed,fri 或 周一-周五；留空表示每天，周末默认按谷时处理。',
  },
  {
    key: 'peakSkipDates',
    group: 'peak',
    kind: 'string',
    value: '',
    label: '跳过的日期（节假日）',
    description: '逗号分隔 YYYY-MM-DD；这些日期全天按谷时处理，例如 2026-01-01,2026-02-17。',
  },
  {
    key: 'peakAutoResume',
    group: 'peak',
    kind: 'boolean',
    value: true,
    label: '默认峰时暂停、谷时自动继续',
    description: '新会话的默认值；单个会话可以用 /budget peak off 覆盖。',
  },
  {
    key: 'autoSync',
    group: 'sync',
    kind: 'boolean',
    value: true,
    label: '自动同步定价与节假日',
    description: '开启后按下面的间隔自动查询 DeepSeek 官方定价和公开节假日日历；失败时保留上一次成功的结果。',
  },
  {
    key: 'syncIntervalHours',
    group: 'sync',
    kind: 'number',
    value: 24,
    label: '同步间隔（小时）',
    description: '自动同步的间隔，最小 1 小时；也可以在下方按钮手动立即查询。',
  },
  {
    key: 'pricingModel',
    group: 'sync',
    kind: 'string',
    value: 'deepseek-flash',
    label: '定价模型',
    description: '从官方定价页取哪个模型的价格列；页面上有 deepseek-flash 与 deepseek-v4-pro 两列。',
    options: [
      { value: 'deepseek-flash', label: 'deepseek-flash' },
      { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
    ],
  },
  {
    key: 'pricingPeriod',
    group: 'sync',
    kind: 'string',
    value: 'peak',
    label: '按峰时还是谷时价格折算',
    description: '峰时价格是谷时的两倍；选 peak 更保守（预算不会被低估），选 offpeak 更接近实际花费。',
    options: [
      { value: 'peak', label: '峰时价格（保守）' },
      { value: 'offpeak', label: '谷时价格（实际）' },
    ],
  },
  {
    key: 'holidayAutoSkip',
    group: 'sync',
    kind: 'boolean',
    value: true,
    label: '自动把法定节假日按谷时处理',
    description: '同步到的节假日日期会和“跳过的日期”一起生效（手填的日期仍然保留），法定节假日全天按谷时处理。',
  },
  {
    key: 'checkIntervalMs',
    group: 'advanced',
    kind: 'number',
    value: 5000,
    label: '检查间隔',
    editable: false,
    description: '定时检查间隔，单位毫秒，用于时长上限与峰谷切换；修改后重启插件生效。',
  },
  {
    key: 'dataFile',
    group: 'advanced',
    kind: 'string',
    value: '',
    label: '数据文件',
    editable: false,
    description: '预算与覆盖配置的数据文件；留空使用 ~/.dsh/session-budget/budgets.json，修改后重启插件生效。',
  },
]

/** Field lookup keyed by the config key. */
const CONFIG_INDEX = new Map(CONFIG_FIELDS.map((field) => [field.key, field]))

/** Whether the settings page may change this field while the plugin runs. */
const isEditable = (field) => field.editable !== false

/** Runtime schema for the plugin row, generated from the field table. */
export const Config = z.object(Object.fromEntries(CONFIG_FIELDS.map((field) => {
  const schema = field.kind === 'boolean' ? z.boolean() : field.kind === 'number' ? z.number() : z.string()
  return [field.key, schema.description(field.description).default(field.value)]
})))

/** Coerce one submitted value to the field's type, or `undefined` when invalid. */
function coerceConfigValue(field, raw) {
  if (field.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (raw === 'true' || raw === 1) return true
    if (raw === 'false' || raw === 0) return false
    return undefined
  }
  if (field.kind === 'number') {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return undefined
    return field.key === 'checkIntervalMs' ? Math.max(1000, Math.floor(value)) : value
  }
  if (typeof raw !== 'string') return undefined
  return raw.trim()
}

/** Layer the settings-page overrides on top of the row configuration. */
function mergeConfig(base, overrides) {
  const merged = { ...base }
  for (const [key, raw] of Object.entries(overrides ?? {})) {
    const field = CONFIG_INDEX.get(key)
    if (field === undefined || !isEditable(field)) continue
    const value = coerceConfigValue(field, raw)
    if (value !== undefined) merged[key] = value
  }
  return merged
}

const toInt = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

const round4 = (value) => Math.round(value * 10000) / 10000

/** Add one usage sample, replacing an earlier sample of the same step. */
function addReplacing(totals, previous, next) {
  return {
    uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
    outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
  }
}

/** Fold one usage sample into an accumulator in place, replacing a same-step sample. */
function addInto(totals, previous, next) {
  totals.uncachedInputTokens += next.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0)
  totals.outputTokens += next.outputTokens - (previous?.outputTokens ?? 0)
  totals.cacheReadTokens += next.cacheReadTokens - (previous?.cacheReadTokens ?? 0)
  totals.cacheWriteTokens += next.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0)
}

function bucketsOf(usage) {
  return {
    uncachedInputTokens: toInt(usage.inputTokens),
    outputTokens: toInt(usage.outputTokens),
    cacheReadTokens: toInt(usage.cacheReadTokens),
    cacheWriteTokens: toInt(usage.cacheWriteTokens),
  }
}

/** Provider usage reported by one settled assistant message, if any. */
function usageOf(event) {
  const data = event?.data
  if (data === undefined || data === null) return undefined
  if (data.usage !== undefined && data.usage !== null) return data.usage
  const stream = data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]
    const usage = chunk?.usage ?? chunk?.data?.usage ?? chunk?.payload?.usage
    if (usage !== undefined && usage !== null && typeof usage === 'object') return usage
  }
  return undefined
}

/** Durable per-session limit store. Reads are synchronous; writes are serialized. */
class BudgetStore {
  constructor(file, log) {
    this.file = file
    this.log = log
    this.records = new Map()
    /** Per-session peak follow-up override: true follows the schedule, false ignores it. */
    this.peak = new Map()
    /** Sessions whose goal this plugin paused for a peak window. */
    this.paused = new Map()
    /** Settings-page overrides: field key -> validated value. */
    this.config = {}
    /** Last successful automatic syncs: `{ pricing, holidays }`. */
    this.sync = {}
    this.chain = Promise.resolve()
    this.pending = undefined
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const sessions = parsed?.sessions
      if (sessions !== undefined && sessions !== null && typeof sessions === 'object') {
        for (const [sessionId, record] of Object.entries(sessions)) {
          const normalized = normalizeRecord(record)
          if (normalized !== undefined) this.records.set(sessionId, normalized)
        }
      }
      for (const [sessionId, follow] of Object.entries(parsed?.peak ?? {})) {
        if (typeof follow === 'boolean') this.peak.set(sessionId, follow)
      }
      for (const [sessionId, paused] of Object.entries(parsed?.paused ?? {})) {
        if (paused === true) this.paused.set(sessionId, true)
      }
      for (const [key, value] of Object.entries(parsed?.config ?? {})) {
        const field = CONFIG_INDEX.get(key)
        if (field === undefined || !isEditable(field)) continue
        const coerced = coerceConfigValue(field, value)
        if (coerced !== undefined) this.config[key] = coerced
      }
      const sync = parsed?.sync
      if (sync !== null && typeof sync === 'object') {
        for (const kind of ['pricing', 'holidays']) {
          const entry = sync[kind]
          if (entry !== null && typeof entry === 'object') this.sync[kind] = entry
        }
      }
    } catch (error) {
      this.log?.warn?.(`session-budget: could not read ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  get(sessionId) {
    return this.records.get(sessionId)
  }

  ensure(sessionId, defaults) {
    const existing = this.records.get(sessionId)
    if (existing !== undefined) return existing
    if (defaults === undefined) return undefined
    const record = {
      limits: { ...defaults },
      startedAt: Date.now(),
      used: ZERO_BUCKETS(),
      last: null,
      exhausted: null,
      seeded: false,
    }
    this.records.set(sessionId, record)
    this.saveSoon()
    return record
  }

  set(sessionId, record) {
    this.records.set(sessionId, record)
    this.saveSoon()
  }

  delete(sessionId) {
    if (!this.records.delete(sessionId)) return
    this.saveSoon()
  }

  /** Explicit per-session peak preference: true, false, or undefined for "follow config". */
  peakOf(sessionId) {
    return this.peak.get(sessionId)
  }

  setPeak(sessionId, follow) {
    if (follow === undefined) {
      if (!this.peak.delete(sessionId)) return
    } else {
      this.peak.set(sessionId, follow === true)
    }
    this.saveSoon()
  }

  pausedOf(sessionId) {
    return this.paused.get(sessionId) === true
  }

  setPaused(sessionId, paused) {
    if (paused === true) {
      this.paused.set(sessionId, true)
    } else if (!this.paused.delete(sessionId)) {
      return
    }
    this.saveSoon()
  }

  /** Settings-page overrides, as a detached copy. */
  configOf() {
    return { ...this.config }
  }

  /** Merge validated overrides into the settings-page layer and persist them. */
  setConfig(patch) {
    for (const [key, value] of Object.entries(patch ?? {})) {
      const field = CONFIG_INDEX.get(key)
      if (field === undefined || !isEditable(field)) continue
      const coerced = coerceConfigValue(field, value)
      if (coerced !== undefined) this.config[key] = coerced
    }
    this.saveSoon()
  }

  /** Drop every settings-page override, falling back to the profile row. */
  clearConfig() {
    this.config = {}
    this.saveSoon()
  }

  /** Last successful sync of one kind (`pricing` or `holidays`), as a detached copy. */
  syncOf(kind) {
    const entry = this.sync[kind]
    return entry === null || entry === undefined ? undefined : JSON.parse(JSON.stringify(entry))
  }

  /** Record the outcome of one sync attempt; `undefined` clears the entry. */
  setSync(kind, entry) {
    if (entry === undefined) {
      if (this.sync[kind] === undefined) return
      delete this.sync[kind]
    } else {
      this.sync[kind] = JSON.parse(JSON.stringify(entry))
    }
    this.saveSoon()
  }

  saveSoon() {
    if (this.pending !== undefined) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      void this.save()
    }, 400)
    this.pending.unref?.()
  }

  save() {
    const payload = {
      version: 4,
      sessions: Object.fromEntries(this.records),
      peak: Object.fromEntries(this.peak),
      paused: Object.fromEntries(this.paused),
      config: { ...this.config },
      sync: { ...this.sync },
    }
    const write = async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
        const temp = `${this.file}.tmp`
        await fs.promises.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8')
        await fs.promises.rename(temp, this.file)
      } catch (error) {
        this.log?.warn?.(`session-budget: could not save ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.chain = this.chain.then(write, write)
    return this.chain
  }

  dispose() {
    if (this.pending !== undefined) {
      clearTimeout(this.pending)
      this.pending = undefined
    }
    return this.save()
  }
}

function normalizeRecord(record) {
  if (record === null || typeof record !== 'object') return undefined
  const limits = {
    tokens: toInt(record?.limits?.tokens),
    money: Math.max(0, Number(record?.limits?.money) || 0),
    minutes: Math.max(0, Number(record?.limits?.minutes) || 0),
  }
  if (limits.tokens === 0 && limits.money === 0 && limits.minutes === 0) return undefined
  const used = {
    uncachedInputTokens: toInt(record?.used?.uncachedInputTokens),
    outputTokens: toInt(record?.used?.outputTokens),
    cacheReadTokens: toInt(record?.used?.cacheReadTokens),
    cacheWriteTokens: toInt(record?.used?.cacheWriteTokens),
  }
  const startedAt = Number.isFinite(record?.startedAt) ? record.startedAt : Date.now()
  const exhausted = record?.exhausted && typeof record.exhausted === 'object'
    ? {
      at: Number.isFinite(record.exhausted.at) ? record.exhausted.at : Date.now(),
      dimension: String(record.exhausted.dimension ?? 'tokens'),
      message: String(record.exhausted.message ?? 'limit reached'),
    }
    : null
  // A record that already carries usage was folded before; treat it as seeded so
  // reloading never double counts the same durable messages.
  const seeded = record?.seeded === true
    || used.uncachedInputTokens > 0
    || used.outputTokens > 0
    || used.cacheReadTokens > 0
    || used.cacheWriteTokens > 0
  return { limits, startedAt, used, last: null, exhausted, seeded }
}

const hasLimits = (record) => record !== undefined && record !== null
  && (record.limits.tokens > 0 || record.limits.money > 0 || record.limits.minutes > 0)

const totalsOf = (record, config) => {
  const used = record.used
  const tokens = used.uncachedInputTokens + used.outputTokens + used.cacheReadTokens + used.cacheWriteTokens
  const money = (used.uncachedInputTokens / 1e6) * config.priceInputPerMillion
    + (used.cacheReadTokens / 1e6) * config.priceCacheReadPerMillion
    + (used.cacheWriteTokens / 1e6) * config.priceCacheWritePerMillion
    + (used.outputTokens / 1e6) * config.priceOutputPerMillion
  return { tokens, money: round4(money) }
}

const formatNumber = (value) => Number(value).toLocaleString('en-US')

const formatMoney = (value, config) => `${config.currency === 'CNY' ? '¥' : ''}${round4(value).toFixed(4)}`

const formatMinutes = (value) => (Math.round(value * 10) / 10).toString()

/**
 * Parse peak windows such as `09:00-12:00,14:00-18:00`.
 *
 * Each window is an inclusive start and an exclusive end in minutes since
 * midnight; a window whose end is not after its start crosses midnight.
 */
function parsePeakWindows(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const windows = []
  for (const part of text.split(/[,，;；\s]+/)) {
    if (part === '') continue
    const match = /^(\d{1,2}):(\d{2})[-~～—](\d{1,2}):(\d{2})$/.exec(part)
    if (match === null) continue
    const start = Number(match[1]) * 60 + Number(match[2])
    const end = Number(match[3]) * 60 + Number(match[4])
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (start >= 24 * 60 || end > 24 * 60 || start === end) continue
    windows.push({ start, end })
  }
  return windows
}

/** Weekday numbers as `Date#getDay` reports them. */
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const WEEKDAY_ALIASES = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
}

/**
 * Parse a weekday filter such as `mon-fri` or `周一-周五`.
 *
 * Returns `null` for "every day" (empty text, `daily`, or nothing parseable),
 * otherwise the set of allowed `Date#getDay` numbers.
 */
function parseWeekdays(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const set = new Set()
  const weekdayOf = (token) => {
    if (WEEKDAY_INDEX[token] !== undefined) return WEEKDAY_INDEX[token]
    const alias = WEEKDAY_ALIASES[token]
    return alias === undefined ? undefined : alias
  }
  for (const raw of text.toLowerCase().split(/[,，、;；\s]+/)) {
    const token = raw.replace(/^周|^星期/, '')
    if (token === '') continue
    if (token === 'daily' || token === 'all' || token === '每天' || token === '全部' || token === '每天') return null
    const range = /^([a-z]{3}|[一二三四五六日天])\s*[-~～—至到]\s*([a-z]{3}|[一二三四五六日天])$/.exec(token)
    if (range !== null) {
      const from = weekdayOf(range[1])
      const to = weekdayOf(range[2])
      if (from === undefined || to === undefined) continue
      for (let day = from; ; day = (day + 1) % 7) {
        set.add(day)
        if (day === to) break
      }
      continue
    }
    const single = weekdayOf(token)
    if (single !== undefined) set.add(single)
  }
  return set.size === 0 ? null : set
}

/** Parse `YYYY-MM-DD` dates that must be treated as valley days. */
function parseSkipDates(text) {
  const dates = new Set()
  if (typeof text !== 'string') return dates
  for (const raw of text.split(/[,，、;；\s]+/)) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
    if (match === null) continue
    dates.add(`${match[1]}-${match[2]}-${match[3]}`)
  }
  return dates
}

/**
 * Official DeepSeek pricing pages, one per currency.
 *
 * The Chinese page lists CNY prices and the English page lists USD prices for the
 * same table, so the configured `currency` decides which page is authoritative.
 */
const PRICING_PAGES = {
  CNY: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  USD: 'https://api-docs.deepseek.com/quick_start/pricing',
}

/** Public holiday calendars, in the order they are tried. */
const holidaySources = (year) => [
  { url: `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`, format: 'holiday-cn' },
  { url: `https://timor.tech/api/holiday/year/${year}`, format: 'timor' },
]

/** Fetch one URL as text with a timeout; throws on a non-2xx answer. */
async function fetchText(url, timeoutMs = 15000) {
  if (typeof fetch !== 'function') throw new Error('当前运行环境没有 fetch，无法自动查询')
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
  timer?.unref?.()
  try {
    const response = await fetch(url, {
      signal: controller?.signal,
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Strip a docs page down to the single line of text its pricing table renders as. */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse the pricing table of a DeepSeek docs page.
 *
 * Returns `{ currency, models: [{ name, cacheHit, cacheMiss, output }] }` where
 * each metric carries `{ offpeak, peak }` prices per million tokens. The table
 * lists the same three rows for every model column, so a row's first half is the
 * off-peak prices and its second half the peak prices, one number per model.
 */
function parsePricingPage(html, currency) {
  const text = htmlToText(html)
  const modelMatches = [...text.matchAll(/deepseek-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*/g)].map((match) => match[0])
  const models = []
  for (const name of modelMatches) {
    if (models.length >= 2) break
    if (!models.includes(name)) models.push(name)
  }
  if (models.length === 0) throw new Error('定价页里没有找到模型列')
  const normalized = text.toUpperCase()
  const rowLabels = [
    { metric: 'cacheHit', zh: '缓存命中', en: 'CACHE HIT' },
    { metric: 'cacheMiss', zh: '缓存未命中', en: 'CACHE MISS' },
    { metric: 'output', zh: '输出', en: 'OUTPUT' },
  ]
  const rows = []
  for (const label of rowLabels) {
    let at = text.lastIndexOf(label.zh)
    if (at < 0) at = normalized.lastIndexOf(label.en)
    if (at < 0) throw new Error(`定价页里没有找到“${label.zh}”价格行`)
    rows.push({ metric: label.metric, at, label: text.slice(at, at + label.zh.length || at + label.en.length) })
  }
  rows.sort((left, right) => left.at - right.at)
  const result = models.map((name) => ({ name, cacheHit: {}, cacheMiss: {}, output: {} }))
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index]
    const next = rows[index + 1]
    const chunk = text.slice(current.at, next === undefined ? text.length : next.at)
    const numbers = [...chunk.matchAll(/(\d+(?:\.\d+)?)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value))
    if (numbers.length < models.length * 2) {
      throw new Error(`定价页“${current.metric}”的价格数字不够（解析到 ${numbers.length} 个）`)
    }
    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      result[modelIndex][current.metric] = {
        offpeak: numbers[modelIndex],
        peak: numbers[modelIndex + models.length],
      }
    }
  }
  return { currency, models: result }
}

/**
 * The four per-million prices the budget maths needs, taken from one model column.
 *
 * Cache writes are charged at the cache-miss input price (DeepSeek does not bill a
 * separate cache-write rate on this table), so the table stays four columns wide.
 */
function pickPrices(pricing, model, period) {
  const wanted = typeof model === 'string' && model !== '' ? model : 'deepseek-flash'
  const chosen = pricing.models.find((entry) => entry.name === wanted) ?? pricing.models[0]
  if (chosen === undefined) throw new Error('定价表里没有可用的模型列')
  const offset = period === 'offpeak' ? 'offpeak' : 'peak'
  const input = chosen.cacheMiss[offset]
  const cacheRead = chosen.cacheHit[offset]
  const output = chosen.output[offset]
  if (!Number.isFinite(input) || !Number.isFinite(cacheRead) || !Number.isFinite(output)) {
    throw new Error(`定价表缺少 ${chosen.name} 的价格`)
  }
  return {
    priceInputPerMillion: input,
    priceCacheReadPerMillion: cacheRead,
    priceCacheWritePerMillion: input,
    priceOutputPerMillion: output,
  }
}

/** Normalize a holiday calendar (holiday-cn JSON or timor.tech JSON) to off-day dates. */
function parseHolidayCalendar(payload, year) {
  const dates = []
  const names = {}
  let sourceYear = Number(year)
  let parsed
  try {
    parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  } catch (error) {
    throw new Error('节假日日历不是有效的 JSON')
  }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.days)) {
    if (Number.isFinite(Number(parsed.year))) sourceYear = Number(parsed.year)
    for (const day of parsed.days) {
      if (day?.isOffDay !== true) continue
      const date = typeof day.date === 'string' ? day.date : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dates.includes(date)) continue
      dates.push(date)
      if (typeof day.name === 'string') names[date] = day.name
    }
    return { year: sourceYear, dates, names, source: 'holiday-cn' }
  }
  const holidays = parsed?.holiday
  if (holidays !== null && typeof holidays === 'object') {
    for (const [key, entry] of Object.entries(holidays)) {
      if (entry?.holiday !== true) continue
      const date = typeof entry?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
        ? entry.date
        : `${sourceYear}-${key}`
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dates.includes(date)) continue
      dates.push(date)
      if (typeof entry?.name === 'string') names[date] = entry.name
    }
    return { year: sourceYear, dates, names, source: 'timor' }
  }
  throw new Error('节假日日历格式无法识别')
}

/**
 * Local wall-clock parts in the configured IANA time zone (or the process zone).
 *
 * `dateKey` is the local calendar date; `weekday` matches `Date#getDay`.
 */
function localParts(date, timeZone) {
  if (typeof timeZone === 'string' && timeZone !== '') {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hour12: false,
      }).formatToParts(date)
      const part = (type) => parts.find((entry) => entry.type === type)?.value
      const hour = Number(part('hour'))
      const minute = Number(part('minute'))
      const weekday = WEEKDAY_INDEX[String(part('weekday') ?? '').toLowerCase().slice(0, 3)]
      if (Number.isFinite(hour) && Number.isFinite(minute) && weekday !== undefined) {
        return {
          minute: (hour % 24) * 60 + minute,
          weekday,
          dateKey: `${part('year')}-${part('month')}-${part('day')}`,
        }
      }
    } catch (error) {
      // An unknown time zone falls back to the process time zone.
    }
  }
  const pad = (value) => String(value).padStart(2, '0')
  return {
    minute: date.getHours() * 60 + date.getMinutes(),
    weekday: date.getDay(),
    dateKey: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
  }
}

/**
 * Whether `date` sits inside a peak window, plus how long that window has left.
 *
 * `options` carries `{ timeZone, weekdays, skipDates }` so a schedule can be
 * restricted to working days and skipped entirely on holidays.
 */
function peakStateOf(windows, date, options = {}) {
  const now = localParts(date, options.timeZone)
  const skipDates = options.skipDates instanceof Set ? options.skipDates : new Set()
  const weekdays = options.weekdays instanceof Set ? options.weekdays : null
  const skipped = skipDates.has(now.dateKey)
  const weekdayOff = weekdays !== null && !weekdays.has(now.weekday)
  if (skipped || weekdayOff) return { active: false, minutesLeft: null, skipped, weekdayOff, dateKey: now.dateKey }
  const minute = now.minute
  for (const window of windows) {
    const crossing = window.start >= window.end
    const inside = crossing
      ? minute >= window.start || minute < window.end
      : minute >= window.start && minute < window.end
    if (!inside) continue
    // A window that runs past midnight belongs to the previous day's schedule.
    if (weekdays !== null && crossing && minute < window.end) {
      const previous = (now.weekday + 6) % 7
      if (!weekdays.has(previous)) continue
    }
    const left = crossing
      ? 24 * 60 - minute + window.end
      : window.end - minute
    return { active: true, minutesLeft: Math.max(1, left), skipped: false, weekdayOff: false, dateKey: now.dateKey }
  }
  return { active: false, minutesLeft: null, skipped: false, weekdayOff: false, dateKey: now.dateKey }
}

/** First limit reached by this record, in the configured dimension order. */
function findBreach(record, config, now) {
  const limits = record.limits
  const totals = totalsOf(record, config)
  if (limits.tokens > 0 && totals.tokens >= limits.tokens) {
    return { dimension: 'tokens', message: `token 用量 ${formatNumber(totals.tokens)} 已达上限 ${formatNumber(limits.tokens)}` }
  }
  if (limits.money > 0 && totals.money >= limits.money) {
    return { dimension: 'money', message: `花费 ${formatMoney(totals.money, config)} 已达上限 ${formatMoney(limits.money, config)}` }
  }
  if (limits.minutes > 0 && now - record.startedAt >= limits.minutes * 60000) {
    const minutes = (now - record.startedAt) / 60000
    return { dimension: 'time', message: `时长 ${formatMinutes(minutes)} 分钟已达上限 ${formatMinutes(limits.minutes)} 分钟` }
  }
  return undefined
}

/**
 * Register the per-session budget policy.
 * @param ctx - the plugin's host context.
 * @param rawConfig - validated plugin configuration from the profile row.
 */
export function apply(ctx, rawConfig) {
  const log = ctx.logger ?? console
  const file = typeof rawConfig.dataFile === 'string' && rawConfig.dataFile.trim() !== ''
    ? rawConfig.dataFile.trim()
    : path.join(os.homedir(), '.dsh', 'session-budget', 'budgets.json')
  const store = new BudgetStore(file, log)
  /** Effective configuration: the profile row, overlaid by settings-page overrides. */
  let config = mergeConfig(rawConfig, store.configOf())

  const reloadConfig = () => {
    config = mergeConfig(rawConfig, store.configOf())
  }

  const defaults = () => {
    const limits = {
      tokens: toInt(config.defaultTokens),
      money: Math.max(0, Number(config.defaultMoney) || 0),
      minutes: Math.max(0, Number(config.defaultMinutes) || 0),
    }
    return limits.tokens > 0 || limits.money > 0 || limits.minutes > 0 ? limits : undefined
  }

  const pricesConfigured = () => config.priceInputPerMillion > 0 || config.priceCacheReadPerMillion > 0
    || config.priceCacheWritePerMillion > 0 || config.priceOutputPerMillion > 0
  const warnPrices = () => {
    if ((Number(config.defaultMoney) > 0) && !pricesConfigured()) {
      log?.warn?.('session-budget: a cost limit is configured but every per-million price is 0, so cost never accumulates')
    }
  }
  warnPrices()

  const agentsService = () => {
    try {
      return ctx.get('agents')
    } catch (error) {
      return undefined
    }
  }
  const goalsService = () => {
    try {
      return ctx.get('goals')
    } catch (error) {
      return undefined
    }
  }
  const liveAgent = (sessionId) => {
    const agents = agentsService()
    if (agents === undefined || agents === null) return undefined
    try {
      return agents.get(sessionId)
    } catch (error) {
      return undefined
    }
  }

  // ------------------------------------------------------- peak / valley windows

  const peakWindowsOf = () => parsePeakWindows(config.peakWindows)
  const peakZone = () => (typeof config.peakTimezone === 'string' ? config.peakTimezone.trim() : '')
  const peakWeekdaysOf = () => parseWeekdays(config.peakWeekdays)
  /**
   * Days that run as valley regardless of the schedule.
   *
   * The hand-written dates always apply; the synced public holidays join them when
   * `holidayAutoSkip` is on, which keeps a stale calendar from overriding the user.
   */
  const peakSkipDatesOf = () => {
    const dates = parseSkipDates(config.peakSkipDates)
    if (config.holidayAutoSkip !== false) {
      const synced = store.syncOf('holidays')
      for (const date of synced?.dates ?? []) {
        if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date)
      }
    }
    return dates
  }
  /** Whether this session follows the peak schedule (per-session preference, then config). */
  const peakFollowed = (sessionId) => {
    const preference = sessionId === undefined ? undefined : store.peakOf(sessionId)
    return preference === undefined ? config.peakAutoResume !== false : preference === true
  }
  const peakNow = (date) => peakStateOf(peakWindowsOf(), date ?? new Date(), {
    timeZone: peakZone(),
    weekdays: peakWeekdaysOf(),
    skipDates: peakSkipDatesOf(),
  })

  // ------------------------------------------------ automatic pricing / holidays

  const errorText = (error) => (error instanceof Error ? error.message : String(error))

  const syncIntervalMs = () => Math.max(1, Number(config.syncIntervalHours) || 24) * 3600000

  /** Fetch the official price table and adopt the four per-million prices. */
  const syncPricingNow = async () => {
    const currency = (typeof config.currency === 'string' && config.currency.trim() !== '' ? config.currency : 'CNY').trim().toUpperCase()
    const key = currency === 'CNY' ? 'CNY' : 'USD'
    const url = PRICING_PAGES[key]
    const html = await fetchText(url)
    const parsed = parsePricingPage(html, key)
    const prices = pickPrices(parsed, config.pricingModel, config.pricingPeriod)
    const wanted = parsed.models.find((entry) => entry.name === config.pricingModel) ?? parsed.models[0]
    const entry = {
      at: Date.now(),
      currency: key,
      model: wanted.name,
      period: config.pricingPeriod === 'offpeak' ? 'offpeak' : 'peak',
      prices: { ...prices },
      models: parsed.models.map((model) => model.name),
      source: url,
    }
    store.setConfig(prices)
    store.setSync('pricing', entry)
    reloadConfig()
    warnPrices()
    log?.info?.(`session-budget: prices synced from ${url} (${entry.model} · ${entry.period})`)
    return entry
  }

  /** Fetch the public holiday calendars for this year and the next one. */
  const syncHolidaysNow = async () => {
    const year = Number(localParts(new Date(), peakZone()).dateKey.slice(0, 4))
    const years = Number.isFinite(year) ? [year, year + 1] : [new Date().getFullYear()]
    const dates = new Set()
    const names = {}
    const failures = []
    let source = ''
    for (const targetYear of years) {
      let done = false
      for (const candidate of holidaySources(targetYear)) {
        try {
          const text = await fetchText(candidate.url)
          const parsed = parseHolidayCalendar(text, targetYear)
          for (const date of parsed.dates) dates.add(date)
          Object.assign(names, parsed.names)
          source = candidate.url
          done = true
          break
        } catch (error) {
          failures.push(`${candidate.url}: ${errorText(error)}`)
        }
      }
      if (!done) log?.warn?.(`session-budget: no holiday calendar for ${targetYear}: ${failures.join('; ')}`)
    }
    if (dates.size === 0) throw new Error(failures.join('; ') || '没有取到节假日数据')
    const entry = { at: Date.now(), years, dates: [...dates].sort(), names, source }
    store.setSync('holidays', entry)
    log?.info?.(`session-budget: ${entry.dates.length} holiday days synced for ${years.join(', ')}`)
    return entry
  }

  /**
   * Run the requested syncs, keeping the last good result when one fails.
   *
   * A failing network must never break enforcement, so failures are reported back
   * to the settings page instead of being thrown at the caller.
   */
  const syncAll = async (kinds = {}) => {
    const result = {}
    if (kinds.pricing !== false) {
      try {
        await syncPricingNow()
        result.pricing = 'ok'
      } catch (error) {
        result.pricing = errorText(error)
        log?.warn?.(`session-budget: pricing sync failed: ${result.pricing}`)
      }
    }
    if (kinds.holidays !== false) {
      try {
        await syncHolidaysNow()
        result.holidays = 'ok'
      } catch (error) {
        result.holidays = errorText(error)
        log?.warn?.(`session-budget: holiday sync failed: ${result.holidays}`)
      }
    }
    try {
      sweep()
    } catch (error) {
      // best effort: a broken sweep must not fail the sync response
    }
    return result
  }

  /** Whether the stored sync results are older than the configured interval. */
  const syncDue = () => {
    const interval = syncIntervalMs()
    const stale = (entry) => entry === undefined || !Number.isFinite(entry.at) || Date.now() - entry.at >= interval
    return stale(store.syncOf('pricing')) || stale(store.syncOf('holidays'))
  }

  ctx.effect(() => {
    const run = () => {
      if (!config.enabled || config.autoSync === false) return
      if (!syncDue()) return
      void syncAll({}).catch(() => {
        // reported through the returned result of the manual path
      })
    }
    const kick = setTimeout(run, 2500)
    kick.unref?.()
    const timer = setInterval(run, Math.min(syncIntervalMs(), 3600000))
    timer.unref?.()
    return () => {
      clearTimeout(kick)
      clearInterval(timer)
    }
  }, 'session-budget.sync')

  /** Sync state for the settings page. */
  const syncSummary = () => {
    const pricing = store.syncOf('pricing')
    const holidays = store.syncOf('holidays')
    return {
      autoSync: config.autoSync !== false,
      intervalHours: Math.max(1, Number(config.syncIntervalHours) || 24),
      currency: typeof config.currency === 'string' ? config.currency.trim().toUpperCase() : 'CNY',
      pricingModel: typeof config.pricingModel === 'string' ? config.pricingModel.trim() : '',
      pricingPeriod: config.pricingPeriod === 'offpeak' ? 'offpeak' : 'peak',
      holidayAutoSkip: config.holidayAutoSkip !== false,
      pricing: pricing === undefined
        ? null
        : {
          at: pricing.at,
          currency: pricing.currency,
          model: pricing.model,
          period: pricing.period,
          prices: pricing.prices,
          models: pricing.models ?? [],
          source: pricing.source,
        },
      holidays: holidays === undefined
        ? null
        : {
          at: holidays.at,
          years: holidays.years ?? [],
          count: Array.isArray(holidays.dates) ? holidays.dates.length : 0,
          dates: Array.isArray(holidays.dates) ? holidays.dates.slice(0, 60) : [],
          source: holidays.source,
        },
    }
  }

  /** Pause the goal and cancel a running turn when a peak window is active. */
  function peakStop(sessionId, agent, state) {
    const goals = goalsService()
    if (goals !== undefined && goals !== null) {
      try {
        const goal = goals.get(agent)
        if (goal !== undefined && goal !== null && goal.phase === 'active') {
          goals.pause(agent, { id: goal.id, revision: goal.revision })
        }
        if (goal !== undefined && goal !== null && goal.phase !== 'complete') store.setPaused(sessionId, true)
      } catch (error) {
        log?.warn?.(`session-budget: could not pause the goal for peak hours: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      if (agent.status === 'running') {
        const left = state?.minutesLeft
        agent.cancel({ kind: 'hook', reason: `session-budget: 峰时暂停${left ? `，${left} 分钟后谷时自动继续` : '，谷时自动继续'}` })
      }
    } catch (error) {
      log?.warn?.(`session-budget: could not cancel the running turn for peak hours: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Resume a goal this plugin paused when the valley begins. */
  function resumeAfterPeak(sessionId) {
    if (!store.pausedOf(sessionId)) return
    store.setPaused(sessionId, false)
    const agent = liveAgent(sessionId)
    const goals = goalsService()
    if (agent === undefined || goals === undefined || goals === null) return
    try {
      const goal = goals.get(agent)
      if (goal === undefined || goal === null) return
      if (goal.phase === 'complete') return
      if (goal.phase === 'active' && goal.activation === 'armed') return
      const code = goal.blockedReason?.code
      if (code === 'budget-exhausted' || code === 'round-limit') return
      goals.resume(agent, { id: goal.id, revision: goal.revision })
      log?.info?.(`session-budget: session ${sessionId} resumed after peak hours`)
    } catch (error) {
      store.setPaused(sessionId, true)
      log?.warn?.(`session-budget: could not resume the goal after peak hours: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** True when the peak policy must stop this step right now. */
  function peakGate(sessionId, agent) {
    if (peakWindowsOf().length === 0) return false
    if (!peakFollowed(sessionId)) return false
    const state = peakNow()
    if (!state.active) {
      resumeAfterPeak(sessionId)
      return false
    }
    peakStop(sessionId, agent, state)
    return true
  }

  /** Stop the model session for a reached limit without touching durable history twice. */
  function enforce(record, sessionId, breach) {
    if (record.exhausted !== null && record.exhausted !== undefined) return
    record.exhausted = { at: Date.now(), dimension: breach.dimension, message: breach.message }
    store.saveSoon()
    log?.info?.(`session-budget: session ${sessionId} stopped — ${breach.message}`)
    const agent = liveAgent(sessionId)
    if (agent === undefined) return
    stopAgent(agent, breach)
  }

  /** Block or pause the active goal, then cancel a running turn. */
  function stopAgent(agent, breach) {
    const goals = goalsService()
    if (goals !== undefined && goals !== null) {
      try {
        const goal = goals.get(agent)
        if (goal !== undefined && goal !== null && goal.phase === 'active') {
          const ref = { id: goal.id, revision: goal.revision }
          if (config.onExceed === 'pause') {
            goals.pause(agent, ref)
          } else {
            goals.block(agent, ref, { code: 'budget-exhausted', message: breach.message })
          }
        }
      } catch (error) {
        log?.warn?.(`session-budget: could not stop the goal: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      if (agent.status === 'running') {
        agent.cancel({ kind: 'hook', reason: `session-budget: ${breach.message}` })
      }
    } catch (error) {
      log?.warn?.(`session-budget: could not cancel the running turn: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Re-arm a goal this plugin blocked, after the budget was raised or reset. */
  function resumeOwnGoal(sessionId) {
    const agent = liveAgent(sessionId)
    const goals = goalsService()
    if (agent === undefined || goals === undefined || goals === null) return
    try {
      const goal = goals.get(agent)
      if (goal === undefined || goal === null || goal.phase !== 'blocked') return
      if (goal.blockedReason?.code !== 'budget-exhausted') return
      goals.resume(agent, { id: goal.id, revision: goal.revision })
    } catch (error) {
      log?.warn?.(`session-budget: could not resume the goal: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Fold one durable assistant settlement into the session's usage window. */
  function foldUsage(sessionId, event) {
    const record = store.get(sessionId)
    if (record === undefined) return
    seedUsage(sessionId, record)
    if (event.type === 'llm/retry-started') {
      if (record.last !== null && record.last.turn === event.data?.turn && record.last.step === event.data?.step) {
        record.last = null
        store.saveSoon()
      }
      return
    }
    const usage = usageOf(event)
    if (usage === undefined) return
    const buckets = bucketsOf(usage)
    const turn = toInt(event.data?.turn)
    const step = toInt(event.data?.step)
    const previous = record.last !== null && record.last.turn === turn && record.last.step === step
      ? record.last.buckets
      : undefined
    record.used = addReplacing(record.used, previous, buckets)
    record.last = { turn, step, buckets }
    store.saveSoon()
  }

  /**
   * Fold the usage the session already logged, the first time a record is used.
   *
   * A budget applies to the whole session, so usage logged before the limit was
   * set still counts. Reading the durable log also gives the Web UI correct
   * numbers for a session that was already running when the plugin loaded.
   */
  function seedUsage(sessionId, record) {
    if (record.seeded) return
    const agent = liveAgent(sessionId)
    const session = agent?.session
    if (session === undefined || session === null) return
    let events
    try {
      events = typeof session.ownEvents === 'function'
        ? session.ownEvents()
        : session.snapshotEvents(0, session.seq)
    } catch (error) {
      return
    }
    if (!Array.isArray(events)) return
    const totals = ZERO_BUCKETS()
    let last = null
    for (const event of events) {
      const turn = toInt(event?.data?.turn)
      const step = toInt(event?.data?.step)
      if (event?.type === 'llm/retry-started') {
        if (last !== null && last.turn === turn && last.step === step) last = null
        continue
      }
      const usage = usageOf(event)
      if (usage === undefined) continue
      const buckets = bucketsOf(usage)
      const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : undefined
      addInto(totals, previous, buckets)
      last = { turn, step, buckets }
    }
    record.used = totals
    record.last = last
    record.seeded = true
    store.saveSoon()
  }

  function checkAndEnforce(sessionId, record) {
    if (!config.enabled) return
    if (record.exhausted !== null && record.exhausted !== undefined) {
      const agent = liveAgent(sessionId)
      if (agent !== undefined) stopAgent(agent, record.exhausted)
      return
    }
    const breach = findBreach(record, config, Date.now())
    if (breach === undefined) return
    enforce(record, sessionId, breach)
  }

  ctx.on('session/event', (session, event) => {
    if (!config.enabled) return
    if (event.type !== 'assistant/message' && event.type !== 'llm/retry-started') return
    foldUsage(session.id, event)
    const record = store.get(session.id)
    if (record !== undefined) checkAndEnforce(session.id, record)
  })

  ctx.on('agent/pre-step', (payload, next) => {
    if (!config.enabled) return next()
    const sessionId = payload?.agent?.id
    if (sessionId === undefined) return next()
    const record = store.get(sessionId)
    if (hasLimits(record)) {
      if (record.exhausted !== null && record.exhausted !== undefined) {
        try {
          stopAgent(payload.agent, record.exhausted)
        } catch (error) {
          // A stop attempt that throws must not turn into a step failure.
        }
        return { kind: 'reject' }
      }
      const breach = findBreach(record, config, Date.now())
      if (breach !== undefined) {
        try {
          enforce(record, sessionId, breach)
        } catch (error) {
          // keep rejecting even if the cooperative stop failed
        }
        return { kind: 'reject' }
      }
    }
    try {
      if (peakGate(sessionId, payload.agent)) return { kind: 'reject' }
    } catch (error) {
      // A peak policy failure must not let a step through unnoticed, but must not
      // break the turn either; fall through to the normal decision on error.
    }
    return next()
  })

  ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined) return
    const record = store.ensure(agent.id, defaults())
    if (record !== undefined) {
      try {
        seedUsage(agent.id, record)
        checkAndEnforce(agent.id, record)
      } catch (error) {
        // A session that cannot be seeded simply starts counting from its next message.
      }
      if (record.exhausted !== null) {
        try {
          stopAgent(agent, record.exhausted)
        } catch (error) {
          // best effort
        }
      }
    }
    try {
      if (peakGate(agent.id, agent)) {
        // The peak window already covers this session; it stays paused until the valley.
      }
    } catch (error) {
      // best effort
    }
  })

  /** One enforcement pass: time limits, then the peak/valley transition. */
  function sweep() {
    if (!config.enabled) return
    const agents = agentsService()
    if (agents === undefined || agents === null) return
    let live = []
    try {
      live = agents.list() ?? []
    } catch (error) {
      return
    }
    const windows = peakWindowsOf()
    const state = windows.length === 0 ? { active: false, minutesLeft: null } : peakNow()
    for (const agent of live) {
      const record = store.get(agent.id)
      if (record !== undefined && record.limits.minutes > 0 && record.exhausted === null) {
        const breach = findBreach(record, config, Date.now())
        if (breach !== undefined) enforce(record, agent.id, breach)
      }
      if (windows.length === 0 || !peakFollowed(agent.id)) {
        resumeAfterPeak(agent.id)
        continue
      }
      if (state.active) peakStop(agent.id, agent, state)
      else resumeAfterPeak(agent.id)
    }
  }

  const interval = Math.max(1000, Number(config.checkIntervalMs) || 5000)
  ctx.effect(() => {
    const timer = setInterval(sweep, interval)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'session-budget.timer')

  // ---------------------------------------------------------------- commands

  /** Peak/valley state the Web UI and the command render. */
  const peakView = (sessionId) => {
    const windows = peakWindowsOf()
    const weekdays = peakWeekdaysOf()
    const skipDates = peakSkipDatesOf()
    const state = windows.length === 0
      ? { active: false, minutesLeft: null, skipped: false, weekdayOff: false, dateKey: '' }
      : peakNow()
    return {
      configured: windows.length > 0,
      windows: typeof config.peakWindows === 'string' ? config.peakWindows.trim() : '',
      timezone: peakZone(),
      weekdays: typeof config.peakWeekdays === 'string' ? config.peakWeekdays.trim() : '',
      skipDates: typeof config.peakSkipDates === 'string' ? config.peakSkipDates.trim() : '',
      weekendAlwaysValley: weekdays !== null && !weekdays.has(0) && !weekdays.has(6),
      today: state.dateKey,
      todaySkipped: state.skipped === true,
      todayOutsideWeekdays: state.weekdayOff === true,
      followed: peakFollowed(sessionId),
      autoResume: config.peakAutoResume !== false,
      active: state.active === true,
      minutesLeft: state.active ? state.minutesLeft : null,
      paused: sessionId === undefined ? false : store.pausedOf(sessionId),
    }
  }

  const viewOf = (record, sessionId) => {
    const enabled = record !== undefined && hasLimits(record)
    const totals = enabled ? totalsOf(record, config) : { tokens: 0, money: 0 }
    const minutes = enabled ? (Date.now() - record.startedAt) / 60000 : 0
    const limits = enabled ? record.limits : { tokens: 0, money: 0, minutes: 0 }
    const remaining = enabled
      ? {
        tokens: limits.tokens > 0 ? Math.max(0, limits.tokens - totals.tokens) : null,
        money: limits.money > 0 ? round4(Math.max(0, limits.money - totals.money)) : null,
        minutes: limits.minutes > 0 ? round4(Math.max(0, limits.minutes - minutes)) : null,
      }
      : { tokens: null, money: null, minutes: null }
    return {
      hasBudget: enabled,
      enabled: Boolean(config.enabled),
      limits: { ...limits },
      usage: { tokens: totals.tokens, money: totals.money, minutes: round4(minutes) },
      remaining,
      exhausted: enabled && record.exhausted !== null ? record.exhausted : null,
      startedAt: enabled ? record.startedAt : null,
      currency: config.currency,
      pricesConfigured: pricesConfigured(),
      peak: peakView(sessionId),
    }
  }

  // ------------------------------------------------------- settings page data

  /** Peak/valley state without a session, for the settings page header. */
  const peakSummary = () => {
    const windows = peakWindowsOf()
    const state = windows.length === 0
      ? { active: false, minutesLeft: null, skipped: false, weekdayOff: false, dateKey: '' }
      : peakNow()
    const holidays = store.syncOf('holidays')
    return {
      configured: windows.length > 0,
      windows: typeof config.peakWindows === 'string' ? config.peakWindows.trim() : '',
      timezone: peakZone(),
      weekdays: typeof config.peakWeekdays === 'string' ? config.peakWeekdays.trim() : '',
      skipDates: typeof config.peakSkipDates === 'string' ? config.peakSkipDates.trim() : '',
      holidayAutoSkip: config.holidayAutoSkip !== false,
      holidayCount: Array.isArray(holidays?.dates) ? holidays.dates.length : 0,
      holidaySyncedAt: Number.isFinite(holidays?.at) ? holidays.at : null,
      today: state.dateKey,
      todaySkipped: state.skipped === true,
      todayOutsideWeekdays: state.weekdayOff === true,
      active: state.active === true,
      minutesLeft: state.active ? state.minutesLeft : null,
    }
  }

  /** Everything the settings page needs to render and to diff its form. */
  const configPayload = () => ({
    fields: CONFIG_FIELDS.map((field) => ({
      key: field.key,
      group: field.group,
      kind: field.kind,
      label: field.label,
      description: field.description,
      options: field.options ?? null,
      editable: isEditable(field),
      default: field.value,
      value: config[field.key],
      overridden: Object.prototype.hasOwnProperty.call(store.configOf(), field.key),
    })),
    overridden: Object.keys(store.configOf()),
    peak: peakSummary(),
    sync: syncSummary(),
    storeFile: store.file,
  })

  /**
   * Validate and persist one settings-page submission.
   *
   * Only fields the page may change are accepted; a rejected field rejects the
   * whole submission so the page can point at the offending row instead of
   * saving half a form.
   */
  function applyConfigPatch(values) {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      return { error: '无效的配置内容' }
    }
    const patch = {}
    for (const [key, raw] of Object.entries(values)) {
      const field = CONFIG_INDEX.get(key)
      if (field === undefined) return { error: `未知字段：${key}` }
      if (!isEditable(field)) return { error: `字段“${field.label}”需要重启插件后才能修改` }
      const coerced = coerceConfigValue(field, raw)
      if (coerced === undefined) return { error: `字段“${field.label}”的值无效：${String(raw)}` }
      patch[key] = coerced
    }
    if (Object.keys(patch).length === 0) return { error: '没有需要保存的字段' }
    store.setConfig(patch)
    reloadConfig()
    warnPrices()
    try {
      sweep()
    } catch (error) {
      log?.warn?.(`session-budget: could not re-apply the new settings: ${error instanceof Error ? error.message : String(error)}`)
    }
    log?.info?.(`session-budget: settings updated (${Object.keys(patch).join(', ')})`)
    return {}
  }

  /** Human-readable peak/valley state for the command and the strip tooltip. */
  const peakLines = (sessionId) => {
    const view = peakView(sessionId)
    if (!view.configured) {
      return [
        '峰时自动恢复：还没有配置峰时时段。',
        '在插件配置的“峰时时段”里填 HH:MM-HH:MM；默认值是 DeepSeek 峰时 09:00-12:00,14:00-18:00（北京时间、周一至周五）。',
      ]
    }
    const lines = [`峰时时段：${view.windows}${view.timezone === '' ? '（本机时区）' : `（${view.timezone}）`}`]
    if (view.weekdays !== '') lines.push(`生效日：${view.weekdays}${view.weekendAlwaysValley ? '（周末全天按谷时）' : ''}`)
    if (view.skipDates !== '') lines.push(`节假日跳过：${view.skipDates}`)
    if (view.todaySkipped) lines.push(`今天被列为节假日（${view.today}），全天按谷时处理。`)
    else if (view.todayOutsideWeekdays) lines.push(`今天不在峰时生效日，全天按谷时处理。`)
    lines.push(`本会话：${view.followed ? '跟随峰时排期（峰时暂停，谷时自动继续）' : '不跟随峰时排期'}`)
    lines.push(view.active
      ? `当前是峰时，约 ${view.minutesLeft} 分钟后进入谷时；${view.followed ? '到谷时会自动继续这个会话。' : '本会话不会自动继续。'}`
      : '当前是谷时。')
    if (view.paused) lines.push('这个会话正在等待谷时自动继续。')
    lines.push('切换：/budget peak on | off | auto（auto 跟随插件配置）')
    return lines
  }

  const statusLines = (record, sessionId) => {
    if (record === undefined) {
      const lines = [
        '本会话还没有用量上限。',
        '设置：/budget set tokens=200k 或 /budget set money=5 time=60m',
        '价格：/budget set 只设上限；金额按插件配置的每百万 token 单价折算。',
      ]
      if (peakView(sessionId).configured) lines.push(...peakLines(sessionId))
      return lines
    }
    const view = viewOf(record, sessionId)
    const lines = ['本会话用量预算：']
    if (view.limits.tokens > 0) {
      lines.push(`- token：${formatNumber(view.usage.tokens)} / ${formatNumber(view.limits.tokens)}`)
    }
    if (view.limits.money > 0) {
      lines.push(`- 金额：${formatMoney(view.usage.money, config)} / ${formatMoney(view.limits.money, config)}（按配置单价折算）`)
    }
    if (view.limits.minutes > 0) {
      lines.push(`- 时长：${formatMinutes(view.usage.minutes)} / ${formatMinutes(view.limits.minutes)} 分钟`)
    }
    if (view.limits.money > 0 && !pricesConfigured()) {
      lines.push('- 注意：金额单价还没配置（插件配置里的 price*PerMillion 全是 0），金额不会累计，请先填单价。')
    }
    lines.push(view.exhausted === null
      ? '- 状态：正常'
      : `- 状态：已停止（${view.exhausted.message}）`)
    if (view.peak.configured) lines.push(...peakLines(sessionId))
    lines.push('调整：/budget set tokens=… money=… time=…　重置：/budget reset　关闭：/budget off')
    return lines
  }

  const parseTokens = (text) => {
    const match = /^([\d.]+)([kKmM]?)$/.exec(text)
    if (match === null) return undefined
    const base = Number(match[1])
    if (!Number.isFinite(base)) return undefined
    const scale = match[2].toLowerCase() === 'k' ? 1e3 : match[2].toLowerCase() === 'm' ? 1e6 : 1
    return Math.round(base * scale)
  }

  const parseMinutes = (text) => {
    const match = /^([\d.]+)([mhM]?)$/.exec(text)
    if (match === null) return undefined
    const base = Number(match[1])
    if (!Number.isFinite(base)) return undefined
    const scale = match[2].toLowerCase() === 'h' ? 60 : 1
    return base * scale
  }

  function handleCommand(invocation) {
    const sessionId = invocation?.agent?.id
    const raw = String(invocation?.rawInput ?? '').trim()
    const [verb = '', ...rest] = raw === '' ? [] : raw.split(/\s+/)
    if (sessionId === undefined) {
      return { kind: 'error', text: '这个命令需要一个会话上下文。' }
    }
    try {
      if (verb === '' || verb === 'status' || verb === 'show') {
        return { kind: 'success', text: statusLines(store.get(sessionId), sessionId).join('\n') }
      }
      if (verb === 'peak') {
        const what = (rest[0] ?? '').toLowerCase()
        if (what === 'on' || what === 'off' || what === 'auto') {
          store.setPeak(sessionId, what === 'auto' ? undefined : what === 'on')
          const agent = liveAgent(sessionId)
          const windows = peakWindowsOf()
          const state = windows.length === 0 ? { active: false } : peakNow()
          if (agent !== undefined && peakFollowed(sessionId) && state.active) peakStop(sessionId, agent, state)
          else resumeAfterPeak(sessionId)
        } else if (what !== '' && what !== 'status') {
          return { kind: 'error', text: `未知的峰时开关“${what}”。用法：/budget peak [on|off|auto]` }
        }
        return { kind: 'success', text: peakLines(sessionId).join('\n') }
      }
      if (verb === 'off' || verb === 'clear') {
        store.delete(sessionId)
        resumeOwnGoal(sessionId)
        return { kind: 'success', text: '本会话的用量上限已关闭。' }
      }
      if (verb === 'reset') {
        const record = store.get(sessionId)
        if (record === undefined) return { kind: 'success', text: '本会话还没有用量上限。' }
        record.used = ZERO_BUCKETS()
        record.last = null
        record.seeded = true
        record.exhausted = null
        record.startedAt = Date.now()
        store.saveSoon()
        resumeOwnGoal(sessionId)
        return { kind: 'success', text: '本会话用量已清零，计时重新开始。' }
      }
      if (verb === 'set') {
        const current = store.get(sessionId)
        const limits = {
          tokens: current?.limits.tokens ?? 0,
          money: current?.limits.money ?? 0,
          minutes: current?.limits.minutes ?? 0,
        }
        let touched = 0
        for (const part of rest) {
          const [key, value = ''] = part.split('=')
          if (key === 'tokens' || key === 'token') {
            const parsed = parseTokens(value)
            if (parsed === undefined) return { kind: 'error', text: `token 上限无法解析：“${part}”。例如 tokens=200k 或 tokens=500000。` }
            limits.tokens = parsed
            touched += 1
          } else if (key === 'money' || key === 'cost') {
            const parsed = Number(value)
            if (!Number.isFinite(parsed) || parsed < 0) return { kind: 'error', text: `金额上限无法解析：“${part}”。例如 money=5。` }
            limits.money = parsed
            touched += 1
          } else if (key === 'time' || key === 'minutes') {
            const parsed = parseMinutes(value)
            if (parsed === undefined) return { kind: 'error', text: `时长上限无法解析：“${part}”。例如 time=60m 或 time=2h。` }
            limits.minutes = parsed
            touched += 1
          } else {
            return { kind: 'error', text: `未知字段“${key}”。可用：tokens=… money=… time=…` }
          }
        }
        if (touched === 0) {
          return { kind: 'error', text: '用法：/budget set tokens=200k money=5 time=60m（可只写其中一项）。' }
        }
        if (limits.tokens === 0 && limits.money === 0 && limits.minutes === 0) {
          store.delete(sessionId)
          resumeOwnGoal(sessionId)
          return { kind: 'success', text: '所有上限都是 0，已关闭本会话的用量限制。' }
        }
        const record = {
          limits,
          startedAt: current?.startedAt ?? Date.now(),
          used: current?.used ?? ZERO_BUCKETS(),
          last: current?.last ?? null,
          exhausted: null,
          seeded: current?.seeded ?? false,
        }
        store.set(sessionId, record)
        seedUsage(sessionId, record)
        checkAndEnforce(sessionId, record)
        if (record.exhausted === null) resumeOwnGoal(sessionId)
        return { kind: 'success', text: statusLines(record, sessionId).join('\n') }
      }
      return { kind: 'error', text: '用法：/budget [status | set tokens=… money=… time=… | peak on|off|auto | reset | off]' }
    } catch (error) {
      return { kind: 'error', text: `用量预算命令失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // Services may mount after this plugin, so wait for them instead of sampling the
  // container once at apply time. Sampling once left every route unmounted whenever
  // the web server happened to load later, which surfaced as 404s in the settings page.
  ctx.inject(['commands'], (inner) => {
    if (inner.commands === undefined || inner.commands === null) return
    inner.effect(() => inner.commands.register({
      name: 'budget',
      description: '查看或设置本会话的用量上限（token / 金额 / 时长）与峰时自动恢复，到达上限即停止模型会话',
      input: { hint: '[status | set tokens=200k money=5 time=60m | peak on|off|auto | reset | off]' },
      handler: handleCommand,
    }), 'session-budget.command')
  })

  // ------------------------------------------------------------- Web UI JSON

  ctx.inject(['webServer'], (web) => {
    const webServer = web.webServer
    if (webServer === undefined || webServer === null) return
    const sendJson = (res, status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }
    const readBody = async (req) => {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 64 * 1024) throw new Error('request body too large')
        chunks.push(chunk)
      }
      if (chunks.length === 0) return undefined
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
    const sameOrigin = (req) => {
      const origin = req.headers.origin
      if (origin === undefined) return true
      let expected
      try {
        expected = webServer.getOrigin?.()
      } catch (error) {
        return true
      }
      return expected === undefined || origin === expected
    }
    const handler = async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const action = url.pathname.slice(`${ROUTE_PREFIX}`.length).replace(/^\/+/, '')
        if (req.method === 'GET' && action === 'config') {
          return sendJson(res, 200, configPayload())
        }
        if (req.method === 'POST' && action === 'config') {
          if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          if (body?.reset === true) {
            store.clearConfig()
            reloadConfig()
            warnPrices()
            try {
              sweep()
            } catch (error) {
              // best effort
            }
            return sendJson(res, 200, configPayload())
          }
          const result = applyConfigPatch(body?.values)
          if (result.error !== undefined) return sendJson(res, 400, { error: result.error })
          return sendJson(res, 200, configPayload())
        }
        if (req.method === 'GET' && action === 'sync') {
          return sendJson(res, 200, syncSummary())
        }
        if (req.method === 'POST' && action === 'sync') {
          if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          if (body?.all !== true && body?.pricing !== true && body?.holidays !== true) {
            return sendJson(res, 400, { error: '需要指定 pricing、holidays 或 all' })
          }
          const kinds = body?.all === true
            ? {}
            : { pricing: body?.pricing === true, holidays: body?.holidays === true }
          const result = await syncAll(kinds)
          return sendJson(res, 200, { ...configPayload(), result })
        }
        if (req.method === 'GET' && (action === 'status' || action === '')) {
          const sessionId = url.searchParams.get('session') ?? ''
          if (sessionId !== '') {
            const record = store.get(sessionId)
            if (record !== undefined) {
              try {
                seedUsage(sessionId, record)
              } catch (error) {
                // read-only view falls back to the stored counters
              }
            }
          }
          return sendJson(res, 200, viewOf(sessionId === '' ? undefined : store.get(sessionId), sessionId === '' ? undefined : sessionId))
        }
        if (req.method === 'POST' && action === 'update') {
          if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          const body = await readBody(req)
          const sessionId = typeof body?.session === 'string' ? body.session : ''
          if (sessionId === '') return sendJson(res, 400, { error: 'missing session' })
          if (body?.peak === true || body?.peak === false || body?.peak === 'auto') {
            store.setPeak(sessionId, body.peak === 'auto' ? undefined : body.peak === true)
            const agent = liveAgent(sessionId)
            const windows = peakWindowsOf()
            const state = windows.length === 0 ? { active: false } : peakNow()
            if (agent !== undefined && peakFollowed(sessionId) && state.active) peakStop(sessionId, agent, state)
            else resumeAfterPeak(sessionId)
            return sendJson(res, 200, viewOf(store.get(sessionId), sessionId))
          }
          if (body?.operation === 'clear') {
            store.delete(sessionId)
            resumeOwnGoal(sessionId)
            return sendJson(res, 200, viewOf(undefined, sessionId))
          }
          if (body?.operation === 'reset') {
            const record = store.get(sessionId)
            if (record !== undefined) {
              record.used = ZERO_BUCKETS()
              record.last = null
              record.seeded = true
              record.exhausted = null
              record.startedAt = Date.now()
              store.saveSoon()
              resumeOwnGoal(sessionId)
            }
            return sendJson(res, 200, viewOf(store.get(sessionId), sessionId))
          }
          const limits = {
            tokens: toInt(body?.limits?.tokens),
            money: Math.max(0, Number(body?.limits?.money) || 0),
            minutes: Math.max(0, Number(body?.limits?.minutes) || 0),
          }
          if (limits.tokens === 0 && limits.money === 0 && limits.minutes === 0) {
            store.delete(sessionId)
            resumeOwnGoal(sessionId)
            return sendJson(res, 200, viewOf(undefined, sessionId))
          }
          const current = store.get(sessionId)
          const record = {
            limits,
            startedAt: current?.startedAt ?? Date.now(),
            used: current?.used ?? ZERO_BUCKETS(),
            last: current?.last ?? null,
            exhausted: null,
            seeded: current?.seeded ?? false,
          }
          store.set(sessionId, record)
          seedUsage(sessionId, record)
          checkAndEnforce(sessionId, record)
          if (record.exhausted === null) resumeOwnGoal(sessionId)
          return sendJson(res, 200, viewOf(store.get(sessionId), sessionId))
        }
        return sendJson(res, 404, { error: 'not found' })
      } catch (error) {
        log?.warn?.(`session-budget: request failed: ${error instanceof Error ? error.message : String(error)}`)
        try {
          sendJson(res, 500, { error: 'internal error' })
        } catch (nested) {
          // response already gone
        }
      }
    }
    web.effect(() => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'session-budget.route')
  })

  ctx.effect(() => () => {
    void store.dispose()
  }, 'session-budget.store')
}

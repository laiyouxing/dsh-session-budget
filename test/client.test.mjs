// Offline smoke test for the session-budget browser artifact.
// Evaluates client.js with stubbed module loader / React / slot context, then
// renders the strip in two scenarios to catch render-path and layout mistakes:
//   1. no budget yet (single line, "set a budget" affordance)
//   2. budget set and already stopped (chips + stopped tag, one nowrap row)
import fs from 'node:fs'
import path from 'node:path'

const SOURCE = path.resolve(import.meta.dirname, '..', 'client.js')
const source = fs.readFileSync(SOURCE, 'utf8')

let failures = 0
const assert = (condition, label) => {
  if (condition) console.log(`ok   ${label}`)
  else { failures += 1; console.error(`FAIL: ${label}`) }
}

/** Loads the artifact once with the given React stub; returns {module, registrations, dictionaries}. */
const load = (makeReact) => {
  let loaded
  const window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  new Function('window', source)(window)
  const registrations = []
  const dictionaries = []
  const ctx = {
    effect(factory) { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
    locale: {
      register: (namespace, dicts) => { dictionaries.push({ namespace, dicts }); return () => {} },
      bind: (namespace) => (key) => {
        const registered = dictionaries.find((item) => item.namespace === namespace)?.dicts?.zh ?? {}
        return registered[key] ?? key
      },
    },
    slots: {
      inject(owner, factory) { return factory() },
      register(options, component) { const entry = { options, component }; registrations.push(entry); return entry },
    },
  }
  const module = loaded.factory((id) => {
    if (id === 'react') return makeReact()
    throw new Error(`unexpected module: ${id}`)
  })
  module.apply(ctx)
  return { module, registrations, dictionaries }
}

/** React stub with plain hooks; presetState overrides useState values in call order. */
const makeReact = (presetState) => {
  let index = 0
  return {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      const preset = presetState?.[index]
      index += 1
      return [preset === undefined ? (typeof initial === 'function' ? initial() : initial) : preset, () => {}]
    },
    useEffect() {},
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
  }
}

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out }
  if (typeof node.type === 'function') { flatten(node.type({ ...node.props, ...(node.props ?? {}) }), out); return out }
  for (const child of node.children.flat(4)) flatten(child, out)
  return out
}

/** Collects every inline style object in the tree. */
const styles = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) styles(child, out); return out }
  if (node.props?.style) out.push(node.props.style)
  if (typeof node.type === 'function') { styles(node.type({ ...node.props, ...(node.props ?? {}) }), out); return out }
  for (const child of (node.children ?? []).flat(4)) styles(child, out)
  return out
}

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ hasBudget: false, limits: {}, usage: {}, remaining: {}, exhausted: null }),
})
globalThis.document = { visibilityState: 'visible' }

// --- scenario 1: no budget yet ---------------------------------------------
const first = load(() => makeReact())
assert(first.registrations.length === 4, 'four slot registrations: strip + three settings seats')
const entry = first.registrations.find((item) => item.options.name === 'conversation.input.dock')
assert(entry !== undefined, 'the composer strip is registered')
assert(entry.options.name === 'conversation.input.dock', 'registered on the composer dock')
assert(entry.options.id === 'session-budget', 'stable slot id')
assert(entry.options.locale === 'session-budget', 'slot registration uses the locale namespace')
assert(typeof entry.options.inject === 'function', 'registration injects props')

const dictionaries = first.dictionaries[0]?.dicts ?? {}
assert(first.dictionaries[0]?.namespace === 'session-budget', 'locale namespace')
for (const locale of ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) {
  assert(typeof dictionaries[locale] === 'object', `dictionary for ${locale}`)
}

const props = entry.options.inject('session-1')
assert(props.sessionId === 'session-1', 'session id reaches the component')

const t = (key) => (dictionaries.zh[key] ?? key)
const tree = entry.component({ ...props, t })
assert(tree !== null && typeof tree === 'object', 'component renders a tree')
const texts = flatten(tree)
assert(texts.includes('本会话未设用量上限'), 'unset copy from zh dictionary')
assert(texts.includes('设置上限'), 'set button copy from zh dictionary')

// --- scenario 2: budget set, token dimension exhausted ----------------------
const stoppedView = {
  hasBudget: true,
  enabled: true,
  limits: { tokens: 50000000, money: 5, minutes: 60 },
  usage: { tokens: 15300000, money: 1.2, minutes: 12 },
  remaining: { tokens: 34700000, money: 3.8, minutes: 48 },
  exhausted: { dimension: 'tokens', message: 'token limit reached' },
  startedAt: 1,
  currency: 'CNY',
  pricesConfigured: true,
}
const second = load(() => makeReact([stoppedView, false, { tokens: '', money: '', minutes: '' }, '', false]))
const tree2 = second.registrations.find((item) => item.options.name === 'conversation.input.dock').component({ ...props, t })
const texts2 = flatten(tree2)
assert(texts2.includes('已停止'), 'stopped tag rendered')
assert(texts2.includes('token'), 'token chip label rendered')
assert(texts2.includes('15M / 50M'), 'token chip shows used / limit')
assert(texts2.includes('¥1.20 / ¥5.00'), 'money chip shows used / limit')
assert(texts2.includes('编辑'), 'edit affordance when a budget exists')

// Layout contract: the collapsed row must be a single nowrap line that cannot
// widen its slot, and no metric may reserve a fixed 132px column again.
const allStyles = styles(tree2)
const row = allStyles.find((style) => style.whiteSpace === 'nowrap' && style.display === 'flex' && style.overflow === 'hidden')
assert(row !== undefined, 'collapsed row is nowrap + overflow hidden')
assert(row.flexWrap === undefined, 'collapsed row does not wrap')
assert(!allStyles.some((style) => style.minWidth === 132 || style.flex === '1 1 132px'), 'no fixed 132px metric column')
assert(allStyles.some((style) => style.minWidth === 0), 'flex children may shrink (minWidth 0 present)')
const root = tree2.props.style
assert(root.minWidth === 0, 'root clamps to slot width')
assert(typeof root.border === 'string' && root.border.includes('1px solid'), 'root restores the visible frame')
assert(typeof root.borderRadius === 'number' && root.borderRadius > 0, 'root is a rounded card')
assert(typeof root.background === 'string' && root.background !== '', 'root paints a card surface')

// --- scenario 3: peak window active, editor open ---------------------------
const peakView = {
  hasBudget: true,
  enabled: true,
  limits: { tokens: 50000000, money: 0, minutes: 0 },
  usage: { tokens: 10000000, money: 0, minutes: 25 },
  remaining: { tokens: 40000000, money: null, minutes: null },
  exhausted: null,
  startedAt: 1,
  currency: 'CNY',
  pricesConfigured: true,
  peak: {
    configured: true,
    windows: '09:00-12:00',
    timezone: '',
    followed: true,
    autoResume: true,
    active: true,
    minutesLeft: 12,
    paused: true,
  },
}
const third = load(() => makeReact([peakView, true, { tokens: '', money: '', minutes: '' }, '', false]))
const tree3 = third.registrations.find((item) => item.options.name === 'conversation.input.dock').component({ ...props, t })
const texts3 = flatten(tree3)
assert(texts3.includes('峰时暂停'), 'peak tag rendered while a peak window is active')
assert(texts3.includes('12 分钟后恢复'), 'peak tag counts down to the valley')
assert(texts3.some((text) => text.includes('峰时暂停、谷时自动继续')), 'editor shows the peak switch with its windows')

/** Finds every node matching a predicate, crossing function components. */
const find = (node, predicate, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) find(child, predicate, out); return out }
  if (typeof node.type === 'function') { find(node.type({ ...node.props }), predicate, out); return out }
  if (predicate(node)) out.push(node)
  for (const child of (node.children ?? []).flat(4)) find(child, predicate, out)
  return out
}
const checkboxes = find(tree3, (node) => node.props?.type === 'checkbox')
assert(checkboxes.length === 1, 'exactly one peak checkbox exists')
assert(checkboxes[0]?.props?.checked === true, 'peak checkbox reflects the followed state')
assert(checkboxes[0]?.props?.disabled === false, 'peak checkbox is operable once windows are configured')
const textInputs = find(tree3, (node) => node.props?.type === 'text')
assert(textInputs.length === 3, 'three numeric fields render')
assert(textInputs.every((node) => node.props?.placeholder === undefined), 'no sample placeholders inside the fields')
const hintNodes = find(tree3, (node) => typeof node.children?.[0] === 'string' && node.children[0].includes('200k'))
assert(hintNodes.length >= 1, 'the examples live in the hint line above the fields')

// --- scenario 4: the settings page renders wherever it is mounted ----------
const configPayload = {
  fields: [
    { key: 'enabled', group: 'general', kind: 'boolean', label: '启用', description: '总开关。', editable: true, default: true, value: true, overridden: false },
    { key: 'peakWindows', group: 'peak', kind: 'string', label: '峰时时段', description: '格式 HH:MM-HH:MM，逗号分隔。', editable: true, default: '09:00-12:00,14:00-18:00', value: '09:00-12:00,14:00-18:00', overridden: false },
    { key: 'priceInputPerMillion', group: 'pricing', kind: 'number', label: '输入单价', description: '每百万 token 的价格。', editable: true, default: 0, value: 0, overridden: false },
  ],
  overridden: [],
  peak: {
    configured: true,
    windows: '09:00-12:00,14:00-18:00',
    timezone: 'Asia/Shanghai',
    weekdays: 'mon-fri',
    active: true,
    minutesLeft: 42,
    todaySkipped: false,
    todayOutsideWeekdays: false,
  },
  storeFile: 'C:/Users/youxi/.dsh/session-budget/budgets.json',
}
// `adopt()` fills the drafts from the payload after the GET; mirror that state
// here because the stub useEffect never runs.
const settingsValues = Object.fromEntries(configPayload.fields.map((field) => [field.key, field.value]))
const fourth = load(() => makeReact([configPayload, settingsValues, '', '', false]))
const seatNames = fourth.registrations.map((item) => item.options.name)
assert(seatNames.includes('settings.section'), 'settings page is registered as a sidebar section')
assert(seatNames.includes('plugins.bundle.config'), 'settings page is registered on the bundle page')
assert(seatNames.includes('plugins.row.config'), 'settings page is registered on the bundle row page')
const sectionSeat = fourth.registrations.find((item) => item.options.name === 'settings.section')
assert(sectionSeat.options.id === 'session-budget', 'settings section carries its own id')
assert(typeof sectionSeat.options.label === 'function' && sectionSeat.options.label() === '会话用量预算', 'settings nav label is localized')
const bundleSeat = fourth.registrations.find((item) => item.options.name === 'plugins.bundle.config')
assert(bundleSeat.options.key === 'dsh-session-budget', 'bundle config key matches the package name')
const rowSeat = fourth.registrations.find((item) => item.options.name === 'plugins.row.config')
assert(rowSeat.options.key === 'dsh-session-budget#session-budget', 'row config key matches package#rowId')
const tree4 = sectionSeat.component({ t })
const texts4 = flatten(tree4)
assert(texts4.includes('会话用量预算'), 'settings page renders its title')
assert(texts4.includes('峰时与谷时'), 'settings page renders the peak group')
assert(texts4.includes('峰时时段'), 'settings page renders the peak windows field')
assert(texts4.includes('当前是峰时，约 42 分钟后进入谷时'), 'settings page reports the live peak state')
assert(texts4.includes('保存设置'), 'settings page renders the save action')
assert(texts4.includes('恢复默认'), 'settings page renders the restore action')
const checkbox4 = find(tree4, (node) => node.props?.type === 'checkbox')
assert(checkbox4.length === 1 && checkbox4[0].props.checked === true, 'boolean fields render as checkboxes')
const peakInput = find(tree4, (node) => node.props?.value === '09:00-12:00,14:00-18:00')
assert(peakInput.length === 1, 'text fields render the current value')
assert(peakInput[0].props.placeholder === undefined, 'settings fields keep samples out of placeholders')

console.log(failures === 0 ? 'RESULT: PASSED' : `RESULT: FAILED (${failures})`)

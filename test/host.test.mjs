// Offline smoke test for the session-budget host plugin.
// Builds a copy of index.js with a stubbed schemastery import, then drives a
// fake cordis context through the enforcement paths.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const build = path.join(os.tmpdir(), 'dsh-session-budget-tests')
fs.mkdirSync(build, { recursive: true })

const stub = path.join(build, 'schemastery-stub.mjs')
fs.writeFileSync(stub, `const field = (extra = {}) => ({
  ...extra,
  type: 'field',
  default: (v) => field({ ...extra, default: v }),
  required: () => field({ ...extra, default: undefined, required: true }),
  description: (text) => field({ ...extra, description: text }),
})
const mk = () => field()
export default { object: (shape) => ({ type: 'object', shape }), boolean: () => mk(), number: () => mk(), string: () => mk() }
`)

const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8').replace(
  "import z from '@deepseek-ai/schemastery'",
  "import z from './schemastery-stub.mjs'",
)
const target = path.join(build, 'index.test.mjs')
fs.writeFileSync(target, source)

const { apply } = await import(pathToFileURL(target).href)

const listeners = new Map()
const effects = []
const calls = { block: [], pause: [], cancel: [], reject: 0, next: 0, command: [], route: undefined }
const agents = []
const goal = { id: 'goal-1', revision: 3, phase: 'active', blockedReason: null }

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
    return () => {}
  },
  effect(factory) {
    const disposer = factory()
    effects.push(disposer)
    return () => {}
  },
  // The plugin starts its optional services with `ctx.inject([...], cb)` so it works
  // no matter which entry mounts first; the stub runs the callback with a child ctx
  // whose services are available as properties, like the real Cordis fiber.
  inject(services, callback) {
    const child = { ...ctx }
    for (const name of services) child[name] = ctx.get(name)
    callback(child)
    return () => {}
  },
  get(service) {
    if (service === 'agents') return { get: (id) => agents.find((a) => a.id === id), list: () => agents }
    if (service === 'goals') {
      return {
        get: () => ({ ...goal }),
        block: (agent, ref, reason) => { calls.block.push({ ref, reason }); goal.phase = 'blocked'; goal.blockedReason = reason },
        pause: (agent, ref) => { calls.pause.push({ ref }); goal.phase = 'paused' },
        resume: () => { goal.phase = 'active'; goal.blockedReason = null },
      }
    }
    if (service === 'commands') return { register: (definition) => { calls.command.push(definition); return () => {} } }
    if (service === 'webServer') return {
      register: (route) => { calls.route = route; return () => {} },
      getOrigin: () => 'http://127.0.0.1:1',
    }
    return undefined
  },
}

const dataFile = path.join(build, 'budgets.json')
try { fs.unlinkSync(dataFile) } catch {}

const config = {
  enabled: true,
  defaultTokens: 0,
  defaultMoney: 0,
  defaultMinutes: 0,
  priceInputPerMillion: 2,
  priceCacheReadPerMillion: 0,
  priceCacheWritePerMillion: 0,
  priceOutputPerMillion: 8,
  currency: 'CNY',
  onExceed: 'block',
  dataFile,
  checkIntervalMs: 1000,
  peakWindows: '',
  peakTimezone: '',
  peakWeekdays: '',
  peakSkipDates: '',
  peakAutoResume: true,
}

// Capture interval callbacks so the peak/valley sweep can be driven deterministically.
const timers = []
globalThis.setInterval = (fn) => { timers.push(fn); return 0 }
const tick = () => { for (const fn of timers) fn() }

apply(ctx, config)

const agent = {
  id: 'session-1',
  status: 'running',
  cancel(cause) { calls.cancel.push(cause); this.status = 'idle' },
}
agents.push(agent)

const emit = (event, handlerArgs) => {
  for (const handler of listeners.get(event) ?? []) handler(...handlerArgs)
}
const emitPreStep = () => {
  let decision
  for (const handler of listeners.get('agent/pre-step') ?? []) {
    decision = handler({ agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal }, () => {
      calls.next += 1
      return { kind: 'enter', messages: [] }
    })
    if (decision?.kind === 'reject') calls.reject += 1
  }
  return decision
}
const command = async (line) => {
  const definition = calls.command[0]
  return await definition.handler({ agent, rawInput: line, attachments: [], signal: new AbortController().signal })
}

let failures = 0
const assert = (condition, label) => {
  if (!condition) {
    failures += 1
    console.error(`FAIL: ${label}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

assert(emitPreStep()?.kind === 'enter', 'no budget: step enters')

const set = await command('set tokens=1000')
assert(set.kind === 'success', 'command set succeeds')
assert(set.text.includes('1,000'), 'set text shows the limit')

emit('session/event', [{ id: 'session-1' }, { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50 } } }])
assert(emitPreStep()?.kind === 'enter', 'under limit: step enters')

emit('session/event', [{ id: 'session-1' }, { type: 'assistant/message', data: { turn: 1, step: 2, usage: { inputTokens: 900, outputTokens: 100 } } }])
assert(calls.block.length === 1, 'breach blocks the active goal once')
assert(calls.block[0]?.reason?.code === 'budget-exhausted', 'blocker code is budget-exhausted')
assert(calls.cancel.length === 1 && calls.cancel[0].kind === 'hook', 'running turn is cancelled')
assert(emitPreStep()?.kind === 'reject', 'exhausted: step is rejected')

const status = await command('')
assert(status.text.includes('已停止'), 'status reports stopped')
assert(status.text.includes('1,150'), 'status shows accumulated tokens')

const reset = await command('reset')
assert(reset.kind === 'success', 'reset succeeds')
assert(goal.phase === 'active', 'reset resumes the budget-blocked goal')
agent.status = 'running'
assert(emitPreStep()?.kind === 'enter', 'after reset: step enters')

emit('session/event', [{ id: 'session-1' }, { type: 'assistant/message', data: { turn: 2, step: 1, usage: { inputTokens: 10, outputTokens: 10 } } }])
emit('session/event', [{ id: 'session-1' }, { type: 'assistant/message', data: { turn: 2, step: 1, usage: { inputTokens: 20, outputTokens: 20 } } }])
const afterReplace = await command('')
assert(afterReplace.text.includes('40'), 'replacement sample counted once (40 tokens)')

const money = await command('set tokens=0 money=0.001')
assert(money.kind === 'success', 'money budget accepted')
goal.phase = 'active'
emit('session/event', [{ id: 'session-1' }, { type: 'assistant/message', data: { turn: 3, step: 1, usage: { inputTokens: 1000, outputTokens: 0 } } }])
assert(calls.block.length === 2, 'money breach blocks the goal')

const off = await command('off')
assert(off.kind === 'success', 'off succeeds')
agent.status = 'running'
assert(emitPreStep()?.kind === 'enter', 'after off: step enters')

// ---- seeding a session that already logged usage before the limit was set ----
const history = [
  { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 300, outputTokens: 200 } } },
  { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 300, outputTokens: 200 } } },
  { type: 'assistant/message', data: { turn: 2, step: 1, usage: { inputTokens: 100, outputTokens: 50 } } },
]
const agent2 = { id: 'session-2', status: 'idle', cancel(cause) { calls.cancel.push(cause) }, session: { seq: 3, ownEvents: () => history } }
agents.push(agent2)
goal.phase = 'active'
goal.blockedReason = null
const blocksBefore = calls.block.length
const set2 = await calls.command[0].handler({ agent: agent2, rawInput: 'set tokens=300', attachments: [], signal: new AbortController().signal })
assert(set2.kind === 'success', 'set on a session with history succeeds')
assert(set2.text.includes('650'), 'status line counts usage logged before the limit (650)')
assert(calls.block.length === blocksBefore + 1, 'already-spent usage above the new limit stops the goal immediately')

const routeRes = {
  status: 0,
  body: null,
  writeHead(status) { this.status = status },
  end(body) { this.body = body },
}
await calls.route.handler({ method: 'GET', url: '/session-budget/status?session=session-2', headers: {} }, routeRes)
const routeView = JSON.parse(routeRes.body)
assert(routeView.hasBudget === true, 'status route reports the seeded budget')
assert(routeView.usage.tokens === 650, 'status route serves seeded usage (650)')
assert(routeView.exhausted !== null, 'status route reports the stopped state')

// ---- peak / valley windows: stop in peak, resume automatically in valley ----
const pad2 = (value) => String(value).padStart(2, '0')
const clockAt = (minutes) => {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`
}
const localMinutes = () => { const now = new Date(); return now.getHours() * 60 + now.getMinutes() }
const windowAroundNow = (before, after) => `${clockAt(localMinutes() - before)}-${clockAt(localMinutes() + after)}`
const readRoute = async (method, url, body) => {
  const res = { status: 0, body: null, writeHead(status) { this.status = status }, end(value) { this.body = value } }
  const req = {
    method,
    url,
    headers: { origin: 'http://127.0.0.1:1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await calls.route.handler(req, res)
  return JSON.parse(res.body)
}
// Settings are edited through the plugin's own route (the Settings page uses it);
// mutating the profile-row object no longer changes behaviour after apply().
const setConfig = async (values) => readRoute('POST', '/session-budget/config', { values })

goal.phase = 'active'
goal.blockedReason = null
agent.status = 'running'
const cancelsBefore = calls.cancel.length
const pausesBefore = calls.pause.length
await setConfig({ peakWindows: windowAroundNow(30, 30) })
tick()
assert(goal.phase === 'paused', 'peak window pauses the active goal')
assert(calls.pause.length === pausesBefore + 1, 'peak pauses through the goal service')
assert(calls.cancel.length === cancelsBefore + 1 && calls.cancel.at(-1).kind === 'hook', 'peak cancels the running turn')
assert(emitPreStep()?.kind === 'reject', 'peak keeps rejecting steps')

const peakStatus = await command('')
assert(peakStatus.text.includes('峰时'), 'status mentions the peak schedule')

const peakView = await readRoute('GET', '/session-budget/status?session=session-1')
assert(peakView.peak.configured === true && peakView.peak.active === true, 'status route reports an active peak window')
assert(peakView.peak.followed === true && peakView.peak.paused === true, 'status route reports the paused session')

const peakOff = await command('peak off')
assert(peakOff.text.includes('不跟随'), 'peak off turns the schedule off for this session')
assert(goal.phase === 'active', 'peak off resumes the goal it paused')
agent.status = 'running'
assert(emitPreStep()?.kind === 'enter', 'with the schedule off a step enters again')

const peakOn = await command('peak on')
assert(peakOn.text.includes('跟随'), 'peak on restores the schedule')
assert(goal.phase === 'paused', 'peak on pauses the goal again')

await setConfig({ peakWindows: '' })
tick()
assert(goal.phase === 'active', 'valley window resumes the peak-paused goal')
agent.status = 'running'
assert(emitPreStep()?.kind === 'enter', 'valley window lets steps enter again')

await setConfig({ peakWindows: windowAroundNow(30, 30) })
const posted = await readRoute('POST', '/session-budget/update', { session: 'session-1', peak: false })
assert(posted.peak.followed === false, 'update route can turn the peak schedule off')
agent.status = 'running'
assert(emitPreStep()?.kind === 'enter', 'per-session opt-out survives the peak gate')
await setConfig({ peakWindows: '' })

// ---- working days and holiday skip dates ----
await command('peak on')
await setConfig({ peakWindows: windowAroundNow(30, 30) })
const nowDate = new Date()
const weekdayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const todayKey = `${nowDate.getFullYear()}-${pad2(nowDate.getMonth() + 1)}-${pad2(nowDate.getDate())}`
await setConfig({ peakWeekdays: weekdayNames[(nowDate.getDay() + 1) % 7] })
tick()
assert(goal.phase === 'active', 'a weekday filter outside today lets the session run')
const weekdayView = await readRoute('GET', '/session-budget/status?session=session-1')
assert(weekdayView.peak.todayOutsideWeekdays === true, 'status reports today falls outside the weekday filter')
assert(weekdayView.peak.active === false, 'the weekday filter makes today a valley day')

await setConfig({ peakWeekdays: '' })
tick()
assert(goal.phase === 'paused', 'clearing the weekday filter restores the peak pause')

await setConfig({ peakSkipDates: todayKey })
agent.status = 'running'
tick()
assert(goal.phase === 'active', 'a skip date turns the peak window into valley')
const skipView = await readRoute('GET', '/session-budget/status?session=session-1')
assert(skipView.peak.todaySkipped === true, 'status reports the skipped holiday')
assert(skipView.peak.active === false, 'a skipped holiday is never peak')
await setConfig({ peakSkipDates: '', peakWindows: '' })
tick()

// ---- settings route: the very fields the Settings page edits ----
const initialConfig = await readRoute('GET', '/session-budget/config')
assert(initialConfig.fields.length === 17, 'config route serves every field')
assert(initialConfig.fields.find((field) => field.key === 'peakWindows')?.default === '09:00-12:00,14:00-18:00', 'config route carries the DeepSeek peak default')
assert(initialConfig.fields.find((field) => field.key === 'dataFile')?.editable === false, 'config route locks the store path')
const editedConfig = await setConfig({ peakWindows: '08:00-09:00' })
assert(editedConfig.overridden.includes('peakWindows'), 'config route records the override')
const editedStatus = await readRoute('GET', '/session-budget/status?session=session-1')
assert(editedStatus.peak.windows === '08:00-09:00', 'status route follows the edited schedule')
const rejectedPatch = await readRoute('POST', '/session-budget/config', { values: { nope: 1 } })
assert(typeof rejectedPatch.error === 'string', 'config route rejects unknown fields')
const afterReset = await readRoute('POST', '/session-budget/config', { reset: true })
assert(afterReset.overridden.length === 0, 'reset drops every override')
assert(afterReset.fields.find((field) => field.key === 'peakWindows')?.value === '', 'reset restores the profile-row value')

await new Promise((resolve) => setTimeout(resolve, 900))
const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
assert(typeof persisted.sessions === 'object', 'store file written')
assert(persisted.version === 3, 'store file carries the v3 payload')
assert(persisted.peak?.['session-1'] === true, 'store file keeps the peak preference')

for (const disposer of effects) if (typeof disposer === 'function') disposer()
console.log(failures === 0 ? 'RESULT: PASSED' : `RESULT: FAILED (${failures})`)

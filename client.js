/**
 * Client half of session-budget: one compact budget line above the message
 * composer, inside a subtle card so it reads as a surface and not as loose text.
 * It reads and writes the host plugin's JSON route, so the strip works without
 * any Harness Client package and without a generated RPC descriptor. Visible
 * copy goes through the Client locale service.
 *
 * Layout rule: the collapsed line is a single row that never wraps and never
 * grows wider than its slot, because the composer dock is narrow. Exact numbers,
 * the peak schedule and the edit controls live in the editor, which the user
 * opens deliberately.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-budget',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /** Locale namespace owned by this plugin. */
    const NS = 'session-budget'
    /** Same-origin route registered by the host half. */
    const ENDPOINT = '/session-budget'
    /** Font size shared by every piece of the collapsed line. */
    const TEXT = 11.5

    const en = {
      'meta.title': 'Session budget',
      'strip.unset': 'No budget for this session',
      'strip.set': 'Set a budget',
      'strip.hint': 'Reaching any limit stops the model session. Tokens accept 200k, cost is an amount like 5, time is in minutes like 60; leave a field at 0 to leave that limit off.',
      'strip.tokens': 'Tokens',
      'strip.money': 'Cost',
      'strip.time': 'Time',
      'strip.minutes': 'min',
      'strip.status': 'Running',
      'strip.exhausted': 'Stopped',
      'strip.elapsed': 'elapsed',
      'strip.open': 'Edit budget',
      'strip.close': 'Close',
      'strip.save': 'Save',
      'strip.reset': 'Reset usage',
      'strip.clear': 'Remove budget',
      'strip.zero': 'Leave 0 to disable that limit.',
      'strip.saving': 'Saving…',
      'strip.unlimited': 'unlimited',
      'strip.peak': 'Peak pause',
      'strip.peakLeft': 'resumes in {n} min',
      'strip.peakCheckbox': 'Pause at peak, resume in valley',
      'strip.peakUnset': 'No peak schedule yet — fill in the peak windows in the plugin settings to pause at peak and resume in the valley',
      'strip.peakValleyToday': 'today runs as valley',
      'settings.nav': 'Session budget',
      'settings.title': 'Session budget',
      'settings.intro': 'When any limit is reached the model session stops: the goal is blocked (or paused) and the running turn is cancelled. These values are the defaults for new sessions; a single session can still be changed from the budget line above the composer or with /budget.',
      'settings.loading': 'Loading settings…',
      'settings.save': 'Save settings',
      'settings.saving': 'Saving…',
      'settings.saved': 'Saved. New values apply immediately.',
      'settings.defaults': 'Restore defaults',
      'settings.restart': 'Takes effect after the plugin restarts.',
      'settings.overridden': 'changed here',
      'settings.defaultValue': 'default {value}',
      'settings.peakNow': 'Peak hours now — about {n} minutes until the valley',
      'settings.peakValley': 'Valley hours now',
      'settings.peakOff': 'No peak windows configured, so sessions never pause for peak hours',
      'settings.valleyToday': 'Today is treated as valley (weekend or skipped date)',
      'settings.group.general': 'General',
      'settings.group.budget': 'Default limits for new sessions',
      'settings.group.pricing': 'Token prices',
      'settings.group.peak': 'Peak and valley hours',
      'settings.group.advanced': 'Advanced',
    }
    const zh = {
      'meta.title': '会话用量预算',
      'strip.unset': '本会话未设用量上限',
      'strip.set': '设置上限',
      'strip.hint': '到达任一上限即停止与模型的会话。token 可填 200k，金额填 5 这样的数字，时长按分钟填 60；某项填 0 表示不限制该项。',
      'strip.tokens': 'token',
      'strip.money': '金额',
      'strip.time': '时长',
      'strip.minutes': '分钟',
      'strip.status': '正常',
      'strip.exhausted': '已停止',
      'strip.elapsed': '已用',
      'strip.open': '编辑',
      'strip.close': '收起',
      'strip.save': '保存',
      'strip.reset': '清零用量',
      'strip.clear': '移除上限',
      'strip.zero': '填 0 表示不限制该项。',
      'strip.saving': '保存中…',
      'strip.unlimited': '不限',
      'strip.peak': '峰时暂停',
      'strip.peakLeft': '{n} 分钟后恢复',
      'strip.peakCheckbox': '峰时暂停、谷时自动继续',
      'strip.peakUnset': '还没有配置峰时排期——在插件设置里填好峰时时段，就能峰时暂停、谷时自动继续',
      'strip.peakValleyToday': '今天按谷时',
      'settings.nav': '会话用量预算',
      'settings.title': '会话用量预算',
      'settings.intro': '到达任一上限就停止与模型的会话：目标会被阻断（或暂停），正在跑的回合会被取消。这里设置的是新会话的默认值；单个会话仍可在输入框上方的预算条或 /budget 命令里单独调整。',
      'settings.loading': '正在读取设置…',
      'settings.save': '保存设置',
      'settings.saving': '保存中…',
      'settings.saved': '已保存，新设置立即生效。',
      'settings.defaults': '恢复默认',
      'settings.restart': '重启插件后生效。',
      'settings.overridden': '已在此修改',
      'settings.defaultValue': '默认 {value}',
      'settings.peakNow': '当前是峰时，约 {n} 分钟后进入谷时',
      'settings.peakValley': '当前是谷时',
      'settings.peakOff': '还没有配置峰时时段，会话不会因峰时暂停',
      'settings.valleyToday': '今天按谷时处理（周末或节假日）',
      'settings.group.general': '常规',
      'settings.group.budget': '新会话的默认上限',
      'settings.group.pricing': 'token 单价',
      'settings.group.peak': '峰时与谷时',
      'settings.group.advanced': '高级',
    }
    /** Every other locale falls back to English until a translation arrives. */
    const dictionaries = { en, zh, ja: en, es: en, fr: en, de: en, ru: en, pt: en }

    const number = (value) => {
      const n = Number(value)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    const formatTokens = (value) => {
      const n = Math.round(Number(value) || 0)
      if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
      if (n >= 1e4) return `${(n / 1e3).toFixed(0)}k`
      return n.toLocaleString('en-US')
    }
    const formatMoney = (value, currency) => {
      const n = Math.round((Number(value) || 0) * 100) / 100
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
      return `${symbol}${n.toFixed(n >= 10 ? 1 : 2)}`
    }
    const formatMinutes = (value) => {
      const n = Number(value) || 0
      if (n >= 60) return `${(n / 60).toFixed(n >= 600 ? 0 : 1)}h`
      return `${Math.round(n * 10) / 10}m`
    }

    /** 22px hairline progress bar that sits inside a chip. */
    const meterStyle = {
      position: 'relative',
      flex: '0 0 auto',
      width: 22,
      height: 3,
      borderRadius: 2,
      background: 'var(--dsw-alias-border-l1)',
      overflow: 'hidden',
    }
    const meterFill = (fraction, exhausted) => ({
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: `${Math.min(100, Math.max(2, fraction * 100))}%`,
      borderRadius: 2,
      background: exhausted ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
      transition: 'width 240ms ease',
    })

    /**
     * One inline metric: muted label, used value, limit, hairline meter.
     * Everything is nowrap so three metrics still fit on one composer line.
     */
    function LimitChip({ label, used, limit, value, title, exhausted }) {
      const fraction = limit > 0 ? used / limit : 0
      return h('span', {
        title,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          flex: '0 0 auto',
          whiteSpace: 'nowrap',
          fontSize: TEXT,
          lineHeight: '16px',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }, [
        h('span', { key: 'label', style: { opacity: 0.85 } }, label),
        h('span', {
          key: 'value',
          style: {
            color: exhausted ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
            fontVariantNumeric: 'tabular-nums',
          },
        }, value),
        h('span', { key: 'meter', style: meterStyle }, h('span', { style: meterFill(fraction, exhausted) })),
      ])
    }

    /** The composer strip: one compact row when collapsed, editor when open. */
    function BudgetStrip(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => en[key] ?? key
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [view, setView] = React.useState(undefined)
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState({ tokens: '', money: '', minutes: '' })
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        if (sessionId === '') return
        try {
          const response = await fetch(`${ENDPOINT}/status?session=${encodeURIComponent(sessionId)}`, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) return
          const payload = await response.json()
          setView(payload)
        } catch (failure) {
          // The host may be restarting; keep the last known view.
        }
      }, [sessionId])

      React.useEffect(() => {
        void load()
      }, [load])

      React.useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load()
        }, 3000)
        return () => clearInterval(timer)
      }, [load])

      const beginEdit = () => {
        const limits = view?.limits ?? { tokens: 0, money: 0, minutes: 0 }
        setDraft({
          tokens: limits.tokens > 0 ? String(limits.tokens) : '',
          money: limits.money > 0 ? String(limits.money) : '',
          minutes: limits.minutes > 0 ? String(limits.minutes) : '',
        })
        setError('')
        setOpen(true)
      }

      const send = async (body) => {
        if (sessionId === '') return
        setBusy(true)
        setError('')
        try {
          const response = await fetch(`${ENDPOINT}/update`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ session: sessionId, ...body }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            setError(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
            return
          }
          setView(payload)
          if (body.operation === undefined) setOpen(false)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const save = () => {
        const parseTokens = (text) => {
          const match = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(text)
          if (match === null) return undefined
          const scale = match[2].toLowerCase() === 'k' ? 1e3 : match[2].toLowerCase() === 'm' ? 1e6 : 1
          return Math.round(Number(match[1]) * scale)
        }
        const tokens = draft.tokens.trim() === '' ? 0 : parseTokens(draft.tokens)
        if (tokens === undefined) {
          setError('token')
          return
        }
        void send({
          limits: {
            tokens,
            money: number(draft.money),
            minutes: number(draft.minutes),
          },
        })
      }

      const exhausted = view?.exhausted ?? null
      const limits = view?.limits ?? { tokens: 0, money: 0, minutes: 0 }
      const usage = view?.usage ?? { tokens: 0, money: 0, minutes: 0 }
      const hasBudget = view?.hasBudget === true
      const stopped = exhausted !== null
      const peak = view?.peak ?? undefined
      const peakActive = peak?.configured === true && peak?.followed === true && peak?.active === true
      const chips = []

      if (hasBudget && limits.tokens > 0) {
        chips.push(h(LimitChip, {
          key: 'tokens',
          label: t('strip.tokens'),
          used: usage.tokens,
          limit: limits.tokens,
          value: `${formatTokens(usage.tokens)} / ${formatTokens(limits.tokens)}`,
          title: `${t('strip.tokens')}: ${formatTokens(usage.tokens)} / ${formatTokens(limits.tokens)}`,
          exhausted: exhausted?.dimension === 'tokens',
        }))
      }
      if (hasBudget && limits.money > 0) {
        chips.push(h(LimitChip, {
          key: 'money',
          label: t('strip.money'),
          used: usage.money,
          limit: limits.money,
          value: `${formatMoney(usage.money, view?.currency)} / ${formatMoney(limits.money, view?.currency)}`,
          title: `${t('strip.money')}: ${formatMoney(usage.money, view?.currency)} / ${formatMoney(limits.money, view?.currency)}`,
          exhausted: exhausted?.dimension === 'money',
        }))
      }
      if (hasBudget && limits.minutes > 0) {
        chips.push(h(LimitChip, {
          key: 'time',
          label: t('strip.time'),
          used: usage.minutes,
          limit: limits.minutes,
          value: `${formatMinutes(usage.minutes)} / ${formatMinutes(limits.minutes)}`,
          title: `${t('strip.time')}: ${formatMinutes(usage.minutes)} / ${formatMinutes(limits.minutes)}`,
          exhausted: exhausted?.dimension === 'time',
        }))
      }

      /** Thin vertical rule between chips, so the row stays scannable. */
      const divider = (key) => h('span', {
        key,
        style: { width: 1, height: 10, flex: '0 0 auto', background: 'var(--dsw-alias-border-l1)' },
      })

      const dot = h('span', {
        key: 'dot',
        style: {
          flex: '0 0 auto',
          width: 6,
          height: 6,
          borderRadius: 3,
          background: stopped
            ? 'var(--dsw-alias-state-error-primary)'
            : peakActive
              ? 'var(--dsw-alias-state-warn-primary)'
              : hasBudget ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
        },
      })

      const summary = hasBudget
        ? chips.flatMap((chip, index) => (index === 0 ? [chip] : [divider(`d${index}`), chip]))
        : h('span', {
          key: 'unset',
          style: {
            flex: '0 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: TEXT,
            lineHeight: '16px',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, t('strip.unset'))

      const toggle = h('button', {
        type: 'button',
        onClick: () => (open ? setOpen(false) : beginEdit()),
        title: open ? t('strip.close') : t('strip.open'),
        'aria-expanded': open ? 'true' : 'false',
        style: {
          flex: '0 0 auto',
          marginLeft: 2,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          borderRadius: 999,
          padding: '0 7px',
          height: 18,
          fontSize: TEXT,
          lineHeight: '16px',
          cursor: 'pointer',
        },
      }, hasBudget ? (open ? t('strip.close') : t('strip.open')) : t('strip.set'))

      const stopTag = stopped
        ? h('span', {
          key: 'stopped',
          title: exhausted?.message ?? '',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flex: '0 0 auto',
            whiteSpace: 'nowrap',
            fontSize: TEXT,
            lineHeight: '16px',
            fontWeight: 600,
            color: 'var(--dsw-alias-state-error-primary)',
          },
        }, t('strip.exhausted'))
        : null

      const peakTag = peakActive
        ? h('span', {
          key: 'peak',
          title: peak?.windows === undefined ? '' : `${t('strip.peak')} · ${peak.windows}`,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flex: '0 0 auto',
            whiteSpace: 'nowrap',
            fontSize: TEXT,
            lineHeight: '16px',
            color: 'var(--dsw-alias-state-warn-primary)',
          },
        }, [
          h('span', { key: 'label' }, t('strip.peak')),
          peak?.minutesLeft !== null && peak?.minutesLeft !== undefined
            ? h('span', { key: 'left', style: { color: 'var(--dsw-alias-label-secondary)' } },
              t('strip.peakLeft').replace('{n}', String(peak.minutesLeft)))
            : null,
        ])
        : null

      const field = (key, label) => h('label', {
        key,
        style: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 0', minWidth: 0 },
      }, [
        h('span', { key: 'label', style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } }, label),
        h('input', {
          key: 'input',
          type: 'text',
          inputMode: 'decimal',
          value: draft[key],
          disabled: busy,
          onChange: (event) => setDraft({ ...draft, [key]: event.target.value }),
          onKeyDown: (event) => { if (event.key === 'Enter') save() },
          style: {
            width: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            padding: '3px 6px',
            fontSize: 11.5,
            lineHeight: '16px',
          },
        }),
      ])

      const button = (key, label, onClick, primary) => h('button', {
        key,
        type: 'button',
        disabled: busy,
        onClick,
        style: {
          flex: '0 0 auto',
          border: `1px solid ${primary ? 'transparent' : 'var(--dsw-alias-border-l1)'}`,
          background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          color: primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
          borderRadius: 6,
          padding: '2px 9px',
          fontSize: 11,
          lineHeight: '16px',
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
        },
      }, label)

      /** Peak/valley switch: one row in the editor, so it never widens the strip. */
      const peakSchedule = peak?.configured === true
        ? [peak.windows, peak.weekdays].filter((part) => typeof part === 'string' && part !== '').join(' · ')
        : ''
      const peakLabel = peak?.configured === true
        ? `${t('strip.peakCheckbox')}（${peakSchedule}）`
        : t('strip.peakUnset')
      const peakValleyToday = peak?.todaySkipped === true || peak?.todayOutsideWeekdays === true
      const peakRow = h('label', {
        key: 'peak-row',
        title: peakValleyToday ? `${peakLabel} — ${t('strip.peakValleyToday')}` : peakLabel,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          fontSize: 10.5,
          lineHeight: '15px',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: peak?.configured === true ? 'pointer' : 'default',
        },
      }, [
        h('input', {
          key: 'peak-box',
          type: 'checkbox',
          checked: peak?.followed === true,
          disabled: busy || peak?.configured !== true,
          onChange: (event) => void send({ peak: event.target.checked }),
          style: { flex: '0 0 auto', margin: 0, accentColor: 'var(--dsw-alias-brand-primary)' },
        }),
        h('span', {
          key: 'peak-text',
          style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, peakValleyToday ? `${peakLabel} — ${t('strip.peakValleyToday')}` : peakLabel),
      ])

      const editor = open ? h('div', {
        key: 'editor',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          marginTop: 6,
          paddingTop: 6,
          borderTop: '1px solid var(--dsw-alias-border-l1)',
        },
      }, [
        h('div', {
          key: 'hint',
          style: { fontSize: 10.5, lineHeight: '15px', color: 'var(--dsw-alias-label-secondary)' },
        }, t('strip.hint')),
        h('div', { key: 'fields', style: { display: 'flex', gap: 6 } }, [
          field('tokens', t('strip.tokens')),
          field('money', t('strip.money')),
          field('minutes', `${t('strip.time')} (${t('strip.minutes')})`),
        ]),
        peakRow,
        h('div', { key: 'actions', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
          button('save', busy ? t('strip.saving') : t('strip.save'), save, true),
          hasBudget ? button('reset', t('strip.reset'), () => void send({ operation: 'reset' }), false) : null,
          hasBudget ? button('clear', t('strip.clear'), () => void send({ operation: 'clear' }), false) : null,
          error !== '' ? h('span', {
            key: 'error',
            style: { flex: '1 1 auto', minWidth: 0, fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' },
          }, error) : null,
        ]),
      ]) : null

      // Two layers, following the shipped dock contract (see the queue dock in
      // `ui-conversation`): `conversation.input.dock` renders straight into the
      // composer stack, a plain column flex with no padding, so a dock entry must
      // subtract both the side clearance and its own inset, cap itself at the card
      // width minus that inset, and center with `margin: auto`. Without this the
      // entry stretches to the full stack and overflows the input card.
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          boxSizing: 'border-box',
          width: 'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
          maxWidth: 'calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
          minWidth: 0,
          margin: '4px auto 2px',
          padding: '0 var(--dsh-composer-dock-inset)',
        },
      }, [
        h('div', {
          key: 'card',
          style: {
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
            width: '100%',
            minWidth: 0,
            padding: '1px 8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 9,
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            fontFamily: 'inherit',
          },
        }, [
          h('div', {
            key: 'row',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
              minHeight: 20,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            },
          }, [
            h('span', {
              key: 'metrics',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flex: '0 1 auto',
                minWidth: 0,
                overflow: 'hidden',
              },
            }, [dot, stopTag, peakTag, summary].filter(Boolean)),
            h('span', { key: 'spacer', style: { flex: '1 1 0', minWidth: 4 } }),
            toggle,
          ]),
          editor,
        ]),
      ])
    }

    /** Shared control styling for the settings page (roomy, unlike the strip). */
    const settingsInput = {
      width: 210,
      boxSizing: 'border-box',
      padding: '4px 8px',
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 6,
      outline: 'none',
    }
    const settingsSectionStyle = {
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-layer-1)',
      padding: '0 14px',
    }
    const GROUP_ORDER = ['general', 'budget', 'pricing', 'peak', 'advanced']

    /** One settings row: title and description on the left, control on the right. */
    function SettingsRow(props) {
      const { field, value, first, onChange, t } = props
      const disabled = field.editable === false
      let control
      if (field.kind === 'boolean') {
        control = h('input', {
          type: 'checkbox',
          checked: value === true,
          disabled,
          'aria-label': field.label,
          onChange: (event) => onChange(field.key, event.target.checked),
          style: { margin: 0, width: 14, height: 14, accentColor: 'var(--dsw-alias-brand-primary)' },
        })
      } else if (Array.isArray(field.options) && field.options.length > 0) {
        control = h('select', {
          value: typeof value === 'string' ? value : '',
          disabled,
          'aria-label': field.label,
          onChange: (event) => onChange(field.key, event.target.value),
          style: settingsInput,
        }, field.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
      } else {
        control = h('input', {
          type: 'text',
          value: value === undefined || value === null ? '' : String(value),
          disabled,
          'aria-label': field.label,
          onChange: (event) => onChange(field.key, event.target.value),
          style: settingsInput,
        })
      }
      const hints = []
      if (field.overridden === true) hints.push(t('settings.overridden'))
      if (disabled) hints.push(t('settings.restart'))
      return h('div', {
        key: field.key,
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          padding: '9px 0',
          borderTop: first ? 'none' : '1px solid var(--dsw-alias-border-l1)',
        },
      }, [
        h('div', { key: 'text', style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } }, [
          h('div', { key: 'label', style: { fontSize: 12.5, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)' } }, field.label),
          h('div', { key: 'desc', style: { fontSize: 11, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' } }, field.description),
          hints.length > 0
            ? h('div', { key: 'hints', style: { fontSize: 10.5, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' } }, hints.join(' · '))
            : null,
        ]),
        h('div', { key: 'control', style: { flex: '0 0 auto', paddingTop: 1 } }, control),
      ])
    }

    /**
     * The settings page: peak/valley schedule, default limits and token prices.
     *
     * It is the same component in three seats — the Settings sidebar
     * (`settings.section`), the bundle page and the bundle row page — so the
     * plugin's configuration is reachable wherever a user looks for it.
     */
    function BudgetSettings(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => en[key] ?? key
      const [payload, setPayload] = React.useState(undefined)
      const [values, setValues] = React.useState({})
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const adopt = React.useCallback((next) => {
        setPayload(next)
        const draft = {}
        for (const field of next?.fields ?? []) draft[field.key] = field.value
        setValues(draft)
      }, [])

      React.useEffect(() => {
        let live = true
        void fetch(`${ENDPOINT}/config`, { cache: 'no-store', headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((next) => {
            if (live) adopt(next)
          })
          .catch((failure) => {
            if (live) setError(String(failure?.message ?? failure))
          })
        return () => {
          live = false
        }
      }, [adopt])

      const post = async (body) => {
        setBusy(true)
        setError('')
        setStatus('')
        try {
          const response = await fetch(`${ENDPOINT}/config`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          const next = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(typeof next.error === 'string' ? next.error : `HTTP ${response.status}`)
          adopt(next)
          setStatus(t('settings.saved'))
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const change = (key, value) => {
        setValues((current) => ({ ...current, [key]: value }))
        setStatus('')
      }

      const save = () => {
        const patch = {}
        for (const field of payload?.fields ?? []) {
          if (field.editable === false) continue
          patch[field.key] = values[field.key]
        }
        void post({ values: patch })
      }

      const restoreDefaults = () => {
        void post({ reset: true })
      }

      const fields = payload?.fields ?? []
      const peak = payload?.peak
      let peakLine = t('settings.peakOff')
      if (peak?.configured === true) {
        peakLine = peak.active === true
          ? t('settings.peakNow').replace('{n}', String(peak.minutesLeft ?? 0))
          : t('settings.peakValley')
        if (peak.todaySkipped === true || peak.todayOutsideWeekdays === true) {
          peakLine = `${peakLine} · ${t('settings.valleyToday')}`
        }
      }

      const sections = GROUP_ORDER.map((group) => {
        const rows = fields.filter((field) => field.group === group)
        if (rows.length === 0) return null
        return h('section', { key: group, style: settingsSectionStyle }, [
          h('div', {
            key: 'title',
            style: {
              padding: '10px 0 2px',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, t(`settings.group.${group}`)),
          ...rows.map((field, index) => h(SettingsRow, {
            key: field.key,
            field,
            value: values[field.key],
            first: index === 0,
            onChange: change,
            t,
          })),
        ])
      }).filter(Boolean)

      const body = payload === undefined
        ? h('div', {
          style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
        }, error === '' ? t('settings.loading') : error)
        : h(React.Fragment, null, [
          h('div', {
            key: 'peak-status',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              lineHeight: '18px',
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, [
            h('span', {
              key: 'dot',
              style: {
                width: 6,
                height: 6,
                borderRadius: 3,
                background: peak?.active === true
                  ? 'var(--dsw-alias-state-warn-primary)'
                  : 'var(--dsw-alias-border-l1)',
              },
            }),
            h('span', { key: 'text' }, peakLine),
          ]),
          ...sections,
          h('div', {
            key: 'actions',
            style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
          }, [
            h('button', {
              key: 'save',
              type: 'button',
              disabled: busy,
              onClick: save,
              style: {
                border: '1px solid transparent',
                background: 'var(--dsw-alias-brand-primary)',
                color: 'var(--dsw-alias-bg-base)',
                borderRadius: 7,
                padding: '5px 14px',
                fontSize: 12,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              },
            }, busy ? t('settings.saving') : t('settings.save')),
            h('button', {
              key: 'defaults',
              type: 'button',
              disabled: busy,
              onClick: restoreDefaults,
              style: {
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                borderRadius: 7,
                padding: '5px 12px',
                fontSize: 12,
                cursor: busy ? 'default' : 'pointer',
              },
            }, t('settings.defaults')),
            status !== ''
              ? h('span', { key: 'ok', style: { fontSize: 11.5, color: 'var(--dsw-alias-state-success-primary)' } }, status)
              : null,
            error !== ''
              ? h('span', { key: 'error', style: { fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary)' } }, error)
              : null,
          ]),
        ])

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minWidth: 0,
          maxWidth: 720,
          padding: '2px 2px 18px',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'inherit',
        },
      }, [
        h('div', { key: 'heading', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
          h('div', { key: 'title', style: { fontSize: 14, fontWeight: 600 } }, t('settings.title')),
          h('div', {
            key: 'intro',
            style: { fontSize: 11.5, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
          }, t('settings.intro')),
        ]),
        body,
        payload !== undefined
          ? h('div', {
            key: 'file',
            style: { fontSize: 10.5, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
          }, payload.storeFile)
          : null,
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'session-budget.dictionaries')
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'session-budget',
          order: 30,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, BudgetStrip))
        // The same page in three seats: the Settings sidebar, the bundle page and
        // the bundle row page, so the schedule is reachable wherever a user looks.
        const seats = [
          {
            slot: 'settings.section',
            options: {
              name: 'settings.section',
              id: 'session-budget',
              order: 60,
              label: () => t('settings.nav'),
              locale: NS,
              inject: () => ({}),
            },
          },
          {
            slot: 'plugins.bundle.config',
            options: {
              name: 'plugins.bundle.config',
              key: 'dsh-session-budget',
              locale: NS,
              inject: () => ({}),
            },
          },
          {
            slot: 'plugins.row.config',
            options: {
              name: 'plugins.row.config',
              key: 'dsh-session-budget#session-budget',
              locale: NS,
              inject: () => ({}),
            },
          },
        ]
        for (const seat of seats) {
          ctx.slots.inject(seat.slot, () => ctx.slots.register(seat.options, BudgetSettings))
        }
      },
    }
  },
})

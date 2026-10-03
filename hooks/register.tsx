import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const windows = atom({ plugin: 'usage-tracker', key: 'windows' } as const, [])
const context = atom({ plugin: 'usage-tracker', key: 'context' } as const, null)
// The host's UTC offset in minutes, from `date +%z`: the module's own Date
// carries no reliable local time zone.
const utcOffset = atom({ plugin: 'usage-tracker', key: 'utcOffset' } as const, 0)

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Week' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Any usage above 0% fills at least one square, so low usage never looks empty.
type BarStyle = { width: number; full: string; empty: string }
const LIMIT_BAR: BarStyle = { width: 10, full: '■', empty: '□' }
// Shorter, to keep the band on one line.
const CONTEXT_BAR: BarStyle = { width: 5, full: '■', empty: '□' }

// The bar as runs of same-coloured squares; `colorAt` colours square `i`.
const filledSquares = (percent: number, width: number) =>
  percent > 0 ? Math.max(1, Math.round((Math.min(percent, 100) / 100) * width)) : 0

const bar = (percent: number, { width, full, empty }: BarStyle, colorAt: (i: number, isFilled: boolean) => string) => {
  const filled = filledSquares(percent, width)
  const runs: { color: string; text: string }[] = []
  for (let i = 0; i < width; i++) {
    const color = colorAt(i, i < filled)
    const square = i < filled ? full : empty
    const last = runs[runs.length - 1]
    if (last?.color === color) last.text += square
    else runs.push({ color, text: square })
  }
  return runs
}

// 68000 -> "68k", 1000000 -> "1M".
const tokenCount = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const colorFor = (percent: number) => (percent >= 80 ? 'red' : percent >= 50 ? 'yellow' : 'green')

const CONTEXT_BLUE = '#4a90d9'
// Past this many tokens, the filled squares holding the tokens beyond it are
// drawn yellow; the last filled square always is.
const CONTEXT_WARN_TOKENS = 200_000

const refreshOffset = async ($: EngineInterface) => {
  const { exitCode, stdout } = await $.process.run(['date', '+%z'])
  const match = /^([+-])(\d\d)(\d\d)/.exec(stdout.trim())
  if (exitCode !== 0 || !match) return

  const minutes = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
  await update($, utcOffset, () => minutes)
}

// "3:40pm" today, "Tue 9am" on any other day.
const resetTime = (resetsAt: string | undefined, nowMs: number, offset: number) => {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) return ''

  const local = new Date(at + offset * 60000)
  const today = new Date(nowMs + offset * 60000)
  const hours = local.getUTCHours()
  const minutes = local.getUTCMinutes()
  const clock =
    `${hours % 12 || 12}` + (minutes ? `:${String(minutes).padStart(2, '0')}` : '') + (hours < 12 ? 'am' : 'pm')
  const isToday = local.toISOString().slice(0, 10) === today.toISOString().slice(0, 10)

  return `resets ${isToday ? '' : `${DAYS[local.getUTCDay()]} `}${clock}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await update($, windows, () => usage.rateLimits)
    await update($, context, () => usage.context)
    await refreshOffset($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, windows, () => e.rateLimits)
    }
    if (e.changed.includes('context')) {
      await update($, context, () => e.context)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const nowMs = await $.clock.now()
    const offset = await read($, utcOffset)
    const fill = await read($, context)
    const sections: {
      key: string
      label: string
      percent: number
      // The figure drawn after the bar, then the dim detail after it.
      value: string
      detail: string
      style: BarStyle
      colorAt: (i: number, isFilled: boolean) => string
    }[] = []

    for (const w of await read($, windows)) {
      if (w.kind in LABELS) {
        // The weekly reset is days away; only the 5h one is worth a glance.
        const detail = w.kind === 'five_hour' ? resetTime(w.resetsAt, nowMs, offset) : ''
        const color = colorFor(w.percentUsed)
        sections.push({
          key: w.kind,
          label: LABELS[w.kind],
          percent: w.percentUsed,
          value: `${Math.round(w.percentUsed)}%`,
          detail,
          style: LIMIT_BAR,
          colorAt: () => color,
        })
      }
    }
    if (fill?.percent !== undefined) {
      // The token count leads; the percentage is the dim detail.
      const percent = `${Math.round(fill.percent)}%`
      const value = fill.tokens !== undefined ? tokenCount(fill.tokens) : percent
      const detail = fill.tokens !== undefined ? percent : ''
      const filled = filledSquares(fill.percent, CONTEXT_BAR.width)
      const blueSquares =
        fill.tokens !== undefined && fill.tokens > CONTEXT_WARN_TOKENS
          ? Math.min(filled - 1, Math.round(CONTEXT_WARN_TOKENS / (fill.window / CONTEXT_BAR.width)))
          : CONTEXT_BAR.width
      sections.push({
        key: 'context',
        label: 'Context',
        percent: fill.percent,
        value,
        detail,
        style: CONTEXT_BAR,
        colorAt: (i, isFilled) => (isFilled && i >= blueSquares ? 'yellow' : CONTEXT_BLUE),
      })
    }

    if (e.props.hasSurvey || sections.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        {sections.map((section, i) => (
          <Text key={section.key}>
            {i > 0 ? <Text dimColor>{'    │    '}</Text> : null}
            <Text bold>{section.label} </Text>
            {bar(section.percent, section.style, section.colorAt).map((run, j) => (
              <Text key={j} color={run.color}>
                {run.text}
              </Text>
            ))}
            <Text> {section.value}</Text>
            {section.detail ? <Text dimColor> {section.detail}</Text> : null}
          </Text>
        ))}
      </Box>
    )
  })
}

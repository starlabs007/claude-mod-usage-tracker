import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const windows = atom({ plugin: 'usage-tracker', key: 'windows' } as const, [])
const context = atom({ plugin: 'usage-tracker', key: 'context' } as const, null)
// The host's UTC offset in minutes, from `date +%z`: the module's own Date
// carries no reliable local time zone.
const utcOffset = atom({ plugin: 'usage-tracker', key: 'utcOffset' } as const, 0)

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Week' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The gauge: a ring that fills clockwise from the top. Any usage above 0%
// shows a sliver, so low usage never looks empty.
const fraction = (percent: number) => (percent > 0 ? Math.min(Math.max(percent / 100, 0.03), 1) : 0)

// Pie glyphs, the text a terminal without graphics shows in place of the ring.
const PIES = ['○', '◔', '◑', '◕', '●']
const pie = (percent: number) => PIES[percent > 0 ? Math.max(1, Math.round(Math.min(percent, 100) / 25)) : 0]

const hexToRgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

// Desktop and mobile: the ring as SVG, a rounded arc over a faint track.
const ringSvg = (percent: number, color: string) => {
  const circumference = 2 * Math.PI * 9
  const arc = fraction(percent) * circumference
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
    '<circle cx="13" cy="13" r="9" fill="none" stroke="#8a8a8a" stroke-opacity=".3" stroke-width="3"/>' +
    (arc > 0
      ? `<circle cx="13" cy="13" r="9" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" ` +
        `stroke-dasharray="${arc.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 13 13)"/>`
      : '') +
    '</svg>'
  )
}

// Terminal: the same ring as anti-aliased RGBA pixels on a transparent
// background, for the kitty graphics protocol. No PNG encoder is needed.
const RING_PX = 64
const ringPixels = (percent: number, color: string) => {
  const size = RING_PX
  const c = size / 2
  const radius = size * 0.4
  const half = size * 0.065
  const sweep = fraction(percent) * 2 * Math.PI
  const [r, g, b] = hexToRgb(color)
  const out = new Uint8Array(size * size * 4)
  const endX = c + radius * Math.sin(sweep)
  const endY = c - radius * Math.cos(sweep)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const dist = Math.hypot(px - c, py - c)
      const ring = Math.abs(dist - radius)
      // Clockwise angle from 12 o'clock.
      const angle = (Math.atan2(px - c, c - py) + 2 * Math.PI) % (2 * Math.PI)
      // Distance to the arc, round caps included.
      const toArc =
        sweep === 0
          ? Infinity
          : angle <= sweep
            ? ring
            : Math.min(Math.hypot(px - c, py - (c - radius)), Math.hypot(px - endX, py - endY))
      const fillA = Math.min(Math.max(half - toArc + 0.5, 0), 1)
      const trackA = Math.min(Math.max(half - ring + 0.5, 0), 1) * 0.3 * (1 - fillA)
      const a = fillA + trackA
      if (a <= 0) continue
      const i = (y * size + x) * 4
      // Track is gray 138; fill is the colour.
      out[i] = Math.round((r * fillA + 138 * trackA) / a)
      out[i + 1] = Math.round((g * fillA + 138 * trackA) / a)
      out[i + 2] = Math.round((b * fillA + 138 * trackA) / a)
      out[i + 3] = Math.round(a * 255)
    }
  }
  return out.toBase64()
}

// 68000 -> "68k", 1000000 -> "1M".
const tokenCount = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const COLORS = { green: '#3fb950', yellow: '#d9a520', red: '#e5534b', blue: '#4a90d9' }
const colorFor = (percent: number) => (percent >= 80 ? COLORS.red : percent >= 50 ? COLORS.yellow : COLORS.green)

// Past this many tokens, the context ring is drawn yellow.
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
      // The figure drawn after the label, then the dim detail after it.
      value: string
      detail: string
      color: string
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
          color,
        })
      }
    }
    if (fill?.percent !== undefined) {
      // The token count leads; the percentage is the dim detail.
      const percent = `${Math.round(fill.percent)}%`
      const value = fill.tokens !== undefined ? tokenCount(fill.tokens) : percent
      const detail = fill.tokens !== undefined ? percent : ''
      const isOverWarn = fill.tokens !== undefined && fill.tokens > CONTEXT_WARN_TOKENS
      sections.push({
        key: 'context',
        label: 'Context',
        percent: fill.percent,
        value,
        detail,
        color: isOverWarn ? COLORS.yellow : COLORS.blue,
      })
    }

    if (e.props.hasSurvey || sections.length === 0) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui

    // The ring, drawn as the surface can: pixels in a terminal that has
    // graphics (its dim glyph elsewhere), SVG in the apps.
    const ring = (section: { percent: number; color: string }) =>
      e.surface === 'terminal' ? (
        <ui.Image
          source={{ rgba: ringPixels(section.percent, section.color), width: RING_PX, height: RING_PX }}
          columns={2}
          rows={1}
          alt={`${pie(section.percent)} `}
        />
      ) : (
        <ui.Svg
          source={ringSvg(section.percent, section.color)}
          alt={`${Math.round(section.percent)}%`}
          width={18}
          height={18}
        />
      )

    // `xs` is the smallest step: one cell in a terminal, a couple of pixels in the apps.
    return (
      <Box gap={6}>
        {sections.map(section => (
          <Box key={section.key} gap="xs" alignItems="center">
            {ring(section)}
            <Text bold>{section.label}</Text>
            <Text>{section.value}</Text>
            {section.detail ? <Text dimColor>{section.detail}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheStamp } from '../types'

const windows = atom({ plugin: 'usage-tracker', key: 'windows' } as const, [])
const context = atom({ plugin: 'usage-tracker', key: 'context' } as const, null)
// The host's UTC offset in minutes, from `date +%z`: the module's own Date
// carries no reliable local time zone.
const utcOffset = atom({ plugin: 'usage-tracker', key: 'utcOffset' } as const, 0)
// When the main thread's last request that read or wrote the prompt cache was
// sent, and how long the cache it left holds.
const cache = atom({ plugin: 'usage-tracker', key: 'cache' } as const, null)

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

// Cold cache, in place of the empty ring: a six-armed snowflake.
const snowflakeSvg = () => {
  const arms = [0, 60, 120, 180, 240, 300]
    .map(
      deg =>
        `<g transform="rotate(${deg} 13 13)">` +
        '<line x1="13" y1="13" x2="13" y2="3"/><polyline points="10.2,5.6 13,7.6 15.8,5.6"/>' +
        '<polyline points="11,9.2 13,10.6 15,9.2"/></g>',
    )
    .join('')
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
    '<g fill="none" stroke="#8fdcff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    arms +
    '</g><circle cx="13" cy="13" r="1.6" fill="#e6f8ff"/></svg>'
  )
}

// Cold cache, desktop and mobile: "COLD" as a frozen title. Angular capitals
// with ice-shard points, deep blue at the foot rising to pale ice, frost on
// every top edge, a cold glow and two glints that twinkle where SVG animates.
// The letters are paths, so no font is involved and the baseline sits where
// we put it: drawn at COLD_W x COLD_H and centred in the row like the text
// beside it, the baseline lies COLD_BASELINE px below the middle, where a
// 13px system face in an 18px line has it.
const COLD_W = 36
const COLD_H = 22
const COLD_BASELINE = 4.6
// Four drawing units to the pixel: the baseline at y 62, caps 41 tall, wedge
// serifs that flare into points like ice shards.
const COLD_LETTERS_SVG = [
  // C: faceted bowl, pointed arms.
  'M34 20 L32 33 L28 29.5 L20 29 L15 33 L14 42 L15 52 L20 56 L28 55.5 L33 51 L35 64 L28 62.5 L18 63 L9 58 L5 49 L5 36 L9 26 L18 21 L28 21 Z',
  // O: faceted.
  'M55 21 L65 24 L70 32 L71 42 L70 52 L65 60 L55 63 L45 60 L40 52 L39 42 L40 32 L45 24 Z M55 29 L60 31 L62 36 L62.5 42 L62 48 L60 53 L55 55 L50 53 L48 48 L47.5 42 L48 36 L50 31 Z',
  // L: a wedge serif on the stem, the foot flaring up into a point.
  'M74 19 L91 20 L87 25 L87 54 L96 54 L103 47 L103 63 L76 63 L79 58 L79 25 Z',
  // D: a wedge serif, a faceted bowl.
  'M106 20 L121 21 L131 25 L137 33 L139 42 L137 52 L131 59 L121 62 L106 63 L109 58 L109 25 Z M118 28 L123 29 L128 33 L130 42 L128 51 L123 55 L118 56 Z',
].join(' ')
const glint = (x: number, y: number, r: number, delay: string) =>
  `<path d="M${x} ${y - r} L${x + r * 0.22} ${y - r * 0.22} L${x + r} ${y} L${x + r * 0.22} ${y + r * 0.22} ` +
  `L${x} ${y + r} L${x - r * 0.22} ${y + r * 0.22} L${x - r} ${y} L${x - r * 0.22} ${y - r * 0.22} Z" fill="#fff">` +
  `<animate attributeName="opacity" values=".15;1;.15" dur="2.6s" begin="${delay}" repeatCount="indefinite"/></path>`
const coldSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${COLD_W}" height="${COLD_H}" viewBox="0 0 ${COLD_W * 4} ${COLD_H * 4}">` +
  '<defs>' +
  '<linearGradient id="ice" x1="0" y1="20" x2="0" y2="64" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0" stop-color="#e8faff"/><stop offset=".3" stop-color="#8fd8f8"/>' +
  '<stop offset=".65" stop-color="#2d8fe0"/><stop offset="1" stop-color="#0b3f8f"/>' +
  '</linearGradient>' +
  '<filter id="frost" x="-15%" y="-30%" width="130%" height="160%">' +
  // A cold halo behind the letters.
  '<feGaussianBlur in="SourceAlpha" stdDeviation="2.5" result="halo"/>' +
  '<feFlood flood-color="#9fe2ff" flood-opacity=".55"/><feComposite in2="halo" operator="in" result="glow"/>' +
  // Frost: the band along every top edge, the alpha minus itself pushed down.
  '<feOffset in="SourceAlpha" dy="2.6" result="down"/>' +
  '<feComposite in="SourceAlpha" in2="down" operator="out" result="rim"/>' +
  '<feMorphology in="rim" operator="dilate" radius=".6" result="rim2"/>' +
  '<feTurbulence type="fractalNoise" baseFrequency=".6" numOctaves="2" seed="4" result="noise"/>' +
  '<feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.6 -.35" result="flecks"/>' +
  '<feComposite in="flecks" in2="rim2" operator="in" result="snowy"/>' +
  '<feFlood flood-color="#ffffff"/><feComposite in2="rim" operator="in" result="snow"/>' +
  // Crackle inside the ice: faint pale veins.
  '<feTurbulence type="turbulence" baseFrequency=".09 .16" numOctaves="2" seed="9" result="veins"/>' +
  '<feColorMatrix in="veins" type="matrix" values="0 0 0 0 .85  0 0 0 0 .96  0 0 0 0 1  0 0 0 -.9 .45" result="lines"/>' +
  '<feComposite in="lines" in2="SourceAlpha" operator="in" result="crackle"/>' +
  '<feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/><feMergeNode in="crackle"/>' +
  '<feMergeNode in="snow"/><feMergeNode in="snowy"/></feMerge>' +
  '</filter>' +
  '</defs>' +
  `<path d="${COLD_LETTERS_SVG}" fill="url(#ice)" fill-rule="evenodd" stroke="#08306a" stroke-width="1.6" ` +
  'stroke-linejoin="miter" paint-order="stroke" filter="url(#frost)"/>' +
  glint(34, 20, 6, '0s') +
  glint(124, 24, 5, '1.3s') +
  '</svg>'

// Cold cache, terminal: one row, so the ice is a dark block behind the
// letters, each a shade colder than the last.
const COLD_LETTERS: [string, string][] = [
  ['c', '#e8f9ff'],
  ['o', '#bdeeff'],
  ['l', '#8fdcff'],
  ['d', '#5cc8f2'],
]
const SNOW = '#8fdcff'
const ICE_BLOCK = '#0f3b54'

// 68000 -> "68k", 1000000 -> "1M".
const tokenCount = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const COLORS = { green: '#3fb950', yellow: '#d9a520', red: '#e5534b', blue: '#4a90d9' }
const colorFor = (percent: number) => (percent >= 80 ? COLORS.red : percent >= 50 ? COLORS.yellow : COLORS.green)

// Past this many tokens, the context ring is drawn yellow.
const CONTEXT_WARN_TOKENS = 200_000

// The cache ring is full at one hour left. It turns yellow at 7 minutes and red
// at 2; the countdown shows minutes, then seconds for the last minute.
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const CACHE_WARN_MS = 7 * MINUTE
const CACHE_DANGER_MS = 2 * MINUTE

const cacheView = (stamp: CacheStamp, nowMs: number) => {
  const leftMs = Math.max(0, stamp.at + stamp.ttlMs - nowMs)
  const value =
    leftMs <= 0 ? 'cold' : leftMs <= MINUTE ? `${Math.ceil(leftMs / 1000)}s` : `${Math.ceil(leftMs / MINUTE)}m`
  const color = leftMs <= CACHE_DANGER_MS ? COLORS.red : leftMs <= CACHE_WARN_MS ? COLORS.yellow : COLORS.blue
  // Whole percent steps: finer than the ring can show.
  const percent = leftMs > 0 ? Math.max(Math.round((leftMs / HOUR) * 100), 1) : 0
  return { value, color, percent }
}

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
  // The timer's copy of `cache`, so a tick redraws only when the band would change.
  let stamp: CacheStamp | null = null
  let shown = ''

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await update($, windows, () => usage.rateLimits)
    await update($, context, () => usage.context)
    await refreshOffset($)
    stamp = await read($, cache)

    $.clock.every(1000, async () => {
      if (!stamp) return
      const view = cacheView(stamp, await $.clock.now())
      const key = `${view.value} ${view.color} ${view.percent}`
      if (key !== shown) {
        shown = key
        $.ui.invalidate('ui.render')
      }
    })
    return result
  })

  // Main-thread requests only: a subagent keeps a cache of its own.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)

    // A cache lifetime counts from when the request was sent.
    const at = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (usage && (usage.cache_read_input_tokens > 0 || usage.cache_creation_input_tokens > 0)) {
      // A write names its lifetime; a read keeps the one the last write was given.
      const ttlMs = usage.ephemeral_1h_input_tokens
        ? HOUR
        : usage.ephemeral_5m_input_tokens
          ? 5 * MINUTE
          : (stamp?.ttlMs ?? HOUR)
      const fresh: CacheStamp = { at, ttlMs }
      stamp = fresh
      await update($, cache, () => fresh)
    }
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
      // The cache has gone cold: drawn in ice in place of the plain value.
      isCold?: boolean
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
    const lastCache = await read($, cache)
    if (lastCache) {
      const view = cacheView(lastCache, nowMs)
      sections.push({ key: 'cache', label: 'Cache', detail: '', isCold: view.value === 'cold', ...view })
    }

    if (e.props.hasSurvey || sections.length === 0) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui

    // The ring, drawn as the surface can: pixels in a terminal that has
    // graphics (its dim glyph elsewhere), SVG in the apps.
    const ring = (section: { percent: number; color: string; isCold?: boolean }) =>
      section.isCold ? (
        e.surface === 'terminal' ? (
          <Text color={SNOW}>❄ </Text>
        ) : (
          <ui.Svg source={snowflakeSvg()} alt="❄" width={18} height={18} />
        )
      ) : e.surface === 'terminal' ? (
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
            {section.isCold ? (
              e.surface === 'terminal' ? (
                <Text bold backgroundColor={ICE_BLOCK}>
                  {' '}
                  {COLD_LETTERS.map(([letter, color]) => (
                    <Text key={letter} color={color}>
                      {letter}
                    </Text>
                  ))}{' '}
                </Text>
              ) : (
                <ui.Svg source={coldSvg()} alt="cold" width={COLD_W} height={COLD_H} />
              )
            ) : (
              <Text>{section.value}</Text>
            )}
            {section.detail ? <Text dimColor>{section.detail}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })
}

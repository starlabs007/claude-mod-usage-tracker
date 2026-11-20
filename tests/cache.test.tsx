import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code/testing'

const MINUTE = 60_000

const BAND = {
  plugin: 'usage-tracker',
  component: 'AbovePrompt',
  props: { hasSurvey: false, bodyColumns: 120 },
} as const

// The engine beneath the mod: a session with no rate limits or context yet,
// a UTC clock, and a model step that read `cacheRead` tokens from the cache
// and wrote `written1h` for an hour and `written5m` for five minutes.
const engine = (on: On, usage: { read?: number; written1h?: number; written5m?: number } = {}) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '+0000\n', stderr: '' } }))
  on('turn.step', async function* (_, e) {
    const w1 = usage.written1h ?? 0
    const w5 = usage.written5m ?? 0
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_read_input_tokens: usage.read ?? 0,
        cache_creation_input_tokens: w1 + w5,
        ...(w1 || w5 ? { ephemeral_1h_input_tokens: w1, ephemeral_5m_input_tokens: w5 } : {}),
        model: 'claude-opus-5-5',
      },
    }
  })
}

const step = async ($: Parameters<Parameters<typeof test>[1]>[0], agentId?: string) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
  }
  return stream.result
}

const cacheText = async (ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text: string } | undefined> }) =>
  (await ui.find({ type: 'Text', text: /^(\d+m|\d+s|cold)$/ }))?.text

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the cache section counts down from an hour (${surface})`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, { written1h: 5000 })
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    // No request yet: no Cache section.
    let ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^Cache$/ })).toBeUndefined()
    await ui.unmount()

    await step($)
    ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^Cache$/ }))?.text).toBe('Cache')
    expect(await cacheText(ui)).toBe('60m')
    await ui.unmount()

    const at = async (leftMs: number) => {
      await clock.set(1_000_000 + 60 * MINUTE - leftMs)
      const view = await $.ui.mount({ ...BAND, surface })
      const text = await cacheText(view)
      await view.unmount()
      return text
    }
    expect(await at(30 * MINUTE)).toBe('30m')
    expect(await at(7 * MINUTE + 30_000)).toBe('8m')
    expect(await at(61_000)).toBe('2m')
    expect(await at(60_000)).toBe('60s')
    expect(await at(1_500)).toBe('2s')
    expect(await at(0)).toBe('cold')
  })
}

test('a read keeps the last lifetime; a 5-minute write starts at 5m', async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on, { written5m: 100 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await cacheText(ui)).toBe('5m')
  await ui.unmount()
})

test("a subagent's request leaves the main thread's countdown alone", async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on, { read: 5000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  await clock.advance(20 * MINUTE)
  await step($, 'sub-1')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await cacheText(ui)).toBe('40m')
  await ui.unmount()
})

test('the ring turns yellow at 7 minutes and red at 2', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on, { written1h: 5000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  const ringAt = async (leftMs: number) => {
    await clock.set(60 * MINUTE - leftMs)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const svgs = await ui.findAll({ type: 'Svg' })
    await ui.unmount()
    return String((svgs.at(-1) as { props?: { source?: string } })?.props?.source ?? '')
  }
  expect(await ringAt(7 * MINUTE + 1)).toContain('#4a90d9')
  expect(await ringAt(7 * MINUTE)).toContain('#d9a520')
  expect(await ringAt(2 * MINUTE + 1)).toContain('#d9a520')
  expect(await ringAt(2 * MINUTE)).toContain('#e5534b')
})

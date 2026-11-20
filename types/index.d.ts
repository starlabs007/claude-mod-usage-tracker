export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }
export type ContextFill = { tokens?: number; window: number; percent?: number }
// `at` in `$.clock.now()` milliseconds; `ttlMs` how long the cache holds from then.
export type CacheStamp = { at: number; ttlMs: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-tracker': { windows: UsageWindow[]; context: ContextFill | null; utcOffset: number; cache: CacheStamp | null }
  }
}

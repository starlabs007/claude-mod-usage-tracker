export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }
export type ContextFill = { tokens?: number; window: number; percent?: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-tracker': { windows: UsageWindow[]; context: ContextFill | null; utcOffset: number }
  }
}

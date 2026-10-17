import type { ConductorCostHistory, ConductorTier, ConductorUsageRatio } from '../types'

export const MAX_SAMPLES = 8
export const MIN_SAMPLES = 2
export const MARGIN = 1.25
/** A first guess per task when nothing like it ran before, in dollars. */
export const DEFAULT_TASK_USD: Record<ConductorTier, number> = { haiku: 0.4, sonnet: 1.5, opus: 3, fable: 7.5 }
/** With no learned points-per-dollar, a window this full holds new tasks. */
export const FALLBACK_HOLD_PCT = 95

export type Estimate = { usd: number; basis: 'kind' | 'agent' | 'default'; samples: number }
export type Window = { kind: string; percentUsed: number; resetsAt?: string }
export type UsageSample = { usd: number; pct: Record<string, number> }
export type Room = {
  budgetUsd: number
  usedUsd: number
  reservedUsd: number
  windows: readonly Window[]
  ratio: ConductorUsageRatio
  now: number
}
export type Fit = { fits: true } | { fits: false; short: string; reason: string; retryAt: number | null }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Adds a finished agent's cost to both histories (by kind and by agent), keeping the newest few. */
export function recordCost(h: ConductorCostHistory, kind: string, agent: string, tier: ConductorTier, usd: number): ConductorCostHistory {
  if (!Number.isFinite(usd) || usd <= 0) return h
  const out: ConductorCostHistory = { ...h }
  const keys = kind === agent ? [`${kind}|${tier}`] : [`${kind}|${tier}`, `${agent}|${tier}`]
  for (const k of keys) out[k] = [...(h[k] ?? []), usd].slice(-MAX_SAMPLES)
  return out
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const cents = (x: number) => Math.ceil(Math.round(x * 1e6) / 1e4) / 100

/** What a task will probably cost: recent costs of the same kind, else of the same agent, else a first guess. */
export function estimateCost(h: ConductorCostHistory, kind: string, agent: string, tier: ConductorTier): Estimate {
  const byKind = h[`${kind}|${tier}`] ?? []
  if (byKind.length >= MIN_SAMPLES) return { usd: cents(mean(byKind) * MARGIN), basis: 'kind', samples: byKind.length }
  const byAgent = h[`${agent}|${tier}`] ?? []
  if (byAgent.length >= MIN_SAMPLES) return { usd: cents(mean(byAgent) * MARGIN), basis: 'agent', samples: byAgent.length }
  return { usd: DEFAULT_TASK_USD[tier], basis: 'default', samples: 0 }
}

/** Learns how many window points a dollar of spend moves, from two readings. A drop in percent means the window reset, so that pair is skipped. */
export function learnRatio(r: ConductorUsageRatio, prev: UsageSample | null, cur: UsageSample): ConductorUsageRatio {
  if (!prev) return r
  const out: ConductorUsageRatio = { ...r }
  const dUsd = cur.usd - prev.usd
  for (const k of Object.keys(cur.pct)) {
    const before = prev.pct[k]
    const after = cur.pct[k]
    if (before === undefined || after === undefined) continue
    const dPct = after - before
    if (!(dUsd > 0 && dPct >= 0)) continue
    let usd = (out[k]?.usd ?? 0) + dUsd
    let pts = (out[k]?.pts ?? 0) + dPct
    if (usd > 50) {
      usd /= 2
      pts /= 2
    }
    out[k] = { usd, pts }
  }
  return out
}

/** Window points moved per dollar spent, or null until enough spend has been seen. */
export function pointsPerUsd(r: ConductorUsageRatio, kind: string): number | null {
  const row = r[kind]
  return row && row.usd >= 1 ? row.pts / row.usd : null
}

/** The next local midnight after `now`. */
export function nextMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

const two = (n: number) => String(n).padStart(2, '0')
const clock = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`
const dayStart = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Plain words for when something happens, in local time. */
export function whenText(at: number, now: number): string {
  const mid = nextMidnight(now)
  if (Math.abs(at - mid) <= 2 * 60_000) return 'tomorrow'
  const d = new Date(at)
  if (dayStart(at) === dayStart(now)) return `at ${clock(d)}`
  if (dayStart(at) === mid) return `tomorrow at ${clock(d)}`
  return `on ${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} at ${clock(d)}`
}

/** The name of a rate-limit window in plain words. */
export function windowName(kind: string): string {
  switch (kind) {
    case 'five_hour': return '5-hour usage limit'
    case 'seven_day': return 'weekly usage limit'
    case 'seven_day_opus': return 'weekly Opus limit'
    case 'seven_day_sonnet': return 'weekly Sonnet limit'
    case 'spend_limit': return 'spending limit'
    default: return `${kind.replace(/_/g, ' ')} limit`
  }
}

export const usdText = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)

/** Does an estimated cost fit in what is left of the daily budget and of every rate-limit window? */
export function checkRoom(estUsd: number, room: Room): Fit {
  const fails: { short: string; reason: string; retryAt: number | null }[] = []
  const { budgetUsd, now } = room
  if (budgetUsd > 0) {
    const left = budgetUsd - room.usedUsd - room.reservedUsd
    if (estUsd > left) {
      if (estUsd > budgetUsd) {
        fails.push({
          short: 'more than the daily budget',
          reason: `it needs about ${usdText(estUsd)}, more than the whole daily budget of ${usdText(budgetUsd)}. Raise the budget to run it.`,
          retryAt: null,
        })
      } else {
        const mid = nextMidnight(now)
        fails.push({
          short: 'daily budget',
          reason: `it needs about ${usdText(estUsd)} and ${usdText(Math.max(0, left))} of today's ${usdText(budgetUsd)} budget is left. It starts ${whenText(mid, now)}, or sooner if you raise the budget.`,
          retryAt: mid,
        })
      }
    }
  }
  for (const w of room.windows) {
    const ppu = pointsPerUsd(room.ratio, w.kind)
    const need = ppu !== null ? estUsd * ppu : 0
    const ahead = ppu !== null ? room.reservedUsd * ppu : 0
    const failed = ppu !== null ? w.percentUsed + ahead + need > 100 : w.percentUsed >= FALLBACK_HOLD_PCT
    if (!failed) continue
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    const ok = Number.isFinite(reset)
    fails.push({
      short: windowName(w.kind),
      reason: `the ${windowName(w.kind)} is ${w.percentUsed}% used${ppu !== null ? ` and this task needs about ${Math.ceil(need)}% more` : ''}. It starts after the limit resets${ok ? ` ${whenText(reset, now)}` : ''}.`,
      retryAt: ok ? reset : null,
    })
  }
  if (!fails.length) return { fits: true }
  const times = fails.map((f) => f.retryAt).filter((t): t is number => t !== null)
  return {
    fits: false,
    short: fails[0]?.short ?? '',
    reason: fails.map((f) => f.reason).join(' '),
    retryAt: times.length ? Math.max(...times) : null,
  }
}

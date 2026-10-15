import type { ConductorEffort, ConductorPlan, ConductorPlanItem, ConductorTaskState, ConductorTier } from '../types'
import type { Mark } from './bar'
import { marksOf } from './bar'

export type PlanItemState = ConductorTaskState

const MAX_ITEMS = 400

const MARK: Record<PlanItemState, string> = { todo: ' ', doing: '~', done: 'x', blocked: '!' }

const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX~!\-])(\]\s+)(.*)$/
const ITEM_ID = /^(?:\*\*|`)?(T\d+(?:\.\d+)*)(?:\*\*|`)?\s*[:.)\-–—]?\s*/i
/** A task's tags: `{agent: builder, model: sonnet, after: T2, files: a.ts, verify: npm test}` at the end of its line. */
const META = /\s*\{([^{}]*:[^{}]*)\}\s*$/
const META_KEY = /[;,]\s*(?=(?:agent|model|effort|after|deps|depends|files?|verify|check)\s*:)/i

const stateOf = (mark: string): PlanItemState =>
  mark === 'x' || mark === 'X' ? 'done' : mark === '~' || mark === '-' ? 'doing' : mark === '!' ? 'blocked' : 'todo'

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const unquote = (s: string) => s.replace(/^[`'"]+|[`'"]+$/g, '').trim()

/** True for each line inside an HTML comment (the template's examples are not tasks). */
export function commentMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = []
  let isInside = false
  for (const line of lines) {
    if (isInside) {
      mask.push(true)
      if (line.includes('-->')) isInside = false
      continue
    }
    const open = line.indexOf('<!--')
    if (open >= 0 && line.slice(0, open).trim() === '') {
      mask.push(true)
      if (!line.includes('-->', open + 4)) isInside = true
      continue
    }
    mask.push(false)
  }

  return mask
}

export type ItemTags = Pick<ConductorPlanItem, 'agent' | 'model' | 'effort' | 'after' | 'files' | 'verify'>

const NO_TAGS: ItemTags = { agent: null, model: null, effort: null, after: [], files: [], verify: null }

export function parseTags(raw: string): ItemTags {
  const tags: ItemTags = { ...NO_TAGS, after: [], files: [] }
  for (const pair of raw.split(META_KEY)) {
    const m = pair.match(/^\s*([a-z]+)\s*:\s*(.*?)\s*$/i)
    if (!m) continue
    const value = unquote(m[2]!)
    if (!value) continue
    switch (m[1]!.toLowerCase()) {
      case 'agent':
        tags.agent = value.toLowerCase().replace(/^conductor:/, '')
        break
      case 'model': {
        const t = value.toLowerCase().match(/haiku|sonnet|opus|fable/)
        tags.model = t ? (t[0] as ConductorTier) : null
        break
      }
      case 'effort': {
        const t = value.toLowerCase().match(/^(low|medium|high|xhigh|max)$/)
        tags.effort = t ? (t[1] as ConductorEffort) : null
        break
      }
      case 'after':
      case 'deps':
      case 'depends':
        tags.after = (value.match(/T\d+(?:\.\d+)*/gi) ?? []).map(x => x.toUpperCase())
        break
      case 'file':
      case 'files':
        tags.files = value.split(/\s*,\s*/).map(unquote).filter(Boolean).slice(0, 20)
        break
      case 'verify':
      case 'check':
        tags.verify = value
        break
    }
  }

  return tags
}

/** Reads plan.md: `# Title`, `## Phase` headings, `- [ ] T1: task {tags}` lines; comments skipped. */
export function parsePlan(text: string, mtimeMs = 0): ConductorPlan | null {
  let title = ''
  let phase = ''
  let firstOpenPhase: string | null = null
  const counts = { total: 0, done: 0, doing: 0, blocked: 0 }
  const current: string[] = []
  const items: ConductorPlanItem[] = []
  const lines = text.split(/\r?\n/)
  const mask = commentMask(lines)

  lines.forEach((line, i) => {
    if (mask[i]) return
    const h1 = line.match(/^#\s+(.*)$/)
    if (h1 && !title) {
      title = h1[1]!.replace(/^plan:\s*/i, '').trim()
      return
    }
    const h2 = line.match(/^#{2,3}\s+(.*)$/)
    if (h2) {
      phase = h2[1]!.trim()
      return
    }
    const box = line.match(CHECKBOX)
    if (!box) return
    const state = stateOf(box[2]!)
    const raw = box[4]!.trim()
    const meta = raw.match(META)
    const body = meta ? raw.slice(0, meta.index).trim() : raw
    const id = body.match(ITEM_ID)?.[1]?.toUpperCase() ?? null
    const itemText = (id ? body.replace(ITEM_ID, '') : body).replace(/[*`]/g, '').trim()
    if (items.length < MAX_ITEMS) {
      items.push({ id, text: itemText, state, phase, ...(meta ? parseTags(meta[1]!) : { ...NO_TAGS, after: [], files: [] }) })
    }
    counts.total += 1
    if (state === 'done') counts.done += 1
    if (state === 'blocked') counts.blocked += 1
    if (state === 'doing') {
      counts.doing += 1
      if (current.length < 4) current.push(id ? `${id}: ${itemText}` : itemText)
    }
    if (state !== 'done' && firstOpenPhase === null) firstOpenPhase = phase
  })

  if (counts.total === 0) return null

  return { title, ...counts, phase: firstOpenPhase ?? phase, current, items, mtimeMs }
}

/** The plan reference in a task prompt: a `Plan item: T12` (or `Plan item: text`) line; `none` for a one-off. */
export function extractPlanItem(prompt: string): string | null {
  const m = prompt.match(/^\s*\**\s*plan[ -]?items?\s*\**\s*:\s*\**\s*(.+)$/im)
  if (!m) return null
  const ref = m[1]!.trim()
  const id = ref.match(/^(?:\*\*|`)?(T\d+(?:\.\d+)*)\b/i)
  if (id) return id[1]!.toUpperCase()

  return /^(none|n\/a|-)\b/i.test(ref) ? 'NONE' : ref.slice(0, 200)
}

/** True for a plan reference that names a real task (not `none`). */
export const isTaskRef = (ref: string | null): ref is string => ref !== null && ref !== 'NONE'

/**
 * Sets the checkbox of the item `ref` names (an id like T12, else the task's
 * text) to `state`. A done item stays done (whoever ticked it): only `isForced` (the person's retry) reopens it.
 */
export function setItemState(text: string, ref: string, state: PlanItemState, isForced = false): { text: string; isMatched: boolean } {
  const lines = text.split(/\r?\n/)
  const mask = commentMask(lines)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const wantId = /^T\d+(\.\d+)*$/i.test(ref) ? ref.toUpperCase() : null
  const wantText = norm(ref)

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const box = lines[i]!.match(CHECKBOX)
    if (!box) continue
    const item = box[4]!
    const id = item.match(ITEM_ID)?.[1]?.toUpperCase() ?? null
    const isHit = wantId ? id === wantId : norm(item).startsWith(wantText) || norm(item.replace(ITEM_ID, '')).startsWith(wantText)
    if (!isHit) continue
    if (stateOf(box[2]!) === 'done' && state !== 'done' && !isForced) return { text, isMatched: true }
    lines[i] = `${box[1]}${MARK[state]}${box[3]}${item}`

    return { text: lines.join(eol), isMatched: true }
  }

  return { text, isMatched: false }
}

/** Tasks for the person or the main agent (`agent: main`, `user`, ...): approvals, decisions. Runs never dispatch them. */
const GATED_AGENTS = new Set(['main', 'user', 'human', 'person', 'you', 'me', 'conductor'])

export const isGated = (item: Pick<ConductorPlanItem, 'agent'>) => item.agent !== null && GATED_AGENTS.has(item.agent)

/**
 * Tasks a run may start now: pending, with an id, not taken, not gated for the
 * person or the main agent, and every task they come after done (an id the plan
 * does not have counts as done).
 */
export function readyItems(items: readonly ConductorPlanItem[], busy: ReadonlySet<string>): ConductorPlanItem[] {
  const stateById = new Map<string, ConductorTaskState>()
  for (const i of items) if (i.id) stateById.set(i.id, i.state)

  return items.filter(
    i => i.id !== null && i.state === 'todo' && !isGated(i) && !busy.has(i.id) && i.after.every(d => (stateById.get(d) ?? 'done') === 'done'),
  )
}

export const PLAN_TEMPLATE = `# Plan: (not started)

<!--
The project plan. The conductor draws the progress bar above the prompt from it,
and /conductor run (or the main agent's run_plan tool) dispatches its tasks.
Phases are ## headings; tasks are checkboxes with a unique id and optional tags:
  - [ ] T1: pending task {agent: builder, model: sonnet, after: T0, files: src/a.ts, verify: npm test}
  - [~] T2: in progress
  - [x] T3: done
  - [!] T4: blocked (say why on the next line)
agent: scout | builder | architect, or main for a task the user or the main agent does (runs skip it). model: haiku | sonnet | opus. after: ids that must finish first.
-->
`

export type PhaseSummary = {
  name: string
  total: number
  done: number
  doing: number
  blocked: number
  state: ConductorTaskState
  items: ConductorPlanItem[]
}

/** The plan's tasks by phase, in order, each phase with its counts and state. */
export function phasesOf(items: readonly ConductorPlanItem[]): PhaseSummary[] {
  const out: PhaseSummary[] = []
  for (const item of items) {
    let ph = out[out.length - 1]
    if (!ph || ph.name !== item.phase) {
      ph = { name: item.phase, total: 0, done: 0, doing: 0, blocked: 0, state: 'todo', items: [] }
      out.push(ph)
    }
    ph.total += 1
    ph.items.push(item)
    if (item.state === 'done') ph.done += 1
    if (item.state === 'doing') ph.doing += 1
    if (item.state === 'blocked') ph.blocked += 1
  }
  for (const ph of out) {
    ph.state =
      ph.done === ph.total ? 'done' : ph.blocked > 0 && ph.doing === 0 ? 'blocked' : ph.doing > 0 || ph.done > 0 ? 'doing' : 'todo'
  }

  return out
}

/** Checkpoint dots for the plan bar: one per task while they fit, else one per phase. */
export function planMarks(items: readonly ConductorPlanItem[], cells: number): Mark[] {
  if (items.length <= Math.floor(cells / 2)) return marksOf(items.map(i => ({ weight: 1, state: i.state })))
  const phases = phasesOf(items)
  if (phases.length < 2) return []

  return marksOf(phases.map(p => ({ weight: p.total, state: p.state })))
}

const TAG_ORDER = ['agent', 'model', 'effort', 'after', 'files', 'verify'] as const

function renderTags(t: ItemTags): string {
  const parts: string[] = []
  for (const k of TAG_ORDER) {
    const v = t[k]
    if (v === null || (Array.isArray(v) && v.length === 0)) continue
    parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
  }

  return parts.length ? ` {${parts.join(', ')}}` : ''
}

/** Sets one tag of the task `id` names (null removes it), rewriting its {tags}. */
export function setItemTag(text: string, id: string, key: 'agent' | 'model', value: string | null): { text: string; isMatched: boolean } {
  const lines = text.split(/\r?\n/)
  const mask = commentMask(lines)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const box = lines[i]!.match(CHECKBOX)
    if (!box) continue
    const raw = box[4]!.trim()
    const meta = raw.match(META)
    const body = meta ? raw.slice(0, meta.index).trim() : raw
    if (body.match(ITEM_ID)?.[1]?.toUpperCase() !== id.toUpperCase()) continue
    const tags = meta ? parseTags(meta[1]!) : { ...NO_TAGS, after: [], files: [] }
    const next: ItemTags = key === 'model' ? { ...tags, model: value as ConductorTier | null } : { ...tags, agent: value }
    lines[i] = `${box[1]}${box[2]}${box[3]}${body}${renderTags(next)}`

    return { text: lines.join(eol), isMatched: true }
  }

  return { text, isMatched: false }
}

/** What the person approves: the tasks and their order, not their checkboxes. */
export function planSignature(items: readonly ConductorPlanItem[]): string {
  let h = 5381
  const s = items.map(i => `${i.id}|${i.text}|${i.after.join(',')}`).join('\n')
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0

  return `${items.length}:${(h >>> 0).toString(36)}`
}

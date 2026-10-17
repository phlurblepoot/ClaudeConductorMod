import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult, EngineInterface, PluginOptions, Register, RenderElement } from 'claude-code'

import type {
  ConductorAgent,
  ConductorAgentStatus,
  ConductorChoice,
  ConductorContext,
  ConductorCostHistory,
  ConductorLaterQuestion,
  ConductorEffort,
  ConductorMode,
  ConductorPlan,
  ConductorHold,
  ConductorPlanItem,
  ConductorQuestion,
  ConductorRole,
  ConductorRun,
  ConductorTask,
  ConductorTier,
  ConductorUsageRatio,
} from '../types'
import { marksOf, svgBar, SVG_FILL } from './bar'
import type { Mark } from './bar'
import { briefPath, decisionsExcerpt, getSection, parseVerdict, recordResult, renderBrief, setSection, summarize } from './briefs'
import type { DepResult } from './briefs'
import { DOT, DOT_TONE, STATUS_DOT, STATUS_TONE, cleanText, cleanTree, drawBar, progressKind, uniqueKeys, hasInput, ink, pctOf, planItemText, taskRow } from './draw'
import type { Table } from './draw'
import type { BarKind } from './draw'
import { describeCall, extractDecisions, extractKnowledge, extractNeeds, extractQuestions, extractStatus, stripTagged } from './notes'
import type { Needs } from './notes'
import type { LaterQuestion } from './notes'
import {
  PLAN_TEMPLATE,
  extractPlanItem,
  isGated,
  isTaskRef,
  parsePlan,
  phasesOf,
  planMarks,
  planSignature,
  readyItems,
  setItemState,
  setItemTag,
} from './plan'
import type { PlanItemState } from './plan'
import * as P from './prompts'
import type { Autonomy } from './prompts'
import {
  CLASSIFIER_SYSTEM,
  ROUTABLE,
  WRITES,
  clampTier,
  classifierPrompt,
  costOf,
  effortFor,
  kindOf,
  learnedTier,
  nextTier,
  parseClassifier,
  recordOutcome,
  routeTask,
  tierOf,
  toolBudgetFor,
} from './route'
import type { TokenUsage } from './route'
import { checkRoom, estimateCost, learnRatio, recordCost, whenText } from './usage'
import type { Estimate, Room, UsageSample, Window } from './usage'
import { spillName, spillNote, textOfResult } from './spill'
import { clipText, countTasks, fracOf, fromProgress, fromTodos, settleTasks, taskCreated, taskUpdated } from './tasks'

type $ = EngineInterface

// ---------------------------------------------------------------- state

const ZERO = { tokens: 0, usd: 0, topUsd: 0 }

const agentsA = atom({ plugin: 'conductor', key: 'agents' } as const, [])
const contextA = atom({ plugin: 'conductor', key: 'context' } as const, { percent: null, tokens: null, window: 0, costUsd: null })
const planA = atom({ plugin: 'conductor', key: 'plan' } as const, null)
const statsA = atom({ plugin: 'conductor', key: 'stats' } as const, {
  haiku: 0,
  sonnet: 0,
  opus: 0,
  fable: 0,
  other: 0,
  checkpoints: 0,
  compactions: 0,
  notes: 0,
})
const modeA = atom({ plugin: 'conductor', key: 'mode' } as const, null)
const lastCheckpointA = atom({ plugin: 'conductor', key: 'lastCheckpoint' } as const, null)
const curationA = atom({ plugin: 'conductor', key: 'curation' } as const, null)
const bandHiddenA = atom({ plugin: 'conductor', key: 'bandHidden' } as const, false)
const mainTasksA = atom({ plugin: 'conductor', key: 'mainTasks' } as const, [])
const expandedA = atom({ plugin: 'conductor', key: 'expanded' } as const, {})
const expandAllA = atom({ plugin: 'conductor', key: 'expandAll' } as const, null)
const runA = atom({ plugin: 'conductor', key: 'run' } as const, null)
const attemptsA = atom({ plugin: 'conductor', key: 'attempts' } as const, {})
const verifyingA = atom({ plugin: 'conductor', key: 'verifying' } as const, {})
const dirtyA = atom({ plugin: 'conductor', key: 'dirty' } as const, [])
const spendA = atom({ plugin: 'conductor', key: 'spend' } as const, { haiku: ZERO, sonnet: ZERO, opus: ZERO, fable: ZERO })
const downshiftA = atom({ plugin: 'conductor', key: 'isDownshifted' } as const, false)
const routingA = atom({ plugin: 'conductor', key: 'routing' } as const, {})
const questionsA = atom({ plugin: 'conductor', key: 'questions' } as const, [])
const approvalA = atom({ plugin: 'conductor', key: 'approval' } as const, null)
const autonomyA = atom({ plugin: 'conductor', key: 'autonomy' } as const, null)
const welcomeA = atom({ plugin: 'conductor', key: 'welcome' } as const, null)
const todayA = atom({ plugin: 'conductor', key: 'today' } as const, { day: '', usd: 0, isWrappingUp: false })
const budgetA = atom({ plugin: 'conductor', key: 'budgetUsd' } as const, null)
const launchIssuesA = atom({ plugin: 'conductor', key: 'launchIssues' } as const, {})
const heldA = atom({ plugin: 'conductor', key: 'held' } as const, {})
const laterQuestionsA = atom({ plugin: 'conductor', key: 'laterQuestions' } as const, [])
const paneStateA = atom({ plugin: 'conductor', key: 'pane' } as const, { isClosedByPerson: false, waiting: null })
const questionsPaneA = atom({ plugin: 'conductor', key: 'questionsPane' } as const, { isClosedByPerson: false, waiting: null })

const PANE = 'conductor-agents'
const QPANE = 'conductor-questions'
const CHIME = 'assets/chime.wav'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
/** Built-in types that get the protocol footer; the conductor's own carry it in their system prompt. */
const GENERIC = new Set(['general-purpose', 'claude', 'Explore', 'Plan'])
const WORK_AGENTS = new Set(['scout', 'builder', 'architect'])
/** The agent types this mod defines and launches itself. */
const OWN_TYPES = new Set(['conductor:scout', 'conductor:builder', 'conductor:architect', 'conductor:curator', 'conductor:verifier'])
const INBOX_HEADER = '# Inbox\n\nRaw notes from subagents, waiting for the curator. Written by the conductor mod.\n'
/** Tool calls a typical run of each tier makes, for the estimated bar when an agent reports no steps. */
const EXPECTED_CALLS: Record<string, number> = { haiku: 10, sonnet: 25, opus: 35, fable: 35 }
const MAX_ATTEMPTS = 3
/** How many finished agents the agents pane keeps. */
const KEEP_FINISHED = 5

// ---------------------------------------------------------------- config

type Config = {
  delegation: ConductorMode
  routing: 'auto' | 'force' | 'off'
  topModel: ConductorTier
  classifier: boolean
  checkpointPercent: number
  compactPercent: number
  compactTokens: number
  curateEvery: number
  bootstrapKnowledge: boolean
  showPane: boolean
  requirePlanItem: boolean
  approveOwnAgents: boolean
  requireApproval: boolean
  maxParallel: number
  verify: 'tagged' | 'always' | 'off'
  escalate: boolean
  spillChars: number
  mapEvery: number
  learnRouting: boolean
  rateLimitDownshift: number
  autonomy: Autonomy
  dailyBudgetUsd: number
  budgetWrapUpPercent: number
  sound: boolean
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  (allowed as readonly unknown[]).includes(v) ? (v as T) : d
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
const num0 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)

const configOf = (o: PluginOptions): Config => ({
  delegation: pick(o.delegation, ['enforce', 'guide', 'off'] as const, 'enforce'),
  routing: pick(o.routing, ['auto', 'force', 'off'] as const, 'auto'),
  topModel: pick(o.topModel, ['opus', 'fable', 'sonnet'] as const, 'opus'),
  classifier: bool(o.classifier, true),
  checkpointPercent: num(o.checkpointPercent, 45),
  compactPercent: num(o.compactPercent, 65),
  compactTokens: num(o.compactTokens, 130000),
  curateEvery: num(o.curateEvery, 5),
  bootstrapKnowledge: bool(o.bootstrapKnowledge, true),
  showPane: bool(o.showPane, true),
  requirePlanItem: bool(o.requirePlanItem, true),
  approveOwnAgents: bool(o.approveOwnAgents, true),
  requireApproval: bool(o.requireApproval, true),
  maxParallel: Math.max(1, Math.min(12, Math.round(num(o.maxParallel, 4)))),
  verify: pick(o.verify, ['tagged', 'always', 'off'] as const, 'tagged'),
  escalate: bool(o.escalate, true),
  spillChars: num(o.spillChars, 12000),
  mapEvery: num(o.mapEvery, 8),
  learnRouting: bool(o.learnRouting, true),
  rateLimitDownshift: num0(o.rateLimitDownshift, 85),
  autonomy: pick(o.autonomy, P.AUTONOMY_LEVELS, 'ask-important'),
  dailyBudgetUsd: num0(o.dailyBudgetUsd, 0),
  budgetWrapUpPercent: Math.min(99, num(o.budgetWrapUpPercent, 90)),
  sound: bool(o.sound, true),
})

// ---------------------------------------------------------------- small helpers

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null)
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(cut; read the file for the rest)` : s)
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const usd = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)

/** The local calendar day, YYYY-MM-DD. */
const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

async function paths($: $) {
  const root = (await $.session.root()).replace(/\\/g, '/').replace(/\/+$/, '')
  const dir = `${root}/${P.KDIR}`

  return {
    root,
    dir,
    index: `${dir}/INDEX.md`,
    plan: `${dir}/plan.md`,
    inbox: `${dir}/inbox.md`,
    decisions: `${dir}/decisions.md`,
    handoff: `${dir}/session/handoff.md`,
    spill: `${dir}/session/spill`,
    report: `${dir}/report`,
  }
}

async function readText($: $, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** Serializes read-modify-write of the files this mod writes (inbox, plan ticks, briefs, decisions). */
let fileChain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = fileChain.then(fn, fn)
  fileChain = run.catch(() => undefined)

  return run
}

/** A path relative to the project root when it lies under it. */
const relTo = (root: string, file: string) => {
  const f = file.replace(/\\/g, '/')
  return f.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? f.slice(root.length + 1) : f
}

export type AgentProgress = { frac: number; label: string; isEstimate: boolean; marks: Mark[] }

/**
 * An agent's bar: its task list when it has one (a dot per task), its reported
 * done/total when it reports steps one at a time, else an estimate from its
 * tool calls.
 */
export function progressOf(a: ConductorAgent): AgentProgress {
  const tasks = a.tasks ?? []
  const isList = (a.taskSource ?? 'history') !== 'history' && tasks.length > 0
  if (isList) {
    const c = countTasks(tasks)
    const frac = a.status === 'done' ? 1 : fracOf(c)
    return { frac, label: `${c.done}/${c.total}`, isEstimate: false, marks: marksOf(tasks.map(t => ({ weight: 1, state: t.state }))) }
  }
  if (a.status === 'done') return { frac: 1, label: 'done', isEstimate: false, marks: [] }
  if (a.total) {
    const done = Math.min(a.done ?? 0, a.total)
    const marks = marksOf(
      Array.from({ length: a.total }, (_, i) => ({ weight: 1, state: i < done ? ('done' as const) : i === done ? ('doing' as const) : ('todo' as const) })),
    )
    return { frac: Math.min(1, (done + 0.5) / a.total), label: `${done}/${a.total}`, isEstimate: false, marks }
  }
  if (a.status !== 'running') return { frac: 0, label: a.status, isEstimate: false, marks: [] }
  const expected = EXPECTED_CALLS[a.tier ?? a.model] ?? 25
  const frac = 0.9 * (1 - Math.exp(-a.toolCalls / expected))

  return { frac, label: `~${Math.round(frac * 100)}%`, isEstimate: true, marks: [] }
}

type RowSpec = {
  id: string
  description: string
  type: string
  model: string
  reason: string
  role: ConductorRole
  planItem: string | null
  kind: string
  attempt: number
  effort: ConductorEffort | null
}

export function makeRow(s: RowSpec, now: number): ConductorAgent {
  const tier = tierOf(s.model)

  return {
    id: s.id,
    description: s.description || s.type,
    type: s.type,
    model: tier ?? s.model,
    reason: s.reason,
    status: 'running',
    startedAt: now,
    endedAt: null,
    toolCalls: 0,
    activity: 'starting',
    done: null,
    total: null,
    step: '',
    planItem: s.planItem,
    tokens: null,
    tasks: [],
    taskSource: null,
    role: s.role,
    tier,
    effort: s.effort,
    kind: s.kind,
    attempt: s.attempt,
    budget: toolBudgetFor(s.type, tier),
    isWarned: false,
    costUsd: null,
    summary: '',
    files: [],
    isAdopted: false,
  }
}

// ---------------------------------------------------------------- module state

let cfg: Config = configOf({})
let isTicking = false
let isMaintaining = false
let isCompactPending = false
let isKnowledgeChecked = false
let isPumping = false
let isUpkeepLaunching = false
/** How many of the mod's launch frames are running now (see framed). */
let launchFrames = 0
/** When the main agent last made a request or a tool call: a wake-up waits while it is at work. */
let lastMainActivityAt = 0
/** Work that must run inside one of the mod's hook frames, waiting for the end of the next one. */
let frameQueue: Array<() => Promise<void>> = []
/** Work kept past the current frame (a launch refused in it), queued when the next frame starts. */
let deferredQueue: Array<() => Promise<void>> = []
let isPumpRequested = false
let lastWakeAt = 0
let wakeTimer: { cancel: () => void } | null = null
/** Plan tasks (and verifications, as `verify:<id>`) whose agent is being launched. */
const launching = new Set<string>()
/** Agents stopped at twice their tool-call budget: their task's brief records the partial work. */
const budgetStopped = new Set<string>()
let lastDrawError = ''
let lastPlanMtime = -1
let costBase: { day: string; usd: number } | null = null

type DispatchMeta = { role: ConductorRole; type: string; reason: string; kind: string; attempt: number; effort: ConductorEffort | null; planItem: string | null }
/** What the conductor knows about a spawn it is about to make, by the spawn's description. */
const dispatchMeta = new Map<string, DispatchMeta>()
/** Recent agent costs and window points per dollar: learned, saved in the store, never drawn. */
let costHistory: ConductorCostHistory = {}
let usageRatio: ConductorUsageRatio = {}
let lastWindows: Window[] = []
let lastUsageSample: UsageSample | null = null
/** Estimates of work started and not finished, by launch key until the launch has an agent id, then by agent id. */
const reservedUsd = new Map<string, number>()
let holdTimer: { cancel: () => void } | null = null
let holdTimerAt = 0

async function modeOf($: $): Promise<ConductorMode> {
  return (await read($, modeA)) ?? cfg.delegation
}

async function autonomyOf($: $): Promise<Autonomy> {
  return (await read($, autonomyA)) ?? cfg.autonomy
}

async function budgetOf($: $): Promise<number> {
  return (await read($, budgetA)) ?? cfg.dailyBudgetUsd
}

function updateAgent($: $, id: string, fn: (a: ConductorAgent) => ConductorAgent) {
  return update($, agentsA, list => list.map(a => (a.id === id ? fn(a) : a)))
}

/** Keeps every running agent and the KEEP_FINISHED (5) most recently finished. */
function prune(list: ConductorAgent[]) {
  const finished = list.filter(a => a.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const keep = new Set(finished.slice(0, KEEP_FINISHED).map(a => a.id))

  return list.filter(a => a.status === 'running' || keep.has(a.id))
}

/** Adds an agent's row unless the spawn hook already did; a row picked up from the session gives way to it. */
async function upsertAgent($: $, row: ConductorAgent) {
  await update($, agentsA, list =>
    list.some(a => a.id === row.id && !a.isAdopted) ? list : prune([...list.filter(a => a.id !== row.id), row]),
  )
}

/** The agent ids the last tick saw running that the pane did not show as running. */
let unseenLive = new Set<string>()

/**
 * Shows an agent as running again: one resumed with SendMessage after it finished or was stopped (no spawn
 * fires for that), or one the mod never saw start. A known row is reopened with its tasks kept and a fresh
 * tool-call budget; an unknown one is added from the session's agent list. Agents the list does not name
 * (the engine's own forks) are left alone.
 */
async function adoptAgent($: $, agentId: string, listed?: AgentInfo): Promise<boolean> {
  const known = (await read($, agentsA)).find(a => a.id === agentId)
  if (known?.status === 'running') return false
  const now = await $.clock.now()
  if (known) {
    await updateAgent($, agentId, a => ({
      ...a,
      status: 'running',
      startedAt: now,
      endedAt: null,
      activity: 'resumed',
      budget: a.toolCalls + toolBudgetFor(a.type, a.tier),
      isWarned: false,
    }))
    if (known.planItem) await markPlan($, known.planItem, 'doing')
    await refreshStatus($)
    return true
  }
  const info = listed ?? (await $.agent.list()).find(i => i.id === agentId)
  if (!info) return false
  const row = makeRow(
    {
      id: agentId,
      description: info.description || info.name || agentId,
      type: info.type,
      model: '?',
      reason: 'picked up from the session',
      role: 'main',
      planItem: null,
      kind: '',
      attempt: 1,
      effort: null,
    },
    now,
  )
  await update($, agentsA, list => (list.some(a => a.id === agentId) ? list : prune([...list, { ...row, isAdopted: true }])))
  await refreshStatus($)

  return true
}

/** The id of an agent this mod just spawned, when the spawn answered none: found by its description. */
async function spawnedId($: $, r: { agentId?: string; deny?: string }, description: string): Promise<string | undefined> {
  if (r.deny !== undefined) return undefined
  if (r.agentId !== undefined) return r.agentId
  try {
    const found = (await $.agent.list()).filter(a => a.description === description && (a.status === 'running' || a.status === 'pending'))
    return found[found.length - 1]?.id
  } catch {
    return undefined
  }
}

/** Runs `fn` from a timer: a spawn made there passes through every hook of this mod. */
function later($: $, fn: () => Promise<unknown>, ms = 30) {
  $.clock.after(ms, () => {
    fn().catch(err => $.ui.log(`conductor: ${String(err)}`))
  })
}

// ---------------------------------------------------------------- launching the mod's own agents

const NO_VERDICT = /gave no verdict|did not ask for one/i

const without = <T,>(m: Record<string, T>, key: string) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== key))

/** Launches waiting for the launch hook, by token, with what the spawn answered. */
const launchRequests = new Map<string, { args: AgentSpawnArgs; result?: AgentSpawnResult }>()
let launchSeq = 0

/**
 * Spawns one of the mod's agents from inside the mod's tool.check hook for run_plan, raised as a query.
 *
 * A subagent steps past the hook that spawned it, and its tool calls do too. Spawned from the tool.call hook
 * (run_plan, or a timer set there), its progress reports went unanswered and its tool calls uncounted, so its
 * bar never moved. That query hook is one the mod's agents never need: run_plan is withheld from them.
 */
async function spawnSafe($: $, args: AgentSpawnArgs): Promise<AgentSpawnResult> {
  const token = `L${++launchSeq}`
  launchRequests.set(token, { args })
  try {
    await $.tool.check({ tool: P.RUN_TOOL, input: { conductorLaunch: token } })
    return launchRequests.get(token)?.result ?? { deny: "the conductor's launch hook did not run" }
  } catch (err) {
    return { deny: String(err) }
  } finally {
    launchRequests.delete(token)
  }
}

export type Launch = { agentId?: string; model?: string; deny?: string; tries: number }

/**
 * The mod's launch frames. Two rules of the engine decide where the mod can launch its agents:
 * - A call the mod makes outside its hook frames (from a timer after its hook returned) skips all of the mod's
 *   own hooks, its approval of its own launches among them: in auto mode such a launch is refused ("the request
 *   that produced this action did not ask for one"), in other modes it would ask the person.
 * - An agent launched within a hook chain steps past that chain's hooks, and so do its own calls. Launched from a
 *   tool call's hook, its progress reports go unanswered and its tool calls uncounted: its bar never moves.
 * So launches, stops and run steps happen in a launch frame, a hook that is not a tool call's: a finished turn,
 * a command, a press in the pane, a measurement. At once when one is running, else at the end of the next one;
 * when none comes and the main agent is idle, it is woken to call run_plan, whose turn then ends in one.
 */
async function framed<T>($: $, body: () => Promise<T>): Promise<T> {
  launchFrames += 1
  if (deferredQueue.length) {
    frameQueue.push(...deferredQueue)
    deferredQueue = []
  }
  try {
    return await body()
  } finally {
    try {
      await settleFrame($)
    } catch (err) {
      $.ui.log(`conductor: ${String(err)}`)
    } finally {
      launchFrames -= 1
    }
  }
}

/** Work started inside a frame that nobody awaits (a `void inFrame(...)`): the frame waits for it before it settles. */
const frameWork = new Set<Promise<unknown>>()

/** Runs the queued in-frame work and a requested pump, still inside the frame. */
async function settleFrame($: $) {
  for (let round = 0; round < 5 && (frameQueue.length > 0 || isPumpRequested || frameWork.size > 0); round++) {
    if (frameWork.size > 0) await Promise.all([...frameWork])
    const queue = frameQueue
    frameQueue = []
    for (const work of queue) await work().catch(err => $.ui.log(`conductor: ${String(err)}`))
    if (isPumpRequested) {
      isPumpRequested = false
      await pump($)
    }
  }
}

/** Runs `work` inside a frame: now when one is running, else at the end of the next one. */
function inFrame($: $, work: () => Promise<unknown>): Promise<void> {
  if (launchFrames > 0) {
    const run = work().then(() => undefined)
    const tracked = run.catch(err => $.ui.log(`conductor: ${String(err)}`))
    frameWork.add(tracked)
    void tracked.finally(() => frameWork.delete(tracked))
    return run
  }
  return new Promise<void>((resolve, reject) => {
    frameQueue.push(() => work().then(() => resolve(), reject))
    scheduleWake($)
  })
}

/** Queues work for the end of the next frame, without waking anyone for it (upkeep, surveys). */
function whenFramed(work: () => Promise<unknown>) {
  frameQueue.push(() => work().then(() => undefined))
}

/** Work a press, typing or pick in the pane started: its frame waits for it before it settles. */
const handlerWork = new Set<Promise<unknown>>()

/** Wraps a pane handler's work, so the press's frame (where launches may run) waits for it. */
function act(work: unknown): void {
  if (!(work instanceof Promise)) return
  const p = work.catch(() => undefined)
  handlerWork.add(p)
  void p.finally(() => handlerWork.delete(p))
}

/**
 * Answers a press, typing or pick. The element's handler runs inside the engine, not inside this hook, so what
 * it starts only queues (it is no frame); once its work has settled, this hook settles the queue as a frame.
 */
async function framedHandler<T>($: $, run: () => Promise<T>): Promise<T> {
  const r = await run()
  for (let i = 0; i < 10 && handlerWork.size > 0; i++) await Promise.all([...handlerWork])

  return framed($, async () => r)
}

/** Asks for a pump at the end of the current frame, or the next one. */
function requestPump($: $) {
  isPumpRequested = true
  if (launchFrames === 0) scheduleWake($)
}

/** When work waits and no frame comes (the session is idle), wakes the main agent to call run_plan. */
function scheduleWake($: $) {
  if (wakeTimer) return
  wakeTimer = $.clock.after(20_000, () => {
    wakeTimer = null
    void (async () => {
      const run = await read($, runA)
      const isRunWaiting = isPumpRequested && run?.isActive === true && !run.isPaused
      if (!frameQueue.length && !deferredQueue.length && !isRunWaiting) return
      const now = Date.now()
      // While the main agent works, its turn's end is the frame; and wake-ups are spaced.
      if (now - lastMainActivityAt < 15_000 || now - lastWakeAt < 30_000) return scheduleWake($)
      lastWakeAt = now
      await $.prompt.submit({ text: `[conductor] Plan work is waiting to start. Call ${P.RUN_TOOL} with no arguments, then end your turn.` })
    })().catch(err => $.ui.log(`conductor: ${String(err)}`))
  })
}

/** Refusals that mean the launch ran outside a frame after all: tried again in the next one. */
const RETRYABLE = /gave no verdict|did not ask for one|launch hook did not run/i

/**
 * Launches one of the mod's own agents inside a frame and hands the outcome to `done`. A refusal that says the
 * launch ran outside a frame is tried again at the next frame, up to `maxTries`, without holding this frame
 * open; it never counts as an attempt at the task.
 */
function launchThen($: $, args: AgentSpawnArgs, done: (l: Launch) => Promise<void>, maxTries = 4, tries = 1): Promise<void> {
  return inFrame($, async () => {
    let l: Launch
    try {
      trace(`launch try ${tries}`)
      const r = await spawnSafe($, args)
      const agentId = await spawnedId($, r, args.description ?? '')
      if (agentId !== undefined) {
        trace(`launch started ${agentId}`)
        l = { agentId, model: r.model, tries }
      } else {
        const deny = r.deny ?? 'no agent id'
        trace(`launch refused: ${deny}`)
        if (RETRYABLE.test(deny) && tries < maxTries) {
          deferredQueue.push(() => launchThen($, args, done, maxTries, tries + 1))
          scheduleWake($)
          return
        }
        l = { deny, tries }
      }
    } catch (err) {
      l = { deny: String(err), tries }
    }
    await done(l)
  })
}

/** One try, right where it is called, for callers that need the answer now: the self-test, whose agent uses no tools. */
async function launchOnce($: $, args: AgentSpawnArgs): Promise<Launch> {
  try {
    const r = await spawnSafe($, args)
    const agentId = await spawnedId($, r, args.description ?? '')
    return agentId !== undefined ? { agentId, model: r.model, tries: 1 } : { deny: r.deny ?? 'no agent id', tries: 1 }
  } catch (err) {
    return { deny: String(err), tries: 1 }
  }
}

function notify($: $, text: string, isLoud: boolean) {
  $.ui.toast(text.charAt(0).toUpperCase() + text.slice(1))
  if (isLoud && cfg.sound) $.audio.play({ asset: CHIME }).catch(() => undefined)
}

/** Held work in the order it is shown: task holds in plan order, then the checks, each with a plain label. */
function holdList(held: Record<string, ConductorHold>, items: ConductorPlanItem[]) {
  const pos = (key: string) => {
    const i = items.findIndex(x => x.id === key.replace(/^verify:/, ''))
    return i < 0 ? items.length : i
  }
  return Object.keys(held)
    .sort((a, b) => Number(a.startsWith('verify:')) - Number(b.startsWith('verify:')) || pos(a) - pos(b))
    .map(key => ({ key, label: key.startsWith('verify:') ? `the check of ${key.slice(7)}` : key, hold: held[key]! }))
}

async function refreshStatus($: $) {
  if ((await modeOf($)) === 'off') return $.ui.status(undefined)
  const ctx = await read($, contextA)
  const agents = await read($, agentsA)
  const plan = await read($, planA)
  const run = await read($, runA)
  const questions = await read($, questionsA)
  const running = agents.filter(a => a.status === 'running').length
  const parts = ['conductor']
  if (ctx.percent !== null) parts.push(`ctx ${ctx.percent}%`)
  if (running) parts.push(plural(running, 'agent'))
  if (plan) parts.push(`plan ${plan.done}/${plan.total}${run?.isActive ? (run.isPaused ? ' ⏸' : ' ▶') : ''}`)
  if (questions.length) parts.push(`${questions.length} need you`)
  const later = (await read($, laterQuestionsA)).length
  if (later) parts.push(`${later} for later`)
  if ((await read($, paneStateA)).waiting) parts.push('pane hidden: /conductor pane')
  if ((await read($, questionsPaneA)).waiting) parts.push('questions pane hidden: /conductor questions')
  const issues = Object.keys(await read($, launchIssuesA)).length
  if (issues) parts.push(`${issues} couldn't start`)
  const holds = Object.keys(await read($, heldA)).length
  if (holds) parts.push(`${holds} waiting for usage`)
  $.ui.status(parts.join(' · '))
}

/**
 * Opens the agents pane. Asked (the person's command or press) it is placed at any width. Unasked (a launch,
 * a run, session start) it opens only when it is not open already and the person has not closed it by hand: an
 * unasked open of an open pane could only move it to "waiting" on a narrow window. When the engine leaves it
 * waiting, the status line and the band say so, with a button that opens it.
 */
async function openPane($: $, isAsked = false, which: 'agents' | 'questions' = 'agents') {
  const id = which === 'questions' ? QPANE : PANE
  try {
    if (!isAsked) {
      if ((which === 'questions' ? (await read($, questionsPaneA)).isClosedByPerson : (await read($, paneStateA)).isClosedByPerson)) return
      if ((await $.ui.panes()).some(p => p.id === id)) return
    }
    const r = await $.ui.open({ id, title: which === 'questions' ? 'Questions' : 'Agents' })
    const waiting = r.isPlaced ? null : r.reason
    if (which === 'questions') await update($, questionsPaneA, s => ({ isClosedByPerson: isAsked ? false : s.isClosedByPerson, waiting }))
    else await update($, paneStateA, s => ({ isClosedByPerson: isAsked ? false : s.isClosedByPerson, waiting }))
    await refreshStatus($)
  } catch (err) {
    $.ui.log(`conductor: could not open the ${which} pane: ${String(err)}`)
  }
}

/** A note the main agent reads with its next request; the person does not see it as typed. */
async function tellMain($: $, text: string) {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[conductor] ${text}` }] } })
  } catch (err) {
    $.ui.log(`conductor: could not leave a note for the main agent: ${String(err)}`)
  }
}

// ---------------------------------------------------------------- knowledge base

async function ensureKnowledge($: $, why: 'auto' | 'init'): Promise<'exists' | 'created' | 'skipped'> {
  const p = await paths($)
  if (await $.fs.exists(p.index)) {
    // A knowledge base from an earlier version gets the files this one added.
    if (!(await $.fs.exists(`${p.dir}/map.md`))) await $.fs.write(`${p.dir}/map.md`, P.SKELETONS['map.md']!)
    return 'exists'
  }
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const isHome = home !== '' && p.root.toLowerCase() === home.toLowerCase()
  const isDriveRoot = /^([a-z]:)?$/i.test(p.root)
  if (why === 'auto' && (isHome || isDriveRoot)) return 'skipped'

  await $.fs.write(p.index, P.INDEX_TEMPLATE)
  for (const [name, text] of Object.entries(P.SKELETONS)) {
    if (!(await $.fs.exists(`${p.dir}/${name}`))) await $.fs.write(`${p.dir}/${name}`, text)
  }
  if (!(await $.fs.exists(p.plan))) await $.fs.write(p.plan, PLAN_TEMPLATE)

  return 'created'
}

async function bootstrap($: $): Promise<boolean> {
  const p = await paths($)
  const entries = await $.fs.list(p.root)
  const files = entries.filter(x => !x.name.startsWith('.') && x.name !== 'node_modules')
  if (files.length < 3) return false
  await launchThen($, { subagentType: 'conductor:curator', description: 'Bootstrap knowledge base', prompt: P.bootstrapTask(p.root), model: 'haiku' }, async l => {
    if (l.agentId === undefined) notify($, `the knowledge survey did not start: ${l.deny}`, false)
  })

  return true
}

async function knowledgeBlock($: $): Promise<string | null> {
  const p = await paths($)
  const index = await readText($, p.index)
  if (index === null) return null
  const parts = [`The conductor's knowledge base for this project is ${p.dir}/. Its index:\n\n${cap(index.trim(), 2500)}`]
  const planText = await readText($, p.plan)
  const plan = planText === null ? null : parsePlan(planText)
  if (plan) {
    const doing = plan.current.length ? `; in progress: ${plan.current.join('; ')}` : ''
    const blocked = plan.blocked ? `; ${plan.blocked} blocked` : ''
    parts.push(`Plan (${P.KDIR}/plan.md): ${plan.title || 'untitled'}: ${plan.done}/${plan.total} tasks done${blocked}; current phase: ${plan.phase || 'none'}${doing}.`)
  }
  const handoff = await readText($, p.handoff)
  if (handoff) parts.push(`The last checkpoint of the main conversation (${P.KDIR}/session/handoff.md):\n\n${cap(handoff.trim(), 3000)}`)

  return parts.join('\n\n')
}

async function fileNotes($: $, a: ConductorAgent, notes: string) {
  const p = await paths($)
  if (!(await $.fs.exists(p.index))) return
  const entry = `\n## ${iso(await $.clock.now())} · ${a.description} (${a.type}, ${a.model})\n${notes.trim()}\n`
  await serial(async () => {
    const cur = (await readText($, p.inbox)) ?? INBOX_HEADER
    await $.fs.write(p.inbox, cur + entry)
  })
  await update($, statsA, s => ({ ...s, notes: s.notes + 1 }))
}

/** Appends dated lines to decisions.md. */
async function appendDecisions($: $, lines: readonly string[], source: string) {
  if (lines.length === 0) return
  const p = await paths($)
  if (!(await $.fs.exists(p.index))) return
  const day = dayOf(await $.clock.now())
  await serial(async () => {
    const cur = (await readText($, p.decisions)) ?? P.SKELETONS['decisions.md']!
    await $.fs.write(p.decisions, `${cur.trimEnd()}\n${lines.map(l => `- ${day}: ${l} (${source})`).join('\n')}\n`)
  })
}

// ---------------------------------------------------------------- upkeep: notes, code map, stale facts

/** Recorded facts whose `(src: path)` names one of the changed files. */
async function staleFacts($: $, changed: readonly string[]): Promise<string[]> {
  if (changed.length === 0) return []
  const p = await paths($)
  const wanted = changed.map(f => f.toLowerCase())
  const skip = new Set(['plan.md', 'inbox.md', 'decisions.md', 'index.md', 'map.md', 'report.md'])
  const files: string[] = []
  for (const sub of ['', '/modules']) {
    try {
      for (const e of await $.fs.list(`${p.dir}${sub}`)) {
        if (e.kind === 'file' && e.name.endsWith('.md') && !skip.has(e.name.toLowerCase())) files.push(`${p.dir}${sub}/${e.name}`)
      }
    } catch {
      // no such folder
    }
  }
  const out: string[] = []
  for (const f of files) {
    const text = (await readText($, f)) ?? ''
    for (const line of text.split(/\r?\n/)) {
      const src = line.match(/\(src:\s*([^)]+)\)/i)?.[1]?.trim().toLowerCase()
      if (src && wanted.some(w => w.endsWith(src) || src.endsWith(w))) out.push(`${relTo(p.root, f)}: ${line.trim()}`)
      if (out.length >= 40) return out
    }
  }

  return out
}

/** What is left to spend: the daily budget, today's spend, work already started, and the rate-limit windows. */
async function roomNow($: $): Promise<Room> {
  const now = await $.clock.now()
  const today = await read($, todayA)
  let reserved = 0
  for (const v of reservedUsd.values()) reserved += v

  return { budgetUsd: await budgetOf($), usedUsd: today.day === dayOf(now) ? today.usd : 0, reservedUsd: reserved, windows: lastWindows, ratio: usageRatio, now }
}

/** Holds work that does not fit in the usage left: the reason is toasted and written to its brief. True when held. */
async function holdIfNoRoom($: $, key: string, label: string, est: Estimate, meta: { tier: ConductorTier; choiceReason: string; kind: string; attempt: number }): Promise<boolean> {
  const room = await roomNow($)
  const fit = checkRoom(est.usd, room)
  const prev = (await read($, heldA))[key]
  if (fit.fits) {
    if (prev) await update($, heldA, m => without(m, key))
    return false
  }
  await update($, heldA, m => ({ ...m, [key]: { reason: fit.reason, short: fit.short, retryAt: fit.retryAt, estimateUsd: est.usd, ...meta, at: room.now } }))
  if (!prev || prev.short !== fit.short) {
    notify($, `${label} waits for usage: ${fit.reason}`, false)
    if (!key.startsWith('verify:')) await editBrief($, key, doc => setSection(doc, 'Waiting for usage', `${iso(room.now)} · ${meta.tier} · ${fit.reason}`))
  }
  await scheduleHoldWake($)
  await refreshStatus($)

  return true
}

/** Sets one timer for the earliest time room should return (a window reset or midnight). */
async function scheduleHoldWake($: $) {
  const held = await read($, heldA)
  const times = Object.values(held).map(h => h.retryAt).filter((t): t is number => typeof t === 'number')
  if (!times.length) {
    holdTimer?.cancel()
    holdTimer = null
    holdTimerAt = 0
    return
  }
  const at = Math.min(...times)
  if (holdTimer && holdTimerAt <= at) return
  holdTimer?.cancel()
  const now = await $.clock.now()
  holdTimerAt = at
  holdTimer = $.clock.after(Math.max(1000, at - now + 30_000), () => {
    holdTimer = null
    holdTimerAt = 0
    requestPump($)
  })
}

/** Pumps when a held piece of work now fits. */
async function pumpIfRoom($: $) {
  const held = Object.values(await read($, heldA))
  if (!held.length) return
  const room = await roomNow($)
  if (held.some(h => checkRoom(h.estimateUsd, room).fits)) requestPump($)
}

async function maybeUpkeep($: $, isForced = false): Promise<string> {
  const cur = await read($, curationA)
  if (cur) {
    const agents = await read($, agentsA)
    if (agents.some(a => a.id === cur.agentId && a.status === 'running')) return 'Knowledge upkeep is already running.'
    await update($, curationA, () => null)
  }
  const p = await paths($)
  if (!(await $.fs.exists(p.index))) return 'No knowledge base here yet (/conductor init).'
  const text = (await readText($, p.inbox)) ?? ''
  const notes = text.includes('\n## ') ? text.slice(text.indexOf('\n## ') + 1) : ''
  const noteCount = (notes.match(/^## /gm) ?? []).length
  const dirty = (await read($, dirtyA)).slice(0, 40)
  const isDue = noteCount >= cfg.curateEvery || dirty.length >= cfg.mapEvery || (isForced && (noteCount > 0 || dirty.length > 0))
  if (!isDue) return `${plural(noteCount, 'note')} and ${plural(dirty.length, 'changed file')} waiting; upkeep runs at ${cfg.curateEvery} notes or ${cfg.mapEvery} files.`
  if (isUpkeepLaunching) return 'Knowledge upkeep is starting.'
  const upkeepEst = estimateCost(costHistory, 'curator', 'curator', 'haiku')
  const upkeepFit = checkRoom(upkeepEst.usd, await roomNow($))
  if (!upkeepFit.fits) return `Knowledge upkeep waits for usage: ${upkeepFit.reason}`
  const stale = await staleFacts($, dirty)
  isUpkeepLaunching = true
  reservedUsd.set('upkeep', upkeepEst.usd)
  await launchThen($, { subagentType: 'conductor:curator', description: 'Knowledge upkeep', prompt: P.upkeepTask({ notes, changed: dirty, stale }), model: 'haiku' }, async l => {
    isUpkeepLaunching = false
    const agentId = l.agentId
    reservedUsd.delete('upkeep')
    if (agentId === undefined) {
      notify($, `knowledge upkeep did not start: ${l.deny}`, false)
      return
    }
    reservedUsd.set(agentId, upkeepEst.usd)
    await update($, curationA, () => ({ agentId, length: text.length, files: dirty }))
  })

  return `Knowledge upkeep: ${plural(noteCount, 'note')}, ${plural(dirty.length, 'changed file')}, ${plural(stale.length, 'fact')} to re-check.`
}

async function finishUpkeep($: $, isDone: boolean) {
  const cur = await read($, curationA)
  if (!cur) return
  await update($, curationA, () => null)
  if (!isDone) return
  const p = await paths($)
  await serial(async () => {
    const text = (await readText($, p.inbox)) ?? ''
    await $.fs.write(p.inbox, INBOX_HEADER + text.slice(cur.length))
  })
  const done = new Set(cur.files ?? [])
  await update($, dirtyA, list => list.filter(f => !done.has(f)))
}

// ---------------------------------------------------------------- plan

async function refreshPlan($: $, isForced = false): Promise<ConductorPlan | null> {
  const p = await paths($)
  let mtimeMs: number
  try {
    mtimeMs = (await $.fs.stat(p.plan)).mtimeMs
  } catch {
    if (lastPlanMtime !== 0) {
      lastPlanMtime = 0
      await update($, planA, () => null)
    }
    return null
  }
  if (!isForced && mtimeMs === lastPlanMtime) return read($, planA)
  lastPlanMtime = mtimeMs
  const text = await readText($, p.plan)
  if (text === null) return read($, planA)
  const plan = parsePlan(text, mtimeMs)
  await update($, planA, () => plan)
  await refreshStatus($)

  return plan
}

async function markPlan($: $, ref: string, state: PlanItemState, isForced = false) {
  if (!isTaskRef(ref)) return
  const p = await paths($)
  await serial(async () => {
    const text = await readText($, p.plan)
    if (text === null) return
    const r = setItemState(text, ref, state, isForced)
    if (r.isMatched && r.text !== text) await $.fs.write(p.plan, r.text)
  })
  await refreshPlan($, true)
}

async function tagPlan($: $, id: string, key: 'agent' | 'model', value: string | null) {
  const p = await paths($)
  await serial(async () => {
    const text = await readText($, p.plan)
    if (text === null) return
    const r = setItemTag(text, id, key, value)
    if (r.isMatched && r.text !== text) await $.fs.write(p.plan, r.text)
  })
  await refreshPlan($, true)
}

const itemById = (plan: ConductorPlan | null, id: string | null) =>
  id && plan ? ((plan.items ?? []).find(i => i.id === id) as (ConductorPlanItem & { id: string }) | undefined) : undefined

// ---------------------------------------------------------------- briefs

/** Writes the task's brief if it has none, else refreshes its inputs from the tasks it comes after. */
async function ensureBrief($: $, plan: ConductorPlan, item: ConductorPlanItem & { id: string }): Promise<string> {
  const p = await paths($)
  const path = briefPath(p.dir, item.id)
  const deps: DepResult[] = []
  for (const d of item.after) {
    const dep = itemById(plan, d)
    const doc = await readText($, briefPath(p.dir, d))
    deps.push({ id: d, text: dep?.text ?? '(not in the plan)', state: dep?.state ?? 'unknown', result: doc ? (getSection(doc, 'Result') ?? '').slice(0, 1200) : null })
  }
  await serial(async () => {
    const cur = await readText($, path)
    if (cur === null) {
      const decisions = decisionsExcerpt(await readText($, p.decisions))
      await $.fs.write(path, renderBrief(item, plan.title, deps, decisions))
    } else if (item.after.length) {
      const body = deps.map(d => `### ${d.id}: ${d.text} (${d.state})\n${d.result?.trim() || '(no result recorded)'}`).join('\n\n')
      await $.fs.write(path, setSection(cur, 'Inputs from earlier tasks', body))
    }
  })

  return path
}

async function editBrief($: $, id: string, fn: (doc: string) => string) {
  const p = await paths($)
  const path = briefPath(p.dir, id)
  await serial(async () => {
    const cur = await readText($, path)
    if (cur !== null) await $.fs.write(path, fn(cur))
  })
}

// ---------------------------------------------------------------- context

async function checkpoint($: $, why: string): Promise<string> {
  const p = await paths($)
  if (!(await $.fs.exists(p.index))) return 'No knowledge base here yet (/conductor init).'
  const r = await $.model.fork({ prompt: P.CHECKPOINT_PROMPT })
  if (!r.isAnswered) return `Checkpoint skipped: ${r.reason}.`
  const now = await $.clock.now()
  await $.fs.write(p.handoff, `<!-- conductor checkpoint ${iso(now)} (${why}) -->\n${r.text.trim()}\n`)
  const ctx = await read($, contextA)
  await update($, lastCheckpointA, () => ({ at: now, tokens: ctx.tokens ?? 0 }))
  await update($, statsA, s => ({ ...s, checkpoints: s.checkpoints + 1 }))

  return `Checkpoint written to ${P.KDIR}/session/handoff.md.`
}

const thresholds = (ctx: ConductorContext) => {
  const window = ctx.window || 200000
  const compactAt = Math.min(cfg.compactTokens, (window * cfg.compactPercent) / 100)
  const checkpointAt = (compactAt * Math.min(cfg.checkpointPercent, cfg.compactPercent)) / cfg.compactPercent

  return { compactAt, checkpointAt }
}

const tokensOf = (ctx: ConductorContext) => ctx.tokens ?? (ctx.percent !== null ? (ctx.percent * (ctx.window || 200000)) / 100 : 0)

async function isCheckpointFresh($: $) {
  const last = await read($, lastCheckpointA)
  const ctx = await read($, contextA)
  const tokens = tokensOf(ctx)

  return last !== null && tokens >= last.tokens && tokens - last.tokens < thresholds(ctx).compactAt * 0.2
}

async function compactNow($: $) {
  try {
    const r = await $.session.compact({ instructions: P.compactInstructions() })
    isCompactPending = false
    return 'skip' in r && r.skip ? `Compaction skipped: ${r.skip}.` : 'Compacted the main conversation.'
  } catch {
    isCompactPending = true
    return 'Compaction waits for the current turn to end.'
  }
}

async function maintain($: $, isCompactDue: boolean) {
  try {
    if (!(await isCheckpointFresh($))) await checkpoint($, isCompactDue ? 'before compaction' : 'context checkpoint')
    if (isCompactDue) {
      notify($, `context is filling; state saved to ${P.KDIR}/session/handoff.md, compacting.`, false)
      await compactNow($)
    }
  } catch (err) {
    $.ui.log(`conductor: maintenance failed: ${String(err)}`)
  } finally {
    isMaintaining = false
  }
}

async function considerMaintenance($: $) {
  if (isMaintaining || (await modeOf($)) === 'off') return
  const ctx = await read($, contextA)
  const tokens = tokensOf(ctx)
  const { compactAt, checkpointAt } = thresholds(ctx)
  const isCompactDue = tokens >= compactAt || isCompactPending
  const isCheckpointDue = tokens >= checkpointAt && !(await isCheckpointFresh($))
  if (!isCompactDue && !isCheckpointDue) return
  isMaintaining = true
  $.clock.after(300, () => void maintain($, isCompactDue))
}

// ---------------------------------------------------------------- routing

type Choice = { model?: ConductorTier; reason: string; kind: string }

async function chooseModel($: $, prompt: string, subagentType: string, asked: string | undefined, planItem: string | null): Promise<Choice> {
  const kind = kindOf(prompt, subagentType)
  if (cfg.routing === 'off') return { reason: 'routing off', kind }
  if (cfg.routing === 'auto' && asked) return { reason: `asked for ${asked}`, kind }
  if (cfg.routing === 'auto' && !ROUTABLE.has(subagentType)) return { reason: `${subagentType}'s own model`, kind }

  const top = cfg.topModel
  const attempt = planItem ? (await read($, attemptsA))[planItem] : undefined
  const item = itemById(await read($, planA), planItem)
  let tier: ConductorTier
  let reason: string
  if (attempt) {
    tier = nextTier(attempt.tier, top) ?? attempt.tier
    reason = `retry after ${attempt.tier} fell short`
  } else if (item?.model) {
    tier = clampTier(item.model, top)
    reason = 'plan tag'
  } else {
    const route = routeTask(prompt, subagentType, top)
    tier = route.tier
    reason = route.reason
    if (!route.isConfident && cfg.classifier) {
      const r = await $.model.complete({
        model: 'haiku',
        system: CLASSIFIER_SYSTEM,
        prompt: classifierPrompt(prompt),
        maxTokens: 8,
        effort: 'low',
        timeoutMs: 8000,
      })
      const said = r.isAnswered ? parseClassifier(r.text) : null
      if (said) {
        tier = said === 'opus' ? top : clampTier(said, top)
        reason = `classified ${said}`
      }
    }
    if (cfg.learnRouting) {
      const learned = learnedTier(tier, kind, await read($, routingA), top)
      if (learned !== tier) {
        reason = `learned: ${kind} often fails on ${tier}`
        tier = learned
      }
    }
  }
  if (await read($, downshiftA)) {
    const capped = clampTier(tier, 'sonnet')
    if (capped !== tier) reason += ' · rate-limit cap'
    tier = capped
  }

  return { model: tier, reason, kind }
}

async function learn($: $, row: ConductorAgent, isOk: boolean) {
  if (!cfg.learnRouting || !row.tier || !row.kind) return
  const next = recordOutcome(await read($, routingA), row.kind, row.tier, isOk)
  await update($, routingA, () => next)
  await $.store.set('routing', next)
}

// ---------------------------------------------------------------- spend and the daily budget

async function addSpend($: $, tier: ConductorTier, u: TokenUsage) {
  const tokens = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const spent = costOf(tier, u)
  const onTop = costOf(cfg.topModel, u)
  await update($, spendA, s => {
    const row = s[tier] ?? ZERO
    return { ...s, [tier]: { tokens: row.tokens + tokens, usd: row.usd + spent, topUsd: row.topUsd + onTop } }
  })
}

/** Records this session's cost today and sums every session's, against the daily budget. */
async function measureBudget($: $, sessionUsd: number) {
  const now = await $.clock.now()
  const day = dayOf(now)
  if (costBase?.day !== day) {
    const startedAt = (await $.session.usage()).startedAt
    costBase = { day, usd: dayOf(startedAt) === day ? 0 : sessionUsd }
  }
  const sessionId = await $.session.id()
  await $.store.set(`budget:${day}:${sessionId}`, Math.max(0, sessionUsd - costBase.usd))
  let total = 0
  for (const key of await $.store.keys()) {
    if (!key.startsWith(`budget:${day}:`)) continue
    const v = await $.store.get(key)
    if (typeof v === 'number') total += v
  }
  await update($, todayA, t => ({ day, usd: total, isWrappingUp: t.day === day ? t.isWrappingUp : false }))
  await checkBudget($)
}

async function checkBudget($: $) {
  const budget = await budgetOf($)
  if (!budget) return
  const today = await read($, todayA)
  const pct = (today.usd / budget) * 100
  if (pct >= cfg.budgetWrapUpPercent && !today.isWrappingUp) await wrapUp($, pct, budget)
}

/** Near the daily budget: the main agent is told to wind down; running agents finish, and the plan run starts a task only when its estimate fits. */
async function wrapUp($: $, pct: number, budget: number) {
  await update($, todayA, t => ({ ...t, isWrappingUp: true }))
  notify($, `daily budget at ${Math.round(pct)}% of ${usd(budget)}: running agents finish; a new task starts only when enough budget is left for it.`, true)
  await tellMain(
    $,
    `The daily usage budget is ${Math.round(pct)}% used. Wrap up your own work: start nothing big, let running agents finish, and tell the user where things stand. The plan run starts a task only when enough of the budget is left for it.`,
  )
  later($, () => checkpoint($, 'daily budget'), 500)
}

// ---------------------------------------------------------------- the Needs-you queue

async function addQuestion($: $, q: ConductorQuestion) {
  await update($, questionsA, list => [...list.filter(x => x.agentId !== q.agentId), q].slice(-20))
  notify($, `${q.itemId ?? q.from} needs you: ${clipText(q.question, 80)}`, true)
  await refreshStatus($)
  if (cfg.showPane) void openPane($, false, 'questions')
}

/** The person's answer to a question: written to the brief and decisions, the task back in the queue. */
async function answerQuestion($: $, qid: string, answer: string, how: 'user' | 'delegate' | 'dismiss') {
  drafts.delete(`qa-${qid}`)
  const q = (await read($, questionsA)).find(x => x.id === qid)
  if (!q) return
  await update($, questionsA, list => list.filter(x => x.id !== qid))
  await refreshStatus($)
  if (how === 'dismiss') return
  const text =
    how === 'delegate'
      ? 'The user leaves this to you: make the most reasonable choice, list it under <decisions>, and continue.'
      : answer.trim()
  if (!text) return
  const source = how === 'delegate' ? 'left to the agent' : 'the user'
  if (how === 'user') await appendDecisions($, [`${q.itemId ? `[${q.itemId}] ` : ''}${q.question} → ${text}`], source)

  if (q.itemId) {
    const itemId = q.itemId
    await editBrief($, itemId, doc => {
      const prev = getSection(doc, 'Answers from the user') ?? ''
      return setSection(doc, 'Answers from the user', `${prev}\n- Q: ${q.question}\n  A: ${text}`.trim())
    })
    await markPlan($, itemId, 'todo')
    const run = await read($, runA)
    const item = itemById(await read($, planA), itemId)
    if (run?.isActive) requestPump($)
    else if (item) void inFrame($, async () => dispatchItem($, item, { attempt: ((await read($, attemptsA))[item.id]?.count ?? 0) + 1 }))
    notify($, `answer sent; ${itemId} is back in the queue.`, false)
  } else {
    await tellMain($, `The user answered the question from ${q.from} ("${q.question}"): ${text}. Pass it on (re-dispatch with the answer) if the work should continue.`)
    notify($, 'answer passed to the main agent.', false)
  }
}

// ---------------------------------------------------------------- questions for later

/** Who asked, for the Questions pane header: `builder · sonnet`. */
function agentLabel(row: ConductorAgent): string {
  const kind = String(row.type ?? '').replace(/^conductor:/, '')
  return kind ? `${kind} · ${row.model}` : String(row.model ?? '')
}

/** Questions an agent left without stopping: listed in the pane, answered whenever the person likes. */
async function addLaterQuestions($: $, row: ConductorAgent, qs: readonly LaterQuestion[], now: number) {
  const itemId = isTaskRef(row.planItem) ? row.planItem : null
  await update($, laterQuestionsA, list => {
    const known = new Set(list.map(q => q.question))
    const added = qs
      .filter(q => q.question && !known.has(q.question))
      .map((q, i) => ({ id: `l-${row.id}-${i}`, itemId, from: row.description, question: q.question, assumed: q.assumed, why: q.why, choices: q.choices, chosen: q.chosen, agent: agentLabel(row), askedAt: now }))
    return uniqueIds([...list, ...added]).slice(-30)
  })
  notify($, `${plural(qs.length, 'question')} for later from ${itemId ?? row.description}: no rush, work goes on.`, false)
  await refreshStatus($)
}

/**
 * Gives every question an id no other one has. A resumed agent's next report numbers its questions from 0 again,
 * and two pane rows with one key make the desktop app refuse the whole pane.
 */
function uniqueIds<T extends { id: string }>(list: readonly T[]): T[] {
  const seen = new Set<string>()
  return list.map(q => {
    let id = q.id
    for (let n = 2; seen.has(id); n++) id = `${q.id}-${n}`
    seen.add(id)
    return id === q.id ? q : { ...q, id }
  })
}

/** The person's answer to a question left for later; `keep` confirms what the agent assumed. Nothing waited on it. */
async function answerLater($: $, qid: string, answer: string, how: 'answer' | 'keep' | 'dismiss') {
  drafts.delete(`la-${qid}`)
  const q = (await read($, laterQuestionsA)).find(x => x.id === qid)
  if (!q) return
  // Only the first with that id: lists kept from before ids were made unique may hold two.
  await update($, laterQuestionsA, list => {
    const at = list.findIndex(x => x.id === qid)
    return uniqueIds(list.filter((_, i) => i !== at))
  })
  await refreshStatus($)
  if (how === 'dismiss') return
  const text = how === 'keep' ? q.assumed || 'as assumed' : answer.trim()
  if (!text) return
  await appendDecisions($, [`${q.itemId ? `[${q.itemId}] ` : ''}${q.question} → ${text}`], how === 'keep' ? "the user kept the agent's assumption" : 'the user')
  if (q.itemId) {
    await editBrief($, q.itemId, doc => {
      const prev = getSection(doc, 'Answers from the user') ?? ''
      return setSection(doc, 'Answers from the user', `${prev}\n- Q: ${q.question}\n  A: ${text}`.trim())
    })
  }
  if (how === 'answer' && text !== q.assumed) {
    await tellMain(
      $,
      `The user answered a question ${q.itemId ?? q.from} left for later: "${q.question}" → ${text}. The agent had gone on assuming: ${q.assumed || '(nothing stated)'}. If finished work depends on it, add a plan task for the change; otherwise there is nothing to do.`,
    )
  }
  notify($, 'answer recorded.', false)
}

/** Empties the For later list without recording anything, like dismissing each question. */
async function dismissAllLater($: $) {
  for (const k of [...drafts.keys()]) if (k.startsWith('la-')) drafts.delete(k)
  await update($, laterQuestionsA, () => [])
  await refreshStatus($)
}

// ---------------------------------------------------------------- plan runs

async function busyItems($: $): Promise<Set<string>> {
  const busy = new Set<string>()
  for (const a of await read($, agentsA)) if (a.status === 'running' && a.planItem) busy.add(a.planItem.toUpperCase())
  for (const id of Object.values(await read($, verifyingA))) busy.add(id)
  for (const q of await read($, questionsA)) if (q.itemId) busy.add(q.itemId)
  for (const id of launching) busy.add(id)

  return busy
}

/**
 * What the person approves: a plan, by its title. Once approved it stays approved through edits (tasks added,
 * fixed, reordered by the agents or the main agent), so a run never stops for them; a plan with a new title asks
 * again. An untitled plan is approved by its tasks. A stored task signature from an earlier version still counts.
 */
const approvalKey = (plan: ConductorPlan) => (plan.title ? `title:${plan.title}` : `tasks:${planSignature(plan.items ?? [])}`)
const isPlanApproved = (plan: ConductorPlan, approval: string | null) =>
  !cfg.requireApproval || approval === approvalKey(plan) || approval === planSignature(plan.items ?? [])

/** Starts a run, or holds it for the person's approval when the plan has not been approved. */
async function startRun($: $, only: string[] | null, isByUser: boolean): Promise<string> {
  const plan = await refreshPlan($, true)
  if (!plan) return `There is no plan yet: have conductor:architect write ${P.KDIR}/plan.md first.`
  const active = await read($, runA)
  if (active?.isActive && !active.isPending) {
    // A run under way: with no ids it covers the whole plan from now on; ids join a run limited to some tasks.
    const next = !only || active.only === null ? null : [...new Set([...active.only, ...only])]
    await update($, runA, r => (r ? { ...r, only: next } : r))
    requestPump($)
    return `The run is under way and now covers ${next ? next.join(', ') : 'the whole plan'}; ready tasks start as soon as your turn ends. You will get a note when the run ends.`
  }
  if (isByUser) await update($, approvalA, () => approvalKey(plan))
  const isApproved = isPlanApproved(plan, await read($, approvalA))
  const now = await $.clock.now()
  const run: ConductorRun = { isActive: isApproved, isPaused: false, isPending: !isApproved, only, startedAt: now, dispatched: 0, done: [], blocked: [] }
  await update($, runA, () => run)
  await update($, welcomeA, () => null)
  await refreshStatus($)
  if (!isApproved) {
    notify($, 'the plan is ready for your review: approve it in the agents pane to start the run.', true)
    if (cfg.showPane) void openPane($)
    return 'The run waits for the user to approve the plan in the agents pane; it starts on approval. Tell the user the plan is ready for their review.'
  }
  const ready = readyItems(plan.items ?? [], await busyItems($)).filter(i => !only || only.includes(i.id!))
  requestPump($)
  if (cfg.showPane) void openPane($)

  return `Run started: ${plural(ready.length, 'task')} ready, up to ${cfg.maxParallel} at a time. They start as soon as your turn ends (the conductor launches between turns, so their progress shows in the pane); end your turn when you have nothing else to do. You will get a note when the run ends.`
}

async function approvePlan($: $, isRunning: boolean): Promise<string> {
  const plan = await refreshPlan($, true)
  if (!plan) return 'There is no plan to approve.'
  await update($, approvalA, () => approvalKey(plan))
  const run = await read($, runA)
  if (run?.isPending || isRunning) {
    if (!run) return startRun($, null, true)
    await update($, runA, r => (r ? { ...r, isActive: true, isPending: false } : r))
    requestPump($)
    return 'Plan approved; the run is starting.'
  }

  return 'Plan approved.'
}

async function setPaused($: $, isPaused: boolean): Promise<string> {
  const run = await read($, runA)
  if (!run?.isActive) return 'No plan run is active.'
  await update($, runA, r => (r ? { ...r, isPaused } : r))
  if (!isPaused) requestPump($)
  await refreshStatus($)

  return isPaused ? 'Run paused: running agents finish, nothing new starts.' : 'Run resumed.'
}

async function stopRun($: $): Promise<string> {
  const run = await read($, runA)
  if (!run) return 'No plan run is active.'
  await update($, runA, () => null)
  await update($, heldA, () => ({}))
  holdTimer?.cancel()
  holdTimer = null
  holdTimerAt = 0
  const runners = (await read($, agentsA)).filter(a => a.status === 'running' && a.role === 'run')
  for (const a of runners) await stopAgent($, a.id)
  await refreshStatus($)

  return `Run stopped${runners.length ? `; stopped ${plural(runners.length, 'agent')}` : ''}.`
}

/** Stops an agent, inside a frame like a launch; `isDeferred` waits for the next frame (not the agent's own tool call). */
async function stopAgent($: $, agentId: string, isDeferred = false) {
  const stop = async () => {
    try {
      await $.tool.call({ tool: 'TaskStop', task_id: agentId })
    } catch (err) {
      $.ui.log(`conductor: could not stop ${agentId}: ${String(err)}`)
    }
  }
  if (isDeferred) {
    deferredQueue.push(stop)
    scheduleWake($)
  } else await inFrame($, stop)
}

/** Starts every ready task the run has room for; ends the run when nothing is left to start or wait on. Runs inside a frame. */
async function pump($: $) {
  if (isPumping) return
  isPumping = true
  try {
    const run = await read($, runA)
    if (!run?.isActive || run.isPaused) return
    const plan = await refreshPlan($, true)
    if (!plan) {
      await finishRun($, 'the plan is gone')
      return
    }
    const agents = await read($, agentsA)
    const runners = agents.filter(a => a.status === 'running' && (a.role === 'run' || a.role === 'verify'))
    const busy = await busyItems($)
    const ready = readyItems(plan.items ?? [], busy).filter(i => !run.only || run.only.includes(i.id!))
    // Holds that no longer apply: the task is not ready any more, or its check has nothing left to check.
    const readyIds = new Set(ready.map(i => i.id))
    const planItems = plan.items ?? []
    for (const key of Object.keys(await read($, heldA))) {
      const id = key.startsWith('verify:') ? key.slice(7) : key
      const it = planItems.find(i => i.id === id)
      const isStale = key.startsWith('verify:') ? !it || it.state === 'done' : !readyIds.has(id)
      if (isStale) await update($, heldA, m => without(m, key))
    }
    // Held checks try again first.
    const verifying = Object.values(await read($, verifyingA))
    for (const key of Object.keys(await read($, heldA)).filter(k => k.startsWith('verify:'))) {
      const it = planItems.find(i => i.id === key.slice(7))
      if (!it || it.state === 'done' || verifying.includes(it.id!) || launching.has(key)) continue
      await dispatchVerify($, it as ConductorPlanItem & { id: string }).catch(err => $.ui.log(`conductor: check of ${it.id} failed: ${String(err)}`))
    }
    // A held task does not block a smaller one behind it: only started tasks use up the room.
    let room = Math.max(0, cfg.maxParallel - runners.filter(a => a.role === 'run').length - launching.size)
    for (const item of ready) {
      if (room <= 0) break
      const attempt = ((await read($, attemptsA))[item.id!]?.count ?? 0) + 1
      const r = await dispatchItem($, item as ConductorPlanItem & { id: string }, { attempt }).catch(err => {
        $.ui.log(`conductor: dispatch of ${item.id} failed: ${String(err)}`)
      })
      if (r === 'started') room--
    }
    await scheduleHoldWake($)
    const questions = (await read($, questionsA)).filter(q => q.itemId)
    if (ready.length === 0 && runners.length === 0 && launching.size === 0 && Object.keys(await read($, verifyingA)).length === 0 && Object.keys(await read($, heldA)).length === 0) {
      await finishRun($, questions.length ? `${plural(questions.length, 'question')} wait for the user` : '')
    }
  } finally {
    isPumping = false
  }
}

type DispatchOpts = { attempt: number; tier?: ConductorTier }

/** Launches a plan task's agent; the task counts as launching (busy) until its launch has an outcome. */
async function dispatchItem($: $, item: ConductorPlanItem & { id: string }, opts: DispatchOpts): Promise<'started' | 'held' | 'skipped'> {
  if (launching.has(item.id)) return 'skipped'
  launching.add(item.id)
  const release = () => void launching.delete(item.id)
  try {
    return await dispatchItemNow($, item, opts, release)
  } catch (err) {
    release()
    throw err
  }
}

async function dispatchItemNow($: $, item: ConductorPlanItem & { id: string }, opts: DispatchOpts, release: () => void): Promise<'started' | 'held' | 'skipped'> {
  const plan = await refreshPlan($, true)
  // The plan may have moved on since this launch was queued: a task ticked done, or one for the person, stays put.
  const current = itemById(plan, item.id)
  if (!plan || !current || current.state === 'done' || isGated(current)) {
    release()
    return 'skipped'
  }
  const p = await paths($)
  const agent = item.agent && WORK_AGENTS.has(item.agent) ? item.agent : 'builder'
  const type = `conductor:${agent}`
  const brief = await ensureBrief($, plan, item)
  // A held task keeps the model it was given, so waiting does not ask the classifier again.
  const prior = (await read($, heldA))[item.id]
  const choice: Choice = opts.tier
    ? { model: opts.tier, reason: 'escalated', kind: kindOf(item.text, type) }
    : prior && prior.attempt === opts.attempt
      ? { model: prior.tier, reason: prior.choiceReason, kind: prior.kind }
      : await chooseModel($, `${item.text}\n${item.files.join(' ')}`, type, undefined, item.id)
  const tier = choice.model ?? (item.model ? clampTier(item.model, cfg.topModel) : 'sonnet')
  const est = estimateCost(costHistory, choice.kind, agent, tier)
  if (await holdIfNoRoom($, item.id, item.id, est, { tier, choiceReason: choice.reason, kind: choice.kind, attempt: opts.attempt })) {
    release()
    return 'held'
  }
  reservedUsd.set(item.id, est.usd)
  const description = `${item.id}: ${clipText(item.text, 48)}${opts.attempt > 1 ? ` (try ${opts.attempt})` : ''}`
  const effort = item.effort ?? effortFor(type, tier)
  dispatchMeta.set(description, { role: 'run', type, reason: choice.reason, kind: choice.kind, attempt: opts.attempt, effort, planItem: item.id })
  await markPlan($, item.id, 'doing')
  const prompt = P.runTaskPrompt(item, relTo(p.root, brief), opts.attempt, P.policyLine(await autonomyOf($)))
  await launchThen($, { subagentType: type, description, prompt, model: tier }, async l => {
    try {
      const agentId = l.agentId
      reservedUsd.delete(item.id)
      if (agentId === undefined) {
        dispatchMeta.delete(description)
        await noteLaunchFailure($, item.id, tier, l)
        return
      }
      reservedUsd.set(agentId, est.usd)
      await update($, launchIssuesA, m => without(m, item.id))
      await upsertAgent(
        $,
        makeRow(
          { id: agentId, description, type, model: l.model ?? tier, reason: choice.reason, role: 'run', planItem: item.id, kind: choice.kind, attempt: opts.attempt, effort },
          await $.clock.now(),
        ),
      )
      await update($, runA, run => (run ? { ...run, dispatched: run.dispatched + 1 } : run))
    } finally {
      release()
    }
  })

  return 'started'
}

/** A plan task whose agent could not be launched: the reason goes to its brief and the pane. Not an attempt at the task. */
async function noteLaunchFailure($: $, id: string, model: string, l: Launch) {
  const now = await $.clock.now()
  const reason = l.deny ?? 'no agent id'
  await update($, launchIssuesA, m => ({ ...m, [id]: { reason, at: now, tries: l.tries, model } }))
  await editBrief($, id, doc => {
    const prev = getSection(doc, 'Launch problems') ?? ''
    return setSection(doc, 'Launch problems', `${prev}\n- ${iso(now)} · ${model} · not started after ${plural(l.tries, 'try')}: ${reason}`.trim())
  })
  await markPlan($, id, 'blocked')
  await update($, runA, run => (run ? { ...run, blocked: run.blocked.includes(id) ? run.blocked : [...run.blocked, id] } : run))
  notify($, `${id} could not start (reason in its brief and the agents pane): ${clipText(reason, 140)}`, true)
  await refreshStatus($)
  requestPump($)
}

/** Puts a task whose launch failed back in the queue. */
async function retryLaunch($: $, id: string): Promise<string> {
  const item = itemById(await read($, planA), id)
  if (!item) return `No plan task ${id}.`
  await update($, launchIssuesA, m => without(m, id))
  await markPlan($, id, 'todo', true)
  if ((await read($, runA))?.isActive) requestPump($)
  else void inFrame($, async () => dispatchItem($, item, { attempt: ((await read($, attemptsA))[id]?.count ?? 0) + 1 }))
  await refreshStatus($)

  return `${id} is back in the queue.`
}

async function dispatchVerify($: $, item: ConductorPlanItem & { id: string }) {
  const key = `verify:${item.id}`
  if (launching.has(key)) return
  launching.add(key)
  const release = () => void launching.delete(key)
  try {
    await dispatchVerifyNow($, item, release)
  } catch (err) {
    release()
    throw err
  }
}

async function dispatchVerifyNow($: $, item: ConductorPlanItem & { id: string }, release: () => void) {
  const p = await paths($)
  const description = `verify ${item.id}`
  const key = `verify:${item.id}`
  const est = estimateCost(costHistory, 'verifier', 'verifier', 'haiku')
  if (await holdIfNoRoom($, key, `the check of ${item.id}`, est, { tier: 'haiku', choiceReason: 'verification', kind: 'verifier', attempt: 1 })) return release()
  reservedUsd.set(key, est.usd)
  dispatchMeta.set(description, { role: 'verify', type: 'conductor:verifier', reason: 'verification', kind: 'verifier', attempt: 1, effort: 'low', planItem: null })
  const prompt = P.verifyTaskPrompt(item, relTo(p.root, briefPath(p.dir, item.id)))
  await launchThen($, { subagentType: 'conductor:verifier', description, prompt, model: 'haiku' }, async l => {
    try {
      const agentId = l.agentId
      reservedUsd.delete(key)
      if (agentId !== undefined) reservedUsd.set(agentId, est.usd)
      if (agentId === undefined) {
        dispatchMeta.delete(description)
        const now = await $.clock.now()
        await editBrief($, item.id, doc => setSection(doc, 'Verification', `${iso(now)} · not verified: the verifier could not start (${l.deny}). Marked done on the builder's report.`))
        await markPlan($, item.id, 'done')
        return
      }
      await update($, verifyingA, m => ({ ...m, [agentId]: item.id }))
      await upsertAgent(
        $,
        makeRow(
          { id: agentId, description, type: 'conductor:verifier', model: l.model ?? 'haiku', reason: 'verification', role: 'verify', planItem: null, kind: 'verifier', attempt: 1, effort: 'low' },
          await $.clock.now(),
        ),
      )
    } finally {
      release()
    }
  })
}

async function finishRun($: $, note: string) {
  const run = await read($, runA)
  if (!run) return
  await update($, runA, () => null)
  const plan = await read($, planA)
  const blocked = (plan?.items ?? []).filter(i => i.state === 'blocked').map(i => i.id ?? i.text)
  const gated = (plan?.items ?? []).filter(i => i.state !== 'done' && isGated(i)).map(i => i.id ?? i.text)
  const summary = `${plural(run.done.length, 'task')} finished this run${blocked.length ? `; blocked: ${blocked.join(', ')}` : ''}${gated.length ? `; for the user or you: ${gated.join(', ')}` : ''}${note ? `; ${note}` : ''}. Plan: ${plan?.done ?? 0}/${plan?.total ?? 0} done.`
  notify($, `plan run finished: ${summary}`, true)
  await tellMain($, `The plan run finished: ${summary} Briefs and results are in ${P.KDIR}/tasks/. Tell the user where things stand.`)
  whenFramed(() => maybeUpkeep($, true))
  await refreshStatus($)
}

// ---------------------------------------------------------------- finishing an agent

/** What an agent's final report means: its row, the plan, the briefs, the queue, the learning. Runs once per agent. */
async function completeAgent($: $, agentId: string, answer: string, reason: string, usage: (TokenUsage & { model?: string }) | null) {
  reservedUsd.delete(agentId)
  const row = (await read($, agentsA)).find(a => a.id === agentId)
  if (!row || row.status !== 'running') return
  const report = extractStatus(answer)
  const needs = row.role === 'verify' || row.role === 'upkeep' ? null : extractNeeds(answer)
  const status: ConductorAgentStatus =
    reason === 'answer' ? (report === 'blocked' && !needs ? 'failed' : 'done') : reason === 'aborted' ? 'stopped' : 'failed'
  const isOk = status === 'done' && report !== 'partial' && report !== 'blocked' && !needs
  const now = await $.clock.now()
  const tier = row.tier ?? tierOf(usage?.model)
  const tokens = usage ? usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : null
  const summary = cleanText(summarize(answer))
  await updateAgent($, agentId, a => ({
    ...a,
    status,
    endedAt: now,
    tokens,
    costUsd: usage && tier ? costOf(tier, usage) : null,
    summary,
    activity: needs ? 'needs you' : report ? `STATUS: ${report}` : status,
    done: isOk && a.total ? a.total : a.done,
    tasks: settleTasks(a.tasks ?? [], isOk ? 'done' : status === 'stopped' ? 'stopped' : 'blocked'),
  }))
  if (usage && tier) {
    await addSpend($, tier, usage)
    const cost = costOf(tier, usage)
    if (Number.isFinite(cost) && cost > 0) {
      const agentType = row.type.replace(/^conductor:/, '')
      costHistory = recordCost(costHistory, row.kind || agentType, agentType, tier, cost)
      await $.store.set('costs', costHistory)
    }
  }

  const source = `${row.planItem && isTaskRef(row.planItem) ? `${row.planItem}, ` : ''}${row.model} agent`
  await appendDecisions($, extractDecisions(answer), source)
  const later = row.role === 'verify' || row.role === 'upkeep' ? [] : extractQuestions(answer)
  if (later.length) await addLaterQuestions($, row, later, now)
  const notes = extractKnowledge(answer)
  if (notes) await fileNotes($, row, notes)
  if ((row.role === 'main' || row.role === 'run') && reason !== 'aborted' && !needs) await learn($, row, isOk)

  if (row.role === 'verify') await onVerified($, row, answer)
  else if (row.role === 'upkeep') await finishUpkeep($, status === 'done')
  else if (isTaskRef(row.planItem)) await onTaskReport($, row, { status, isOk, reason, needs, summary })
  else if (needs) {
    await addQuestion($, { id: `q-${agentId}`, itemId: null, agentId, from: row.description, question: needs.question, options: needs.options, why: needs.why, choices: needs.choices, agent: agentLabel(row), askedAt: now })
  }

  if (row.role !== 'upkeep') whenFramed(() => maybeUpkeep($))
  if ((await read($, runA))?.isActive) requestPump($)
  await refreshStatus($)
}

type TaskOutcome = { status: ConductorAgentStatus; isOk: boolean; reason: string; needs: Needs | null; summary: string }

async function onTaskReport($: $, row: ConductorAgent, o: TaskOutcome) {
  const id = row.planItem!
  const now = await $.clock.now()
  await editBrief($, id, doc =>
    recordResult(doc, { at: iso(now), model: row.model, status: o.needs ? 'needs the user' : o.isOk ? 'done' : o.status, attempt: row.attempt || 1, summary: o.summary }),
  )
  // A task already done (ticked by the main agent, or an earlier report) is not reopened, re-verified or retried.
  const current = itemById(await refreshPlan($, true), id)
  if (current?.state === 'done') return
  if (o.reason === 'aborted') {
    if (budgetStopped.delete(row.id)) {
      await editBrief($, id, doc =>
        setSection(
          doc,
          'Stopped at the tool-call budget',
          `${iso(now)} · ${row.model} · stopped after ${row.toolCalls} tool calls (budget ${row.budget}). Last step: ${row.step || row.activity}. Files it touched: ${(row.files ?? []).join(', ') || 'none recorded'}. Pick up from those files rather than starting over, or split the task.`,
        ),
      )
      await retryOrBlock($, current, id, row.tier, 'it was stopped at twice its tool-call budget', row.role === 'run')
      return
    }
    await markPlan($, id, 'todo')
    return
  }
  if (o.needs) {
    await markPlan($, id, 'blocked')
    await addQuestion($, { id: `q-${row.id}`, itemId: id, agentId: row.id, from: row.description, question: o.needs.question, options: o.needs.options, why: o.needs.why, choices: o.needs.choices, agent: agentLabel(row), askedAt: now })
    return
  }
  const item = itemById(await read($, planA), id)
  if (o.isOk) {
    if (item && (cfg.verify === 'always' || (cfg.verify === 'tagged' && item.verify))) {
      const isVerifying = Object.values(await read($, verifyingA)).includes(id) || launching.has(`verify:${id}`)
      if (!isVerifying) void inFrame($, () => dispatchVerify($, item))
      return
    }
    await markPlan($, id, 'done')
    await update($, attemptsA, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)))
    await update($, runA, run => (run ? { ...run, done: [...run.done, id] } : run))
    return
  }
  await retryOrBlock($, item, id, row.tier, o.summary, row.role === 'run')
}

/** A failed task: retried one tier up (up to three tries) when the conductor dispatched it, else blocked. */
async function retryOrBlock($: $, item: (ConductorPlanItem & { id: string }) | undefined, id: string, tier: ConductorTier | null, why: string, isRun: boolean) {
  if (itemById(await read($, planA), id)?.state === 'done') return
  const prev = (await read($, attemptsA))[id]
  const count = (prev?.count ?? 0) + 1
  const from = tier ?? prev?.tier ?? 'sonnet'
  await update($, attemptsA, m => ({ ...m, [id]: { tier: from, count, report: why.slice(0, 1500) } }))
  const up = nextTier(from, cfg.topModel) ?? (count < 2 ? from : null)
  if (cfg.escalate && isRun && item && count < MAX_ATTEMPTS && up) {
    await editBrief($, id, doc => setSection(doc, 'What went wrong last time', `On ${from}: ${why}`))
    await markPlan($, id, 'todo')
    notify($, `${id} fell short on ${from}; retrying on ${up}.`, false)
    void inFrame($, () => dispatchItem($, item, { attempt: count + 1, tier: up }))
    return
  }
  await markPlan($, id, 'blocked')
  await update($, runA, run => (run ? { ...run, blocked: [...run.blocked, id] } : run))
  notify($, `${id} is blocked after ${plural(count, 'try')}.`, true)
}

async function onVerified($: $, row: ConductorAgent, answer: string) {
  const id = (await read($, verifyingA))[row.id]
  await update($, verifyingA, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== row.id)))
  if (!id) return
  const verdict = parseVerdict(answer)
  const now = await $.clock.now()
  // A later verdict on a task already done (another verifier's, a re-report's) is recorded and changes nothing.
  const isDone = itemById(await refreshPlan($, true), id)?.state === 'done'
  await editBrief($, id, doc =>
    setSection(doc, 'Verification', `${iso(now)} · ${verdict ? (verdict.isPass ? 'pass' : 'fail') : 'inconclusive'}\n\n${verdict?.detail ?? summarize(answer, 600)}`),
  )
  if (isDone) return
  if (!verdict || verdict.isPass) {
    await markPlan($, id, 'done')
    await update($, attemptsA, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)))
    await update($, runA, run => (run ? { ...run, done: [...run.done, id] } : run))
    return
  }
  const builder = (await read($, agentsA))
    .filter(a => a.planItem === id && a.role !== 'verify')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
  if (builder) await learn($, builder, false)
  await retryOrBlock($, itemById(await read($, planA), id), id, builder?.tier ?? null, `The verifier failed it: ${verdict.detail}`, builder?.role !== 'main')
}

// ---------------------------------------------------------------- tool calls inside agents

/** A TodoWrite, TaskCreate or TaskUpdate call folded into its loop's list: the main agent's or a subagent's. */
async function recordTasks($: $, agentId: string | undefined, tool: string, input: Record<string, unknown>, result: unknown) {
  const apply = (prev: readonly ConductorTask[]): ConductorTask[] | null => {
    if (tool === 'TodoWrite') return Array.isArray(input.todos) ? fromTodos(input.todos as Array<Record<string, unknown>>) : null
    if (tool === 'TaskUpdate') return taskUpdated(prev, input)
    const task = (result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
    const id = task?.id === undefined ? null : String(task.id)

    return id === null ? null : taskCreated(prev, id, str(task?.subject) || str(input.subject))
  }

  if (agentId === undefined) {
    await update($, mainTasksA, prev => apply(prev) ?? prev)
    return
  }
  const source = tool === 'TodoWrite' ? ('todo' as const) : ('tasks' as const)
  await updateAgent($, agentId, a => {
    const tasks = apply(a.taskSource === source ? (a.tasks ?? []) : [])
    if (!tasks) return a
    const c = countTasks(tasks)
    return { ...a, tasks, taskSource: source, done: c.done, total: c.total, step: tasks.find(t => t.state === 'doing')?.text ?? a.step }
  })
}

/** Counts a subagent's tool call, and keeps it to its tool-call budget. */
async function noteToolCall($: $, agentId: string, tool: string, input: Record<string, unknown>) {
  let isOver = false
  let isWayOver = false
  await updateAgent($, agentId, a => {
    const calls = a.toolCalls + 1
    const budget = a.budget || 100
    isOver = calls > budget && !a.isWarned
    isWayOver = calls === budget * 2 + 1 && a.status === 'running'
    return { ...a, toolCalls: calls, activity: describeCall(tool, input), isWarned: a.isWarned || isOver }
  })
  if (isOver) {
    later($, async () => {
      await $.session.send({
        to: { agentId },
        text: 'You have used the tool-call budget for this task. Wrap up: finish the step you are on, then give your final report (STATUS: partial if unfinished, saying what is left).',
      })
    })
  }
  if (isWayOver) {
    budgetStopped.add(agentId)
    notify($, `stopped an agent at twice its tool-call budget (${agentId}); its partial work goes to its task's brief.`, false)
    void stopAgent($, agentId, true)
  }
}

async function markEdited($: $, agentId: string, file: string) {
  const p = await paths($)
  const rel = relTo(p.root, file)
  if (rel.toLowerCase().startsWith(`${P.KDIR}/`) || rel === file.replace(/\\/g, '/')) return
  await update($, dirtyA, list => (list.includes(rel) ? list : [...list, rel].slice(-200)))
  await updateAgent($, agentId, a => ({ ...a, files: (a.files ?? []).includes(rel) ? a.files : [...(a.files ?? []), rel].slice(-30) }))
}

// ---------------------------------------------------------------- the progress report (no model calls)

async function writeReport($: $): Promise<string> {
  const p = await paths($)
  const plan = await refreshPlan($, true)
  const spend = await read($, spendA)
  const routing = await read($, routingA)
  const today = await read($, todayA)
  const now = await $.clock.now()
  const phases = phasesOf(plan?.items ?? [])
  const results = new Map<string, string>()
  for (const item of plan?.items ?? []) {
    if (!item.id || item.state === 'todo') continue
    const doc = await readText($, briefPath(p.dir, item.id))
    const r = doc ? getSection(doc, 'Result') : null
    if (r) results.set(item.id, r.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 300))
  }
  const tiers = (Object.keys(spend) as ConductorTier[]).filter(k => spend[k].tokens > 0)
  const spent = tiers.reduce((s, k) => s + spend[k].usd, 0)
  const onTop = tiers.reduce((s, k) => s + spend[k].topUsd, 0)
  const saved = onTop > 0 ? ` (saved ${Math.round((1 - spent / onTop) * 100)}%)` : ''
  const frac = plan ? fracOf({ total: plan.total, done: plan.done, doing: plan.doing, blocked: plan.blocked }) : 0
  const glyph = { done: '✓', doing: '◉', todo: '○', blocked: '✕' } as const

  const md = [
    `# Progress report: ${plan?.title || 'project'}`,
    '',
    `${iso(now)} · ${plan ? `${plan.done}/${plan.total} tasks done (${pctOf(frac)}%)${plan.blocked ? `, ${plan.blocked} blocked` : ''}` : 'no plan'}`,
    '',
    ...phases.flatMap(ph => [
      `## ${ph.name || 'Tasks'} (${ph.done}/${ph.total})`,
      '',
      ...ph.items.map(i => `- ${glyph[i.state]} ${planItemText(i)}${i.id && results.has(i.id) ? `\n  - ${results.get(i.id)}` : ''}`),
      '',
    ]),
    '## Usage (estimated)',
    '',
    ...tiers.map(k => `- ${k}: ${kTokens(spend[k].tokens)} tokens, ${usd(spend[k].usd)}`),
    `- Subagents in all: ${usd(spent)}; the same work on ${cfg.topModel} alone: ${usd(onTop)}${saved}`,
    ...(today.day ? [`- Today across sessions: ${usd(today.usd)}`] : []),
    '',
    '## What the router has learned',
    '',
    ...(Object.keys(routing).length
      ? Object.entries(routing).map(([k, v]) => `- ${k}: ${Object.entries(v).map(([tr, o]) => `${tr} ${o?.ok ?? 0}/${(o?.ok ?? 0) + (o?.fail ?? 0)}`).join(', ')}`)
      : ['- Nothing yet.']),
    '',
  ].join('\n')

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const color = { done: '#3FB950', doing: '#D97757', todo: '#8B949E', blocked: '#E5534B' } as const
  const list = phases
    .map(
      ph =>
        `<h2>${esc(ph.name || 'Tasks')} <span class="m">${ph.done}/${ph.total}</span></h2><ul>${ph.items
          .map(
            i =>
              `<li><span style="color:${color[i.state]}">${glyph[i.state]}</span> ${esc(planItemText(i))}${i.id && results.has(i.id) ? `<div class="r">${esc(results.get(i.id)!)}</div>` : ''}</li>`,
          )
          .join('')}</ul>`,
    )
    .join('\n')
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(plan?.title || 'Progress report')}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1f2328;background:#fff}
@media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}}h1{font-size:22px}h2{font-size:16px;margin-top:28px}
ul{padding:0}li{margin:4px 0;list-style:none}.r{opacity:.7;font-size:13px;margin-left:22px}.m{opacity:.7}svg{max-width:100%;height:auto}</style></head><body>
<h1>${esc(plan?.title || 'Progress report')}</h1><p class="m">${esc(iso(now))} · ${plan ? `${plan.done}/${plan.total} tasks done (${pctOf(frac)}%)` : 'no plan'}</p>
${svgBar(frac, 820, planMarks(plan?.items ?? [], 60), SVG_FILL.plan)}
${list}
<h2>Usage <span class="m">(estimated)</span></h2><ul>${tiers.map(k => `<li>${k}: ${kTokens(spend[k].tokens)} tokens, ${usd(spend[k].usd)}</li>`).join('')}
<li>Subagents in all ${usd(spent)}; the same work on ${cfg.topModel} alone ${usd(onTop)}${saved}</li></ul>
</body></html>`

  await $.fs.write(`${p.report}.md`, md)
  await $.fs.write(`${p.report}.html`, html)

  return `${P.KDIR}/report.md and ${P.KDIR}/report.html`
}

// ---------------------------------------------------------------- the welcome-back card

async function welcomeText($: $): Promise<string | null> {
  const plan = await read($, planA)
  if (!plan || plan.done >= plan.total) return null
  const items = plan.items ?? []
  const blocked = items.filter(i => i.state === 'blocked').map(i => i.id ?? clipText(i.text, 20))
  const next = readyItems(items, new Set())[0]
  const parts = [`Welcome back · ${plan.title || 'plan'}: ${plan.done}/${plan.total} done`]
  if (plan.doing) parts.push(`${plan.doing} were in progress`)
  if (blocked.length) parts.push(`blocked: ${blocked.slice(0, 3).join(', ')}`)
  if (next) parts.push(`next up: ${planItemText(next)}`)

  return clipText(parts.join(' · '), 200)
}

// ---------------------------------------------------------------- self-test

const SELFTEST = 'conductor self-test'
/** While a self-test or probe runs: each step its launch passed through, timed from its start. */
let selfTestLog: string[] | null = null
let traceT0 = 0
const trace = (line: string) => {
  if (selfTestLog) selfTestLog.push(traceT0 ? `+${Date.now() - traceT0}ms ${line}` : line)
}

const SELFTEST_PROMPT = 'Self-test of the conductor mod. Reply with exactly "STATUS: done" and nothing else. Use no tools.'
const PROBE_TOOLS_PROMPT = `Self-test of the conductor mod. Call ${P.PROGRESS_TOOL} with steps ["look", "report"] and done 0. Then run Glob with pattern "*.md". Then call ${P.PROGRESS_TOOL} with done 2. Then reply exactly "STATUS: done".`

/** Launches one tiny Haiku agent the way plan runs do (inside a frame, through launch()) and reports the outcome and its steps. */
async function selfTest($: $): Promise<string> {
  selfTestLog = []
  traceT0 = Date.now()
  dispatchMeta.set(SELFTEST, { role: 'upkeep', type: 'conductor:scout', reason: 'self-test', kind: 'selftest', attempt: 1, effort: 'low', planItem: null })
  const l = await launchOnce($, { subagentType: 'conductor:scout', description: SELFTEST, prompt: SELFTEST_PROMPT, model: 'haiku' })
  const steps = selfTestLog
  selfTestLog = null
  traceT0 = 0
  const isOk = l.agentId !== undefined

  return [
    `Self-test ${isOk ? 'passed: the mod can launch its own agents here' : 'FAILED: the mod cannot launch its own agents here'}.`,
    `Launch result: ${isOk ? `started agent ${l.agentId} on ${l.model ?? '?'}` : `refused: ${l.deny}`}`,
    'The mod launches its agents from inside its own hooks (a tool call, a finished turn, a command or a press in the pane); work that comes due elsewhere waits for the next one.',
    'Steps:',
    ...(steps.length ? steps.map(x => `- ${x}`) : ['- (no step was seen)']),
  ].join('\n')
}

/**
 * Diagnosis, for the main agent (run_plan with tasks ["__PROBE_LATE__"], then ["__PROBE_STATUS__"]): a launch
 * timed the way a plan run times it, 0.3s after the tool call returns, while the agent's next request streams.
 */
function probeLate($: $): string {
  selfTestLog = []
  traceT0 = Date.now()
  trace('probe scheduled; the tool call returns now')
  $.clock.after(300, () => {
    trace('probe launches')
    void launchThen($, { subagentType: 'conductor:scout', description: 'conductor probe', prompt: PROBE_TOOLS_PROMPT, model: 'haiku' }, async l =>
      trace(`launch result: ${JSON.stringify(l)}`),
    )
  })

  return 'Probe scheduled: a launch in 0.3s. Read the trace with tasks ["__PROBE_STATUS__"] once it has answered.'
}

/** Diagnosis: launches, inside run_plan, an agent that reports progress and makes a tool call. */
async function probeTools($: $): Promise<string> {
  selfTestLog = []
  traceT0 = Date.now()
  const l = await launchOnce(
    $,
    {
      subagentType: 'conductor:scout',
      description: 'conductor probe',
      prompt: `Self-test of the conductor mod. Call ${P.PROGRESS_TOOL} with steps ["look", "report"] and done 0. Then run Glob with pattern "*.md". Then call ${P.PROGRESS_TOOL} with done 2. Then reply exactly "STATUS: done".`,
      model: 'haiku',
    },
  )
  trace(`launch result: ${JSON.stringify(l)}`)

  return `Probe agent ${l.agentId ?? `not started: ${l.deny}`}. Read its pane row with tasks ["__PROBE_STATUS__"].`
}

async function probeStatus($: $): Promise<string> {
  const rows = (await read($, agentsA))
    .filter(a => a.description === 'conductor probe')
    .map(a => `row ${a.id}: ${a.status} · ${a.toolCalls} tool calls · ${a.activity} · tasks ${JSON.stringify(a.tasks)}`)
  const out = [...(selfTestLog ?? ['(no probe trace)']), ...rows].join('\n')
  if (/launch result/.test(out)) {
    selfTestLog = null
    traceT0 = 0
  }

  return out
}

// ---------------------------------------------------------------- state from older versions

const ROW_DEFAULTS: Partial<ConductorAgent> = {
  tasks: [],
  taskSource: null,
  files: [],
  summary: '',
  isAdopted: false,
  isWarned: false,
  budget: 100,
  costUsd: null,
  tokens: null,
  step: '',
  activity: '',
  done: null,
  total: null,
  planItem: null,
  role: 'main',
  tier: null,
  effort: null,
  kind: '',
  attempt: 1,
  toolCalls: 0,
  reason: '',
  endedAt: null,
}

/** Fills what values kept from an older version of the mod lack, so nothing reads a field that is not there. */
async function tidyState($: $) {
  await update($, agentsA, list =>
    (Array.isArray(list) ? list : []).filter(a => a && typeof a.id === 'string').map(a => ({ ...ROW_DEFAULTS, ...a, description: str(a.description) || a.id, model: str(a.model) || '?' }) as ConductorAgent),
  )
  await update($, questionsA, list =>
    Array.isArray(list)
      ? list
          .filter(q => q && typeof q.id === 'string')
          .map(q => {
            const options: string[] = Array.isArray(q.options) ? q.options.filter((o: unknown): o is string => typeof o === 'string') : []
            const choices: ConductorChoice[] = Array.isArray(q.choices) ? q.choices : options.map(label => ({ label, detail: '', isRecommended: false }))
            return { ...q, options, why: str(q.why), choices, agent: str(q.agent) }
          })
      : [],
  )
  await update($, laterQuestionsA, list => uniqueIds(Array.isArray(list) ? list.filter(q => q && typeof q.id === 'string').map(q => ({ ...q, assumed: str(q.assumed), from: str(q.from), why: str(q.why), agent: str(q.agent), choices: Array.isArray(q.choices) ? q.choices : [], chosen: typeof q.chosen === 'number' ? q.chosen : null })).filter(q => q.choices.length > 0 || q.assumed !== '' || String(q.question ?? '').includes('?')) : []))
  await update($, launchIssuesA, m => (m && typeof m === 'object' ? m : {}))
  await update($, heldA, m => (m && typeof m === 'object' && !Array.isArray(m) ? m : {}))
  await update($, runA, r => (r ? { ...r, done: Array.isArray(r.done) ? r.done : [], blocked: Array.isArray(r.blocked) ? r.blocked : [], only: Array.isArray(r.only) ? r.only : null } : r))
  await update($, expandedA, m => (m && typeof m === 'object' ? m : {}))
}

/** What the pane's drawing did lately, per surface, for `/conductor diag`: no model calls, nothing written until asked. */
type DrawRecord = { started: number; finished: number; lastStartAt: number; lastEndAt: number; lastMs: number; lastError: string; chars: number; nodes: number; props: unknown; tree: unknown }
const paneDraws: Record<string, DrawRecord> = {}
/** Half-typed "Other" answers by Input key. Not $.state: a write per keystroke would redraw the pane and reset the field. */
const drafts = new Map<string, string>()
let lastTickRedrawAt = 0

/** Draws through `draw`; when drawing throws, a short note says why instead of the engine dropping the pane. */
async function safeDraw(
  $: $,
  table: () => Table,
  site: { surface: string; props: unknown; pane?: 'agents' | 'questions' },
  draw: () => Promise<RenderElement>,
): Promise<RenderElement> {
  const isQuestions = site.pane === 'questions'
  const rec = (paneDraws[isQuestions ? `questions/${site.surface}` : site.surface] ??= { started: 0, finished: 0, lastStartAt: 0, lastEndAt: 0, lastMs: 0, lastError: '', chars: 0, nodes: 0, props: null, tree: null })
  const startedAt = Date.now()
  rec.started += 1
  rec.lastStartAt = startedAt
  rec.props = site.props
  try {
    const tree = uniqueKeys(cleanTree(await draw()))
    const json = JSON.stringify(tree)
    rec.finished += 1
    rec.lastEndAt = Date.now()
    rec.lastMs = rec.lastEndAt - startedAt
    rec.chars = json.length
    rec.nodes = json.split('"type":').length - 1
    rec.tree = tree
    return tree
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    rec.lastError = message
    rec.lastEndAt = Date.now()
    if (message !== lastDrawError) {
      lastDrawError = message
      $.ui.log(`conductor: the ${isQuestions ? 'questions' : 'agents'} pane could not draw: ${message}`)
    }
    const { Box, Text, Button } = table()
    return (
      <Box flexDirection="column">
        <Text color="error">{isQuestions ? 'The Questions pane could not draw.' : 'The agents pane could not draw.'}</Text>
        <Text dimColor wrap="wrap">
          {cleanText(clipText(message, 300))}
        </Text>
        <Button key="reset-view" label="reset view" onPress={() => act(update($, expandedA, () => ({})))} />
      </Box>
    )
  }
}

/**
 * `/conductor diag`: writes what the pane's drawing did lately (per surface: draws started and finished, time,
 * last error, size, the props the engine gave and the last tree) and the mod's state to
 * `.knowledge/session/pane-diag.json`, so a pane that draws blank can be replayed in a test. No model calls.
 */
async function writeDiag($: $): Promise<string> {
  const p = await paths($)
  const now = Date.now()
  let panes: unknown = null
  try {
    panes = await $.ui.panes()
  } catch (err) {
    panes = `could not list: ${String(err)}`
  }
  const plan = await read($, planA)
  const state = {
    agents: await read($, agentsA),
    run: await read($, runA),
    expanded: await read($, expandedA),
    expandAll: await read($, expandAllA),
    questions: await read($, questionsA),
    laterQuestions: await read($, laterQuestionsA),
    launchIssues: await read($, launchIssuesA),
    verifying: await read($, verifyingA),
    attempts: await read($, attemptsA),
    approval: await read($, approvalA),
    pane: await read($, paneStateA),
    questionsPane: await read($, questionsPaneA),
    mode: await modeOf($),
    plan: plan ? { title: plan.title, total: plan.total, done: plan.done, items: plan.items.length } : null,
  }
  const draws = Object.fromEntries(Object.entries(paneDraws).map(([surface, r]) => [surface, { ...r, sinceLastStartMs: now - r.lastStartAt, isDrawing: r.lastStartAt > r.lastEndAt }]))
  const path = `${p.dir}/session/pane-diag.json`
  await $.fs.write(path, JSON.stringify({ at: new Date(now).toISOString(), panes, draws, state }, null, 1))
  const summary = Object.entries(paneDraws)
    .map(([surface, r]) => `${surface}: ${r.finished}/${r.started} draws finished, last ${r.lastMs} ms, ${r.chars} chars, ${r.nodes} elements${r.lastError ? `, last error: ${clipText(r.lastError, 120)}` : ''}`)
    .join('; ')

  return `Wrote ${relTo(p.root, path)}. ${summary || 'The pane has not been drawn since the mod loaded.'}`
}

// ---------------------------------------------------------------- the clock

/** Every 2s: pick up plan.md edits, settle agents that ended unseen, redraw elapsed times. */
async function tick($: $) {
  if (isTicking) return
  isTicking = true
  try {
    await refreshPlan($)
    const agents = await read($, agentsA)
    const listed = await $.agent.list()
    const infos = new Map(listed.map(i => [i.id, i]))
    const now = await $.clock.now()

    // Running in the session but not in the pane: resumed with SendMessage, or started unseen. Picked up on
    // the second tick in a row, and not in the seconds after a finish, since the list can lag a spawn hook
    // adding the row or a turn.complete settling it.
    const live = new Set<string>()
    for (const info of listed) {
      if (info.status !== 'running' && info.status !== 'pending') continue
      const row = agents.find(a => a.id === info.id)
      if (row?.status === 'running') continue
      if (row?.endedAt != null && now - row.endedAt < 6000) continue
      if (unseenLive.has(info.id)) await adoptAgent($, info.id, info)
      else live.add(info.id)
    }
    unseenLive = live

    for (const a of agents.filter(x => x.status === 'running')) {
      const info = infos.get(a.id)
      if (!info || info.status === 'running' || info.status === 'pending') continue
      // Ended without our turn.complete seeing it: read its last answer from its transcript.
      let answer = ''
      try {
        const rows = await $.session.messages({ agentId: a.id })
        if (Array.isArray(rows)) answer = [...rows].reverse().find(m => m.role === 'assistant' && m.text.trim())?.text ?? ''
      } catch {
        // no transcript to read
      }
      const reason = info.status === 'completed' ? 'answer' : info.status === 'killed' || info.status === 'stopped' ? 'aborted' : 'error'
      await completeAgent($, a.id, answer, reason, null)
    }
    // Only elapsed times change with the clock; a redraw with nothing running resets nothing useful, so it is rare.
    const anyRunning = (await read($, agentsA)).some(x => x.status === 'running')
    if (anyRunning || now - lastTickRedrawAt >= 30000) {
      lastTickRedrawAt = now
      $.ui.invalidate('ui.render')
    }
  } catch (err) {
    $.ui.log(`conductor: tick failed: ${String(err)}`)
  } finally {
    isTicking = false
  }
}

// ---------------------------------------------------------------- register

export const register: Register = (on, options) => {
  cfg = configOf(options)

  // ------------------------------------------------------------ session start

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'conductor',
      description: 'Conductor: plan runs, agents pane, approvals, autonomy, budget, report, checkpoint, compact',
      argumentHint:
        '[status|test|run [ids]|retry <id>|pause|resume|stop|approve|plan <goal>|report|autonomy <level>|budget <usd>|pane|band|expand|mode <m>|checkpoint|compact|curate|init|route <task>]',
    })
    await $.tool.register({
      name: 'progress',
      description:
        "Report your progress on the task you were given, for the conductor's progress display: call it once you have a plan (steps: your step list, done: 0) and again after each step (done: steps finished). Cheap; returns at once.",
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 12,
            description: 'Your steps for this task, in order, a few words each. Send on the first call, and again only if the plan changes.',
          },
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          step: { type: 'string', description: 'Optional: the step you are on now, when you sent no steps list.' },
          total: { type: 'integer', minimum: 1, description: 'Optional: your step count, when you sent no steps list.' },
        },
        required: ['done'],
      },
    })
    await $.tool.register({
      name: 'run_plan',
      description:
        'Run the project plan in .knowledge/plan.md: the conductor dispatches every ready task to the agent and model the plan names, in parallel, writes each a brief, verifies results, retries failures on a stronger model, queues questions for the user and ticks the plan. Returns at once; a note arrives when the run ends. If the user has not approved the plan yet, the run waits for their approval in the agents pane. Main agent only.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: { type: 'array', items: { type: 'string' }, description: 'Optional: run only these task ids (e.g. ["T4", "T5"]).' },
        },
      },
    })

    const p = await paths($)
    const specs = [
      {
        name: 'scout',
        description:
          'Fast read-only investigator: finds, reads and summarizes code and docs, answers questions about the codebase with file paths. Use for any lookup or exploration.',
        prompt: P.scoutPrompt(p.root),
        model: 'haiku',
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', P.RUN_TOOL],
      },
      {
        name: 'builder',
        description: 'Implements features, fixes bugs, refactors, writes tests and runs builds. Use for any change to project files.',
        prompt: P.builderPrompt(p.root),
        model: 'sonnet',
        disallowedTools: ['Agent', P.RUN_TOOL],
      },
      {
        name: 'architect',
        description:
          'Designs systems, writes the project plan, reviews risky changes and finds root causes of hard bugs. Use before large or ambiguous work.',
        prompt: P.architectPrompt(p.root),
        model: cfg.topModel,
        disallowedTools: ['Agent', P.RUN_TOOL],
      },
      {
        name: 'curator',
        description: 'Keeps the .knowledge/ base: folds notes in, keeps the code map current, re-checks stale facts. Run by the conductor mod.',
        prompt: P.curatorPrompt(p.root),
        model: 'haiku',
        disallowedTools: ['Agent', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', P.RUN_TOOL, P.PROGRESS_TOOL],
      },
      {
        name: 'verifier',
        description: 'Checks one finished plan task against its done-criteria. Run by the conductor mod.',
        prompt: P.verifierPrompt(p.root),
        model: 'haiku',
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', P.RUN_TOOL, P.PROGRESS_TOOL],
      },
    ]
    for (const spec of specs) {
      try {
        await $.agent.register(spec)
      } catch (err) {
        $.ui.log(`conductor: agent ${spec.name} not registered: ${String(err)}`)
      }
    }

    await tidyState($)
    // Urgent questions already waiting: show them unasked (openPane skips an open pane or one the person closed).
    if (cfg.showPane && (await read($, questionsA)).length) void openPane($, false, 'questions')
    const learned = await $.store.get('routing')
    if (learned && typeof learned === 'object') await update($, routingA, () => learned as Record<string, never>)
    const storedCosts = await $.store.get('costs')
    if (storedCosts && typeof storedCosts === 'object' && !Array.isArray(storedCosts)) {
      const clean: ConductorCostHistory = {}
      for (const [k, v] of Object.entries(storedCosts as Record<string, unknown>)) {
        if (Array.isArray(v) && v.every(x => typeof x === 'number' && Number.isFinite(x))) clean[k] = v as number[]
      }
      costHistory = clean
    }
    const storedRatio = await $.store.get('usageRatio')
    if (storedRatio && typeof storedRatio === 'object' && !Array.isArray(storedRatio)) {
      const clean: ConductorUsageRatio = {}
      for (const [k, v] of Object.entries(storedRatio as Record<string, unknown>)) {
        const row = v as { usd?: unknown; pts?: unknown } | null
        if (row && typeof row.usd === 'number' && typeof row.pts === 'number' && Number.isFinite(row.usd) && Number.isFinite(row.pts)) clean[k] = { usd: row.usd, pts: row.pts }
      }
      usageRatio = clean
    }
    try {
      lastWindows = [...(await $.session.usage()).rateLimits]
    } catch {
      lastWindows = []
    }
    const today = dayOf(await $.clock.now())
    for (const key of await $.store.keys()) {
      if (key.startsWith('budget:') && !key.startsWith(`budget:${today}:`)) await $.store.delete(key)
    }

    await refreshPlan($, true)
    if ((await $.session.turns()) === 0 && !(await read($, runA))?.isActive) {
      const text = await welcomeText($)
      await update($, welcomeA, () => text)
    }
    await refreshStatus($)
    $.clock.every(2000, () => void tick($))
    if (cfg.showPane && (await modeOf($)) !== 'off') void openPane($)

    return r
  })

  // ------------------------------------------------------------ prompts

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const mode = await modeOf($)
    const isMain = e.tools.includes('Agent') && !e.traits.includes('teammate')
    if (mode === 'off' || !isMain) return r

    return {
      sections: [
        ...r.sections,
        {
          id: 'conductor:orchestrator',
          text: P.orchestratorSection(mode === 'enforce', mode === 'enforce' && cfg.requirePlanItem),
          scope: 'session' as const,
        },
      ],
    }
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if ((await modeOf($)) === 'off') return r
    const text = await knowledgeBlock($)

    return text ? { ...r, blocks: [...r.blocks, { name: 'conductorKnowledge', text }] } : r
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isKnowledgeChecked && (await modeOf($)) !== 'off') {
      isKnowledgeChecked = true
      try {
        if ((await ensureKnowledge($, 'auto')) === 'created') {
          notify($, `created ${P.KDIR}/ (knowledge base and plan) in this project.`, false)
          await refreshPlan($, true)
          if (cfg.bootstrapKnowledge) whenFramed(() => bootstrap($))
        }
      } catch (err) {
        $.ui.log(`conductor: could not create the knowledge base: ${String(err)}`)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ subagents

  on('agent.offer', { agent: 'conductor:curator' }, () => ({ isOffered: false })).catch(($, e, next) => next(e))
  on('agent.offer', { agent: 'conductor:verifier' }, () => ({ isOffered: false })).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (e.fork) return next(e)
    const mode = await modeOf($)
    const meta = dispatchMeta.get(e.description)
    const type = e.subagentType ?? meta?.type ?? 'general-purpose'
    const role: ConductorRole =
      type === 'conductor:verifier' ? 'verify' : type === 'conductor:curator' ? 'upkeep' : (meta?.role ?? (e.prompt.includes(P.RUN_MARK) ? 'run' : 'main'))
    const planRef = meta ? meta.planItem : extractPlanItem(e.prompt)
    let prompt = e.prompt
    let choice: Choice = { reason: meta?.reason ?? role, kind: meta?.kind ?? kindOf(prompt, type) }

    if (role === 'main') {
      const isWork = type === 'conductor:builder' || (GENERIC.has(type) && WRITES.test(prompt.toLowerCase()))
      if (mode === 'enforce' && cfg.requirePlanItem && planRef === null && isWork) {
        return {
          deny: `Conductor: give this task a line \`Plan item: T<n>\` naming the plan task it covers, or \`Plan item: none\` for a one-off. For multi-step work, have conductor:architect write ${P.KDIR}/plan.md and call ${P.RUN_TOOL}.`,
        }
      }
      choice = await chooseModel($, prompt, type, e.model, isTaskRef(planRef) ? planRef : null)
      if (mode !== 'off') {
        const p = await paths($)
        if (GENERIC.has(type) && !prompt.includes('## Conductor protocol')) prompt += P.footer(p.root)
        const plan = await read($, planA)
        const item = isTaskRef(planRef) ? itemById(plan, planRef) : undefined
        if (plan && item) {
          const brief = relTo(p.root, await ensureBrief($, plan, item))
          if (!prompt.includes(brief)) prompt += `\n\nYour brief: ${brief}. Read it first.`
        }
        if (!prompt.includes('Decision policy:')) prompt += `\n\n${P.policyLine(await autonomyOf($))}`
      }
    }

    const r = await next({ ...e, prompt, ...(choice.model ? { model: choice.model } : {}) })
    dispatchMeta.delete(e.description)
    if (r.deny !== undefined || r.agentId === undefined) return r

    const tier = tierOf(r.model)
    const planItem = isTaskRef(planRef) ? planRef : null
    const row = makeRow(
      {
        id: r.agentId,
        description: e.description,
        type,
        model: r.model,
        reason: choice.reason,
        role,
        planItem,
        kind: choice.kind,
        attempt: meta?.attempt ?? (planItem ? ((await read($, attemptsA))[planItem]?.count ?? 0) + 1 : 1),
        effort: meta?.effort ?? effortFor(type, tier),
      },
      await $.clock.now(),
    )
    await update($, agentsA, list => prune([...list.filter(a => a.id !== row.id), row]))
    await update($, statsA, s => (tier ? { ...s, [tier]: s[tier] + 1 } : { ...s, other: s.other + 1 }))
    if (planItem && role === 'main') await markPlan($, planItem, 'doing')
    await refreshStatus($)
    if (cfg.showPane && mode !== 'off' && role !== 'upkeep') void openPane($)

    return r
  }).catch(($, e, next) => next(e))

  // Each subagent thinks as hard as its job needs: low for lookups and checks, high for design.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      lastMainActivityAt = Date.now()
      trace(`main request ${e.index}`)
      return yield* next(e)
    }
    let row = (await read($, agentsA)).find(a => a.id === e.agentId)
    // A request from an agent the pane shows as finished, or does not know: it was resumed (or started unseen).
    if (row?.status !== 'running' && (await adoptAgent($, e.agentId))) row = (await read($, agentsA)).find(a => a.id === e.agentId)
    if (row && row.tier === null) {
      const tier = tierOf(e.model)
      if (tier) await updateAgent($, row.id, a => ({ ...a, tier, model: tier }))
    }
    if (e.effort === undefined || !row?.effort || row.effort === e.effort) return yield* next(e)

    return yield* next({ ...e, effort: row.effort })
  })

  // A frame: queued launches and a requested pump run at its end.
  on('turn.complete', async ($, e, next) => framed($, async () => {
    const r = await next(e)
    try {
      if (e.agentId === undefined) {
        if (isCompactPending) await considerMaintenance($)
        return r
      }
      const row = (await read($, agentsA)).find(a => a.id === e.agentId)
      const startedAt = (await $.clock.now()) - e.durationMs
      if (!row || (row.status !== 'running' && row.endedAt !== null && startedAt > row.endedAt)) await adoptAgent($, e.agentId)
      await completeAgent($, e.agentId, e.answer, e.reason, e.usage ?? null)
    } catch (err) {
      $.ui.log(`conductor: could not record ${e.agentId ?? 'main'} turn: ${String(err)}`)
    }

    return r
  }))

  // The main conversation keeps reports without their filed blocks, and large outputs as a pointer to a file.
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined || (await modeOf($)) === 'off') return next(e)
    const o = e.origin
    const tool = o.kind === 'tool' ? String(o.tool) : null
    const isReport = tool === 'Agent' || o.kind === 'task-notification'
    const isResult = e.door === 'tool-result' && tool !== null && !tool.startsWith('mcp__conductor__')
    if (!isReport && !isResult) return next(e)

    const p = await paths($)
    const strip = (text: string) =>
      isReport ? stripTagged(stripTagged(stripTagged(text, 'knowledge', `${P.KDIR}/inbox.md`), 'decisions', `${P.KDIR}/decisions.md`), 'questions', 'the Questions pane') : text
    const content: typeof e.message.content = []
    let isChanged = false
    for (const b of e.message.content) {
      if (b.type === 'text' && typeof b.text === 'string') {
        const text = strip(b.text)
        isChanged ||= text !== b.text
        content.push(text === b.text ? b : { ...b, text })
        continue
      }
      if (b.type !== 'tool_result') {
        content.push(b)
        continue
      }
      const { text, hasMedia } = textOfResult(b.content)
      const clean = strip(text)
      if (isResult && !hasMedia && clean.length > cfg.spillChars) {
        const file = `${p.spill}/${spillName(tool ?? 'tool', String(b.tool_use_id ?? Date.now()))}`
        await $.fs.write(file, clean)
        content.push({ ...b, content: spillNote(relTo(p.root, file), clean) })
        isChanged = true
      } else if (clean !== text && !hasMedia) {
        content.push({ ...b, content: clean })
        isChanged = true
      } else {
        content.push(b)
      }
    }

    return isChanged ? next({ ...e, message: { ...e.message, content } }) : next(e)
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ tools

  on('tool.describe', { tool: 'mcp__conductor__progress' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__conductor__run_plan' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.check', { tool: 'mcp__conductor__progress' }, () => ({ decision: 'allow' as const })).catch(($, e, next) => next(e))
  // Also where the mod's own launches happen (see spawnSafe): a query carrying a launch token spawns its agent.
  on('tool.check', { tool: 'mcp__conductor__run_plan' }, async ($, e) => {
    const token = str((e.input as { conductorLaunch?: unknown } | null)?.conductorLaunch)
    const request = token ? launchRequests.get(token) : undefined
    if (request) {
      try {
        request.result = await $.agent.spawn(request.args)
      } catch (err) {
        request.result = { deny: String(err) }
      }
    }

    return { decision: 'allow' as const }
  }).catch(($, e, next) => next(e))

  // The agents this mod launches itself (plan runs, verifiers, upkeep, /conductor plan) come from no model
  // request, so auto mode's classifier has nothing to judge and refuses them, and other modes would open a
  // dialog per task. The mod approves those launches, and only those: its own call, of its own agent types.
  // Every tool call the launched agents make is still decided by the session's mode as usual.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const type = str((e.input as { subagent_type?: unknown } | null)?.subagent_type)
    if (cfg.approveOwnAgents && next.origin.plugin === $.plugin.name && OWN_TYPES.has(type)) {
      trace(`tool.check: origin ${next.origin.plugin}, ${type} → allow (the mod's own launch)`)
      return { decision: 'allow' as const, reason: 'launched by the conductor mod' }
    }
    const r = await next(e)
    trace(`tool.check: origin ${next.origin.plugin}, ${type} → ${r.decision} (${r.reason ?? ''})`)

    return r
  }).catch(($, e, next) => next(e))

  // Self-test tracing: the later permission steps an Agent launch can meet.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (selfTestLog && e.tool_name === 'Agent') trace('PermissionRequest raised for Agent')
    const r = await next(e)
    if (selfTestLog && e.tool_name === 'Agent') trace(`PermissionRequest answered: ${JSON.stringify(r).slice(0, 300)}`)
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PermissionDenied', async ($, e, next) => {
    if (selfTestLog && e.tool_name === 'Agent') trace(`PermissionDenied: ${e.reason}`)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Stopping an agent this mod is tracking (the stop buttons, tool-call budgets, stopping a run).
  on('tool.check', { tool: 'TaskStop' }, async ($, e, next) => {
    const id = str((e.input as { task_id?: unknown } | null)?.task_id)
    if (cfg.approveOwnAgents && next.origin.plugin === $.plugin.name && (await read($, agentsA)).some(a => a.id === id)) {
      return { decision: 'allow' as const, reason: 'stopped by the conductor mod' }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Not a launch frame (see framed): an agent launched here would skip this very hook for its own tool calls.
  on('tool.call', async ($, e, next) => (async () => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (e.agentId === undefined) lastMainActivityAt = Date.now()

    if (e.agentId !== undefined && (await read($, agentsA)).find(a => a.id === e.agentId)?.status !== 'running') {
      await adoptAgent($, e.agentId)
    }

    if (tool === P.PROGRESS_TOOL) {
      if (e.agentId !== undefined) {
        const done = int(input.done)
        const total = int(input.total)
        const step = str(input.step)
        const steps = Array.isArray(input.steps) ? input.steps.filter((x): x is string => typeof x === 'string') : null
        await updateAgent($, e.agentId, a => {
          const list = fromProgress(a.tasks ?? [], a.taskSource ?? null, { done, total, step, steps })
          const isList = list.source === 'steps'
          const c = countTasks(list.tasks)
          const current = list.tasks.find(t => t.state === 'doing')
          return {
            ...a,
            tasks: list.tasks,
            taskSource: list.source,
            total: isList ? c.total : total && total > 0 ? total : a.total,
            done: isList ? c.done : done === null ? a.done : Math.min(done, total || a.total || done),
            step: current?.text ?? (step || a.step),
          }
        })
      }
      return { result: 'Progress noted.' }
    }

    if (tool === P.RUN_TOOL) {
      if (e.agentId !== undefined) return { result: 'Only the main agent starts plan runs.' }
      const only = Array.isArray(input.tasks) ? input.tasks.filter((x): x is string => typeof x === 'string').map(x => x.toUpperCase()) : null
      if (only?.includes('__SELFTEST__')) return { result: await selfTest($) }
      if (only?.includes('__DIAG__')) return { result: await writeDiag($) }
      if (only?.includes('__PROBE_LATE__')) return { result: probeLate($) }
      if (only?.includes('__PROBE_TOOLS__')) return { result: await probeTools($) }
      if (only?.includes('__PROBE_STATUS__')) return { result: await probeStatus($) }
      return { result: await startRun($, only && only.length ? only : null, false) }
    }

    if (e.agentId !== undefined) {
      await noteToolCall($, e.agentId, tool, input)
    } else if (EDIT_TOOLS.has(tool) && (await modeOf($)) === 'enforce') {
      const file = (str(input.file_path) || str(input.notebook_path)).replace(/\\/g, '/')
      if (file) {
        const p = await paths($)
        const cwd = (await $.session.cwd()).replace(/\\/g, '/')
        const abs = (/^([a-z]:)?\//i.test(file) ? file : `${cwd}/${file}`).toLowerCase()
        const isInProject = abs.startsWith(`${p.root.toLowerCase()}/`)
        const isKnowledge = abs.startsWith(`${p.dir.toLowerCase()}/`)
        if (isInProject && !isKnowledge) {
          return {
            deny: `Conductor: in this session the main agent orchestrates and subagents edit project files. Delegate this change to a conductor:builder agent with a self-contained prompt (goal, files, constraints, done-criteria, Plan item). The user can allow direct edits with /conductor mode guide.`,
          }
        }
      }
    }

    if (selfTestLog && tool === 'Agent') trace(`tool.call Agent: origin ${next.origin.plugin}`)
    const r = await next(e)
    if (selfTestLog && tool === 'Agent') trace(`tool.call Agent answered: ${JSON.stringify({ deny: r.deny, isError: r.isError, text: r.text }).slice(0, 400)}`)
    const isOk = r.deny === undefined && r.isError !== true
    if (TASK_TOOLS.has(tool) && isOk) await recordTasks($, e.agentId, tool, input, r.result)
    const file = str(input.file_path) || str(input.notebook_path)
    if (EDIT_TOOLS.has(tool) && isOk && file) {
      if (e.agentId !== undefined) await markEdited($, e.agentId, file)
      if (/\/\.knowledge\/plan\.md$/i.test(file.replace(/\\/g, '/'))) await refreshPlan($, true)
    }

    return r
  })()).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ context, cost and rate limits

  on('session.measure', async ($, e, next) => framed($, async () => {
    const r = await next(e)
    await update($, contextA, () => ({
      percent: e.context.percent ?? null,
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      costUsd: e.cost?.usd ?? null,
    }))
    if (e.cost && e.changed.includes('cost')) await measureBudget($, e.cost.usd)
    lastWindows = [...e.rateLimits]
    if (e.cost) {
      const cur: UsageSample = { usd: e.cost.usd, pct: Object.fromEntries(e.rateLimits.map(l => [l.kind, l.percentUsed])) }
      const learned = learnRatio(usageRatio, lastUsageSample, cur)
      lastUsageSample = cur
      if (learned !== usageRatio) {
        usageRatio = learned
        await $.store.set('usageRatio', learned)
      }
    }
    await pumpIfRoom($)
    if (cfg.rateLimitDownshift > 0 && e.changed.includes('rateLimits')) {
      const worst = Math.max(0, ...e.rateLimits.map(l => l.percentUsed))
      const isDown = worst >= cfg.rateLimitDownshift
      if (isDown !== (await read($, downshiftA))) {
        await update($, downshiftA, () => isDown)
        notify($, isDown ? `a rate-limit window is ${worst}% used: new tasks are capped at sonnet.` : 'rate limits eased: model routing is back to normal.', false)
      }
    }
    await refreshStatus($)
    if (e.changed.includes('context')) await considerMaintenance($)

    return r
  }))

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || (await modeOf($)) === 'off') return next(e)
    if ((e.trigger === 'manual' || e.trigger === 'auto') && !(await isCheckpointFresh($))) {
      try {
        await checkpoint($, `${e.trigger} compaction`)
      } catch (err) {
        $.ui.log(`conductor: checkpoint before compaction failed: ${String(err)}`)
      }
    }
    const ours = P.compactInstructions()
    const instructions = e.instructions?.includes(ours) ? e.instructions : [e.instructions, ours].filter(Boolean).join('\n\n')
    const r = await next({ ...e, instructions })
    if (!('skip' in r && r.skip)) await update($, statsA, s => ({ ...s, compactions: s.compactions + 1 }))

    return r
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ command

  on('command.run', { command: 'conductor' }, async ($, e) => framed($, async () => {
    const [sub = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)

    switch (sub.toLowerCase()) {
      case 'pane': {
        await openPane($, true)
        const waiting = (await read($, paneStateA)).waiting
        return { text: waiting ? `The agents pane is waiting to be placed: ${waiting}` : 'Agents pane opened.' }
      }
      case 'questions':
      case 'q': {
        await openPane($, true, 'questions')
        const waiting = (await read($, questionsPaneA)).waiting
        return { text: waiting ? `The Questions pane is waiting to be placed: ${waiting}` : 'Questions pane opened.' }
      }
      case 'diag':
        return { text: await writeDiag($) }
      case 'run':
        return { text: await startRun($, rest.length ? rest.map(x => x.toUpperCase()) : null, true) }
      case 'approve':
        return { text: await approvePlan($, false) }
      case 'pause':
        return { text: await setPaused($, true) }
      case 'resume':
        return { text: await setPaused($, false) }
      case 'stop':
        return { text: await stopRun($) }
      case 'plan': {
        const goal = rest.join(' ').trim()
        if (!goal) return { text: 'Usage: /conductor plan <goal>' }
        const p = await paths($)
        await ensureKnowledge($, 'init')
        whenFramed(async () => {
          await launchThen($, { subagentType: 'conductor:architect', description: `Plan: ${clipText(goal, 40)}`, prompt: P.planTask(p.root, goal), model: cfg.topModel }, async l => {
            if (l.agentId === undefined) notify($, `the architect did not start: ${l.deny}`, true)
          })
        })
        return { text: `An architect is drafting the plan for "${clipText(goal, 60)}". It shows in the agents pane for your approval when done.` }
      }
      case 'retry': {
        const id = rest[0]?.toUpperCase()
        if (!id) {
          const issues = Object.keys(await read($, launchIssuesA))
          return { text: issues.length ? `Usage: /conductor retry <id>. Tasks that could not start: ${issues.join(', ')}.` : 'Usage: /conductor retry <id>' }
        }
        return { text: await retryLaunch($, id) }
      }
      case 'test':
      case 'selftest':
        return { text: await selfTest($) }
      case 'report':
        return { text: `Report written to ${await writeReport($)} (built from saved data; no model calls).` }
      case 'autonomy': {
        const want = rest[0]?.toLowerCase() as Autonomy | undefined
        if (!want || !P.AUTONOMY_LEVELS.includes(want)) {
          const cur = await autonomyOf($)
          return { text: `Agents ${P.AUTONOMY_LABEL[cur]} (${cur}). Levels: ${P.AUTONOMY_LEVELS.join(', ')}.` }
        }
        await update($, autonomyA, () => want)
        return { text: `Agents now ${P.AUTONOMY_LABEL[want]}. It applies to tasks dispatched from now on.` }
      }
      case 'budget': {
        const v = Number(rest[0])
        if (!rest[0] || !Number.isFinite(v) || v < 0) {
          const b = await budgetOf($)
          const t = await read($, todayA)
          return {
            text: b
              ? `Daily budget ${usd(b)}; today ${usd(t.usd)} (${Math.round((t.usd / b) * 100)}%). /conductor budget <usd> changes it, 0 turns it off.`
              : 'No daily budget. /conductor budget <usd> sets one.',
          }
        }
        await update($, budgetA, () => v)
        await update($, todayA, t => ({ ...t, isWrappingUp: false }))
        await checkBudget($)
        if (Object.keys(await read($, heldA)).length) requestPump($)
        return { text: v ? `Daily budget set to ${usd(v)}: a plan task starts only when enough of it is left for that task; models are never changed for it.` : 'Daily budget off.' }
      }
      case 'expand':
      case 'tasks': {
        const isOpen = !((await read($, expandedA)).band ?? false)
        await update($, expandedA, m => ({ ...m, band: isOpen }))
        await update($, bandHiddenA, () => false)
        return { text: isOpen ? "Project bar expanded: the plan's tasks show above the prompt." : 'Project bar collapsed.' }
      }
      case 'band': {
        const isHidden = !(await read($, bandHiddenA))
        await update($, bandHiddenA, () => isHidden)
        return { text: isHidden ? 'Project bar hidden.' : 'Project bar shown.' }
      }
      case 'mode': {
        const want = rest[0]?.toLowerCase()
        if (want !== 'enforce' && want !== 'guide' && want !== 'off') {
          return { text: `Delegation mode is ${await modeOf($)}. Use /conductor mode enforce|guide|off.` }
        }
        await update($, modeA, () => want)
        await refreshStatus($)
        return { text: `Delegation mode: ${want}. It takes effect on the next request.` }
      }
      case 'checkpoint':
        return { text: await checkpoint($, 'manual') }
      case 'compact':
        later(
          $,
          async () => {
            if (!(await isCheckpointFresh($))) await checkpoint($, 'manual compaction')
            notify($, await compactNow($), false)
          },
          200,
        )
        return { text: 'Checkpointing, then compacting the main conversation.' }
      case 'curate':
      case 'upkeep':
        later($, async () => notify($, await maybeUpkeep($, true), false))
        return { text: 'Checking the knowledge base for upkeep.' }
      case 'init': {
        const made = await ensureKnowledge($, 'init')
        await refreshPlan($, true)
        const isBooting = rest[0] !== 'nobootstrap'
        if (isBooting) whenFramed(() => bootstrap($))
        return {
          text: `${made === 'exists' ? 'The knowledge base already exists.' : `Created ${P.KDIR}/.`}${isBooting ? ' A Haiku agent will survey the project to fill it in.' : ''}`,
        }
      }
      case 'route': {
        const task = rest.join(' ')
        if (!task) return { text: 'Usage: /conductor route <task description>' }
        const r = routeTask(task, 'general-purpose', cfg.topModel)
        const learnedT = learnedTier(r.tier, kindOf(task, 'general-purpose'), await read($, routingA), cfg.topModel)
        return {
          text: `${learnedT} (${r.reason}${learnedT !== r.tier ? `; learned up from ${r.tier}` : ''}${r.isConfident ? '' : '; unsure, Haiku would break the tie'})`,
        }
      }
      default: {
        const ctx = await read($, contextA)
        const plan = await read($, planA)
        const stats = await read($, statsA)
        const agents = await read($, agentsA)
        const run = await read($, runA)
        const spend = await read($, spendA)
        const today = await read($, todayA)
        const budget = await budgetOf($)
        const questions = await read($, questionsA)
        const { compactAt, checkpointAt } = thresholds(ctx)
        const rows = Object.values(spend)
        const spent = rows.reduce((s, x) => s + x.usd, 0)
        const onTop = rows.reduce((s, x) => s + x.topUsd, 0)
        const cur = await autonomyOf($)
        const lines = [
          `Mode: ${await modeOf($)} · routing ${cfg.routing} · top ${cfg.topModel} · agents ${P.AUTONOMY_LABEL[cur]}${(await read($, downshiftA)) ? ' · rate-limit cap on' : ''}`,
          `Context: ${ctx.percent ?? '?'}% (${kTokens(ctx.tokens ?? 0)} of ${kTokens(ctx.window)}) · checkpoint at ${kTokens(checkpointAt)}, compact at ${kTokens(compactAt)}`,
          `Plan: ${plan ? `${plan.done}/${plan.total} done · ${plan.doing} in progress · ${plan.blocked} blocked · ${plan.phase || 'no phase'}` : 'none yet'}${run ? ` · run ${run.isPending ? 'awaiting approval' : run.isPaused ? 'paused' : 'active'} (${run.dispatched} dispatched)` : ''}`,
          `Agents: ${agents.filter(a => a.status === 'running').length} running · spawned haiku ${stats.haiku}, sonnet ${stats.sonnet}, opus ${stats.opus}, fable ${stats.fable}, other ${stats.other}${questions.length ? ` · ${questions.length} questions wait for you` : ''}`,
          `Usage (est.): subagents ${usd(spent)}, on ${cfg.topModel} alone ${usd(onTop)}${onTop > 0 ? ` (saved ${Math.round((1 - spent / onTop) * 100)}%)` : ''} · today ${usd(today.usd)}${budget ? ` of ${usd(budget)}` : ''}${ctx.costUsd !== null ? ` · session ${usd(ctx.costUsd)}` : ''}`,
          `Knowledge: ${stats.notes} notes filed · ${stats.checkpoints} checkpoints · ${stats.compactions} compactions · ${(await read($, dirtyA)).length} files to map`,
        ]
        return { text: lines.join('\n') }
      }
    }
  }))

  // ------------------------------------------------------------ the agents pane

  // Presses, typing and picks in the mod's pane and band: frames, so what they start runs inside one.
  on('ui.press', async ($, e, next) => (e.plugin === $.plugin.name ? framedHandler($, () => next(e)) : next(e)))
  on('ui.input', async ($, e, next) => (e.plugin === $.plugin.name && e.kind === 'submit' ? framedHandler($, () => next(e)) : next(e)))
  on('ui.select', async ($, e, next) => (e.plugin === $.plugin.name ? framedHandler($, () => next(e)) : next(e)))

  on('ui.render', { component: 'Pane', requestId: QPANE }, async ($, e) => safeDraw($, () => $.ui.resolve(e), { surface: e.surface, props: e.props, pane: 'questions' }, async () => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const questions = await read($, questionsA)
    const later = await read($, laterQuestionsA)
    const open = await read($, expandedA)
    const isLaterOpen = open.later ?? true
    const Input = hasInput(t) ? t.Input : null

    const cols = Math.max(24, Number(e.props.bodyColumns) || 60)
    const isNarrow = cols < 36

    // One card per question: header (task, agent), the question, why, suggested answers, own answer, actions.
    const card = (
      kind: 'urgent' | 'later',
      q: ConductorQuestion | ConductorLaterQuestion,
      index: number,
    ) => {
      const isUrgent = kind === 'urgent'
      const qid = q.id
      const lead = q.itemId ?? clipText(q.from, 40)
      const title = q.itemId ? clipText(q.from.replace(/^[A-Z]+\d+(\.\d+)*:\s*/, '').replace(/\s*\(try \d+\)$/, ''), 60) : ''
      const agent = str(q.agent)
      const later = q as ConductorLaterQuestion
      const chosen = isUrgent ? null : (later.chosen ?? null)
      const assumed = isUrgent ? '' : str(later.assumed)
      const prefix = isUrgent ? 'qo' : 'lo'
      const inputKey = isUrgent ? `qa-${qid}` : `la-${qid}`
      const onPick = (label: string, i: number) =>
        isUrgent ? act(answerQuestion($, qid, label, 'user')) : act(i === chosen ? answerLater($, qid, '', 'keep') : answerLater($, qid, label, 'answer'))
      const onText = (v: string) => {
        const s = v.trim()
        if (s) act(isUrgent ? answerQuestion($, qid, s, 'user') : answerLater($, qid, s, 'answer'))
      }
      const choices: ConductorChoice[] = (q.choices ?? []).length > 0 ? (q.choices ?? []) : isUrgent ? ((q as ConductorQuestion).options ?? []).map(label => ({ label, detail: '', isRecommended: false })) : []
      const border = isNarrow ? {} : isUrgent ? { borderStyle: 'round' as const, borderColor: 'warning', paddingX: 1 } : { borderStyle: 'round' as const, borderDimColor: true, paddingX: 1 }
      return (
        <Box key={`${isUrgent ? 'q' : 'lq'}-${qid}`} flexDirection="column" marginTop={1} paddingLeft={isNarrow ? 1 : undefined} {...border}>
          {isNarrow && index > 0 && <Text dimColor>{'─'.repeat(Math.min(cols - 2, 40))}</Text>}
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text wrap="truncate-end">
              <Text bold color="claude">
                {lead}
              </Text>
              {title !== '' && <Text dimColor>{` · ${title}`}</Text>}
            </Text>
            {agent !== '' && (
              <Text dimColor wrap="truncate-end">
                {agent}
              </Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text bold wrap="wrap">
              {clipText(q.question, 1500)}
            </Text>
          </Box>
          {str(q.why) !== '' && (
            <Text dimColor wrap="wrap">
              Why it matters: {clipText(str(q.why), 1000)}
            </Text>
          )}
          {choices.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Suggested answers</Text>
              {choices.map((c, i) => (
                <Box key={`${prefix}w-${qid}-${i}`} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                  <Box flexDirection="row" gap={1}>
                    <Button key={`${prefix}-${qid}-${i}`} label={c.label} variant={c.isRecommended ? 'primary' : undefined} onPress={() => onPick(c.label, i)} />
                    {c.isRecommended && <Text color="success">★</Text>}
                    {c.isRecommended && <Text color="success">recommended</Text>}
                    {chosen === i && <Text color="claude">●</Text>}
                    {chosen === i && <Text color="claude">the agent went with this</Text>}
                  </Box>
                  {str(c.detail) !== '' && (
                    <Box paddingLeft={2}>
                      <Text dimColor wrap="wrap">
                        {clipText(c.detail, 1000)}
                      </Text>
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          )}
          {!isUrgent && choices.length === 0 && assumed !== '' && (
            <Text dimColor wrap="wrap">
              went on assuming: {assumed}
            </Text>
          )}
          {Input && e.surface !== 'mobile' ? (
            <Box flexDirection="column" marginTop={1} width="100%">
              <Text dimColor>Or write your own answer (Enter sends it)</Text>
              <Input key={inputKey} placeholder="Type here" submitLabel="send" value={drafts.get(inputKey) ?? ''} onInput={v => void drafts.set(inputKey, v)} onSubmit={onText} />
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text dimColor wrap="wrap">
                To write your own answer, open this chat in the desktop app or the terminal.
              </Text>
            </Box>
          )}
          <Box flexDirection="row" gap={2} marginTop={1}>
            {isUrgent && <Button key={`qd-${qid}`} plain label="let AI decide" onPress={() => act(answerQuestion($, qid, '', 'delegate'))} />}
            {isUrgent && <Button key={`qx-${qid}`} plain dimColor label="dismiss" onPress={() => act(answerQuestion($, qid, '', 'dismiss'))} />}
            {!isUrgent && assumed !== '' && <Button key={`lk-${qid}`} plain label="keep what the agent chose" onPress={() => act(answerLater($, qid, '', 'keep'))} />}
            {!isUrgent && <Button key={`ld-${qid}`} plain dimColor label="dismiss" onPress={() => act(answerLater($, qid, '', 'dismiss'))} />}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {questions.length === 0 && later.length === 0 && (
          <Box flexDirection="column" alignItems="center" paddingY={1}>
            <Text color="success">✓ All clear</Text>
            <Text>No questions right now.</Text>
            <Text dimColor wrap="wrap">
              When an agent needs your view, its question shows up here.
            </Text>
          </Box>
        )}

        {questions.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Text bold color="warning">
                ● Needs you ({questions.length})
              </Text>
              <Text dimColor>work on these tasks waits for your answer</Text>
            </Box>
            {questions.map((q, i) => card('urgent', q, i))}
          </Box>
        )}

        {later.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Box flexDirection="row" gap={1}>
                <Button
                  key="tg-later"
                  plain
                  label={`${isLaterOpen ? '▾' : '▸'} For later (${later.length})`}
                  onPress={() => void update($, expandedA, m => ({ ...m, later: !(m.later ?? true) }))}
                />
                <Text dimColor>no rush: work goes on</Text>
              </Box>
              {later.length >= 2 && <Button key="ld-all" plain dimColor label="dismiss all" onPress={() => act(dismissAllLater($))} />}
            </Box>
            {isLaterOpen && later.map((q, i) => card('later', q, i))}
          </Box>
        )}
      </Box>
    )
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => safeDraw($, () => $.ui.resolve(e), { surface: e.surface, props: e.props }, async () => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = t
    const agents = await read($, agentsA)
    const ctx = await read($, contextA)
    const plan = await read($, planA)
    const stats = await read($, statsA)
    const mainTasks = await read($, mainTasksA)
    const open = await read($, expandedA)
    const all = (await read($, expandAllA)) ?? false
    const questions = await read($, questionsA)
    const run = await read($, runA)
    const approval = await read($, approvalA)
    const autonomy = await autonomyOf($)
    const spend = await read($, spendA)
    const today = await read($, todayA)
    const budget = await budgetOf($)
    const attempts = await read($, attemptsA)
    const verifying = await read($, verifyingA)
    const held = await read($, heldA)
    const launchIssues = await read($, launchIssuesA)
    const laterQuestions = await read($, laterQuestionsA)
    const isDown = await read($, downshiftA)
    const mode = await modeOf($)
    const now = await $.clock.now()
    const p = await paths($)
    const cols = Math.max(24, Number(e.props.bodyColumns) || 60)
    const barCells = Math.max(10, Math.min(56, cols - 10))
    const isOpen = (key: string, d: boolean) => open[key] ?? d
    const toggle = (key: string, d: boolean) => () => void update($, expandedA, m => ({ ...m, [key]: !(m[key] ?? d) }))
    const Input = hasInput(t) ? t.Input : null
    const Select = hasInput(t) ? t.Select : null

    // Context, with dots at the checkpoint and compaction thresholds.
    const tokens = tokensOf(ctx)
    const { compactAt, checkpointAt } = thresholds(ctx)
    const window = ctx.window || 200000
    const ctxFrac = tokens / window
    const ctxKind: BarKind = tokens >= compactAt ? 'full' : tokens >= checkpointAt ? 'warn' : 'ok'
    const ctxMarks: Mark[] = [
      { at: checkpointAt / window, state: tokens >= checkpointAt ? 'done' : 'todo' },
      { at: compactAt / window, state: tokens >= compactAt ? 'doing' : 'todo' },
    ]

    // The plan: approval, run state, phases.
    const items = plan?.items ?? []
    const phases = phasesOf(items)
    const currentPhase = phases.find(ph => ph.state !== 'done')?.name ?? null
    const isApproved = plan ? isPlanApproved(plan, approval) : true
    const hasTodo = items.some(i => i.state === 'todo')
    const busy = new Set<string>()
    for (const a of agents) if (a.status === 'running' && a.planItem) busy.add(a.planItem)
    const ready = readyItems(items, busy)
    const mainCounts = plan ? { total: plan.total, done: plan.done, doing: plan.doing, blocked: plan.blocked } : countTasks(mainTasks)
    const mainFrac = fracOf(mainCounts)
    const mainMarks = plan ? planMarks(items, barCells) : marksOf(mainTasks.map(x => ({ weight: 1, state: x.state })))
    const isMainOpen = isOpen('main', true)
    const isEditing = isOpen('edit', false)
    const workers = new Map<string, ConductorAgent>()
    for (const a of agents) if (a.status === 'running' && a.planItem) workers.set(a.planItem.toUpperCase(), a)
    const checking = new Set(Object.values(verifying))
    const noteFor = (item: ConductorPlanItem) => {
      if (!item.id) return ''
      const w = workers.get(item.id)
      if (w) return `← ${w.model}${w.attempt > 1 ? ` · try ${w.attempt}` : ''}`
      if (checking.has(item.id)) return 'verifying'
      if (held[`verify:${item.id}`]) return `check waits for usage: ${held[`verify:${item.id}`]!.short}`
      if (questions.some(q => q.itemId === item.id)) return 'needs you'
      if (isGated(item) && item.state !== 'done') return 'for you / main agent'
      const hold = held[item.id]
      if (hold && item.state !== 'done') return `waiting for usage: ${hold.short}`
      const issue = launchIssues[item.id]
      if (issue && item.state !== 'done') return `couldn't start: ${clipText(issue.reason, 48)}`
      const tries = attempts[item.id]
      return tries && item.state !== 'done' ? `${plural(tries.count, 'failed try')} · last on ${tries.tier}` : ''
    }

    const holds = holdList(held, items)
    const running = agents.filter(a => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
    const finished = agents.filter(a => a.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, KEEP_FINISHED)
    const isAllOpen = agents.length > 0 && agents.every(a => isOpen(`a:${a.id}`, all))
    const spentRows = Object.values(spend)
    const spent = spentRows.reduce((s, x) => s + x.usd, 0)
    const onTop = spentRows.reduce((s, x) => s + x.topUsd, 0)

    const tierNames: ConductorTier[] = cfg.topModel === 'fable' ? ['haiku', 'sonnet', 'opus', 'fable'] : ['haiku', 'sonnet', 'opus']
    const modelOptions = [{ value: 'auto', label: 'auto' }, ...tierNames.map(x => ({ value: x, label: x }))]
    const agentOptions = ['builder', 'scout', 'architect'].map(x => ({ value: x, label: x }))

    const agentBlock = (a: ConductorAgent) => {
      const pr = progressOf(a)
      const key = `a:${a.id}`
      const isRunning = a.status === 'running'
      const isAgentOpen = isOpen(key, all)
      const tasks = a.tasks ?? []
      const more = a.taskSource === 'history' && a.total ? Math.max(0, a.total - tasks.length) : 0
      const took = elapsed((a.endedAt ?? now) - a.startedAt)
      const files = a.files ?? []

      return (
        <Box key={`ag-${a.id}`} flexDirection="column" marginBottom={isRunning ? 1 : 0}>
          <Box flexDirection="row" gap={1}>
            <Text color={STATUS_TONE[a.status]}>{STATUS_DOT[a.status]}</Text>
            <Button key={`tg-${a.id}`} plain label={`${isAgentOpen ? '▾' : '▸'} ${a.description}`} onPress={toggle(key, all)} />
            <Text dimColor wrap="truncate-end">
              {a.model} · {took}
              {a.costUsd ? ` · ${usd(a.costUsd)}` : a.tokens ? ` · ${kTokens(a.tokens)} tok` : ''}
            </Text>
            {isRunning && <Button key={`stop-${a.id}`} plain dimColor label="stop" onPress={() => act(stopAgent($, a.id))} />}
          </Box>
          {isRunning && (
            <Box flexDirection="row" gap={1} paddingLeft={2} alignItems="center">
              {drawBar(t, e.surface, pr.isEstimate ? 'estimate' : 'agent', pr.frac, barCells, pr.marks, `${a.description}: ${pr.label}`)}
              <Text bold={!pr.isEstimate} dimColor={pr.isEstimate}>
                {pr.label}
              </Text>
            </Box>
          )}
          {isRunning && (
            <Box paddingLeft={2}>
              <Text dimColor wrap="truncate-end">
                {a.step ? `${a.step} · ` : ''}
                {a.activity} · {a.toolCalls}/{a.budget || '∞'} tools
              </Text>
            </Box>
          )}
          {isAgentOpen && (
            <Box paddingLeft={4}>
              <Text dimColor wrap="truncate-end">
                {a.type.replace(/^conductor:/, '')} · {a.reason}
                {a.effort ? ` · effort ${a.effort}` : ''}
              </Text>
            </Box>
          )}
          {isAgentOpen && tasks.map((task, i) => taskRow(t, `t-${a.id}-${i}`, task, 4))}
          {isAgentOpen && more > 0 && (
            <Box paddingLeft={4}>
              <Text dimColor>… {plural(more, 'more step')}</Text>
            </Box>
          )}
          {isAgentOpen && tasks.length === 0 && (
            <Box paddingLeft={4}>
              <Text dimColor>No steps reported.</Text>
            </Box>
          )}
          {isAgentOpen && files.length > 0 && (
            <Box paddingLeft={4}>
              <Markdown
                key={`files-${a.id}`}
                text={`${files
                  .slice(0, 20)
                  .map(f => `[${f}](file:///${encodeURI(`${p.root}/${f}`.replace(/^\/+/, ''))})`)
                  .join(' · ')}${files.length > 20 ? ` · and ${files.length - 20} more` : ''}`}
              />
            </Box>
          )}
          {isAgentOpen && !isRunning && a.summary !== '' && (
            <Box paddingLeft={4}>
              <Text dimColor wrap="wrap">
                {clipText(a.summary, 400)}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {(questions.length > 0 || laterQuestions.length > 0) && (
          <Box flexDirection="row" gap={1} marginBottom={1} flexWrap="wrap">
            <Text color={questions.length > 0 ? 'warning' : undefined} dimColor={questions.length === 0}>
              {`Questions: ${[questions.length ? `${questions.length} need you` : '', laterQuestions.length ? `${laterQuestions.length} for later` : ''].filter(Boolean).join(' · ')}`}
            </Text>
            <Button key="open-questions" label="open questions" onPress={() => act(openPane($, true, 'questions'))} />
          </Box>
        )}
        {Object.keys(launchIssues).length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="error">
              Couldn't start ({Object.keys(launchIssues).length})
            </Text>
            {Object.entries(launchIssues).map(([id, issue]) => (
              <Box key={`li-${id}`} flexDirection="column" paddingLeft={1}>
                <Text wrap="wrap">
                  <Text color="claude">{id}</Text> not started after {plural(issue.tries, 'try')} ({issue.model}): {clipText(issue.reason, 300)}
                </Text>
                <Box flexDirection="row" gap={1}>
                  <Button key={`lr-${id}`} label="retry" onPress={() => act(retryLaunch($, id).then(m => $.ui.toast(m)))} />
                  <Button key={`lx-${id}`} plain dimColor label="dismiss" onPress={() => act(update($, launchIssuesA, m => without(m, id)))} />
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {plan && !isApproved && hasTodo && (
          <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginBottom={1}>
            <Text bold>
              Plan ready for review: {plural(plan.total, 'task')} in {plural(phases.length, 'phase')}
              {run?.isPending ? ' · a run is waiting' : ''}
            </Text>
            <Text dimColor wrap="wrap">
              Review {P.KDIR}/plan.md (or set agents and models with "edit tasks" below), then approve.
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key="approve-run" variant="primary" label="approve & run" hotkey="r" onPress={() => act(approvePlan($, true).then(m => $.ui.toast(m)))} />
              <Button key="approve" label="approve" hotkey="a" onPress={() => act(approvePlan($, false).then(m => $.ui.toast(m)))} />
            </Box>
          </Box>
        )}

        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold>Context</Text>
          <Text dimColor wrap="truncate-end">
            {ctx.percent ?? pctOf(ctxFrac)}% · {kTokens(tokens)}/{kTokens(window)}
            {ctx.costUsd !== null ? ` · ${usd(ctx.costUsd)}` : ''}
          </Text>
        </Box>
        <Box marginBottom={1}>{drawBar(t, e.surface, ctxKind, ctxFrac, barCells + 8, ctxMarks, `Context ${pctOf(ctxFrac)}% full`)}</Box>

        {run && (
          <Box flexDirection="row" gap={1} marginBottom={1} flexWrap="wrap">
            <Text bold color={run.isPaused || run.isPending ? 'warning' : 'success'}>
              {run.isPending ? '⧗ run awaits approval' : run.isPaused ? '⏸ run paused' : '▶ run'}
            </Text>
            <Text dimColor>
              {run.dispatched} dispatched · {run.done.length} done{run.blocked.length ? ` · ${run.blocked.length} blocked` : ''}
              {holds.length ? ` · ${holds.length} waiting for usage` : ''}
              {today.isWrappingUp ? ' · budget wrap-up' : ''}
            </Text>
            {run.isActive && (
              <Button key="pause" label={run.isPaused ? 'resume' : 'pause'} hotkey="p" onPress={() => act(setPaused($, !run.isPaused).then(m => $.ui.toast(m)))} />
            )}
            <Button key="stop-run" label="stop run" onPress={() => act(stopRun($).then(m => $.ui.toast(m)))} />
          </Box>
        )}
        {holds.slice(0, 3).map(hd => (
          <Box key={`hold-${hd.key}`} paddingLeft={2}>
            <Text color="warning" wrap="wrap">
              {cleanText(clipText(`⧗ ${hd.label} waits for usage: ${hd.hold.reason}`, 400))}
            </Text>
          </Box>
        ))}
        {holds.length > 3 && (
          <Box paddingLeft={2}>
            <Text dimColor>… and {holds.length - 3} more waiting</Text>
          </Box>
        )}
        {!run && plan && isApproved && ready.length > 0 && (
          <Box flexDirection="row" gap={1} marginBottom={1}>
            <Button key="run" variant="primary" label={`run plan (${ready.length} ready)`} hotkey="r" onPress={() => act(startRun($, null, true).then(m => $.ui.toast(m)))} />
          </Box>
        )}

        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Button
            key="tg-main"
            plain
            label={`${isMainOpen ? '▾' : '▸'} Main · ${plan?.title ? clipText(plan.title, 40) : plan ? 'plan' : 'no plan yet'}`}
            onPress={toggle('main', true)}
          />
          <Text dimColor>{mainCounts.total ? `${mainCounts.done}/${mainCounts.total}` : ''}</Text>
        </Box>
        {mainCounts.total > 0 && (
          <Box flexDirection="row" gap={1} paddingLeft={2} alignItems="center">
            {drawBar(t, e.surface, progressKind(mainFrac), mainFrac, barCells, mainMarks, `Plan ${pctOf(mainFrac)}%`)}
            <Text bold>{pctOf(mainFrac)}%</Text>
          </Box>
        )}
        {plan && (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {[plan.phase, plan.doing ? `${plan.doing} in progress` : '', plan.blocked ? `${plan.blocked} blocked` : ''].filter(Boolean).join(' · ')}
            </Text>
          </Box>
        )}
        {isMainOpen &&
          phases.map((ph, pi) => {
            const key = `p:${ph.name}`
            const isPhaseOpen = isOpen(key, ph.name === currentPhase)
            return (
              <Box key={`ph-${pi}`} flexDirection="column">
                <Box flexDirection="row" gap={1} paddingLeft={2}>
                  <Text {...ink(DOT_TONE[ph.state])}>{DOT[ph.state]}</Text>
                  <Button key={`tg-ph-${pi}`} plain label={`${isPhaseOpen ? '▾' : '▸'} ${ph.name || 'Tasks'}`} onPress={toggle(key, ph.name === currentPhase)} />
                  <Text dimColor>
                    {ph.done}/{ph.total}
                  </Text>
                </Box>
                {isPhaseOpen && ph.items.length > 60 && (
                  <Box paddingLeft={4}>
                    <Text dimColor>
                      showing 60 of {ph.items.length}: the rest are in {P.KDIR}/plan.md
                    </Text>
                  </Box>
                )}
                {isPhaseOpen &&
                  ph.items.slice(0, 60).map((item, ii) => (
                    <Box key={`pib-${pi}-${ii}`} flexDirection="column">
                      {taskRow(t, `pi-${pi}-${ii}`, { text: planItemText(item), state: item.state }, 4, noteFor(item))}
                      {isEditing && item.id && item.state === 'todo' && Select && (
                        <Box flexDirection="row" gap={1} paddingLeft={6}>
                          <Select
                            key={`sa-${item.id}`}
                            label="agent"
                            value={item.agent && WORK_AGENTS.has(item.agent) ? item.agent : 'builder'}
                            options={agentOptions}
                            onSelect={v => act(tagPlan($, item.id!, 'agent', v))}
                          />
                          <Select
                            key={`sm-${item.id}`}
                            label="model"
                            value={item.model ?? 'auto'}
                            options={modelOptions}
                            onSelect={v => act(tagPlan($, item.id!, 'model', v === 'auto' ? null : v))}
                          />
                        </Box>
                      )}
                    </Box>
                  ))}
              </Box>
            )
          })}
        {isMainOpen && mainTasks.length > 0 && (
          <Box flexDirection="column">
            <Box paddingLeft={2} flexDirection="row" gap={1}>
              <Text bold>Main agent's todos</Text>
              <Text dimColor>
                {countTasks(mainTasks).done}/{mainTasks.length}
              </Text>
            </Box>
            {mainTasks.map((task, i) => taskRow(t, `mt-${i}`, task, 4))}
          </Box>
        )}
        {isMainOpen && !plan && mainTasks.length === 0 && (
          <Box paddingLeft={2}>
            <Text dimColor wrap="wrap">
              No plan yet. A multi-step request gets one in {P.KDIR}/plan.md, or start one with /conductor plan &lt;goal&gt;.
            </Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text bold>Running ({running.length})</Text>
        </Box>
        {running.length === 0 && <Text dimColor>No agents running.</Text>}
        {running.map(agentBlock)}

        {finished.length > 0 && (
          <Box flexDirection="column" marginTop={running.length ? 0 : 1}>
            <Text bold>Finished</Text>
            {finished.map(agentBlock)}
          </Box>
        )}

        <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
          <Button
            key="toggle-all"
            label={isAllOpen ? 'collapse all' : 'expand all'}
            hotkey="e"
            onPress={() =>
              void update($, expandedA, m => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('a:')))).then(() =>
                update($, expandAllA, () => !isAllOpen),
              )
            }
          />
          {plan && hasTodo && Select && <Button key="edit" label={isEditing ? 'done editing' : 'edit tasks'} hotkey="t" onPress={toggle('edit', false)} />}
          <Button key="checkpoint" label="checkpoint" hotkey="c" onPress={() => act(checkpoint($, 'manual').then(m => $.ui.toast(m)))} />
          <Button key="compact" label="compact" hotkey="k" onPress={() => act($.command.run({ command: 'conductor', args: 'compact' }))} />
          <Button key="curate" label="upkeep" hotkey="u" onPress={() => act(maybeUpkeep($, true).then(m => $.ui.toast(m)))} />
          <Button key="report" label="report" hotkey="o" onPress={() => act(writeReport($).then(m => $.ui.toast(`Report: ${m}`)))} />
          <Button key="clear" label="clear finished" hotkey="x" onPress={() => act(update($, agentsA, list => list.filter(a => a.status === 'running')))} />
        </Box>

        {Select && (
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Select
              key="autonomy"
              label="agents"
              value={autonomy}
              options={P.AUTONOMY_LEVELS.map(l => ({ value: l, label: P.AUTONOMY_LABEL[l] }))}
              onSelect={v => act(update($, autonomyA, () => v as Autonomy))}
            />
          </Box>
        )}
        <Text dimColor wrap="truncate-end">
          subagents {usd(spent)}
          {onTop > spent ? ` · on ${cfg.topModel} alone ${usd(onTop)} · saved ${Math.round((1 - spent / onTop) * 100)}%` : ''} (est.)
          {budget ? ` · today ${usd(today.usd)}/${usd(budget)}` : today.usd ? ` · today ${usd(today.usd)}` : ''}
          {isDown ? ' · rate-limit cap' : ''}
        </Text>
        <Text dimColor wrap="truncate-end">
          {mode} · haiku {stats.haiku} · sonnet {stats.sonnet} · opus {stats.opus}
          {stats.fable ? ` · fable ${stats.fable}` : ''} · {stats.notes} notes
        </Text>
      </Box>
    )
  }))

  // Remembers a close by the person, so no launch or run re-opens the pane uninvited.
  on('ui.close', async ($, e, next) => {
    if (e.id === QPANE) {
      await update($, questionsPaneA, s => ({ isClosedByPerson: e.origin.kind === 'person' ? true : s.isClosedByPerson, waiting: null }))
      await refreshStatus($)
    }
    if (e.id === PANE) {
      await update($, paneStateA, s => ({ isClosedByPerson: e.origin.kind === 'person' ? true : s.isClosedByPerson, waiting: null }))
      await refreshStatus($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ the project bar above the prompt

  // Drawing that throws falls back to the engine's own band rather than losing the prompt area.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const plan = await read($, planA)
      const agents = await read($, agentsA)
      const isHidden = await read($, bandHiddenA)
      const welcome = await read($, welcomeA)
      const questions = await read($, questionsA)
      const run = await read($, runA)
      const issueCount = Object.keys(await read($, launchIssuesA)).length
      const laterCount = (await read($, laterQuestionsA)).length
      const paneWaiting = (await read($, paneStateA)).waiting !== null
      const running = agents.filter(a => a.status === 'running')
      const held = await read($, heldA)
      const verifyingMap = await read($, verifyingA)
      const now = await $.clock.now()
      if (isHidden || (await modeOf($)) === 'off' || (!plan && running.length === 0 && questions.length === 0 && laterCount === 0)) return next(e)

      const t = $.ui.resolve(e)
      const { Box, Text, Button } = t
      const isBandOpen = Boolean(plan) && ((await read($, expandedA)).band ?? false)
      const cols = Number(e.props.bodyColumns) || 80
      const items = plan?.items ?? []
      const frac = plan ? fracOf({ total: plan.total, done: plan.done, doing: plan.doing, blocked: plan.blocked }) : 0
      const barCells = Math.max(12, Math.min(44, Math.floor(cols / 3)))
      const working = running.length ? `${plural(running.length, 'agent')} working` : ''
      const heldCount = Object.keys(held).length
      const runChip = run ? (run.isPending ? '⧗ awaiting approval' : run.isPaused ? '⏸ paused' : '▶ running') : ''
      const details = plan
        ? [`${plan.done}/${plan.total} tasks`, plan.doing ? `${plan.doing} in progress` : '', plan.blocked ? `${plan.blocked} blocked` : '', heldCount ? `${heldCount} waiting for usage` : '', plan.phase, working]
        : ['no plan yet', working]
      const toggle = () => void update($, expandedA, m => ({ ...m, band: !(m.band ?? false) }))

      const welcomeRow = welcome ? (
        <Box flexDirection="row" gap={1}>
          <Text color="claude">◆</Text>
          <Text wrap="truncate-end">{welcome}</Text>
          {plan && <Button key="welcome-run" label="run" onPress={() => act(startRun($, null, true).then(m => $.ui.toast(m)))} />}
          <Button key="welcome-x" plain dimColor label="dismiss" onPress={() => act(update($, welcomeA, () => null))} />
        </Box>
      ) : null

      const header = (
        <Box flexDirection="row" gap={1} alignItems="center">
          {plan ? (
            <Button key="band-toggle" plain label={`${isBandOpen ? '▾' : '▸'} ${plan.title ? clipText(plan.title, Math.max(16, Math.floor(cols / 2))) : 'Project'}`} onPress={toggle} />
          ) : (
            <Text bold>Project</Text>
          )}
          {runChip !== '' && <Text color={run?.isActive && !run.isPaused ? 'success' : 'warning'}>{runChip}</Text>}
          {questions.length + laterCount > 0 && (
            <Button key="questions-chip" plain label={[questions.length ? `${questions.length} need you` : '', laterCount ? `${laterCount} for later` : ''].filter(Boolean).join(' · ')} onPress={() => act(openPane($, true, 'questions'))} />
          )}
          {issueCount > 0 && <Text color="error">{issueCount} couldn't start</Text>}
          {!plan && (
            <Text dimColor wrap="truncate-end">
              {details.filter(Boolean).join(' · ')}
            </Text>
          )}
          <Button key="agents" label={paneWaiting ? 'show agents' : 'agents'} plain onPress={() => act(openPane($, true))} />
        </Box>
      )

      const itemOf = (id: string | undefined) => (id ? items.find(i => i.id === id) : undefined)
      const labels = [...running].sort((a, b) => a.startedAt - b.startedAt).map(a => {
        if (a.type.replace(/^conductor:/, '') === 'verifier' || /^verify /.test(a.description)) {
          const id = verifyingMap[a.id] ?? a.description.replace(/^verifys+/, '').trim()
          const it = itemOf(id)
          return it ? `checking ${planItemText(it)}` : a.description
        }
        const it = a.planItem ? itemOf(a.planItem.toUpperCase()) : undefined
        return it ? planItemText(it) : a.description
      })
      let nowLine = null
      if (labels.length) {
        const more = labels.length > 1 ? `+${labels.length - 1} more` : ''
        nowLine = (
          <Box flexDirection="row" gap={1}>
            <Text color={STATUS_TONE.running}>◉</Text>
            <Text wrap="truncate-end">{clipText(labels[0]!, Math.max(12, cols - 4 - (more ? more.length + 2 : 0)))}</Text>
            {more !== '' && <Text dimColor>{more}</Text>}
          </Box>
        )
      } else if (Object.keys(held).length) {
        const list = holdList(held, items)
        const first = list[0]!
        nowLine = (
          <Box flexDirection="row" gap={1}>
            <Text color="warning" wrap="truncate-end">
              {clipText(`⧗ ${first.label} waits for usage: ${first.hold.short}${first.hold.retryAt ? `, starts ${whenText(first.hold.retryAt, now)}` : ''}`, Math.max(12, cols - 4))}
            </Text>
            {list.length > 1 && <Text dimColor>+{list.length - 1} more</Text>}
          </Box>
        )
      }
      const barLine = plan ? (
        <Box flexDirection="row" gap={1} alignItems="center">
          {drawBar(t, e.surface, progressKind(frac), frac, barCells, planMarks(items, barCells), `Project ${pctOf(frac)}% done`)}
          <Text bold>{pctOf(frac)}%</Text>
          <Text dimColor wrap="truncate-end">
            {details.filter(Boolean).join(' · ')}
          </Text>
        </Box>
      ) : null

      let body: ReturnType<typeof taskRow>[] = []
      let phaseLine = null
      if (isBandOpen && plan) {
        const phases = phasesOf(items)
        const current = phases.find(ph => ph.state !== 'done') ?? phases[phases.length - 1]
        const workers = new Map<string, ConductorAgent>()
        for (const a of running) if (a.planItem) workers.set(a.planItem.toUpperCase(), a)
        const room = Math.max(3, e.props.maxRows - 3)
        const list = current?.items ?? []
        const row = (item: ConductorPlanItem, i: number) => {
          const worker = item.id ? workers.get(item.id) : undefined
          return taskRow(t, `bi-${i}`, { text: planItemText(item), state: item.state }, 2, worker ? `← ${worker.model}` : '')
        }
        if (list.length <= room) {
          body = list.map(row)
        } else {
          // Too many to show: the finished ones fold into one line, the rest fill the room.
          const done = list.filter(i => i.state === 'done').length
          const left = list.filter(i => i.state !== 'done')
          const head = done ? [taskRow(t, 'bi-done', { text: `${done} done`, state: 'done' }, 2)] : []
          const fit = Math.max(1, room - head.length - 1)
          body = [...head, ...left.slice(0, fit).map(row)]
          if (left.length > fit) body.push(taskRow(t, 'bi-more', { text: `… ${left.length - fit} more in this phase`, state: 'todo' }, 2))
        }
        phaseLine =
          phases.length > 1 ? (
            <Box paddingLeft={2}>
              <Text wrap="truncate-end">
                {phases.map((ph, i) => (
                  <Text {...(ph === current ? { bold: true as const } : { dimColor: true as const })}>
                    <Text {...ink(DOT_TONE[ph.state])}>{DOT[ph.state]}</Text> {ph.name || 'Tasks'} {ph.done}/{ph.total}
                    {i < phases.length - 1 ? '   ' : ''}
                  </Text>
                ))}
              </Text>
            </Box>
          ) : null
      }
      const below = await next(e)

      return (
        <Box flexDirection="column">
          {cleanTree(welcomeRow)}
          {cleanTree(header)}
          {cleanTree(nowLine)}
          {cleanTree(barLine)}
          {cleanTree(phaseLine)}
          {cleanTree(body)}
          {below}
        </Box>
      )
    } catch (err) {
      $.ui.log(`conductor: the project bar could not draw: ${String(err)}`)
      return next(e)
    }
  })
}

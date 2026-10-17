export type ConductorTier = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type ConductorMode = 'enforce' | 'guide' | 'off'

export type ConductorEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ConductorAgentStatus = 'running' | 'done' | 'failed' | 'stopped'

/** Who launched an agent: the main agent, a plan run, a verification, or knowledge upkeep. */
export type ConductorRole = 'main' | 'run' | 'verify' | 'upkeep'

export type ConductorTaskState = 'todo' | 'doing' | 'done' | 'blocked'

/** One step of an agent's work, or one item of the main agent's todo list. */
export type ConductorTask = { id: string | null; text: string; state: ConductorTaskState }

/**
 * Where an agent's task list came from: `steps` its declared step list
 * (progress tool), `history` the steps it reported one at a time, `todo`
 * TodoWrite, `tasks` TaskCreate/TaskUpdate.
 */
export type ConductorTaskSource = 'steps' | 'history' | 'todo' | 'tasks'

/** One plan task, with the tags the architect gave it (`{agent: builder, model: sonnet, after: T2, ...}`). */
export type ConductorPlanItem = {
  id: string | null
  text: string
  state: ConductorTaskState
  phase: string
  agent: string | null
  model: ConductorTier | null
  effort: ConductorEffort | null
  after: string[]
  files: string[]
  verify: string | null
}

export type ConductorAgent = {
  id: string
  description: string
  type: string
  /** Display label of the model it runs on: haiku, sonnet, opus, fable, or the id. */
  model: string
  /** Why the router picked that model. */
  reason: string
  status: ConductorAgentStatus
  startedAt: number
  endedAt: number | null
  toolCalls: number
  /** The last thing it did, e.g. "Edit login.ts". */
  activity: string
  /** Steps reported through the progress tool or TodoWrite; null until reported. */
  done: number | null
  total: number | null
  step: string
  /** The plan task id (T12) or text this agent was given, if any. */
  planItem: string | null
  tokens: number | null
  /** Its steps or todos, each done, in progress or pending; empty until it reports any. */
  tasks: ConductorTask[]
  taskSource: ConductorTaskSource | null
  role: ConductorRole
  tier: ConductorTier | null
  effort: ConductorEffort | null
  /** The routing kind its outcome teaches, e.g. `builder:standard implementation`. */
  kind: string
  attempt: number
  /** Tool calls before it is told to wrap up; twice this and it is stopped. */
  budget: number
  isWarned: boolean
  costUsd: number | null
  /** Its report, cut short, once it has finished. */
  summary: string
  /** Files it edited, relative to the project root. */
  files: string[]
  /** Picked up from the session (resumed, or started where no spawn hook saw it) rather than at its spawn. */
  isAdopted: boolean
}

export type ConductorContext = {
  percent: number | null
  tokens: number | null
  window: number
  costUsd: number | null
}

export type ConductorPlan = {
  title: string
  total: number
  done: number
  doing: number
  blocked: number
  /** The phase of the first task not yet done. */
  phase: string
  /** Tasks in progress, by id and text. */
  current: string[]
  /** Every task, in plan order (at most 400). */
  items: ConductorPlanItem[]
  mtimeMs: number
}

export type ConductorStats = {
  haiku: number
  sonnet: number
  opus: number
  fable: number
  other: number
  checkpoints: number
  compactions: number
  notes: number
}

export type ConductorCheckpoint = { at: number; tokens: number }

/** The upkeep agent running now: the inbox length it was given and the changed files it maps. */
export type ConductorCuration = { agentId: string; length: number; files: string[] }

/** A plan run: the conductor dispatching ready tasks until the plan is done or stuck. */
export type ConductorRun = {
  isActive: boolean
  /** Dispatch held by the person (pause) or by the daily budget. */
  isPaused: boolean
  /** Waiting for the person to approve the plan. */
  isPending: boolean
  /** Restricts the run to these task ids; null runs the whole plan. */
  only: string[] | null
  startedAt: number
  dispatched: number
  done: string[]
  blocked: string[]
}

/** The last failed attempt at a plan task: the tier it ran on, how many tries, its report. */
export type ConductorAttempt = { tier: ConductorTier; count: number; report: string }

export type ConductorSpendRow = { tokens: number; usd: number; topUsd: number }

/** Subagent spend per tier, and what the same tokens would have cost on the top model. */
export type ConductorSpend = Record<ConductorTier, ConductorSpendRow>

export type ConductorAutonomy = 'ask-all' | 'ask-important' | 'ask-blocking' | 'decide-all'

/** One suggested answer to a question: a short label, a plain explanation, and whether the agent recommends it. */
export type ConductorChoice = { label: string; detail: string; isRecommended: boolean }

/** A question an agent stopped on, waiting in the pane's Needs-you queue. */
export type ConductorQuestion = {
  id: string
  /** The plan task it blocks, or null for an ad-hoc agent's question. */
  itemId: string | null
  agentId: string
  from: string
  question: string
  options: string[]
  /** Why the agent is asking, in plain words. Empty for old questions. */
  why: string
  /** Suggested answers (up to 5), same labels as `options`. For old questions, built from `options` with no detail. */
  choices: ConductorChoice[]
  /** Who asked, e.g. `builder · sonnet`; empty for old questions. */
  agent: string
  askedAt: number
}

/** Today's spend across sessions, against the daily budget. */
export type ConductorToday = { day: string; usd: number; isWrappingUp: boolean }

/** A question an agent left for the person without stopping: it went on with `assumed`. */
export type ConductorLaterQuestion = { id: string; itemId: string | null; from: string; question: string; assumed: string; why: string; choices: ConductorChoice[]; chosen: number | null; /** Who asked, e.g. `builder · sonnet`; empty for old questions. */ agent: string; askedAt: number }

/** A plan task whose agent could not be launched: why, when, after how many tries. Not an attempt at the task. */
export type ConductorLaunchIssue = { reason: string; at: number; tries: number; model: string }

export type ConductorOutcome = { ok: number; fail: number }

/** Outcomes per routing kind and tier: what the router learns from. */
export type ConductorRouting = Record<string, Partial<Record<ConductorTier, ConductorOutcome>>>

/** Recent agent costs in US dollars, by `<kind>|<tier>` and `<agent>|<tier>`, newest last (at most 8 each). */
export type ConductorCostHistory = Record<string, number[]>

/** Per rate-limit window kind: the spend seen and the window points it moved, to learn points per dollar. */
export type ConductorUsageRatio = Record<string, { usd: number; pts: number }>

/** A plan task (or its check) held because not enough usage is left: the reason in plain words, a short form for one-line displays, when room should return (ms; null if unknown), and the model choice to reuse when it starts. */
export type ConductorHold = {
  reason: string
  short: string
  retryAt: number | null
  estimateUsd: number
  tier: ConductorTier
  choiceReason: string
  kind: string
  attempt: number
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    conductor: {
      agents: ConductorAgent[]
      context: ConductorContext
      plan: ConductorPlan | null
      stats: ConductorStats
      mode: ConductorMode | null
      lastCheckpoint: ConductorCheckpoint | null
      curation: ConductorCuration | null
      bandHidden: boolean
      /** The main agent's own todo list (TodoWrite, TaskCreate/TaskUpdate). */
      mainTasks: ConductorTask[]
      /** Which rows are open: `main`, `band`, `a:<agentId>`, `p:<phase>`; absent keys take their default. */
      expanded: Record<string, boolean>
      /** Last 'all' toggle: true expands every agent row. */
      expandAll: boolean | null
      run: ConductorRun | null
      /** By plan task id. */
      attempts: Record<string, ConductorAttempt>
      /** Verifier agent id → the plan task it checks. */
      verifying: Record<string, string>
      /** Files subagents changed since the code map was last updated. */
      dirty: string[]
      spend: ConductorSpend
      /** True while a rate-limit window is past the downshift threshold. */
      isDownshifted: boolean
      routing: ConductorRouting
      /** By plan task id: launches that failed, shown in the pane until retried or dismissed. */
      launchIssues: Record<string, ConductorLaunchIssue>
      /** Plan work waiting for usage, by task id (`T15`) or `verify:<id>` for its check. */
      held: Record<string, ConductorHold>
      /** Questions agents left for later: answering them blocks nothing. */
      laterQuestions: ConductorLaterQuestion[]
      /** The agents pane: whether the person closed it (unasked opens then skip it), and why the engine left it waiting. */
      pane: { isClosedByPerson: boolean; waiting: string | null }
      /** The Questions pane, same shape. */
      questionsPane: { isClosedByPerson: boolean; waiting: string | null }
      questions: ConductorQuestion[]
      /** The signature of the plan the person approved. */
      approval: string | null
      autonomy: ConductorAutonomy | null
      /** The welcome-back card, until dismissed. */
      welcome: string | null
      today: ConductorToday
      /** The daily budget in US dollars set from the pane or /conductor budget; null uses the setting. */
      budgetUsd: number | null
    }
  }
}

import type { ConductorTask, ConductorTaskSource, ConductorTaskState } from '../types'

/** Pure task-list logic: agents' steps, todo lists and the counts the bars draw. */

const MAX_TASKS = 30

export const clipText = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export type TaskCounts = { total: number; done: number; doing: number; blocked: number }

export function countTasks(list: readonly { state: ConductorTaskState }[]): TaskCounts {
  const c = { total: list.length, done: 0, doing: 0, blocked: 0 }
  for (const t of list) {
    if (t.state === 'done') c.done += 1
    else if (t.state === 'doing') c.doing += 1
    else if (t.state === 'blocked') c.blocked += 1
  }

  return c
}

/** How full a bar is: a finished task counts whole, one in progress half. */
export const fracOf = (c: TaskCounts) => (c.total ? Math.min(1, (c.done + c.doing * 0.5) / c.total) : 0)

export type ProgressReport = { done: number | null; total: number | null; step: string; steps: string[] | null }

export type TaskList = { tasks: ConductorTask[]; source: ConductorTaskSource }

/**
 * Folds a progress report into an agent's list. A `steps` list replaces the
 * list and `done` ticks its first n; without one, each new `step` is added to
 * a running history, the one before it ticked.
 */
export function fromProgress(prev: readonly ConductorTask[], source: ConductorTaskSource | null, p: ProgressReport): TaskList {
  const base =
    p.steps && p.steps.length
      ? p.steps.map(x => clipText(x)).filter(Boolean).slice(0, MAX_TASKS)
      : source === 'steps'
        ? prev.map(t => t.text)
        : null

  if (base && base.length) {
    const d = Math.max(0, Math.min(base.length, p.done ?? countTasks(prev).done))
    const tasks = base.map((text, i): ConductorTask => ({
      id: null,
      text,
      state: i < d ? 'done' : i === d ? 'doing' : 'todo',
    }))

    return { tasks, source: 'steps' }
  }

  const history = source === 'history' ? [...prev] : []
  const step = clipText(p.step)
  if (step && history[history.length - 1]?.text !== step) {
    for (let i = 0; i < history.length; i++) history[i] = { ...history[i]!, state: 'done' }
    history.push({ id: null, text: step, state: 'doing' })
  }

  return { tasks: history.slice(-MAX_TASKS), source: 'history' }
}

const stateOfStatus = (s: unknown): ConductorTaskState =>
  s === 'completed' ? 'done' : s === 'in_progress' ? 'doing' : 'todo'

/** A TodoWrite list. */
export function fromTodos(todos: readonly Record<string, unknown>[]): ConductorTask[] {
  return todos.slice(0, MAX_TASKS).map(t => ({
    id: null,
    text: clipText(typeof t.content === 'string' ? t.content : String(t.activeForm ?? '')),
    state: stateOfStatus(t.status),
  }))
}

/** TaskCreate: a new pending task under the id the tool answered. */
export function taskCreated(prev: readonly ConductorTask[], id: string, subject: string): ConductorTask[] {
  return [...prev.filter(t => t.id !== id), { id, text: clipText(subject), state: 'todo' as const }].slice(-MAX_TASKS)
}

/** TaskUpdate: a new status or subject for the task its id names; `deleted` drops it. */
export function taskUpdated(prev: readonly ConductorTask[], input: Record<string, unknown>): ConductorTask[] {
  const id = String(input.taskId ?? '')
  if (input.status === 'deleted') return prev.filter(t => t.id !== id)

  return prev.map(t =>
    t.id !== id
      ? t
      : {
          ...t,
          text: typeof input.subject === 'string' && input.subject ? clipText(input.subject) : t.text,
          state: input.status === undefined ? t.state : stateOfStatus(input.status),
        },
  )
}

/** The list once its agent reported: done ticks what was left, blocked marks the step it stopped on. */
export function settleTasks(tasks: readonly ConductorTask[], outcome: 'done' | 'blocked' | 'stopped'): ConductorTask[] {
  if (outcome === 'done') return tasks.map(t => ({ ...t, state: 'done' }))
  if (outcome === 'blocked') return tasks.map(t => (t.state === 'doing' ? { ...t, state: 'blocked' } : t))

  return [...tasks]
}

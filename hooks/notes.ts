/** Pure text helpers for the reports subagents return. */

import type { ConductorChoice } from '../types'

const tagged = (tag: string) => new RegExp(`^([ \\t]*)<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gim')

const isEmptyBlock = (body: string) => /^\s*(none|n\/a|-)?\.?\s*$/i.test(body)

/** The bodies of a report's `<tag>` blocks joined, or null when there are none. */
export function extractTagged(answer: string, tag: string): string | null {
  const parts: string[] = []
  for (const m of answer.matchAll(tagged(tag))) {
    const body = m[2]!.trim()
    if (!isEmptyBlock(body)) parts.push(body)
  }

  return parts.length ? parts.join('\n') : null
}

/** The report with its `<tag>` blocks replaced by a pointer to where they were filed. */
export function stripTagged(text: string, tag: string, where: string): string {
  if (!new RegExp(`^[ \\t]*<${tag}>`, 'im').test(text)) return text

  return text.replace(tagged(tag), (_, lead: string, body: string) => (isEmptyBlock(body) || !where ? '' : `${lead}[${tag} saved to ${where}]`))
}

/** The durable notes in a report's <knowledge> blocks, or null when none. */
export const extractKnowledge = (answer: string) => extractTagged(answer, 'knowledge')

/** The report with its <knowledge> blocks replaced by a pointer. */
export function stripKnowledge(text: string, where: string): string {
  const out = stripTagged(text, 'knowledge', where)

  return where ? out.replace(/\[knowledge saved to /g, '[notes saved to ') : out
}

/** The choices an agent made itself, from its <decisions> block: one line each. */
export function extractDecisions(answer: string): string[] {
  const body = extractTagged(answer, 'decisions')
  if (!body) return []

  return body
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 20)
}

/** One suggested answer: a short label, a plain explanation, and whether the agent recommends it. */
export type Choice = ConductorChoice

export type LaterQuestion = { question: string; assumed: string; why: string; choices: Choice[]; chosen: number | null }

export type Needs = { question: string; why: string; options: string[]; choices: Choice[] }

const MAX = { question: 400, why: 400, label: 100, detail: 300, choices: 5, later: 10 }

const OPTION_LINE = /^\s*(?:[-*]\s*)?(\d+)[.)]\s+(.+)$/
const RECOMMENDED = /[([]\s*recommended\s*[)\]]/gi
const ARROW = /→|->|=>/
const OLD_LATER = /\s*(?:→|->|=>)\s*/

/** The value of a `KEY: value` line, tolerating a leading `- ` or `* ` and `**` bold marks; undefined when the line is not that key. */
function field(line: string, key: string): string | undefined {
  const m = line.match(new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*)?\\s*${key}\\s*(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.*)$`, 'i'))

  return m ? m[1]!.replace(/\*\*\s*$/, '').trim() : undefined
}

const clip = (s: string, n: number) => s.trim().slice(0, n)

/** One option line's text: `label — what it means (recommended)`. */
function parseChoice(text: string): Choice {
  const isRecommended = new RegExp(RECOMMENDED.source, 'i').test(text)
  const clean = text.replace(RECOMMENDED, '').replace(/\s{2,}/g, ' ').trim()
  const m = clean.match(/^(.*?)\s(?:—|–|--|-)\s(.*)$/) ?? clean.match(/^(.*?):\s(.*)$/)

  return { label: clip(m ? m[1]! : clean, MAX.label), detail: clip(m ? m[2]! : '', MAX.detail), isRecommended }
}

/** Only the first option marked recommended stays recommended. */
function oneRecommended(choices: Choice[]): Choice[] {
  let seen = false

  return choices.map(c => {
    const keep = c.isRecommended && !seen
    if (c.isRecommended) seen = true
    return keep === c.isRecommended ? c : { ...c, isRecommended: keep }
  })
}

type Group = { question: string; why: string; choices: Choice[]; wentWith: string | null }

/**
 * One question group, from the line after its question on: `WHY:`, numbered options and `WENT WITH:`.
 * A line it does not recognise continues the field before it.
 */
function parseGroup(question: string, lines: string[]): Group {
  const g: Group = { question, why: '', choices: [], wentWith: null }
  let last: 'question' | 'why' | 'option' | 'wentWith' = 'question'
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const why = field(line, 'why')
    const went = why === undefined ? field(line, 'went\\s+with') : undefined
    const opt = why === undefined && went === undefined ? line.match(OPTION_LINE) : null
    if (why !== undefined) {
      g.why = why
      last = 'why'
    } else if (went !== undefined) {
      g.wentWith = went
      last = 'wentWith'
    } else if (opt) {
      const c = parseChoice(opt[2]!)
      if (c.label && g.choices.length < MAX.choices) g.choices.push(c)
      last = 'option'
    } else if (last === 'question') g.question = `${g.question} ${line}`
    else if (last === 'why') g.why = `${g.why} ${line}`
    else if (last === 'option' && g.choices.length) {
      const c = g.choices.at(-1)!
      c.detail = c.detail ? `${c.detail} ${line}` : line
    } else if (last === 'wentWith') g.wentWith = `${g.wentWith ?? ''} ${line}`.trim()
  }

  return {
    question: clip(g.question, MAX.question),
    why: clip(g.why, MAX.why),
    choices: oneRecommended(g.choices.map(c => ({ ...c, detail: clip(c.detail, MAX.detail) }))),
    wentWith: g.wentWith,
  }
}

/** Which option `WENT WITH` names: a 1-based number or a label (any case); null when neither. */
function chosenOf(choices: Choice[], wentWith: string): number | null {
  const n = wentWith.match(/^\s*(\d+)\s*\.?\s*$/)
  if (n) {
    const i = Number(n[1]) - 1
    return i >= 0 && i < choices.length ? i : null
  }
  const text = wentWith.trim().toLowerCase()
  const i = choices.findIndex(c => c.label.toLowerCase() === text)

  return i >= 0 ? i : null
}

function laterOf(g: Group): LaterQuestion {
  const raw = g.wentWith ?? ''
  const chosen = raw ? chosenOf(g.choices, raw) : null

  return { question: g.question, assumed: chosen !== null ? g.choices[chosen]!.label : clip(raw, MAX.question), why: g.why, choices: g.choices, chosen }
}

/** An old one-line later question, `- question → what it assumed`. */
function oldLater(line: string): LaterQuestion {
  const [question = '', ...rest] = line.replace(/^\s*[-*]\s*/, '').trim().split(OLD_LATER)

  return { question: clip(question, MAX.question), assumed: clip(rest.join(' → '), MAX.question), why: '', choices: [], chosen: null }
}

/** The body of the last `<tag>` that begins a line, up to its closing tag (same line allowed) or the end; null when empty or "none". */
function lastBlock(answer: string, tag: string): string | null {
  const opens = [...answer.matchAll(new RegExp(`^[ \\t]*<${tag}>`, 'gim'))]
  const last = opens.at(-1)
  if (!last) return null
  const rest = answer.slice(last.index! + last[0].length)
  const end = rest.search(new RegExp(`<\/${tag}>`, 'i'))
  const body = (end >= 0 ? rest.slice(0, end) : rest).trim()

  return isEmptyBlock(body) ? null : body
}

/**
 * Questions an agent left for the person without stopping, from its <questions> block.
 * Each group starts at `Q:` and may carry `WHY:`, numbered options (one `(recommended)`) and `WENT WITH:`;
 * it ends at a blank line, the next `Q:` or the end of the block. A line outside any group is the old
 * one-line form `- question → what it assumed`.
 */
export function extractQuestions(answer: string): LaterQuestion[] {
  const body = lastBlock(answer, 'questions')
  if (!body) return []
  const out: LaterQuestion[] = []
  let group: { question: string; lines: string[] } | null = null
  const close = () => {
    if (group) out.push(laterOf(parseGroup(group.question, group.lines)))
    group = null
  }

  for (const line of body.split(/\r?\n/)) {
    const q = field(line, 'q')
    if (q !== undefined) {
      close()
      group = { question: q, lines: [] }
    } else if (!line.trim()) close()
    else if (group && /^\s*[-*]\s/.test(line) && OLD_LATER.test(line) && !OPTION_LINE.test(line) && field(line, 'why') === undefined && field(line, 'went\\s+with') === undefined) {
      // An old-style item written straight after a group, without a blank line.
      close()
      out.push(oldLater(line))
    } else if (group) (group as { lines: string[] }).lines.push(line)
    else if (ARROW.test(line) && !/^\s*<\/?[a-z][\w-]*>\s*$/i.test(line)) out.push(oldLater(line))
  }
  close()

  return out.filter(q => q.question).slice(0, MAX.later)
}

export type ReportStatus = 'done' | 'partial' | 'blocked'

export function extractStatus(answer: string): ReportStatus | null {
  const m = answer.match(/^\W*status\W*:?\s*\**\s*(done|partial|blocked)\b/im)

  return m ? (m[1]!.toLowerCase() as ReportStatus) : null
}

/**
 * A question the agent stopped on: a `NEEDS:` line, then an optional `WHY:` line and numbered options
 * (one marked `(recommended)`), up to the first blank line, `<tag>` line or `STATUS` line.
 * The old `OPTIONS: a | b | c` line still reads when there are no numbered options.
 */
export function extractNeeds(answer: string): Needs | null {
  // An urgent question belongs to a stopped agent: a report that says done never has one.
  if (extractStatus(answer) === 'done') return null
  // The keyword begins its line, optionally in bold; never after a list marker.
  const q = answer.match(/^[ \t]*(?:\*\*|__)?needs(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*(.+)$/im)
  if (!q) return null
  const after: string[] = []
  for (const line of answer.slice(q.index! + q[0].length).split(/\r?\n/).slice(1)) {
    if (!line.trim() || /^\s*<\/?[a-z][\w-]*>/i.test(line) || /^\W*status\W*:/i.test(line)) break
    after.push(line)
  }
  const old = answer.match(/^\W*options\W*:?\s*\**\s*(.+)$/im)
  const g = parseGroup(q[1]!.replace(/\*\*\s*$/, ''), after.filter(l => field(l, 'options') === undefined))
  const choices = g.choices.length
    ? g.choices
    : old
      ? old[1]!
          .split('|')
          .map(x => clip(x, MAX.label))
          .filter(Boolean)
          .slice(0, MAX.choices)
          .map(label => ({ label, detail: '', isRecommended: false }))
      : []

  return { question: g.question, why: g.why, options: choices.map(c => c.label), choices }
}

/** One-line summary of what a tool call is doing, for the agents pane. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
  const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${tool} ${base(str('file_path') || str('notebook_path'))}`
    case 'Bash':
    case 'PowerShell':
      return `$ ${clip(str('command').split('\n')[0] ?? '')}`
    case 'Grep':
      return `Grep ${clip(str('pattern'), 36)}`
    case 'Glob':
      return `Glob ${clip(str('pattern'), 36)}`
    case 'WebFetch':
      return `Fetch ${clip(str('url').replace(/^https?:\/\//, ''), 40)}`
    case 'WebSearch':
      return `Search ${clip(str('query'), 40)}`
    default:
      return clip(tool.replace(/^mcp__/, '').replace(/__/g, ' '), 40)
  }
}

/** A filesystem-safe slug of a task description. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'task'

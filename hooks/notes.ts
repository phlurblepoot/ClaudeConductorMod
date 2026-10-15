/** Pure text helpers for the reports subagents return. */

const tagged = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi')

const isEmptyBlock = (body: string) => /^\s*(none|n\/a|-)?\.?\s*$/i.test(body)

/** The bodies of a report's `<tag>` blocks joined, or null when there are none. */
export function extractTagged(answer: string, tag: string): string | null {
  const parts: string[] = []
  for (const m of answer.matchAll(tagged(tag))) {
    const body = m[1]!.trim()
    if (!isEmptyBlock(body)) parts.push(body)
  }

  return parts.length ? parts.join('\n') : null
}

/** The report with its `<tag>` blocks replaced by a pointer to where they were filed. */
export function stripTagged(text: string, tag: string, where: string): string {
  if (!new RegExp(`<${tag}>`, 'i').test(text)) return text

  return text.replace(tagged(tag), (_, body: string) => (isEmptyBlock(body) || !where ? '' : `[${tag} saved to ${where}]`))
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

export type LaterQuestion = { question: string; assumed: string }

/** Questions an agent left for the person without stopping, from its <questions> block: `question → what it assumed`. */
export function extractQuestions(answer: string): LaterQuestion[] {
  const body = extractTagged(answer, 'questions')
  if (!body) return []

  return body
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 10)
    .map(l => {
      const [question = '', ...rest] = l.split(/\s*(?:→|->|=>)\s*/)
      return { question: question.trim().slice(0, 400), assumed: rest.join(' → ').trim().slice(0, 400) }
    })
}

export type ReportStatus = 'done' | 'partial' | 'blocked'

export function extractStatus(answer: string): ReportStatus | null {
  const m = answer.match(/^\W*status\W*:?\s*\**\s*(done|partial|blocked)\b/im)

  return m ? (m[1]!.toLowerCase() as ReportStatus) : null
}

export type Needs = { question: string; options: string[] }

/** A question the agent stopped on: a `NEEDS:` line, with optional `OPTIONS: a | b | c`. */
export function extractNeeds(answer: string): Needs | null {
  const q = answer.match(/^\W*needs\W*:?\s*\**\s*(.+)$/im)
  if (!q) return null
  const o = answer.match(/^\W*options\W*:?\s*\**\s*(.+)$/im)
  const options = o
    ? o[1]!
        .split('|')
        .map(x => x.trim())
        .filter(Boolean)
        .slice(0, 5)
    : []

  return { question: q[1]!.trim().slice(0, 500), options }
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

import type { ConductorPlanItem } from '../types'
import { stripKnowledge } from './notes'

/**
 * Task briefs: `.knowledge/tasks/<id>.md`, one per plan task. A brief holds
 * what one agent needs for its task (goal, files, done-criteria, decisions)
 * and the results of the tasks it comes after, so agents hand work to each
 * other through files instead of through the main conversation.
 */

export const briefPath = (dir: string, id: string) => `${dir}/tasks/${id}.md`

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const sectionRe = (heading: string) => new RegExp(`(^|\\n)## ${escapeRe(heading)}[^\\n]*\\n[\\s\\S]*?(?=\\n## |$)`)

/** The body of a `## heading` section, or null when the document has none. */
export function getSection(doc: string, heading: string): string | null {
  const m = doc.match(sectionRe(heading))
  if (!m) return null

  return m[0].replace(/^\n?## [^\n]*\n/, '').trim()
}

/** Replaces a `## heading` section's body, or appends the section. */
export function setSection(doc: string, heading: string, body: string): string {
  const block = `## ${heading}\n${body.trim()}\n`
  const re = sectionRe(heading)
  if (re.test(doc)) return doc.replace(re, (_, lead: string) => `${lead}${block}`)

  return `${doc.trimEnd()}\n\n${block}`
}

export type DepResult = { id: string; text: string; state: string; result: string | null }

export function depsBody(deps: readonly DepResult[]): string {
  if (deps.length === 0) return '(none: this task does not wait on others)'

  return deps
    .map(d => `### ${d.id}: ${d.text} (${d.state})\n${d.result?.trim() || '(no result recorded)'}`)
    .join('\n\n')
}

/** A new brief for a plan task. */
export function renderBrief(
  item: ConductorPlanItem & { id: string },
  planTitle: string,
  deps: readonly DepResult[],
  decisions: string,
): string {
  const lines = [
    `# ${item.id}: ${item.text}`,
    '',
    `Plan: ${planTitle || 'untitled'} · ${item.phase || 'no phase'}`,
    `Agent: ${item.agent ?? 'builder'}${item.model ? ` · model: ${item.model}` : ''}`,
    '',
    '## Goal',
    item.text,
    '',
  ]
  if (item.files.length) lines.push('## Files', ...item.files.map(f => `- ${f}`), '')
  lines.push(
    '## Done when',
    item.verify ? `\`${item.verify}\` passes, and the goal above is met.` : 'The goal above is met; say in your report how you checked it.',
    '',
  )
  let doc = lines.join('\n')
  doc = setSection(doc, 'Inputs from earlier tasks', depsBody(deps))
  if (decisions.trim()) doc = setSection(doc, 'Decisions that apply', decisions)
  doc = setSection(doc, 'Notes', '(Detail the architect or the main agent adds for this task.)')

  return doc
}

export type ResultEntry = { at: string; model: string; status: string; attempt: number; summary: string }

/** Records an agent's result: the latest under `## Result`, earlier ones moved to `## Earlier attempts`. */
export function recordResult(doc: string, r: ResultEntry): string {
  let out = doc
  const prev = getSection(doc, 'Result')
  if (prev) {
    const earlier = getSection(doc, 'Earlier attempts')
    out = setSection(out, 'Earlier attempts', [earlier, prev].filter(Boolean).join('\n\n---\n\n').slice(-4000))
  }

  return setSection(out, 'Result', `${r.at} · ${r.model} · attempt ${r.attempt} · ${r.status}\n\n${r.summary.trim()}`)
}

/** A report cut to what a later agent needs: no knowledge block, no status line. */
export function summarize(answer: string, max = 1500): string {
  const text = stripKnowledge(answer, '')
    .replace(/\[notes saved to \]/g, '')
    .replace(/^\W*status\W*:?.*$/im, '')
    .trim()

  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** The last dated decisions, for a brief. */
export function decisionsExcerpt(text: string | null, maxLines = 15): string {
  if (!text) return ''
  const lines = text.split(/\r?\n/).filter(l => /^\s*[-*]\s+|^\s*\d{4}-\d{2}-\d{2}/.test(l))

  return lines.slice(-maxLines).join('\n')
}

export type Verdict = { isPass: boolean; detail: string }

/** A verifier's answer: `VERDICT: pass|fail` and what follows. */
export function parseVerdict(answer: string): Verdict | null {
  const m = answer.match(/^\W*verdict\W*:?\s*\**\s*(pass|fail)\b/im)
  if (!m) return null

  return { isPass: m[1]!.toLowerCase() === 'pass', detail: answer.slice((m.index ?? 0) + m[0].length).trim().slice(0, 1500) }
}

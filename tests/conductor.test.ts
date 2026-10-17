import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { marksOf, svgBar, textBar } from '../hooks/bar'
import { cleanTree, progressKind, uniqueKeys } from '../hooks/draw'
import { getSection, parseVerdict, recordResult, renderBrief, setSection } from '../hooks/briefs'
import { extractDecisions, extractKnowledge, extractNeeds, extractQuestions, extractStatus, stripKnowledge } from '../hooks/notes'
import {
  PLAN_TEMPLATE,
  extractPlanItem,
  parsePlan,
  parseTags,
  phasesOf,
  planMarks,
  planSignature,
  readyItems,
  setItemState,
  setItemTag,
} from '../hooks/plan'
import { costOf, learnedTier, nextTier, recordOutcome, routeTask } from '../hooks/route'
import { AUTONOMY_LEVELS, LATER_EXAMPLE, PLAIN, URGENT_EXAMPLE, architectPrompt, policyLine, protocol, runTaskPrompt, verifierPrompt } from '../hooks/prompts'
import { spillNote, textOfResult } from '../hooks/spill'
import { DEFAULT_TASK_USD, checkRoom, estimateCost, learnRatio, nextMidnight, pointsPerUsd, recordCost, whenText, windowName } from '../hooks/usage'
import { fromProgress, fromTodos, settleTasks, taskCreated, taskUpdated } from '../hooks/tasks'

const OPTIONS = { options: { showPane: false, classifier: false, sound: false } }

const NO_TAGS = { agent: null, model: null, effort: null, after: [], files: [], verify: null }

/** An in-memory file system beneath the plugin, so its file work runs in a test. */
function memFs(on: On, files: Record<string, string>) {
  // The engine hands paths over in the platform's form (C:\proj\...): compare them as /proj/...
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  let clock = 1
  const mtimes: Record<string, number> = {}
  on('fs.read', (_, e) => (norm(e.path) in files ? { value: files[norm(e.path)]! } : { deny: `ENOENT ${e.path}` }))
  on('fs.write', (_, e) => {
    files[norm(e.path)] = e.text
    mtimes[norm(e.path)] = ++clock
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: norm(e.path) in files || Object.keys(files).some(k => k.startsWith(`${norm(e.path)}/`)) }))
  on('fs.stat', (_, e) =>
    norm(e.path) in files
      ? { value: { kind: 'file' as const, size: files[norm(e.path)]!.length, mtimeMs: mtimes[norm(e.path)] ?? 1, isLink: false } }
      : { deny: `ENOENT ${e.path}` },
  )
  on('fs.list', () => ({ value: [] }))
}

describe('router', () => {
  test('lookups and summaries go to Haiku', () => {
    expect(routeTask('Find where the auth token is read and list the files that use it', 'general-purpose', 'opus').tier).toBe('haiku')
    expect(routeTask('Summarize what src/payments does', 'claude', 'opus').tier).toBe('haiku')
  })

  test('ordinary implementation goes to Sonnet', () => {
    expect(routeTask('Implement a POST endpoint for creating invoices in src/api/invoices.ts and add unit tests', 'general-purpose', 'opus').tier).toBe('sonnet')
  })

  test('hard reasoning goes to the top model, never above it', () => {
    const hard =
      'Investigate why the websocket reconnect is flaky: find the root cause of the race condition in the concurrent retry loop and design a fix'
    expect(routeTask(hard, 'general-purpose', 'opus').tier).toBe('opus')
    expect(routeTask(hard, 'general-purpose', 'fable').tier).toBe('fable')
    expect(routeTask(hard, 'general-purpose', 'sonnet').tier).toBe('sonnet')
  })

  test('agent types decide where the text cannot', () => {
    expect(routeTask('anything at all', 'Explore', 'opus').tier).toBe('haiku')
    expect(routeTask('anything at all', 'conductor:scout', 'opus').tier).toBe('haiku')
    expect(routeTask('anything at all', 'Plan', 'opus').tier).toBe('opus')
    expect(routeTask('anything at all', 'conductor:curator', 'opus').tier).toBe('haiku')
  })

  test('escalation climbs one tier at a time, up to the top model', () => {
    expect(nextTier('haiku', 'opus')).toBe('sonnet')
    expect(nextTier('sonnet', 'opus')).toBe('opus')
    expect(nextTier('opus', 'opus')).toBe(null)
    expect(nextTier('sonnet', 'sonnet')).toBe(null)
  })

  test('a kind of task that keeps failing on a tier is routed one up', () => {
    let stats = {}
    for (let i = 0; i < 3; i++) stats = recordOutcome(stats, 'builder:mechanical change', 'haiku', false)
    expect(learnedTier('haiku', 'builder:mechanical change', stats, 'opus')).toBe('haiku')
    stats = recordOutcome(stats, 'builder:mechanical change', 'haiku', true)
    stats = recordOutcome(stats, 'builder:mechanical change', 'haiku', false)
    expect(learnedTier('haiku', 'builder:mechanical change', stats, 'opus')).toBe('sonnet')
  })

  test('costs follow the price table', () => {
    const u = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(costOf('haiku', u)).toBe(1.5)
    expect(costOf('opus', u)).toBe(6)
  })
})

describe('plan', () => {
  const PLAN = [
    '# Plan: Ship the invoicing app',
    '',
    '## Phase 1: Foundations',
    '- [x] T1: Scaffold the project',
    '- [x] T2: Database schema',
    '',
    '## Phase 2: Invoices',
    '- [~] T3: Create-invoice endpoint {agent: builder, model: sonnet, after: T2, files: src/api.ts, src/db.ts, verify: npm test api}',
    '- [ ] T4: Invoice PDF export {model: haiku, after: T3}',
    '- [!] T5: Stripe webhooks',
    '  blocked: waiting for API keys',
  ].join('\n')

  test('counts tasks by state, reads their tags, and finds the open phase', () => {
    const plan = parsePlan(PLAN, 7)!
    expect(plan.total).toBe(5)
    expect([plan.done, plan.doing, plan.blocked]).toEqual([2, 1, 1])
    expect(plan.phase).toBe('Phase 2: Invoices')
    expect(plan.current).toEqual(['T3: Create-invoice endpoint'])
    expect(plan.items[2]).toEqual({
      id: 'T3',
      text: 'Create-invoice endpoint',
      state: 'doing',
      phase: 'Phase 2: Invoices',
      agent: 'builder',
      model: 'sonnet',
      effort: null,
      after: ['T2'],
      files: ['src/api.ts', 'src/db.ts'],
      verify: 'npm test api',
    })
    expect(plan.items[4]).toEqual({ id: 'T5', text: 'Stripe webhooks', state: 'blocked', phase: 'Phase 2: Invoices', ...NO_TAGS })
  })

  test("the template's example tasks inside its comment are not a plan", () => {
    expect(parsePlan(PLAN_TEMPLATE)).toBe(null)
    expect(setItemState(PLAN_TEMPLATE, 'T1', 'done').isMatched).toBe(false)
  })

  test('tags with commas inside a value', () => {
    expect(parseTags('agent: scout, after: T1, T2, files: a.ts, b.ts, verify: npm test, then lint')).toEqual({
      ...NO_TAGS,
      agent: 'scout',
      after: ['T1', 'T2'],
      files: ['a.ts', 'b.ts'],
      verify: 'npm test, then lint',
    })
  })

  test('a task is ready once every task it comes after is done', () => {
    const items = parsePlan(PLAN)!.items
    expect(readyItems(items, new Set()).map(i => i.id)).toEqual([])
    const t3done = parsePlan(setItemState(PLAN, 'T3', 'done').text)!.items
    expect(readyItems(t3done, new Set()).map(i => i.id)).toEqual(['T4'])
    expect(readyItems(t3done, new Set(['T4'])).map(i => i.id)).toEqual([])
  })

  test('the pickers rewrite a task tag, and approval ignores checkbox ticks', () => {
    expect(setItemTag(PLAN, 'T4', 'model', 'sonnet').text).toContain('- [ ] T4: Invoice PDF export {model: sonnet, after: T3}')
    expect(setItemTag(PLAN, 'T5', 'agent', 'scout').text).toContain('- [!] T5: Stripe webhooks {agent: scout}')
    const sig = planSignature(parsePlan(PLAN)!.items)
    expect(planSignature(parsePlan(setItemState(PLAN, 'T4', 'done').text)!.items)).toBe(sig)
    expect(planSignature(parsePlan(`${PLAN}\n- [ ] T6: New task`)!.items)).not.toBe(sig)
  })

  test('ticks an item by id or text, and never reopens a done one', () => {
    expect(setItemState(PLAN, 'T4', 'done').text).toContain('- [x] T4: Invoice PDF export')
    expect(setItemState(PLAN, 'T1', 'doing').text).toContain('- [x] T1: Scaffold the project')
    expect(setItemState(PLAN, 'invoice pdf export', 'doing').text).toContain('- [~] T4: Invoice PDF export')
  })

  test('dotted ids; a done task stays done unless forced; tasks for the person or the main agent never run', () => {
    const text = [
      '# Plan: Rig',
      '## Phase 1',
      '- [x] T29.2: Base mesh',
      '- [ ] T29.2.1: Rig the face {after: T29.2}',
      '- [ ] T29.2.2: Approve the look {agent: main, after: T29.2.1}',
      '- [ ] T30: Ship {after: T29.2.2}',
    ].join('\n')
    const items = parsePlan(text)!.items
    expect(items.map(i => i.id)).toEqual(['T29.2', 'T29.2.1', 'T29.2.2', 'T30'])
    expect(items[3]!.after).toEqual(['T29.2.2'])
    expect(readyItems(items, new Set()).map(i => i.id)).toEqual(['T29.2.1'])
    const rigged = setItemState(text, 'T29.2.1', 'done').text
    expect(rigged).toContain('- [x] T29.2.1: Rig the face')
    expect(rigged).toContain('- [x] T29.2: Base mesh')
    expect(readyItems(parsePlan(rigged)!.items, new Set()).map(i => i.id)).toEqual([])
    expect(setItemState(text, 'T29.2', 'todo').text).toContain('- [x] T29.2: Base mesh')
    expect(setItemState(text, 'T29.2', 'blocked').text).toContain('- [x] T29.2: Base mesh')
    expect(setItemState(text, 'T29.2', 'todo', true).text).toContain('- [ ] T29.2: Base mesh')
  })

  test('groups tasks by phase; dots per task while they fit, else per phase', () => {
    const items = parsePlan(PLAN)!.items
    expect(phasesOf(items).map(p => [p.name, p.done, p.total, p.state])).toEqual([
      ['Phase 1: Foundations', 2, 2, 'done'],
      ['Phase 2: Invoices', 0, 3, 'doing'],
    ])
    expect(planMarks(items, 20).map(m => m.state)).toEqual(['done', 'done', 'doing', 'todo', 'blocked'])
    expect(planMarks(items, 8)).toEqual([
      { at: 0.4, state: 'done' },
      { at: 1, state: 'doing' },
    ])
  })

  test('reads the Plan item line of a task prompt', () => {
    expect(extractPlanItem('Build the export.\nPlan item: T4 (PDF export)\nFiles: src/pdf.ts')).toBe('T4')
    expect(extractPlanItem('**Plan item:** T12')).toBe('T12')
    expect(extractPlanItem('Plan item: none')).toBe('NONE')
    expect(extractPlanItem('No plan here')).toBe(null)
  })
})

describe('briefs', () => {
  test('a brief carries the goal, files, done-criteria and the inputs it depends on', () => {
    const item = { id: 'T4', text: 'PDF export', state: 'todo' as const, phase: 'Phase 2', ...NO_TAGS, files: ['src/pdf.ts'], verify: 'npm test pdf' }
    const doc = renderBrief(item, 'Invoicing', [{ id: 'T3', text: 'Endpoint', state: 'done', result: 'Added POST /invoices.' }], '- 2026-10-12: use pdfkit')
    expect(doc).toContain('# T4: PDF export')
    expect(doc).toContain('- src/pdf.ts')
    expect(doc).toContain('`npm test pdf` passes')
    expect(getSection(doc, 'Inputs from earlier tasks')).toContain('Added POST /invoices.')
    expect(getSection(doc, 'Decisions that apply')).toBe('- 2026-10-12: use pdfkit')
  })

  test('results replace each other; earlier attempts are kept', () => {
    let doc = '# T1: x\n\n## Notes\nnone\n'
    doc = recordResult(doc, { at: 'a', model: 'haiku', status: 'blocked', attempt: 1, summary: 'first' })
    doc = recordResult(doc, { at: 'b', model: 'sonnet', status: 'done', attempt: 2, summary: 'second' })
    expect(getSection(doc, 'Result')).toContain('second')
    expect(getSection(doc, 'Earlier attempts')).toContain('first')
    expect(getSection(setSection(doc, 'Notes', 'more'), 'Notes')).toBe('more')
  })
})

describe('task lists', () => {
  test('a declared step list ticks as done climbs', () => {
    const first = fromProgress([], null, { done: 0, total: null, step: '', steps: ['Read code', 'Write fix', 'Run tests'] })
    expect(first.source).toBe('steps')
    expect(first.tasks.map(t => t.state)).toEqual(['doing', 'todo', 'todo'])
    expect(fromProgress(first.tasks, first.source, { done: 2, total: null, step: '', steps: null }).tasks.map(t => t.state)).toEqual(['done', 'done', 'doing'])
  })

  test('steps reported one at a time build a history', () => {
    const a = fromProgress([], null, { done: 0, total: 4, step: 'Survey', steps: null })
    const b = fromProgress(a.tasks, a.source, { done: 1, total: 4, step: 'Patch', steps: null })
    expect(b.tasks).toEqual([
      { id: null, text: 'Survey', state: 'done' },
      { id: null, text: 'Patch', state: 'doing' },
    ])
  })

  test('TodoWrite and TaskCreate/TaskUpdate lists', () => {
    expect(fromTodos([{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }]).map(t => t.state)).toEqual(['done', 'doing'])
    const moved = taskUpdated(taskCreated(taskCreated([], '1', 'Write docs'), '2', 'Ship'), { taskId: '1', status: 'completed' })
    expect(moved.map(t => [t.text, t.state])).toEqual([
      ['Write docs', 'done'],
      ['Ship', 'todo'],
    ])
    expect(taskUpdated(moved, { taskId: '2', status: 'deleted' }).length).toBe(1)
  })

  test('a finished agent ticks its list; a blocked one marks where it stopped', () => {
    const list = fromProgress([], null, { done: 1, total: null, step: '', steps: ['a', 'b', 'c'] }).tasks
    expect(settleTasks(list, 'done').every(t => t.state === 'done')).toBe(true)
    expect(settleTasks(list, 'blocked').map(t => t.state)).toEqual(['done', 'blocked', 'todo'])
  })
})

describe('bars', () => {
  test('a drawing never repeats a key, and its text holds no control characters', () => {
    const row = (key: string, label: string) => ({ type: 'Button', key, props: { key, label } })
    const tree = { type: 'Box', props: {}, children: [row('la-l-a1-0', 'one'), row('la-l-a1-0', 'two\u001b[31m'), { type: 'Box', key: 'x', props: { key: 'x' }, children: [row('la-l-a1-0', 'three')] }] }
    const drawn = uniqueKeys(cleanTree(tree))
    expect(drawn.children.map(c => c.key)).toEqual(['la-l-a1-0', 'la-l-a1-0~2', 'x'])
    expect((drawn.children[2] as { children: Array<{ key: string; props: { key: string } }> }).children[0]!.props.key).toBe('la-l-a1-0~3')
    expect((drawn.children[1] as { props: { label: string } }).props.label).toBe('two')
    expect(tree.children[1]!.key).toBe('la-l-a1-0')
  })

  test('the text bar fills, keeps its width and draws a dot per checkpoint', () => {
    const marks = marksOf([
      { weight: 1, state: 'done' },
      { weight: 1, state: 'doing' },
      { weight: 1, state: 'todo' },
    ])
    const spans = textBar(0.55, 12, marks)
    expect(spans.map(s => s.text).join('')).toBe('━━━●━━╸◉───○')
    expect(spans.find(s => s.text === '◉')?.tone).toBe('doing')
  })

  test('too many checkpoints for the width: the bar alone', () => {
    const marks = marksOf(Array.from({ length: 10 }, () => ({ weight: 1, state: 'todo' as const })))
    expect(textBar(0, 10, marks).map(s => s.text).join('')).toBe('──────────')
  })

  test('the plan bar is blue while work is in progress and green once done', () => {
    expect(progressKind(0.4)).toBe('agent')
    expect(progressKind(1)).toBe('plan')
  })

  test('the SVG bar draws a dot per checkpoint', () => {
    const svg = svgBar(0.4, 300, marksOf([{ weight: 1, state: 'done' }, { weight: 1, state: 'todo' }]), '#3FB950')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.match(/<circle/g)?.length).toBe(2)
  })
})

describe('reports', () => {
  const REPORT =
    'STATUS: done\nAdded the endpoint.\n<decisions>\n- Used zod for validation (it was already a dependency)\n</decisions>\n<knowledge>\n- Invoices live in src/api/invoices.ts (src: src/api/invoices.ts)\n</knowledge>'

  test('pulls the status, decisions, notes, questions and verdicts', () => {
    expect(extractStatus(REPORT)).toBe('done')
    expect(extractDecisions(REPORT)).toEqual(['Used zod for validation (it was already a dependency)'])
    expect(extractKnowledge(REPORT)).toBe('- Invoices live in src/api/invoices.ts (src: src/api/invoices.ts)')
    expect(extractNeeds('STATUS: blocked\nNEEDS: Which database?\nOPTIONS: sqlite | postgres')).toEqual({
      question: 'Which database?',
      why: '',
      options: ['sqlite', 'postgres'],
      choices: [
        { label: 'sqlite', detail: '', isRecommended: false },
        { label: 'postgres', detail: '', isRecommended: false },
      ],
    })
    expect(extractNeeds(REPORT)).toBe(null)
    expect(extractQuestions('<questions>\n- Which date format? → ISO 8601\n- Tabs or spaces?\n</questions>')).toEqual([
      { question: 'Which date format?', assumed: 'ISO 8601', why: '', choices: [], chosen: null },
    ])
    expect(parseVerdict('VERDICT: fail\nThe test for totals fails.')).toEqual({ isPass: false, detail: 'The test for totals fails.' })
  })

  test('prose mentions of the questions tag never become questions', () => {
    const report = (block: string) =>
      [
        'STATUS: done',
        'Summary:',
        '- Item 4 shows the fenced <questions> template in the prompt.',
        '- options/WENT WITH: inside <questions> for later ones.',
        '- tsc exits 0.',
        '- Checks:',
        '',
        '<decisions>',
        '- Kept the parser pure.',
        '</decisions>',
        block,
      ].join('\n')
    expect(extractQuestions(report('<questions>none</questions>'))).toEqual([])
    expect(extractQuestions(report('<questions>\nNone\n</questions>'))).toEqual([])
    expect(extractQuestions('Notes: see `<questions>` and WENT WITH: later.\n- tsc exits 0.\n<questions>none</questions>')).toEqual([])
    const real = extractQuestions(
      report('<questions>\nQ: Keep the old API?\nWHY: Callers may use it.\n1. Yes - nothing breaks (recommended)\n2. No - simpler code\nWENT WITH: 1\n</questions>'),
    )
    expect(real).toHaveLength(1)
    expect(real[0]!.question).toBe('Keep the old API?')
    expect(real[0]!.chosen).toBe(0)
    expect(extractDecisions('See the <decisions> tag in prose.\n- not one\n<decisions>\n- real\n</decisions>')).toEqual(['real'])
  })

  test('reads the structured urgent question and the structured later questions', () => {
    const n = extractNeeds(
      'STATUS: blocked\nNEEDS: Which database should hold the data?\nWHY: The schema depends on it.\n1. SQLite — one file, no setup (recommended)\n2) Postgres: a server,\n   better for many users\n3. Both [Recommended]\n\nSummary text that is not part of the question.',
    )
    expect(n).toEqual({
      question: 'Which database should hold the data?',
      why: 'The schema depends on it.',
      options: ['SQLite', 'Postgres', 'Both'],
      choices: [
        { label: 'SQLite', detail: 'one file, no setup', isRecommended: true },
        { label: 'Postgres', detail: 'a server, better for many users', isRecommended: false },
        { label: 'Both', detail: '', isRecommended: false },
      ],
    })
    const bold = extractNeeds('STATUS: blocked\n**NEEDS:** Ship now?\n**Why:** The demo is tomorrow.\n- 1. Yes - ship (recommended)\n- 2. No - wait a week\nSTATUS: blocked')
    expect(bold).toMatchObject({ question: 'Ship now?', why: 'The demo is tomorrow.', options: ['Yes', 'No'] })

    const l = extractQuestions(
      '<questions>\nQ: Keep dates as text?\nWHY: Sorting works either way.\n1. Text - simple (recommended)\n2. Real dates - stricter\nWENT WITH: Real dates\n\nq: Tabs or spaces?\nWhy: Only style.\n1. Tabs - one key\n2. Spaces -- what the repo uses (recommended)\nWent with: 2\nQ: Name the folder?\nWENT WITH: something else\n</questions>',
    )
    expect(l).toHaveLength(3)
    expect(l[0]).toMatchObject({ question: 'Keep dates as text?', why: 'Sorting works either way.', assumed: 'Real dates', chosen: 1 })
    expect(l[0]!.choices[0]).toEqual({ label: 'Text', detail: 'simple', isRecommended: true })
    expect(l[1]).toMatchObject({ question: 'Tabs or spaces?', why: 'Only style.', assumed: 'Spaces', chosen: 1 })
    expect(l[1]!.choices[1]).toEqual({ label: 'Spaces', detail: 'what the repo uses', isRecommended: true })
    expect(l[2]).toEqual({ question: 'Name the folder?', assumed: 'something else', why: '', choices: [], chosen: null })
  })

  test('an urgent question needs a stopped report and a NEEDS: that begins its line', () => {
    const t7 =
      'STATUS: done\nThe questions reader now ignores prose mentions of the tag.\n\n- **hooks/notes.ts:** `extractQuestions` uses the last block.\n- NEEDS: extractNeeds was already line-anchored, so I left it alone.\n- Checks: tsc passes.'
    expect(extractStatus(t7)).toBe('done')
    expect(extractNeeds(t7)).toBe(null)
    expect(extractNeeds('STATUS: done\nNEEDS: Which database?\nOPTIONS: a | b')).toBe(null)

    expect(extractNeeds('STATUS: blocked\nNEEDS: Which database?\n1. SQLite (recommended)\n2. Postgres')).toMatchObject({
      question: 'Which database?',
      options: ['SQLite', 'Postgres'],
    })
    expect(extractNeeds('STATUS: blocked\n**NEEDS:** Ship now?\n1. Yes\n2. No')).toMatchObject({ question: 'Ship now?', options: ['Yes', 'No'] })
    expect(extractNeeds('STATUS: blocked\n  needs: lower case works\n1. a\n2. b')).toMatchObject({ question: 'lower case works' })

    expect(extractNeeds('STATUS: blocked\nThe build failed.\n- NEEDS: this is a bullet about code')).toBe(null)
    expect(extractNeeds('STATUS: blocked\n1. NEEDS: numbered prose')).toBe(null)
    expect(extractNeeds('STATUS: blocked\nIt NEEDS: a retry')).toBe(null)
  })

  test('keeps one recommended option, at most five, and reads a mixed later-questions block', () => {
    const n = extractNeeds('NEEDS: Pick one\n1. a (recommended)\n2. b (recommended)\n3. c\n4. d\n5. e\n6. f')
    expect(n?.choices.map(c => c.isRecommended)).toEqual([true, false, false, false, false])
    expect(n?.options).toEqual(['a', 'b', 'c', 'd', 'e'])

    const mixed = extractQuestions('<questions>\nQ: Keep the old API?\n1. Yes - nothing breaks (recommended)\n2. No - simpler code\nWENT WITH: yes\n\n- Which date format? → ISO 8601\n</questions>')
    expect(mixed).toEqual([
      {
        question: 'Keep the old API?',
        assumed: 'Yes',
        why: '',
        choices: [
          { label: 'Yes', detail: 'nothing breaks', isRecommended: true },
          { label: 'No', detail: 'simpler code', isRecommended: false },
        ],
        chosen: 0,
      },
      { question: 'Which date format?', assumed: 'ISO 8601', why: '', choices: [], chosen: null },
    ])
  })

  test('strips the notes the inbox already holds', () => {
    expect(stripKnowledge('STATUS: done\nok\n<knowledge>\n- x\n</knowledge>', '.knowledge/inbox.md')).toBe('STATUS: done\nok\n[notes saved to .knowledge/inbox.md]')
  })

  test('a spilled output keeps its head, its tail and a pointer', () => {
    const big = `${'a'.repeat(3000)}MIDDLE${'z'.repeat(3000)}`
    const note = spillNote('.knowledge/session/spill/bash-1.txt', big)
    expect(note).toContain('.knowledge/session/spill/bash-1.txt')
    expect(note).not.toContain('MIDDLE')
    expect(textOfResult([{ type: 'text', text: 'hi' }, { type: 'image' }])).toEqual({ text: 'hi', hasMedia: true })
  })
})

const SPAWN = { provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false } as const
const PANE = { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const

describe('hooks', () => {
  test('a spawn with no model gets the cheapest that fits; a named model stands', OPTIONS, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('session.root', () => ({ value: '/proj' }))
    const asked: Array<string | undefined> = []
    on('agent.spawn', (_, e) => {
      asked.push(e.model)
      return { model: e.model ?? 'claude-sonnet-5-5', agentId: `agent-${asked.length}` }
    })
    await $.agent.spawn({ ...SPAWN, tool_use_id: 't1', subagentType: 'general-purpose', description: 'find config', prompt: 'Find where the config file is loaded and list the files' })
    await $.agent.spawn({ ...SPAWN, tool_use_id: 't2', subagentType: 'general-purpose', description: 'pin it', prompt: 'Implement the retry\nPlan item: none', model: 'opus' })
    expect(asked).toEqual(['haiku', 'opus'])
  })

  test('the plan-first gate refuses a builder task that names no plan task', OPTIONS, async ($, on) => {
    on('session.root', () => ({ value: '/proj' }))
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
    const refused = await $.agent.spawn({ ...SPAWN, tool_use_id: 't1', subagentType: 'conductor:builder', description: 'x', prompt: 'Implement the export' })
    expect(refused.deny).toContain('Plan item')
    const allowed = await $.agent.spawn({ ...SPAWN, tool_use_id: 't2', subagentType: 'conductor:builder', description: 'x', prompt: 'Implement the export\nPlan item: none' })
    expect(allowed.agentId).toBe('agent-1')
  })

  test('the pane lists running agents and the bar counts them, on every surface', OPTIONS, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('session.root', () => ({ value: '/proj' }))
    on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'agent-1' }))
    on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
    await $.agent.spawn({ ...SPAWN, tool_use_id: 't1', subagentType: 'conductor:builder', description: 'Add invoice export', prompt: 'Implement the PDF export\nPlan item: none' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ plugin: 'conductor', surface, component: 'Pane', requestId: 'conductor-agents', props: PANE })
      expect(await pane.find({ type: 'Button', text: /Add invoice export/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /Running \(1\)/ })).toBeDefined()
      await pane.unmount()

      const band = await $.ui.mount({
        plugin: 'conductor',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
      })
      expect(await band.find({ type: 'Text', text: /1 agent working/ })).toBeDefined()
      await band.unmount()
    }
  })

  test('agent and main task lists expand in the pane, on every surface', OPTIONS, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('session.root', () => ({ value: '/proj' }))
    on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'agent-1' }))
    on('tool.call', () => ({ result: 'ok' }))
    await $.agent.spawn({ ...SPAWN, tool_use_id: 't1', subagentType: 'conductor:builder', description: 'Add invoice export', prompt: 'Implement the PDF export\nPlan item: none' })
    await $.tool.call({ tool: 'mcp__conductor__progress', agentId: 'agent-1', done: 1, steps: ['Read the code', 'Render the PDF', 'Run the tests'] } as never)
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Review the export', status: 'pending', activeForm: 'Reviewing' }] })

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ plugin: 'conductor', surface, component: 'Pane', requestId: 'conductor-agents', props: PANE })
      expect(await pane.find({ type: 'Text', text: 'Review the export' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'Read the code' })).toBeUndefined()
      await pane.press({ key: 'tg-agent-1' })
      expect(await pane.find({ type: 'Text', text: 'Read the code' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '1/3' })).toBeDefined()
      await pane.press({ key: 'tg-agent-1' })
      await pane.unmount()
    }
  })

  test("the mod approves only its own launches: the model's agent calls keep the session's permission decision", OPTIONS, async ($, on) => {
    on('tool.check', () => ({ decision: 'ask' as const, reason: 'the mode decides' }))
    const fromModel = await $.tool.check({ tool: 'Agent', input: { subagent_type: 'conductor:builder', description: 'x', prompt: 'y' } })
    expect(fromModel.decision).toBe('ask')
    const stop = await $.tool.check({ tool: 'TaskStop', input: { task_id: 'someone-else' } })
    expect(stop.decision).toBe('ask')
  })

  test('/conductor test launches one tiny agent and reports whether it started', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: 1000 })
    on('session.root', () => ({ value: '/proj' }))
    const asked: string[] = []
    on('agent.spawn', (_, e) => {
      asked.push(`${e.subagentType}:${e.model}`)
      return { model: 'claude-haiku-4-5', agentId: 'probe-1' }
    })
    on('agent.list', () => ({ value: [{ id: 'probe-1', description: 'conductor self-test', type: 'conductor:scout', status: 'running' }] }))
    const running = $.command.run({ command: 'conductor', args: 'test' } as never)
    await clock.advance(100)
    const ok = await running
    expect(ok.text).toContain('Self-test passed')
    // (The test kit drops agent types no session.start registered, so only the model is checked.)
    expect(asked.map(x => x.split(':').pop())).toEqual(['haiku'])
  })

  test('an agent resumed after it was stopped shows as running again, and its report is still read', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    on('session.root', () => ({ value: '/proj' }))
    on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'agent-1' }))
    on('agent.list', () => ({ value: [{ id: 'ghost-1', description: 'Started elsewhere', type: 'general-purpose', status: 'running' }] }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('tool.call', () => ({ result: 'ok' }))
    const end = (agentId: string, reason: 'answer' | 'aborted', answer: string) =>
      $.turn.complete({ turnId: `t-${agentId}`, agentId, answer, reason, durationMs: 1000, isAborted: reason === 'aborted' })
    const pane = async (check: (ui: Mounted<'terminal', 'Pane'>) => Promise<void>) => {
      const ui = await $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'Pane', requestId: 'conductor-agents', props: PANE })
      await check(ui)
      await ui.unmount()
    }

    await $.agent.spawn({ ...SPAWN, tool_use_id: 't1', subagentType: 'conductor:builder', description: 'Long job', prompt: 'Implement it\nPlan item: none' })
    await end('agent-1', 'aborted', '')
    await pane(async ui => expect(await ui.find({ type: 'Text', text: /Running \(0\)/ })).toBeDefined())

    // Resumed with SendMessage: no spawn fires, but its first call shows it is running again.
    await clock.advance(30_000)
    await $.tool.call({ tool: 'mcp__conductor__progress', agentId: 'agent-1', done: 0, steps: ['Pick up where I stopped'] } as never)
    await pane(async ui => {
      expect(await ui.find({ type: 'Text', text: /Running \(1\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Pick up where I stopped/ })).toBeDefined()
    })

    // Its report when it finishes again is read, not dropped.
    await end('agent-1', 'answer', 'STATUS: done\nFinished the job.\n<knowledge>none</knowledge>')
    await pane(async ui => expect(await ui.find({ type: 'Text', text: /Running \(0\)/ })).toBeDefined())

    // An agent the mod never saw start is picked up by its first call, from the session's agent list.
    await $.tool.call({ tool: 'Read', file_path: '/proj/a.ts', agentId: 'ghost-1' } as never)
    await pane(async ui => expect(await ui.find({ type: 'Button', text: /Started elsewhere/ })).toBeDefined())
  })

  describe('launching in auto mode', () => {
    const NO_VERDICT =
      'The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is.'

    /** A project with a one-task plan, a spawn that answers by \`decide\`, and the engine's turn events answered. */
    function world(on: On, decide: (n: number) => 'refuse' | 'deny' | 'start') {
      on('session.root', () => ({ value: '/proj' }))
      on('turn.start', (_, e) => ({ turnId: e.turnId }))
      on('turn.complete', (_, e) => ({ text: e.answer }))
      on('tool.call', () => ({ result: 'ok' }))
      const files: Record<string, string> = {
        '/proj/.knowledge/INDEX.md': '# Knowledge index\n',
        '/proj/.knowledge/decisions.md': '# Decisions\n',
        '/proj/.knowledge/plan.md': '# Plan: Demo\n## Phase 1: Build\n- [ ] T1: Write the parser {agent: builder, model: haiku}',
      }
      memFs(on, files)
      const spawned: string[] = []
      on('agent.spawn', (_, e) => {
        spawned.push(e.description)
        const verdict = decide(spawned.length)
        if (verdict === 'refuse') return { deny: NO_VERDICT }
        if (verdict === 'deny') return { deny: 'Agent type blocked by policy' }
        return { model: 'claude-haiku-4-5', agentId: `ag-${spawned.length}` }
      })
      // The test kit answers a plugin's own spawn without an id; the mod finds the agent by its description.
      on('agent.list', () => ({
        value: spawned.map((d, i) => ({ id: `ag-${i + 1}`, description: d, type: 'conductor:builder', status: decide(i + 1) === 'start' ? 'running' : 'failed' })),
      }))
      return { files, spawned }
    }

    const pane = async ($: Engine, check: (ui: Mounted<'terminal', 'Pane'>) => Promise<void>) => {
      const ui = await $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'Pane', requestId: 'conductor-agents', props: PANE })
      await check(ui)
      await ui.unmount()
    }

    test('a refused launch is kept, not failed, and retried at the next launch point, never inside a tool call', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 14, 12) })
      mock.store(on)
      const { files, spawned } = world(on, n => (n === 1 ? 'refuse' : 'start'))

      await $.turn.start({ text: 'run the plan', turnId: 'm1' })
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(3000)
      expect(spawned.length).toBe(1)
      expect(files['/proj/.knowledge/plan.md']).toContain('- [~] T1')
      await pane($, async ui => expect(await ui.find({ type: 'Text', text: /Couldn't start/ })).toBeUndefined())

      // A tool call is no launch point: an agent launched there would skip the mod's tool.call hook.
      await $.tool.call({ tool: 'mcp__conductor__run_plan' } as never)
      await clock.advance(100)
      expect(spawned.length).toBe(1)

      // The main agent's turn ends: a launch point.
      await $.turn.complete({ turnId: 'm1', answer: 'Started the run.', reason: 'answer', durationMs: 5000, isAborted: false })
      await clock.advance(100)
      expect(spawned.length).toBe(2)
      await pane($, async ui => expect(await ui.find({ type: 'Text', text: /Running \(1\)/ })).toBeDefined())
    })

    test('a held launch starts once the main agent is idle', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 14, 12) })
      mock.store(on)
      const { spawned } = world(on, n => (n === 1 ? 'refuse' : 'start'))

      await $.turn.start({ text: 'run the plan', turnId: 'm1' })
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(3000)
      expect(spawned.length).toBe(1)

      await $.turn.complete({ turnId: 'm1', answer: 'Started the run.', reason: 'answer', durationMs: 5000, isAborted: false })
      await clock.advance(1000)
      expect(spawned.length).toBe(2)
    })

    test('a launch that fails for good: reason in the brief and the pane, not an attempt, and retry works', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 14, 12) })
      mock.store(on)
      let isBlocked = true
      const { files, spawned } = world(on, () => (isBlocked ? 'deny' : 'start'))

      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(1000)
      expect(spawned.length).toBe(1)
      expect(files['/proj/.knowledge/plan.md']).toContain('- [!] T1')
      expect(files['/proj/.knowledge/tasks/T1.md']).toContain('## Launch problems')
      expect(files['/proj/.knowledge/tasks/T1.md']).toContain('Agent type blocked by policy')
      await pane($, async ui => {
        expect(await ui.find({ type: 'Text', text: /Couldn't start \(1\)/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /failed try/ })).toBeUndefined()
      })

      isBlocked = false
      await pane($, async ui => {
        await ui.press({ key: 'lr-T1' })
      })
      await clock.advance(1000)
      expect(spawned.length).toBe(2)
      expect(files['/proj/.knowledge/plan.md']).toContain('- [~] T1')
      // The retry is the task's first real attempt.
      expect(spawned[1]).toBe('T1: Write the parser')
    })
  })

  describe('approval and questions for later', () => {
    function project(on: On, plan: string) {
      on('session.root', () => ({ value: '/proj' }))
      on('turn.complete', (_, e) => ({ text: e.answer }))
      on('tool.call', () => ({ result: 'ok' }))
      const files: Record<string, string> = {
        '/proj/.knowledge/INDEX.md': '# Knowledge index\n',
        '/proj/.knowledge/decisions.md': '# Decisions\n',
        '/proj/.knowledge/plan.md': plan,
      }
      memFs(on, files)
      const spawned: string[] = []
      const models: Array<string | undefined> = []
      on('agent.spawn', (_, e) => {
        spawned.push(e.description)
        models.push(e.model)
        return { model: 'claude-haiku-4-5', agentId: `ag-${spawned.length}` }
      })
      const ended = new Set<string>()
      on('agent.list', () => ({ value: spawned.map((d, i) => ({ id: `ag-${i + 1}`, description: d, type: 'conductor:builder', status: ended.has(`ag-${i + 1}`) ? 'completed' : 'running' })) }))
      on('session.measure', (_, e) => ({ changed: e.changed }))
      return { files, spawned, models, ended }
    }

    test('an approved plan stays approved when it is edited: the run does not wait again', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { files } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: First {model: haiku}')

      await $.command.run({ command: 'conductor', args: 'approve' } as never)
      files['/proj/.knowledge/plan.md'] += '\n- [ ] T2: Added by the architect {model: haiku, after: T1}'
      const asked = await $.tool.call({ tool: 'mcp__conductor__run_plan' } as never)
      await clock.advance(100)
      expect(String((asked as { result?: unknown }).result)).toContain('Run started')
      const ui = await $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'Pane', requestId: 'conductor-agents', props: PANE })
      expect(await ui.find({ type: 'Text', text: /ready for review/ })).toBeUndefined()
      await ui.unmount()

      // A plan with a new title is a new plan: it asks again.
      files['/proj/.knowledge/plan.md'] = '# Plan: Something else\n## Phase 1\n- [ ] T1: Other {model: haiku}'
      await $.command.run({ command: 'conductor', args: 'stop' } as never)
      const again = await $.tool.call({ tool: 'mcp__conductor__run_plan' } as never)
      expect(String((again as { result?: unknown }).result)).toContain('approve')
    })

    test('a question left for later blocks nothing, and its answer is recorded', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { files, spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}')

      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      expect(spawned.length).toBe(1)
      await $.turn.complete({
        turnId: 't1',
        agentId: 'ag-1',
        answer: 'STATUS: done\nParser written.\n<questions>\n- Should dates be ISO or local format? → ISO 8601\n</questions>\n<knowledge>none</knowledge>',
        reason: 'answer',
        durationMs: 1,
        isAborted: false,
      })
      await clock.advance(100)
      expect(files['/proj/.knowledge/plan.md']).toContain('- [x] T1')

      const ui = await $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'Pane', requestId: 'conductor-questions', props: PANE })
      expect(await ui.find({ type: 'Button', text: /For later \(1\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /went on assuming: ISO 8601/ })).toBeDefined()
      await ui.input({ key: 'la-l-ag-1-0', text: 'local format' })
      await clock.advance(100)
      expect(await ui.find({ type: 'Button', text: /For later/ })).toBeUndefined()
      await ui.unmount()
      expect(files['/proj/.knowledge/decisions.md']).toContain('Should dates be ISO or local format? → local format')
      expect(files['/proj/.knowledge/tasks/T1.md']).toContain('A: local format')
    })

    const QPROPS = { ...PANE, title: 'Questions' }
    const keysOf = (node: unknown, out: string[] = []): string[] => {
      const n = node as { key?: string; props?: { key?: string }; children?: unknown[] }
      const key = n.props?.key ?? n.key
      if (key) out.push(key)
      for (const c of n.children ?? []) if (c && typeof c === 'object') keysOf(c, out)
      return out
    }
    test('keysOf finds keys in drawn trees (props.key) and plain nodes', () => {
      expect(keysOf({ props: { key: 'a' }, children: [{ key: 'b' }, { props: { key: 'c' }, children: [] }] })).toEqual(['a', 'b', 'c'])
    })
    const questionsPane = ($: Engine, surface: 'terminal' | 'desktop' | 'mobile') =>
      $.ui.mount({ plugin: 'conductor', surface, component: 'Pane', requestId: 'conductor-questions', props: QPROPS })

    test('the Questions pane draws urgent and later questions with reasons, explanations and marks, on every surface', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { files, spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}')
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      expect(spawned.length).toBe(2)
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: `STATUS: blocked\n${URGENT_EXAMPLE}`, reason: 'answer', durationMs: 1, isAborted: false })
      await $.turn.complete({
        turnId: 't2',
        agentId: 'ag-2',
        answer: `STATUS: done\nPrinter written.\n<questions>\n${LATER_EXAMPLE}\n</questions>\n<knowledge>none</knowledge>`,
        reason: 'answer',
        durationMs: 1,
        isAborted: false,
      })
      await clock.advance(100)

      for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
        const ui = await questionsPane($, surface)
        expect(await ui.find({ type: 'Text', text: /Needs you \(1\)/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Why it matters: Customers see these numbers/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /prices look lower/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'recommended' })).toBeDefined()
        expect(await ui.find({ type: 'Button', key: 'qo-q-ag-1-1' })).toBeDefined()
        expect(await ui.find({ type: 'Button', text: 'let AI decide' })).toBeDefined()
        expect(await ui.find({ type: 'Button', text: /For later \(2\)/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'the agent went with this' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Why it matters: They take space/ })).toBeDefined()
        expect(await ui.find({ type: 'Button', key: 'lo-l-ag-2-0-1' })).toBeDefined()
        expect(await ui.find({ type: 'Button', text: 'keep what the agent chose' })).toBeDefined()
        // Input exists only where the surface has it.
        const input = await ui.find({ type: 'Input', key: 'qa-q-ag-1' })
        if (surface === 'mobile') expect(input).toBeUndefined()
        else expect(input).toBeDefined()
        const keys = keysOf(await ui.drawn())
        expect(keys.length).toBeGreaterThan(0)
        expect(new Set(keys).size).toBe(keys.length)
        await ui.unmount()
      }
    })

    const TWO = '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}'
    const askBoth = async ($: Engine, on: On) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { files } = project(on, TWO)
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: `STATUS: blocked\n${URGENT_EXAMPLE}`, reason: 'answer', durationMs: 1, isAborted: false })
      await $.turn.complete({ turnId: 't2', agentId: 'ag-2', answer: `STATUS: done\nPrinter written.\n<questions>\n${LATER_EXAMPLE}\n</questions>\n<knowledge>none</knowledge>`, reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(100)
      return { clock, files }
    }
    const textNode = (node: unknown, text: string): { props: Record<string, unknown> } | undefined => {
      const n = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
      if (n.type === 'Text' && (n.children ?? []).every(c => typeof c === 'string') && (n.children ?? []).join('') === text) return n as never
      for (const c of n.children ?? []) { if (c && typeof c === 'object') { const r = textNode(c, text); if (r) return r } }
      return undefined
    }
    type Found = { props: Record<string, unknown> } | undefined

    test('the Questions pane lays out one card per question with header, bold question, suggested answers and a full-width own-answer box, on every surface', OPTIONS, async ($, on) => {
      await askBoth($, on)
      for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
        const ui = await questionsPane($, surface)
        const card = (await ui.find({ key: 'q-q-ag-1' })) as Found
        expect(card?.props.borderStyle).toBe('round')
        expect(card?.props.borderColor).toBe('warning')
        const later = (await ui.find({ key: 'lq-l-ag-2-0' })) as Found
        expect(later?.props.borderStyle).toBe('round')
        expect(later?.props.borderDimColor).toBe(true)
        const lead = textNode(await ui.drawn(), 'T1')
        expect(lead?.props.bold).toBe(true)
        expect(lead?.props.color).toBe('claude')
        expect(await ui.find({ type: 'Text', text: /· haiku/ })).toBeDefined()
        const question = textNode(await ui.drawn(), 'Should the report show prices with tax included?')
        expect(question?.props.bold).toBe(true)
        expect((await ui.find({ type: 'Button', key: 'qo-q-ag-1-0' }) as Found)?.props.variant).toBe('primary')
        expect((await ui.find({ type: 'Button', key: 'qo-q-ag-1-1' }) as Found)?.props.variant).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: '★' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'Suggested answers' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Needs you \(1\)/ })).toBeDefined()
        if (surface === 'mobile') {
          expect(await ui.find({ type: 'Input' })).toBeUndefined()
          expect(await ui.find({ type: 'Text', text: /open this chat in the desktop app/ })).toBeDefined()
        } else {
          const input = (await ui.find({ type: 'Input', key: 'qa-q-ag-1' })) as Found
          expect(input).toBeDefined()
          expect(input?.props.label).toBeUndefined()
          expect(await ui.find({ type: 'Text', text: /Or write your own answer/ })).toBeDefined()
        }
        const keys = keysOf(await ui.drawn())
        expect(keys.length).toBeGreaterThan(0)
        expect(new Set(keys).size).toBe(keys.length)
        await ui.unmount()
      }
    })

    test('on a narrow pane the cards have no border and are told apart by a rule', OPTIONS, async ($, on) => {
      await askBoth($, on)
      const ui = await $.ui.mount({ plugin: 'conductor', surface: 'desktop', component: 'Pane', requestId: 'conductor-questions', props: { ...QPROPS, bodyColumns: 30 } })
      const later = (await ui.find({ key: 'lq-l-ag-2-1' })) as Found
      expect(later).toBeDefined()
      expect(later?.props.borderStyle).toBeUndefined()
      expect(((await ui.find({ key: 'q-q-ag-1' })) as Found)?.props.borderStyle).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
      const keys = keysOf(await ui.drawn())
      expect(keys.length).toBeGreaterThan(0)
      expect(new Set(keys).size).toBe(keys.length)
      await ui.unmount()
    })

    test('with no questions the pane says all clear, on every surface', OPTIONS, async ($, on) => {
      mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      project(on, TWO)
      for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
        const ui = await questionsPane($, surface)
        expect(await ui.find({ type: 'Text', text: '✓ All clear' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'No questions right now.' })).toBeDefined()
        await ui.unmount()
      }
    })

    describe('every answer path records on the desktop surface', () => {
      const paths: { name: string; act: (ui: Awaited<ReturnType<typeof questionsPane>>) => Promise<void>; check: (files: Record<string, string>, ui: Awaited<ReturnType<typeof questionsPane>>) => Promise<void> }[] = [
        { name: 'urgent option', act: async ui => void (await ui.press({ key: 'qo-q-ag-1-1' })), check: async f => expect(f['/proj/.knowledge/decisions.md']).toContain('→ Leave tax out') },
        { name: 'urgent own answer', act: ui => (ui as never as { input: (e: object) => Promise<void> }).input({ key: 'qa-q-ag-1', text: 'tax only on export' }), check: async f => expect(f['/proj/.knowledge/decisions.md']).toContain('→ tax only on export') },
        {
          name: 'urgent let AI decide',
          act: async ui => void (await ui.press({ key: 'qd-q-ag-1' })),
          check: async (f, ui) => {
            expect(await ui.find({ type: 'Button', key: 'qd-q-ag-1' })).toBeUndefined()
            expect(f['/proj/.knowledge/tasks/T1.md']).toContain('The user leaves this to you')
          },
        },
        {
          name: 'urgent dismiss',
          act: async ui => void (await ui.press({ key: 'qx-q-ag-1' })),
          check: async (f, ui) => {
            expect(await ui.find({ type: 'Button', key: 'qx-q-ag-1' })).toBeUndefined()
            expect(f['/proj/.knowledge/decisions.md'] ?? '').not.toContain('Leave tax out')
            expect(f['/proj/.knowledge/tasks/T1.md']).not.toContain('Answers from the user')
          },
        },
        { name: 'later option', act: async ui => void (await ui.press({ key: 'lo-l-ag-2-0-1' })), check: async f => expect(f['/proj/.knowledge/decisions.md']).toContain('Should old reports be kept after the upgrade? → Delete them') },
        { name: 'later keep', act: async ui => void (await ui.press({ key: 'lk-l-ag-2-0' })), check: async f => expect(f['/proj/.knowledge/decisions.md']).toContain("the user kept the agent's assumption") },
        { name: 'later own answer', act: ui => (ui as never as { input: (e: object) => Promise<void> }).input({ key: 'la-l-ag-2-0', text: 'keep for a year' }), check: async f => expect(f['/proj/.knowledge/decisions.md']).toContain('→ keep for a year') },
        {
          name: 'later dismiss',
          act: async ui => void (await ui.press({ key: 'ld-l-ag-2-0' })),
          check: async (f, ui) => {
            expect(await ui.find({ type: 'Button', key: 'ld-l-ag-2-0' })).toBeUndefined()
            expect(await ui.find({ type: 'Button', text: /For later \(1\)/ })).toBeDefined()
            expect(f['/proj/.knowledge/decisions.md'] ?? '').not.toContain('Delete them')
          },
        },
        {
          name: 'dismiss all',
          act: async ui => void (await ui.press({ key: 'ld-all' })),
          check: async (_, ui) => {
            expect(await ui.find({ type: 'Button', text: /For later/ })).toBeUndefined()
            expect(await ui.find({ type: 'Text', text: /Needs you \(1\)/ })).toBeDefined()
          },
        },
      ]
      for (const p of paths) {
        test(p.name, OPTIONS, async ($, on) => {
          const { clock, files } = await askBoth($, on)
          const ui = await questionsPane($, 'desktop')
          await p.act(ui)
          await clock.advance(100)
          await p.check(files, ui)
          await ui.unmount()
        })
      }
    })

    test('a stored question from before the agent label draws without one and without error', OPTIONS, async ($, on) => {
      mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      on('session.start', () => ({ cwd: '/proj' }) as never)
      on('command.register', () => ({ value: true }) as never)
      on('agent.register', () => ({ value: true }) as never)
      on('tool.register', () => ({ value: true }) as never)
      let seeded = false
      on('state.get', async (_, e, next) => {
        const r = await next(e)
        if (e.key !== 'questions' || seeded) return r
        seeded = true
        return { value: { ...(r.value ?? {}), value: [{ id: 'q-old', itemId: null, agentId: 'old', from: 'old agent', question: 'Old question?', options: ['yes', 'no'], askedAt: 1 }] } } as never
      })
      project(on, TWO)
      await ($.session as unknown as { start: (e: object) => Promise<unknown> }).start({ cwd: '/proj' })
      for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
        const ui = await questionsPane($, surface)
        expect(await ui.find({ type: 'Text', text: 'Old question?' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /·/ })).toBeUndefined()
        expect(await ui.find({ type: 'Button', key: 'qo-q-old-0' })).toBeDefined()
        await ui.unmount()
      }
    })

    test('pressing a Questions pane option records the answer; the agent\'s own pick on a later question is recorded as kept', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { files } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}')
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: `STATUS: blocked\n${URGENT_EXAMPLE}`, reason: 'answer', durationMs: 1, isAborted: false })
      await $.turn.complete({
        turnId: 't2',
        agentId: 'ag-2',
        answer: `STATUS: done\nPrinter written.\n<questions>\n${LATER_EXAMPLE}\n</questions>\n<knowledge>none</knowledge>`,
        reason: 'answer',
        durationMs: 1,
        isAborted: false,
      })
      await clock.advance(100)

      const ui = await questionsPane($, 'terminal')
      await ui.press({ key: 'qo-q-ag-1-1' })
      await clock.advance(100)
      expect(files['/proj/.knowledge/decisions.md']).toContain('→ Leave tax out')
      expect(files['/proj/.knowledge/tasks/T1.md']).toContain('A: Leave tax out')
      await ui.press({ key: 'lo-l-ag-2-0-1' })
      await clock.advance(100)
      expect(files['/proj/.knowledge/decisions.md']).toContain('Should old reports be kept after the upgrade? → Delete them')
      // The first later question was the agent's own pick (option 1): pressing it keeps it.
      await ui.press({ key: 'lo-l-ag-2-1-0' })
      await clock.advance(100)
      expect(files['/proj/.knowledge/decisions.md']).toContain('Which name should the new folder have? → reports-2026')
      expect(files['/proj/.knowledge/decisions.md']).toContain("the user kept the agent's assumption")
      expect(await ui.find({ type: 'Text', text: 'No questions right now.' })).toBeDefined()
      await ui.unmount()
    })

    test('text typed in an Other box survives redraws; submit records it; empty submit keeps the question; drafts are per question', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { files } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}')
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: `STATUS: blocked\n${URGENT_EXAMPLE}`, reason: 'answer', durationMs: 1, isAborted: false })
      await $.turn.complete({ turnId: 't2', agentId: 'ag-2', answer: `STATUS: done\nPrinter written.\n<questions>\n${LATER_EXAMPLE}\n</questions>\n<knowledge>none</knowledge>`, reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(100)
      const redraw = async (ui: Awaited<ReturnType<typeof questionsPane>>) => {
        await ui.press({ key: 'tg-later' })
        await clock.advance(100)
        await ui.press({ key: 'tg-later' })
        await clock.advance(100)
      }
      let n = 0
      for (const surface of ['terminal', 'desktop'] as const) {
        n++
        const ui = (await questionsPane($, surface)) as unknown as Awaited<ReturnType<typeof questionsPane>> & { input: (e: object) => Promise<void> }
        const dec = () => files['/proj/.knowledge/decisions.md'] ?? ''
        // An empty or spaces-only submit keeps the question.
        await ui.input({ key: 'qa-q-ag-1', text: '   ' })
        await clock.advance(100)
        expect(await ui.find({ type: 'Text', text: /Needs you \(1\)/ })).toBeDefined()
        expect(dec()).not.toContain('→   ')

        const urgent = `urgent ${surface} ${'x'.repeat(120)}`
        await ui.input({ key: 'qa-q-ag-1', text: urgent, kind: 'change' } as never)
        await redraw(ui)
        expect((await ui.find({ type: 'Input', key: 'qa-q-ag-1' }))?.props.value).toBe(urgent)
        expect(dec()).not.toContain(urgent)

        const later = `later ${surface} ${'y'.repeat(120)}`
        await ui.input({ key: 'la-l-ag-2-0', text: later, kind: 'change' } as never)
        await ui.input({ key: 'la-l-ag-2-1', text: 'second draft', kind: 'change' } as never)
        await redraw(ui)
        expect((await ui.find({ type: 'Input', key: 'la-l-ag-2-0' }))?.props.value).toBe(later)
        expect((await ui.find({ type: 'Input', key: 'la-l-ag-2-1' }))?.props.value).toBe('second draft')
        expect(dec()).not.toContain(later)
        const keys = keysOf(await ui.drawn())
        expect(keys.length).toBeGreaterThan(0)
        expect(new Set(keys).size).toBe(keys.length)

        // Answering one later question leaves the other's draft alone.
        await ui.press({ key: 'lo-l-ag-2-0-1' })
        await clock.advance(100)
        expect(await ui.find({ type: 'Input', key: 'la-l-ag-2-0' })).toBeUndefined()
        expect((await ui.find({ type: 'Input', key: 'la-l-ag-2-1' }))?.props.value).toBe('second draft')
        await ui.input({ key: 'la-l-ag-2-1', text: 'second draft' })
        await clock.advance(100)
        expect(dec()).toContain('→ second draft')

        await ui.input({ key: 'qa-q-ag-1', text: urgent })
        await clock.advance(100)
        expect(dec()).toContain(`→ ${urgent}`)
        expect(await ui.find({ type: 'Input', key: 'qa-q-ag-1' })).toBeUndefined()
        await ui.unmount()

        if (surface === 'terminal') {
          // Fresh questions for the desktop round.
          files['/proj/.knowledge/plan.md'] = '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}'
          await $.turn.complete({ turnId: `t${n}a`, agentId: 'ag-1', answer: `STATUS: blocked\n${URGENT_EXAMPLE}`, reason: 'answer', durationMs: 1, isAborted: false })
          await $.turn.complete({ turnId: `t${n}b`, agentId: 'ag-2', answer: `STATUS: done\nPrinter written.\n<questions>\n${LATER_EXAMPLE}\n</questions>\n<knowledge>none</knowledge>`, reason: 'answer', durationMs: 1, isAborted: false })
          await clock.advance(100)
        }
      }
    })

    test('dismiss all empties the For later list without recording anything, on terminal and desktop', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { files } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}')
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: `STATUS: done\nParser written.\n<questions>\n${LATER_EXAMPLE}\n</questions>\n<knowledge>none</knowledge>`, reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(100)
      const before = files['/proj/.knowledge/decisions.md'] ?? ''
      for (const surface of ['terminal', 'desktop'] as const) {
        const ui = await questionsPane($, surface)
        expect(await ui.find({ type: 'Button', key: 'ld-all', text: 'dismiss all' })).toBeDefined()
        const keys = keysOf(await ui.drawn())
        expect(keys.length).toBeGreaterThan(0)
        expect(new Set(keys).size).toBe(keys.length)
        await ui.press({ key: 'ld-all' })
        await clock.advance(100)
        expect(await ui.find({ type: 'Button', text: /For later/ })).toBeUndefined()
        expect(await ui.find({ type: 'Button', key: 'ld-all' })).toBeUndefined()
        await ui.unmount()
        expect(files['/proj/.knowledge/decisions.md'] ?? '').toBe(before)
        if (surface === 'terminal') {
          await $.turn.complete({ turnId: 't2', agentId: 'ag-2', answer: `STATUS: done\nPrinter written.\n<questions>\n${LATER_EXAMPLE}\n</questions>\n<knowledge>none</knowledge>`, reason: 'answer', durationMs: 1, isAborted: false })
          await clock.advance(100)
        }
      }
    })

    test('one later question has no dismiss all button', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}')
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: 'STATUS: done\nParser written.\n<questions>\n- Should dates be ISO or local format? → ISO 8601\n</questions>\n<knowledge>none</knowledge>', reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(100)
      const ui = await questionsPane($, 'terminal')
      expect(await ui.find({ type: 'Button', text: /For later \(1\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'ld-all' })).toBeUndefined()
      await ui.unmount()
    })

    test('stored later questions with no choices, no assumption and no question mark are dropped at session start', OPTIONS, async ($, on) => {
      mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      on('session.start', () => ({ cwd: '/proj' }) as never)
      on('command.register', () => ({ value: true }) as never)
      on('agent.register', () => ({ value: true }) as never)
      on('tool.register', () => ({ value: true }) as never)
      let seeded = false
      on('state.get', async (_, e, next) => {
        const r = await next(e)
        if (e.key !== 'laterQuestions' || seeded) return r
        seeded = true
        const mk = (id: string, question: string, extra: object) => ({ id, question, from: 'ag-1', itemId: null, ...extra })
        return { value: { ...(r.value ?? {}), value: [mk('j1', 'NEEDS: left alone', {}), mk('k1', 'Keep me?', {}), mk('k2', 'with a pick', { assumed: 'x' }), mk('k3', 'with choices', { choices: [{ label: 'a', detail: '', isRecommended: false }] })] } } as never
      })
      project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}')
      await ($.session as unknown as { start: (e: object) => Promise<unknown> }).start({ cwd: '/proj' })
      const ui = await questionsPane($, 'terminal')
      expect(await ui.find({ type: 'Button', text: /For later \(3\)/ })).toBeDefined()
      await ui.unmount()
    })

    describe('session start opens the Questions pane', () => {
      const seedAndStart = async ($: any, on: On, key: string, list: object[]) => {
        mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
        mock.store(on)
        const { opened } = fakePanes(on)
        on('session.start', () => ({ cwd: '/proj' }) as never)
        on('command.register', () => ({ value: true }) as never)
        on('agent.register', () => ({ value: true }) as never)
        on('tool.register', () => ({ value: true }) as never)
        let seeded = false
        on('state.get', async (_, e, next) => {
          const r = await next(e)
          if (e.key !== key || seeded) return r
          seeded = true
          return { value: { ...(r.value ?? {}), value: list } } as never
        })
        project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}')
        await ($.session as unknown as { start: (e: object) => Promise<unknown> }).start({ cwd: '/proj' })
        return opened
      }
      const mk = (id: string) => ({ id, question: 'Which flag parser?', from: 'ag-1', itemId: null, choices: [{ label: 'a', detail: '', isRecommended: false }] })

      test('an urgent question already waiting opens it', { options: { showPane: true, classifier: false, sound: false } }, async ($, on) => {
        const opened = await seedAndStart($, on, 'questions', [mk('u1')])
        expect(opened).toContain('conductor-questions')
      })
      test('only later questions open nothing', { options: { showPane: true, classifier: false, sound: false } }, async ($, on) => {
        const opened = await seedAndStart($, on, 'laterQuestions', [mk('l1')])
        expect(opened).not.toContain('conductor-questions')
      })
      test('no questions open nothing', { options: { showPane: true, classifier: false, sound: false } }, async ($, on) => {
        const opened = await seedAndStart($, on, 'none', [])
        expect(opened).not.toContain('conductor-questions')
      })
    })

    describe('usage check before starting', () => {
      const NOW = new Date(2026, 9, 15, 12).getTime()
      const dayKey = () => {
        const d = new Date(NOW)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }
      /** Fakes what was spent today, whatever the mod writes. */
      const spentToday = (on: On, usd: number, isWrappingUp = false) =>
        on('state.get', async (_, e, next) => {
          const r = await next(e)
          if (e.key !== 'today') return r
          return { value: { ...(r.value ?? {}), value: { day: dayKey(), usd, isWrappingUp } } } as never
        })
      const toasts = (on: On) => {
        const out: string[] = []
        on('ui.toast', async (_, e, next) => {
          out.push(e.text)
          return next(e)
        })
        return out
      }
      const TWO_MODELS = '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the big parser {model: sonnet}\n- [ ] T2: Write the small printer {model: haiku}'
      const measure = ($: Engine, windows: Array<{ kind: string; percentUsed: number; resetsAt?: string }>) =>
        $.session.measure({ context: { window: 200000 }, rateLimits: windows, cost: { usd: 0 }, changed: ['rateLimits'] } as never)

      test('a task that does not fit the budget is held while a smaller one starts; raising the budget starts it on the same model', OPTIONS, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        mock.store(on)
        const said = toasts(on)
        spentToday(on, 1.5)
        const { files, spawned, models } = project(on, TWO_MODELS)

        await $.command.run({ command: 'conductor', args: 'budget 2' } as never)
        await $.command.run({ command: 'conductor', args: 'run' } as never)
        await clock.advance(100)
        expect(spawned).toEqual(['T2: Write the small printer'])
        expect(files['/proj/.knowledge/plan.md']).toContain('- [ ] T1')
        const brief = files['/proj/.knowledge/tasks/T1.md']!
        expect(brief).toContain('## Waiting for usage')
        expect(brief).toContain('$1.50')
        expect(brief).toContain('$0.50')
        expect(said.some(t => /T1 waits for usage/.test(t))).toBe(true)

        await $.command.run({ command: 'conductor', args: 'budget 20' } as never)
        await clock.advance(100)
        expect(spawned).toEqual(['T2: Write the small printer', 'T1: Write the big parser'])
        expect(models).toContain('sonnet')
        expect(files['/proj/.knowledge/plan.md']).toContain('- [~] T1')
      })

      test('a full rate-limit window holds a task until it eases, on the same model', OPTIONS, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        mock.store(on)
        const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the big parser {model: sonnet}')
        const full = [{ kind: 'five_hour', percentUsed: 97, resetsAt: new Date(NOW + 3600_000).toISOString() }]
        await measure($, full)
        await $.command.run({ command: 'conductor', args: 'run' } as never)
        await clock.advance(100)
        expect(spawned).toEqual([])

        await clock.advance(1000)
        await measure($, [{ kind: 'five_hour', percentUsed: 5, resetsAt: new Date(NOW + 5 * 3600_000).toISOString() }])
        await clock.advance(1000)
        expect(spawned).toEqual(['T1: Write the big parser'])
      })

      test('passing the wrap-up line tells no running agent to stop, and the run is not paused at 100%', OPTIONS, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        mock.store(on)
        const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the small printer {model: haiku}')
        const sent: string[] = []
        on('session.send', async (_, e, next) => {
          sent.push(JSON.stringify(e))
          return next(e)
        })
        await $.command.run({ command: 'conductor', args: 'run' } as never)
        await clock.advance(100)
        expect(spawned.length).toBe(1)
        await $.command.run({ command: 'conductor', args: 'budget 10' } as never)
        await $.session.measure({ context: { window: 200000 }, rateLimits: [], cost: { usd: 11 }, changed: ['cost'] } as never)
        await clock.advance(100)
        expect(sent.join('\n')).not.toContain('Finish the step you are on')
        const ui = await $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'Pane', requestId: 'conductor-agents', props: PANE })
        expect(await ui.find({ type: 'Text', text: /paused/i })).toBeUndefined()
        await ui.unmount()
      })

      test('a finished agent with usage records its cost under its kind', OPTIONS, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        const saved: Record<string, unknown> = {}
        on('store.get', (_, e) => ({ value: saved[e.key] }))
        on('store.set', (_, e) => {
          saved[e.key] = e.value
          return { value: undefined }
        })
        on('store.delete', (_, e) => {
          delete saved[e.key]
          return { value: undefined }
        })
        on('store.keys', () => ({ value: Object.keys(saved) }))
        const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the small printer {model: haiku}')
        await $.command.run({ command: 'conductor', args: 'run' } as never)
        await clock.advance(100)
        expect(spawned.length).toBe(1)
        await $.turn.complete({
          turnId: 't1',
          agentId: 'ag-1',
          answer: 'STATUS: done\nDone.\n<knowledge>none</knowledge>',
          reason: 'answer',
          durationMs: 1,
          isAborted: false,
          usage: { input_tokens: 100000, output_tokens: 20000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-4-5' },
        } as never)
        await clock.advance(100)
        const costs = saved['costs'] as Record<string, number[]> | undefined
        expect(costs).toBeDefined()
        const keys = Object.keys(costs ?? {})
        expect(keys.some(k => k.endsWith('|haiku'))).toBe(true)
        expect(Object.values(costs ?? {}).every(v => v.length === 1 && v[0]! > 0)).toBe(true)
      })

      describe('what runs and what waits', () => {
        const BAND = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} }
        const bandOf = ($: Engine, surface: 'terminal' | 'desktop', bodyColumns = 100) =>
          $.ui.mount({ plugin: 'conductor', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns } })
        const agentsPane = ($: Engine, surface: 'terminal' | 'desktop') =>
          $.ui.mount({ plugin: 'conductor', surface, component: 'Pane', requestId: 'conductor-agents', props: PANE })
        type N = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
        /** The closest Box holding the bar (an Svg or the block-drawn Text): does it also hold the band-toggle button? */
        const barBoxHoldsToggle = (node: unknown, surface: string): boolean | undefined => {
          const n = node as N
          const kids = (n.children ?? []).filter((c): c is N => Boolean(c) && typeof c === 'object')
          const isBar = (c: N) => (surface === 'desktop' ? c.type === 'Svg' : c.type === 'Text' && JSON.stringify(c).includes('━'))
          if (n.type === 'Box' && kids.some(isBar)) return JSON.stringify(n).includes('band-toggle')
          for (const c of kids) {
            const r = barBoxHoldsToggle(c, surface)
            if (r !== undefined) return r
          }
          return undefined
        }
        const THREE = '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}\n- [ ] T3: Write the linter {model: haiku}'

        test('the band names the running task and keeps the bar on its own line, on every surface', OPTIONS, async ($, on) => {
          const clock = mock.clock(on, { now: NOW })
          mock.store(on)
          on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
          const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}')
          await $.command.run({ command: 'conductor', args: 'run' } as never)
          await clock.advance(100)
          expect(spawned.length).toBe(1)
          for (const surface of ['terminal', 'desktop'] as const) {
            const band = await bandOf($, surface)
            expect(await band.find({ type: 'Text', text: 'T1 Write the parser' })).toBeDefined()
            expect(await band.find({ type: 'Text', text: /1 agent working/ })).toBeDefined()
            expect(barBoxHoldsToggle(await band.drawn(), surface)).toBe(false)
            const keys = keysOf(await band.drawn())
            expect(keys.length).toBeGreaterThan(0)
            expect(new Set(keys).size).toBe(keys.length)
            await band.unmount()
          }
        })

        test('with several running the band shows the first task and "+N more"', OPTIONS, async ($, on) => {
          const clock = mock.clock(on, { now: NOW })
          mock.store(on)
          on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
          const { spawned } = project(on, THREE)
          await $.command.run({ command: 'conductor', args: 'run' } as never)
          await clock.advance(100)
          expect(spawned.length).toBe(3)
          for (const surface of ['terminal', 'desktop'] as const) {
            const band = await bandOf($, surface)
            expect(await band.find({ type: 'Text', text: /^T\d Write the/ })).toBeDefined()
            expect(await band.find({ type: 'Text', text: '+2 more' })).toBeDefined()
            const keys = keysOf(await band.drawn())
            expect(keys.length).toBeGreaterThan(0)
            expect(new Set(keys).size).toBe(keys.length)
            await band.unmount()
          }
        })

        test('a long task name is clipped to the width and ends with an ellipsis', OPTIONS, async ($, on) => {
          const clock = mock.clock(on, { now: NOW })
          mock.store(on)
          on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
          project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write a very long parser name that cannot possibly fit on one line {model: haiku}')
          await $.command.run({ command: 'conductor', args: 'run' } as never)
          await clock.advance(100)
          for (const surface of ['terminal', 'desktop'] as const) {
            const band = await bandOf($, surface, 40)
            expect(await band.find({ type: 'Text', text: /^T1 Write a very/ })).toBeDefined()
            const label = JSON.stringify(await band.drawn()).match(/"(T1 Write a very[^"]*)"/)?.[1] ?? ''
            expect(label.length).toBeLessThanOrEqual(36)
            expect(label.endsWith('…')).toBe(true)
            await band.unmount()
          }
        })

        test('a held task shows as waiting for usage in the band, the Agents pane and the status line', OPTIONS, async ($, on) => {
          const clock = mock.clock(on, { now: NOW })
          mock.store(on)
          spentToday(on, 1.5)
          const statuses: string[] = []
          on('ui.status', (_, e) => {
            statuses.push(String(e.text))
            return { value: undefined }
          })
          on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
          const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the big parser {model: sonnet}')
          await $.command.run({ command: 'conductor', args: 'budget 2' } as never)
          await $.command.run({ command: 'conductor', args: 'run' } as never)
          await clock.advance(100)
          expect(spawned).toEqual([])
          expect(statuses.some(x => x.includes('1 waiting for usage'))).toBe(true)
          for (const surface of ['terminal', 'desktop'] as const) {
            const band = await bandOf($, surface)
            expect(await band.find({ type: 'Text', text: /waits for usage/ })).toBeDefined()
            const bk = keysOf(await band.drawn())
            expect(new Set(bk).size).toBe(bk.length)
            await band.unmount()
            const pane = await agentsPane($, surface)
            expect(await pane.find({ type: 'Text', text: /waiting for usage:/ })).toBeDefined()
            expect(await pane.find({ type: 'Text', text: /⧗ T1 waits for usage: / })).toBeDefined()
            const pk = keysOf(await pane.drawn())
            expect(new Set(pk).size).toBe(pk.length)
            await pane.unmount()
          }
        })

        /** Colours of the text-bar fill Texts in a drawn tree (leaf Texts holding bar blocks). */
        const barColors = (node: unknown, out: unknown[] = []): unknown[] => {
          const n = node as N
          const kids = (n.children ?? []).filter((c): c is N => Boolean(c) && typeof c === 'object')
          if (n.type === 'Text' && kids.length === 0 && JSON.stringify(n).includes('━')) out.push(n.props?.color)
          for (const c of kids) barColors(c, out)
          return out
        }

        test('the project bar is blue while the plan is unfinished, on terminal and desktop', OPTIONS, async ($, on) => {
          const clock = mock.clock(on, { now: NOW })
          mock.store(on)
          on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
          project(on, '# Plan: Demo\n## Phase 1\n- [x] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}\n- [ ] T3: Write the linter {model: haiku}')
          await $.command.run({ command: 'conductor', args: 'run' } as never)
          await clock.advance(100)
          const term = await bandOf($, 'terminal')
          expect(barColors(await term.drawn())).toContain('ide')
          await term.unmount()
          const desk = await bandOf($, 'desktop')
          expect(JSON.stringify(await desk.drawn())).toContain('#4C8DF6')
          await desk.unmount()
        })

        test('the project bar turns green when every task is done', OPTIONS, async ($, on) => {
          const clock = mock.clock(on, { now: NOW })
          mock.store(on)
          on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
          project(on, '# Plan: Demo\n## Phase 1\n- [x] T1: Write the parser {model: haiku}\n- [x] T2: Write the printer {model: haiku}')
          await $.command.run({ command: 'conductor', args: 'run' } as never)
          await clock.advance(100)
          const term = await bandOf($, 'terminal')
          expect(barColors(await term.drawn())).toContain('success')
          await term.unmount()
          const desk = await bandOf($, 'desktop')
          expect(JSON.stringify(await desk.drawn())).toContain('#3FB950')
          await desk.unmount()
        })

        test('a running agent with no steps reported has a light blue estimate bar', OPTIONS, async ($, on) => {
          const clock = mock.clock(on, { now: NOW })
          mock.store(on)
          on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
          project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}')
          await $.command.run({ command: 'conductor', args: 'run' } as never)
          await clock.advance(100)
          const term = await agentsPane($, 'terminal')
          expect(barColors(await term.drawn())).toContain('ide')
          await term.unmount()
          const desk = await agentsPane($, 'desktop')
          expect(JSON.stringify(await desk.drawn())).toContain('#8FB4F8')
          await desk.unmount()
        })

        test('the Agents pane keeps the last 5 finished agents', OPTIONS, async ($, on) => {
          const clock = mock.clock(on, { now: NOW })
          mock.store(on)
          const items = Array.from({ length: 7 }, (_, i) => `- [ ] T${i + 1}: Task number ${i + 1} {model: haiku}`).join('\n')
          const { spawned, ended: done } = project(on, `# Plan: Demo\n## Phase 1\n${items}`)
          on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
          await $.command.run({ command: 'conductor', args: 'run' } as never)
          await clock.advance(100)
          for (let i = 1; i <= 7; i++) {
            done.add(`ag-${i}`)
            await $.turn.complete({ turnId: `t${i}`, agentId: `ag-${i}`, answer: 'STATUS: done\nDone.\n<knowledge>none</knowledge>', reason: 'answer', durationMs: 1, isAborted: false })
            await clock.advance(100)
          }
          expect(spawned.length).toBe(7)
          for (const surface of ['terminal', 'desktop'] as const) {
            const pane = await agentsPane($, surface)
            const keys = keysOf(await pane.drawn())
            expect(keys.filter(k => k.startsWith('tg-ag-')).length).toBe(5)
            expect(keys.length).toBeGreaterThan(0)
            expect(new Set(keys).size).toBe(keys.length)
            await pane.unmount()
          }
        })
      })

      test('a run with only held tasks does not finish', OPTIONS, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        mock.store(on)
        const said = toasts(on)
        spentToday(on, 1.5)
        const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the big parser {model: sonnet}')
        await $.command.run({ command: 'conductor', args: 'budget 2' } as never)
        await $.command.run({ command: 'conductor', args: 'run' } as never)
        await clock.advance(100)
        expect(spawned).toEqual([])
        expect(said.some(t => /waits for usage/.test(t))).toBe(true)
        expect(said.some(t => /plan run finished/i.test(t))).toBe(false)
      })
    })

    test('the Questions pane still draws questions in the old format', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}')
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      expect(spawned.length).toBe(2)
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: 'STATUS: blocked\nNEEDS: Which flag parser should the CLI use?\nOPTIONS: yargs | commander', reason: 'answer', durationMs: 1, isAborted: false })
      await $.turn.complete({
        turnId: 't2',
        agentId: 'ag-2',
        answer: 'STATUS: done\nPrinter written.\n<questions>\n- Should dates be ISO or local format? → ISO 8601\n</questions>\n<knowledge>none</knowledge>',
        reason: 'answer',
        durationMs: 1,
        isAborted: false,
      })
      await clock.advance(100)
      for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
        const ui = await questionsPane($, surface)
        expect(await ui.find({ type: 'Button', key: 'qo-q-ag-1-1', text: 'commander' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Why it matters/ })).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: /went on assuming: ISO 8601/ })).toBeDefined()
        expect(await ui.find({ type: 'Button', key: 'lk-l-ag-2-0' })).toBeDefined()
        const keys = keysOf(await ui.drawn())
        expect(keys.length).toBeGreaterThan(0)
        expect(new Set(keys).size).toBe(keys.length)
        await ui.unmount()
      }
    })

    test('/conductor questions opens the Questions pane', OPTIONS, async ($, on) => {
      mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      on('session.root', () => ({ value: '/proj' }))
      memFs(on, {})
      const r = await $.command.run({ command: 'conductor', args: 'questions' } as never)
      expect(JSON.stringify(r)).toMatch(/Questions pane (opened|is waiting)/)
    })

    const SHOW = { options: { showPane: true, classifier: false, sound: false } }
    const BAR = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} }
    /** Stands in for the surface's pane placing: records opens, lists what is open, placed everywhere. */
    function fakePanes(on: On) {
      const open: string[] = []
      const opened: string[] = []
      on('ui.open', (_, e) => {
        opened.push(e.id)
        if (!open.includes(e.id)) open.push(e.id)
        return { value: { isPlaced: true as const } } as never
      })
      on('ui.panes', () => ({ value: open.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as never)
      return { open, opened }
    }

    test('the Agents pane keeps no question sections: one line with the counts and a button that opens the Questions pane', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { opened } = fakePanes(on)
      const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}')
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      expect(spawned.length).toBe(2)
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: `STATUS: blocked\n${URGENT_EXAMPLE}`, reason: 'answer', durationMs: 1, isAborted: false })
      await $.turn.complete({ turnId: 't2', agentId: 'ag-2', answer: `STATUS: done\nPrinter written.\n<questions>\n${LATER_EXAMPLE}\n</questions>\n<knowledge>none</knowledge>`, reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(100)

      for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
        const ui = await $.ui.mount({ plugin: 'conductor', surface, component: 'Pane', requestId: 'conductor-agents', props: PANE })
        expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeUndefined()
        expect(await ui.find({ type: 'Button', text: /For later/ })).toBeUndefined()
        expect(await ui.find({ type: 'Button', text: 'let AI decide' })).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: 'Questions: 1 need you · 2 for later' })).toBeDefined()
        expect(await ui.find({ type: 'Button', key: 'open-questions' })).toBeDefined()
        const keys = keysOf(await ui.drawn())
        expect(keys.length).toBeGreaterThan(0)
        expect(new Set(keys).size).toBe(keys.length)
        opened.length = 0
        await ui.press({ key: 'open-questions' })
        await clock.advance(100)
        expect(opened).toEqual(['conductor-questions'])
        await ui.unmount()
      }
    })

    test('the project bar shows one questions chip, also when only a later question exists, and it opens the Questions pane', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { opened } = fakePanes(on)
      on('turn.complete', (_, e) => ({ text: e.answer }))
      on('ui.render', (engine, e) => engine.ui.resolve(e).Box({}))
      on('session.root', () => ({ value: '/proj' }))
      on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'agent-1' }))
      await $.agent.spawn({ ...SPAWN, tool_use_id: 't1', subagentType: 'conductor:builder', description: 'Add export', prompt: 'Implement the export\nPlan item: none' })
      await $.turn.complete({
        turnId: 't1',
        agentId: 'agent-1',
        answer: 'STATUS: done\nExport added.\n<questions>\n- Should dates be ISO or local format? → ISO 8601\n</questions>\n<knowledge>none</knowledge>',
        reason: 'answer',
        durationMs: 1,
        isAborted: false,
      })
      await clock.advance(100)
      for (const surface of ['terminal', 'desktop'] as const) {
        const band = await $.ui.mount({ plugin: 'conductor', surface, component: 'AbovePrompt', props: BAR })
        expect(await band.find({ type: 'Button', key: 'questions-chip', text: '1 for later' })).toBeDefined()
        expect(await band.find({ type: 'Text', text: /need you/ })).toBeUndefined()
        opened.length = 0
        await band.press({ key: 'questions-chip' })
        await clock.advance(100)
        expect(opened).toEqual(['conductor-questions'])
        await band.unmount()
      }
    })

    test('a new urgent question opens the Questions pane (not the Agents pane) unasked, once, and not again after the person closed it', SHOW, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { open, opened } = fakePanes(on)
      let closedByPerson = false
      on('state.get', async (_, e, next) => {
        const r = await next(e)
        if (!closedByPerson || e.key !== 'questionsPane' || !r.value) return r
        return { value: { ...r.value, value: { ...((r.value.value ?? { waiting: null }) as object), isClosedByPerson: true } } }
      })
      const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Write the parser {model: haiku}\n- [ ] T2: Write the printer {model: haiku}\n- [ ] T3: Write the tests {model: haiku}\n- [ ] T4: Write the logger {model: haiku}')
      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      expect(spawned.length).toBe(4)
      opened.length = 0
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: `STATUS: blocked\n${URGENT_EXAMPLE}`, reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(100)
      expect(opened).toContain('conductor-questions')
      expect(opened).not.toContain('conductor-agents')
      // Already open: a second urgent question does not ask again.
      opened.length = 0
      await $.turn.complete({ turnId: 't2', agentId: 'ag-2', answer: 'STATUS: blocked\nNEEDS: Which flag parser should the CLI use?\nOPTIONS: yargs | commander', reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(100)
      expect(opened).not.toContain('conductor-questions')
      // Closed, but not by the person: the next urgent question opens it again.
      open.splice(open.indexOf('conductor-questions'), 1)
      opened.length = 0
      await $.turn.complete({ turnId: 't3', agentId: 'ag-3', answer: 'STATUS: blocked\nNEEDS: Which test runner should the tests use?\nOPTIONS: vitest | jest', reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(100)
      expect(opened).toContain('conductor-questions')
      // Closed by the person: the next urgent question leaves it closed. The test kit cannot raise a
      // ui.close with origin person, so the pane's stored state reads as the ui.close hook leaves it.
      open.splice(open.indexOf('conductor-questions'), 1)
      closedByPerson = true
      opened.length = 0
      await $.turn.complete({ turnId: 't4', agentId: 'ag-4', answer: 'STATUS: blocked\nNEEDS: Which logger should the CLI use?\nOPTIONS: pino | winston', reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(100)
      expect(opened).not.toContain('conductor-questions')
      expect(opened).not.toContain('conductor-agents')
      // Asked, it opens again.
      closedByPerson = false
      await $.command.run({ command: 'conductor', args: 'questions' } as never)
      await clock.advance(100)
      expect(opened).toContain('conductor-questions')
    })

    test('a task ticked done while its agent ran stays done: a late report neither retries nor reopens it',OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { files, spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: First {model: sonnet}')

      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      expect(spawned.length).toBe(1)
      files['/proj/.knowledge/plan.md'] = files['/proj/.knowledge/plan.md']!.replace('- [~] T1', '- [x] T1')
      await $.turn.complete({ turnId: 't1', agentId: 'ag-1', answer: 'STATUS: blocked\nRan out of room.', reason: 'answer', durationMs: 1, isAborted: false })
      await clock.advance(500)
      expect(spawned.length).toBe(1)
      expect(files['/proj/.knowledge/plan.md']).toContain('- [x] T1')
    })

    test('a task for the person or the main agent is never dispatched', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      const { files, spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: Approve the look {agent: main}\n- [ ] T2: Build the rig {model: haiku}')

      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      expect(spawned.length).toBe(1)
      expect(spawned[0]).toContain('T2')
      expect(files['/proj/.knowledge/plan.md']).toContain('- [ ] T1')
    })

    test('run_plan with no tasks widens a run limited to some tasks to the whole plan', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      on('turn.start', (_, e) => ({ turnId: e.turnId }))
      const { spawned } = project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: First {model: haiku}\n- [ ] T2: Second {model: haiku}')
      const turn = async (turnId: string, call: () => Promise<unknown>) => {
        await $.turn.start({ text: 'go', turnId })
        const r = await call()
        await $.turn.complete({ turnId, answer: 'Started.', reason: 'answer', durationMs: 1, isAborted: false })
        await clock.advance(100)
        return String((r as { result?: unknown }).result)
      }

      await $.command.run({ command: 'conductor', args: 'approve' } as never)
      await turn('m1', () => $.tool.call({ tool: 'mcp__conductor__run_plan', tasks: ['T1'] } as never))
      expect(spawned.map(d => d.slice(0, 2))).toEqual(['T1'])
      expect(await turn('m2', () => $.tool.call({ tool: 'mcp__conductor__run_plan' } as never))).toContain('the whole plan')
      expect(spawned.map(d => d.slice(0, 2))).toEqual(['T1', 'T2'])
    })

    test('the pane draws when the engine gives no width', OPTIONS, async ($, on) => {
      const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
      mock.store(on)
      project(on, '# Plan: Demo\n## Phase 1\n- [ ] T1: First {model: haiku}')

      await $.command.run({ command: 'conductor', args: 'run' } as never)
      await clock.advance(100)
      const ui = await $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'Pane', requestId: 'conductor-agents', props: { ...PANE, bodyColumns: undefined } as never })
      expect(await ui.find({ type: 'Text', text: /could not draw/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /Running \(1\)/ })).toBeDefined()
      await ui.unmount()
    })
  })

  test('an agent report with colour codes or control characters still draws, on every surface', OPTIONS, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on)
    on('session.root', () => ({ value: '/proj' }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'agent-1' }))
    await $.agent.spawn({ ...SPAWN, tool_use_id: 't1', subagentType: 'conductor:builder', description: 'Run the tests', prompt: 'Run them\nPlan item: none' })
    const answer = 'STATUS: done\r\nOutput: \u001b[32mPASS\u001b[0m 12 tests \u0007\u0008 \u0000end'
    await $.turn.complete({ turnId: 'x', agentId: 'agent-1', answer, reason: 'answer', durationMs: 1, isAborted: false })

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ plugin: 'conductor', surface, component: 'Pane', requestId: 'conductor-agents', props: PANE })
      // Rows stay open across surfaces: open it once.
      if (surface === 'terminal') await pane.press({ key: 'tg-agent-1' })
      expect(await pane.find({ type: 'Text', text: /PASS 12 tests/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /could not draw/ })).toBeUndefined()
      await pane.unmount()
    }
  })

  test('/conductor diag records how the pane drew, per surface, with the mod state', OPTIONS, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on)
    on('session.root', () => ({ value: '/proj' }))
    const files: Record<string, string> = { '/proj/.knowledge/INDEX.md': '# Knowledge index\n' }
    memFs(on, files)
    on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'agent-1' }))
    await $.agent.spawn({ ...SPAWN, tool_use_id: 't1', subagentType: 'conductor:builder', description: 'Add invoice export', prompt: 'Implement\nPlan item: none' })
    const pane = await $.ui.mount({ plugin: 'conductor', surface: 'desktop', component: 'Pane', requestId: 'conductor-agents', props: PANE })
    await pane.unmount()

    const reply = await $.command.run({ command: 'conductor', args: 'diag' } as never)
    expect(JSON.stringify(reply)).toContain('pane-diag.json')
    const diag = JSON.parse(files['/proj/.knowledge/session/pane-diag.json']!)
    expect(diag.draws.desktop.finished).toBeGreaterThan(0)
    expect(diag.draws.desktop.isDrawing).toBe(false)
    expect(JSON.stringify(diag.draws.desktop.tree)).toContain('Add invoice export')
    expect(diag.state.agents[0].description).toBe('Add invoice export')
  })

  test('the main agent may edit the knowledge base, not project files', OPTIONS, async ($, on) => {
    on('session.root', () => ({ value: '/proj' }))
    on('session.cwd', () => ({ value: '/proj' }))
    const ran: string[] = []
    on('tool.call', (_, e) => {
      ran.push(`${e.agentId ?? 'main'}:${String((e as unknown as { file_path: string }).file_path)}`)
      return { result: 'ok' }
    })
    const main = await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/.knowledge/decisions.md', old_string: 'a', new_string: 'b' })
    expect(main.deny).toContain('conductor:builder')
    expect(ran).toEqual(['main:/proj/.knowledge/decisions.md'])
  })

  test('a plan run: approval, dispatch by tags, briefs, escalation, and a question answered from the pane', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 12) })
    const spawned: Array<{ type: string; model: string | undefined; prompt: string; description: string }> = []
    mock.store(on)
    on('session.root', () => ({ value: '/proj' }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    // A plugin's spawn ends in the Agent tool, which answers the new agent's id.
    on('tool.call', (_, e) => (String(e.tool) === 'Agent' ? { result: { agentId: `ag-${spawned.length}` } } : { result: 'ok' }))
    const files: Record<string, string> = {
      '/proj/.knowledge/INDEX.md': '# Knowledge index\n',
      '/proj/.knowledge/decisions.md': '# Decisions\n',
      '/proj/.knowledge/plan.md': [
        '# Plan: Demo',
        '## Phase 1: Build',
        '- [ ] T1: Write the parser {agent: builder, model: haiku}',
        '- [ ] T2: Write the CLI {model: sonnet, after: T1}',
      ].join('\n'),
    }
    memFs(on, files)
    on('agent.spawn', (_, e) => {
      spawned.push({ type: e.subagentType, model: e.model, prompt: e.prompt, description: e.description })
      return { model: e.model ?? 'sonnet', agentId: `ag-${spawned.length}` }
    })
    // The test kit answers a plugin's own spawn without an id; the mod then finds the agent by its description.
    on('agent.list', () => ({ value: spawned.map((x, i) => ({ id: `ag-${i + 1}`, description: x.description, type: x.type, status: 'running' })) }))
    const finish = (agentId: string, answer: string) =>
      $.turn.complete({ turnId: `turn-${agentId}`, agentId, answer, reason: 'answer', durationMs: 1, isAborted: false })

    // The main agent asks for a run; it waits for the person's approval.
    const asked = await $.tool.call({ tool: 'mcp__conductor__run_plan' } as never)
    expect(String((asked as { result?: unknown }).result)).toContain('approve')
    await clock.advance(100)
    expect(spawned.length).toBe(0)

    // The pane shows the plan for review, and its tasks' agent and model pickers.
    for (const surface of ['terminal', 'desktop'] as const) {
      const review = await $.ui.mount({ plugin: 'conductor', surface, component: 'Pane', requestId: 'conductor-agents', props: PANE })
      expect(await review.find({ type: 'Button', text: 'approve & run' })).toBeDefined()
      await review.press({ key: 'edit' })
      expect(await review.find({ type: 'Select', key: 'sm-T2' })).toBeDefined()
      await review.press({ key: 'edit' })
      await review.unmount()
    }

    // Approved: T1 starts on the model its tag names, with a brief; T2 waits for it.
    await $.command.run({ command: 'conductor', args: 'approve' } as never)
    await clock.advance(100)
    // (The test kit drops agent types no session.start registered, so the type is not checked here.)
    expect(spawned.map(s => s.model)).toEqual(['haiku'])
    expect(spawned[0]!.prompt).toContain('Plan item: T1')
    expect(spawned[0]!.prompt).toContain('.knowledge/tasks/T1.md')
    expect(files['/proj/.knowledge/plan.md']).toContain('- [~] T1')
    expect(files['/proj/.knowledge/tasks/T1.md']).toContain('# T1: Write the parser')

    // T1 finishes: ticked, its decision filed, and T2 starts with T1's result in its brief.
    await finish('ag-1', 'STATUS: done\nParser written in src/parse.ts.\n<decisions>\n- Hand-rolled the tokenizer\n</decisions>\n<knowledge>none</knowledge>')
    await clock.advance(500)
    expect(files['/proj/.knowledge/plan.md']).toContain('- [x] T1')
    expect(files['/proj/.knowledge/decisions.md']).toContain('Hand-rolled the tokenizer')
    expect(spawned.map(s => s.model)).toEqual(['haiku', 'sonnet'])
    expect(files['/proj/.knowledge/tasks/T2.md']).toContain('Parser written in src/parse.ts.')

    // T2 falls short on Sonnet: retried on Opus, told what went wrong.
    await finish('ag-2', 'STATUS: blocked\nThe tests for flags fail.')
    await clock.advance(500)
    expect(spawned.map(s => s.model)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(files['/proj/.knowledge/tasks/T2.md']).toContain('What went wrong last time')

    // The retry needs the person: a question in the pane, answered with one of its options.
    await finish('ag-3', 'STATUS: blocked\nNEEDS: Which flag parser should the CLI use?\nOPTIONS: yargs | commander')
    await clock.advance(500)
    expect(files['/proj/.knowledge/plan.md']).toContain('- [!] T2')
    const onDesktop = await $.ui.mount({ plugin: 'conductor', surface: 'desktop', component: 'Pane', requestId: 'conductor-questions', props: PANE })
    expect(await onDesktop.find({ type: 'Button', text: 'let AI decide' })).toBeDefined()
    await onDesktop.unmount()
    const pane = await $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'Pane', requestId: 'conductor-questions', props: PANE })
    expect(await pane.find({ type: 'Text', text: /Needs you \(1\)/ })).toBeDefined()
    await pane.press({ key: 'qo-q-ag-3-0' })
    await clock.advance(500)
    await pane.unmount()
    expect(files['/proj/.knowledge/tasks/T2.md']).toContain('A: yargs')
    expect(files['/proj/.knowledge/decisions.md']).toContain('Which flag parser should the CLI use? → yargs')
    expect(spawned.length).toBe(4)
    expect(spawned[3]!.prompt).toContain('Plan item: T2')
  })

  test('a large tool output in the main conversation is saved to a file and cut to a pointer', OPTIONS, async ($, on) => {
    on('session.root', () => ({ value: '/proj' }))
    const files: Record<string, string> = {}
    memFs(on, files)
    const big = `${'line of build output\n'.repeat(2000)}FINAL: 3 tests failed`
    const kept = await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: big }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: 'u1',
    } as never)
    const spilled = Object.keys(files).find(f => f.includes('/.knowledge/session/spill/'))
    expect(spilled).toBeDefined()
    expect(files[spilled!]).toBe(big)
    const text = JSON.stringify((kept as { message?: unknown }).message)
    expect(text).toContain('FINAL: 3 tests failed')
    expect(text.length).toBeLessThan(5000)
  })
})

describe('prompts', () => {
  const count = (text: string, part: string) => text.split(part).length - 1
  const item = { id: 'T1', text: 'Do it', agent: null, model: null, effort: null, after: [], files: [], verify: null } as never

  test('the protocol examples parse into structured questions', () => {
    const p = protocol('/p')
    expect(p).toContain(URGENT_EXAMPLE)
    expect(p).toContain(LATER_EXAMPLE)
    const n = extractNeeds(`STATUS: blocked\n${URGENT_EXAMPLE}`)
    expect(n?.question).toBe('Should the report show prices with tax included?')
    expect(n?.why).not.toBe('')
    expect(n?.choices).toHaveLength(2)
    expect(n?.choices.map(c => c.isRecommended)).toEqual([true, false])
    expect(n?.choices.every(c => c.detail !== '')).toBe(true)
    const l = extractQuestions(`<questions>\n${LATER_EXAMPLE}\n</questions>`)
    expect(l).toHaveLength(2)
    for (const q of l) {
      expect(q.why).not.toBe('')
      expect(q.choices).toHaveLength(2)
      expect(q.choices.filter(c => c.isRecommended)).toHaveLength(1)
      expect(q.chosen).toBe(0)
    }
  })

  test('the plain-language rule reaches every prompt that asks, once', () => {
    expect(count(protocol('/p'), PLAIN)).toBe(1)
    for (const level of AUTONOMY_LEVELS) expect(count(policyLine(level), PLAIN)).toBe(1)
    expect(count(runTaskPrompt(item, 'b.md', 1, policyLine('ask-important')), PLAIN)).toBe(1)
    expect(architectPrompt('/p')).toMatch(/plain language/)
    expect(verifierPrompt('/p')).toMatch(/plain words/)
  })
})

describe('usage check', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
  const now = at(17, 13)
  const room = (over: Record<string, unknown> = {}) => ({ budgetUsd: 0, usedUsd: 0, reservedUsd: 0, windows: [], ratio: {}, now, ...over })

  test('recordCost keeps the last 8 per key and writes both keys', () => {
    let h = {}
    for (let i = 1; i <= 10; i++) h = recordCost(h, 'build', 'builder:x', 'sonnet', i)
    expect((h as Record<string, number[]>)['build|sonnet']).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    expect((h as Record<string, number[]>)['builder:x|sonnet']).toHaveLength(8)
    expect(Object.keys(recordCost({}, 'a', 'a', 'haiku', 1))).toEqual(['a|haiku'])
  })

  test('recordCost ignores bad costs and does not mutate', () => {
    const h = { 'k|sonnet': [1] }
    expect(recordCost(h, 'k', 'a', 'sonnet', 0)).toBe(h)
    expect(recordCost(h, 'k', 'a', 'sonnet', -2)).toBe(h)
    expect(recordCost(h, 'k', 'a', 'sonnet', NaN)).toBe(h)
    const next = recordCost(h, 'k', 'a', 'sonnet', 2)
    expect(h).toEqual({ 'k|sonnet': [1] })
    expect(next['k|sonnet']).toEqual([1, 2])
  })

  test('estimateCost uses kind, then agent, then the default', () => {
    expect(estimateCost({ 'k|sonnet': [1, 2] }, 'k', 'a', 'sonnet')).toEqual({ usd: 1.88, basis: 'kind', samples: 2 })
    const byAgent = estimateCost({ 'builder:x|sonnet': [1, 1] }, 'k', 'builder:x', 'sonnet')
    expect(byAgent.basis).toBe('agent')
    expect(byAgent.usd).toBe(1.25)
    expect(estimateCost({}, 'k', 'a', 'opus')).toEqual({ usd: DEFAULT_TASK_USD.opus, basis: 'default', samples: 0 })
    expect(estimateCost({ 'k|sonnet': [9] }, 'k', 'a', 'sonnet').basis).toBe('default')
  })

  test('learnRatio accumulates, skips resets, halves past $50, ignores null prev', () => {
    const r1 = learnRatio({}, { usd: 1, pct: { five_hour: 10 } }, { usd: 3, pct: { five_hour: 30 } })
    expect(r1.five_hour).toEqual({ usd: 2, pts: 20 })
    const r2 = learnRatio(r1, { usd: 3, pct: { five_hour: 30 } }, { usd: 5, pct: { five_hour: 2 } })
    expect(r2).toEqual(r1)
    const r3 = learnRatio({ five_hour: { usd: 49, pts: 100 } }, { usd: 0, pct: { five_hour: 0 } }, { usd: 3, pct: { five_hour: 6 } })
    expect(r3.five_hour).toEqual({ usd: 26, pts: 53 })
    const base = { five_hour: { usd: 1, pts: 1 } }
    expect(learnRatio(base, null, { usd: 5, pct: { five_hour: 9 } })).toBe(base)
  })

  test('pointsPerUsd needs a dollar of spend', () => {
    expect(pointsPerUsd({ w: { usd: 0.9, pts: 9 } }, 'w')).toBeNull()
    expect(pointsPerUsd({}, 'w')).toBeNull()
    expect(pointsPerUsd({ w: { usd: 2, pts: 20 } }, 'w')).toBe(10)
  })

  test('whenText speaks plainly', () => {
    expect(whenText(at(17, 14, 30), now)).toBe('at 14:30')
    expect(whenText(at(18, 9), now)).toBe('tomorrow at 09:00')
    expect(whenText(nextMidnight(now), now)).toBe('tomorrow')
    expect(whenText(at(24, 9), now)).toBe('on Sat 24 Oct at 09:00')
  })

  test('windowName', () => {
    expect(windowName('five_hour')).toBe('5-hour usage limit')
    expect(windowName('seven_day')).toBe('weekly usage limit')
    expect(windowName('seven_day_opus')).toBe('weekly Opus limit')
    expect(windowName('seven_day_sonnet')).toBe('weekly Sonnet limit')
    expect(windowName('spend_limit')).toBe('spending limit')
    expect(windowName('some_new_one')).toBe('some new one limit')
  })

  test('checkRoom fits with no budget and no windows', () => {
    expect(checkRoom(5, room())).toEqual({ fits: true })
  })

  test('checkRoom holds on the daily budget', () => {
    const f = checkRoom(3, room({ budgetUsd: 10, usedUsd: 8 }))
    expect(f).toMatchObject({ fits: false, short: 'daily budget', retryAt: nextMidnight(now) })
    if (!f.fits) {
      expect(f.reason).toContain('$3.00')
      expect(f.reason).toContain('$2.00')
      expect(f.reason).toContain('$10')
      expect(f.reason).toContain('tomorrow')
    }
    const big = checkRoom(12, room({ budgetUsd: 10 }))
    expect(big).toMatchObject({ fits: false, short: 'more than the daily budget', retryAt: null })
    expect(checkRoom(3, room({ budgetUsd: 10, usedUsd: 5, reservedUsd: 3 })).fits).toBe(false)
    expect(checkRoom(3, room({ budgetUsd: 10, usedUsd: 5, reservedUsd: 2 })).fits).toBe(true)
  })

  test('checkRoom holds on a nearly full window without a ratio', () => {
    const resetsAt = new Date(at(17, 16)).toISOString()
    const f = checkRoom(1, room({ windows: [{ kind: 'five_hour', percentUsed: 96, resetsAt }] }))
    expect(f).toMatchObject({ fits: false, short: '5-hour usage limit', retryAt: at(17, 16) })
    if (!f.fits) expect(f.reason).toContain('at 16:00')
    expect(checkRoom(1, room({ windows: [{ kind: 'five_hour', percentUsed: 90, resetsAt }] })).fits).toBe(true)
  })

  test('checkRoom uses a learned ratio', () => {
    const ratio = { five_hour: { usd: 10, pts: 100 } }
    const windows = [{ kind: 'five_hour', percentUsed: 85 }]
    const f = checkRoom(2, room({ ratio, windows }))
    expect(f).toMatchObject({ fits: false, retryAt: null })
    if (!f.fits) expect(f.reason).toContain('about 20% more')
    expect(checkRoom(0.4, room({ ratio, windows })).fits).toBe(true)
  })

  test('checkRoom gives the latest retry time when several checks fail', () => {
    const resetsAt = new Date(at(17, 16)).toISOString()
    const f = checkRoom(3, room({ budgetUsd: 10, usedUsd: 9, windows: [{ kind: 'five_hour', percentUsed: 99, resetsAt }] }))
    expect(f).toMatchObject({ fits: false, short: 'daily budget', retryAt: nextMidnight(now) })
  })
})

import type { Elements, RenderSurface } from 'claude-code'

import type { ConductorAgentStatus, ConductorPlanItem, ConductorTaskState } from '../types'
import { SVG_FILL, SVG_HEIGHT, svgBar, textBar } from './bar'
import type { Mark, Tone } from './bar'

/** Drawing primitives the pane and the band share: bars, task rows, colours. */

export type Table = Elements[RenderSurface]

export type BarKind = keyof typeof SVG_FILL

export const DOT: Record<ConductorTaskState, string> = { done: '✓', doing: '◉', todo: '○', blocked: '✕' }
export const DOT_TONE: Record<ConductorTaskState, string | null> = { done: 'success', doing: 'claude', todo: null, blocked: 'error' }
export const STATUS_DOT: Record<ConductorAgentStatus, string> = { running: '●', done: '✓', failed: '✕', stopped: '■' }
export const STATUS_TONE: Record<ConductorAgentStatus, string> = {
  running: 'suggestion',
  done: 'success',
  failed: 'error',
  stopped: 'warning',
}
const TEXT_FILL: Record<BarKind, string | null> = {
  plan: 'success',
  agent: 'ide',
  estimate: 'ide',
  ok: 'success',
  warn: 'warning',
  full: 'error',
}

/** Terminal escape sequences: colours and cursor moves (CSI), titles and links (OSC), and the two-character ones. */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]?/g
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const HAS_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

/**
 * Text as the engine draws it: no escape sequences or control characters but tab and newline. One of those
 * anywhere (an agent's report quoting coloured test output, say) makes the engine refuse the whole drawing.
 */
export const cleanText = (s: string) => (HAS_CONTROL.test(s) ? s.replace(/\r\n?/g, '\n').replace(ESCAPES, '').replace(CONTROLS, '') : s)

/** The props that carry drawn text, by element type. */
const TEXT_PROPS = ['label', 'text', 'placeholder', 'value', 'title', 'alt', 'source'] as const

/** A drawing with every string in it cleaned (cleanText): its text children, labels and options. */
export function cleanTree<T>(node: T): T {
  if (typeof node === 'string') return cleanText(node) as T
  if (Array.isArray(node)) return node.map(cleanTree) as T
  if (!node || typeof node !== 'object') return node
  const el = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown }
  if (el.type === 'Svg' || el.type === 'Raster' || el.type === 'Image') return node
  let props = el.props
  if (props) {
    const next: Record<string, unknown> = { ...props }
    for (const k of TEXT_PROPS) if (typeof next[k] === 'string') next[k] = cleanText(next[k] as string)
    if (Array.isArray(next.options)) {
      next.options = next.options.map(o => (o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string' ? { ...o, label: cleanText((o as { label: string }).label) } : o))
    }
    if (next.children !== undefined) next.children = cleanTree(next.children)
    props = next
  }
  return { ...el, ...(props ? { props } : {}), ...(el.children !== undefined ? { children: cleanTree(el.children) } : {}) } as T
}

/**
 * A cleaned drawing (cleanTree's copy, changed in place) where no two elements share a key: a second one gets
 * `key~2`. The desktop app refuses a whole drawing with a repeated key; a press still reaches its own element.
 */
export function uniqueKeys<T>(tree: T): T {
  const seen = new Set<string>()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    const el = node as { key?: unknown; props?: Record<string, unknown>; children?: unknown }
    const key = typeof el.key === 'string' ? el.key : typeof el.props?.key === 'string' ? (el.props.key as string) : null
    if (key !== null) {
      let next = key
      for (let n = 2; seen.has(next); n++) next = `${key}~${n}`
      seen.add(next)
      if (next !== key) {
        if (typeof el.key === 'string') el.key = next
        if (el.props && typeof el.props.key === 'string') el.props.key = next
      }
    }
    walk(el.props?.children)
    walk(el.children)
  }
  walk(tree)
  return tree
}

/** Pixels per cell on the graphical surfaces, to size an SVG bar among text. */
const PX_PER_CELL = 7.2

/** Text colour props: a theme key (drawn in the person's light or dark theme), or dim. */
export const ink = (color: string | null) => (color ? { color } : { dimColor: true as const })

export const pctOf = (frac: number) => Math.round(Math.min(1, Math.max(0, frac)) * 100)

/** Blue while work is in progress, green once it is all done. */
export const progressKind = (frac: number): BarKind => (frac >= 1 ? 'plan' : 'agent')

/** A progress bar with checkpoint dots: SVG where the surface draws it, text in the terminal. */
export function drawBar(t: Table, surface: RenderSurface, kind: BarKind, frac: number, cells: number, marks: readonly Mark[], alt: string) {
  if (surface !== 'terminal' && 'Svg' in t) {
    const { Svg } = t as Elements['desktop']
    const width = Math.round(cells * PX_PER_CELL)

    return <Svg source={svgBar(frac, width, marks, SVG_FILL[kind])} alt={alt} width={width} height={SVG_HEIGHT} />
  }
  const { Text } = t
  const fill = surface === 'terminal' ? TEXT_FILL[kind] : SVG_FILL[kind]
  const inkOf = (tone: Tone) =>
    tone === 'fill' || tone === 'done' ? ink(fill) : tone === 'track' || tone === 'todo' ? ink(null) : ink(DOT_TONE[tone])

  return (
    <Text wrap="truncate-end">
      {textBar(frac, cells, marks).map(s => (
        <Text {...inkOf(s.tone)}>{s.text}</Text>
      ))}
    </Text>
  )
}

/** One task line: its state glyph, its text, and a note (who works on it). */
export function taskRow(t: Table, key: string, task: { text: string; state: ConductorTaskState }, indent: number, note = '') {
  const { Box, Text } = t

  return (
    <Box key={key} flexDirection="row" gap={1} paddingLeft={indent}>
      <Text {...ink(DOT_TONE[task.state])}>{DOT[task.state]}</Text>
      <Text {...(task.state === 'done' ? { dimColor: true as const } : {})} wrap="truncate-end">
        {task.text}
      </Text>
      {note !== '' && <Text color="claude">{note}</Text>}
    </Box>
  )
}

export const planItemText = (i: ConductorPlanItem) => (i.id ? `${i.id} ${i.text}` : i.text)

/** Surfaces that take typing and picking (the phone does not). */
export const hasInput = (t: Table): t is Elements['terminal'] | Elements['desktop'] | Elements['vscode'] => 'Input' in t && 'Select' in t

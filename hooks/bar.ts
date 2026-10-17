import type { ConductorTaskState } from '../types'

/**
 * Progress bars with checkpoint dots: a text bar for the terminal (and any
 * surface without SVG) and an SVG one for the desktop. A mark sits at the end
 * of its segment, filled once that segment is done.
 */

export type Mark = { at: number; state: ConductorTaskState }

export type Segment = { weight: number; state: ConductorTaskState }

/** One mark per segment, at its end, spaced by cumulative weight. */
export function marksOf(segments: readonly Segment[]): Mark[] {
  const total = segments.reduce((s, x) => s + Math.max(0, x.weight), 0)
  if (!total) return []
  let acc = 0

  return segments.map(s => {
    acc += Math.max(0, s.weight)
    return { at: acc / total, state: s.state }
  })
}

export type Tone = 'fill' | 'track' | ConductorTaskState

export type Span = { text: string; tone: Tone }

const DOT: Record<ConductorTaskState, string> = { done: '●', doing: '◉', todo: '○', blocked: '✕' }

/** The text bar as runs of one tone each, `width` cells across. */
export function textBar(frac: number, width: number, marks: readonly Mark[] = []): Span[] {
  const w = Math.max(4, Math.floor(width))
  const f = Math.min(1, Math.max(0, frac)) * w
  const full = Math.floor(f)
  const cells: Span[] = []
  for (let i = 0; i < w; i++) {
    cells.push(
      i < full
        ? { text: '━', tone: 'fill' }
        : i === full && f - full >= 0.5
          ? { text: '╸', tone: 'fill' }
          : { text: '─', tone: 'track' },
    )
  }

  // Dots need room: at most one every second cell, else the bar alone.
  if (marks.length > 0 && marks.length <= Math.floor(w / 2)) {
    const used = new Set<number>()
    for (const m of marks) {
      let pos = Math.min(w - 1, Math.max(0, Math.round(m.at * w) - 1))
      while (used.has(pos) && pos > 0) pos -= 1
      if (used.has(pos)) continue
      used.add(pos)
      cells[pos] = { text: DOT[m.state], tone: m.state }
    }
  }

  const spans: Span[] = []
  for (const c of cells) {
    const last = spans[spans.length - 1]
    if (last && last.tone === c.tone) last.text += c.text
    else spans.push({ ...c })
  }

  return spans
}

/** Fill colours for the SVG bar: mid tones that read on light and dark backgrounds. */
export const SVG_FILL = {
  plan: '#3FB950',
  agent: '#4C8DF6',
  estimate: '#8FB4F8',
  ok: '#3FB950',
  warn: '#D29922',
  full: '#E5534B',
} as const

const TRACK = 'rgba(140,140,140,0.28)'
const TODO_FILL = 'rgba(140,140,140,0.16)'
const TODO_STROKE = 'rgba(140,140,140,0.85)'
const DOING = '#D97757'
const BLOCKED = '#E5534B'

export const SVG_HEIGHT = 18

/** The SVG bar, `widthPx` wide: a rounded track, a gradient fill and a dot per mark. */
export function svgBar(frac: number, widthPx: number, marks: readonly Mark[], fill: string): string {
  const W = Math.max(40, Math.round(widthPx))
  const H = SVG_HEIGHT
  const R = 6
  const cy = H / 2
  const span = W - 2 * R
  const fw = Math.min(1, Math.max(0, frac)) * span
  const n = (v: number) => Number(v.toFixed(1))
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs><linearGradient id="f" x1="0" x2="1"><stop offset="0" stop-color="${fill}" stop-opacity="0.6"/><stop offset="1" stop-color="${fill}"/></linearGradient></defs>`,
    `<rect x="${R}" y="${cy - 3}" width="${span}" height="6" rx="3" fill="${TRACK}"/>`,
  ]
  if (fw > 0.5) out.push(`<rect x="${R}" y="${cy - 3}" width="${n(Math.max(6, fw))}" height="6" rx="3" fill="url(#f)"/>`)

  if (marks.length > 0 && marks.length <= Math.floor(span / 12)) {
    for (const m of marks) {
      const cx = n(R + Math.min(1, Math.max(0, m.at)) * span)
      if (m.state === 'done') {
        out.push(
          `<circle cx="${cx}" cy="${cy}" r="5.5" fill="${fill}"/>`,
          `<path d="M${n(cx - 2.5)} ${n(cy + 0.1)} l1.8 1.8 l3.3 -3.6" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
        )
      } else if (m.state === 'doing') {
        out.push(
          `<circle cx="${cx}" cy="${cy}" r="5.5" fill="${DOING}" fill-opacity="0.2" stroke="${DOING}" stroke-width="1.5"/>`,
          `<circle cx="${cx}" cy="${cy}" r="2.2" fill="${DOING}"/>`,
        )
      } else if (m.state === 'blocked') {
        out.push(
          `<circle cx="${cx}" cy="${cy}" r="5.5" fill="${BLOCKED}"/>`,
          `<path d="M${n(cx - 2.2)} ${n(cy - 2.2)} l4.4 4.4 M${n(cx + 2.2)} ${n(cy - 2.2)} l-4.4 4.4" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>`,
        )
      } else {
        out.push(`<circle cx="${cx}" cy="${cy}" r="4.8" fill="${TODO_FILL}" stroke="${TODO_STROKE}" stroke-width="1.2"/>`)
      }
    }
  }
  out.push('</svg>')

  return out.join('')
}

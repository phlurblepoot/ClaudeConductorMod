/**
 * Spilling: a large tool output in the main conversation is saved to a file
 * and replaced by its head, its tail and a pointer, since every byte in the
 * main conversation is sent again on every later turn.
 */

export type ResultText = { text: string; hasMedia: boolean }

/** The text of a tool_result's content, and whether it carries an image or document. */
export function textOfResult(content: unknown): ResultText {
  if (typeof content === 'string') return { text: content, hasMedia: false }
  if (!Array.isArray(content)) return { text: '', hasMedia: false }
  let text = ''
  let hasMedia = false
  for (const c of content as Array<Record<string, unknown>>) {
    if (c?.type === 'text' && typeof c.text === 'string') text += c.text
    else hasMedia = true
  }

  return { text, hasMedia }
}

/** What the conversation keeps of a spilled output. */
export function spillNote(path: string, full: string, head = 1500, tail = 400): string {
  const lines = full.split('\n').length

  return [
    full.slice(0, head),
    '',
    `… [conductor: ${full.length} chars, ${lines} lines in all; the full output is saved to ${path}. Read it in ranges (Read with offset and limit), or have a conductor:scout pull out what you need.]`,
    '',
    `…${full.slice(-tail)}`,
  ].join('\n')
}

export const spillName = (tool: string, toolUseId: string) =>
  `${tool.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${toolUseId.replace(/[^a-z0-9_-]+/gi, '')}.txt`

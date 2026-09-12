import type { ReactNode } from 'react'

import { AuthoredText } from './AuthoredText'
import styles from './TutorProse.module.css'

/**
 * Rendering what the tutor wrote.
 *
 * Model output is untrusted input. The safest way to render untrusted text is not to sanitise
 * it but to never have a path that could execute it — so there is no `dangerouslySetInnerHTML`
 * here, no HTML parser, and no Markdown library. Every fragment below becomes a React text
 * child, which React escapes unconditionally. `<script>alert(1)</script>` arriving from the
 * model is displayed as those characters, because there is no code that could do anything
 * else with it.
 *
 * What is supported is the small set a tutor genuinely needs: paragraphs, fenced code blocks,
 * bullet and numbered lists, and inline code. Deliberately no links and no images — the two
 * constructs that carry a URL, which is the one piece of Markdown that can still do damage
 * when rendered "safely", and which an explanation of a `for` loop has no use for.
 *
 * Headings are not supported either. The session page has its own heading structure, and
 * letting model output inject headings into it would break the document outline that keyboard
 * and screen-reader navigation depends on. A tutor reply that wants a heading gets a
 * paragraph.
 */

export type ProseBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'code'; readonly language: string | null; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }

const FENCE = /^\s*```(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/

/**
 * Splits tutor text into blocks.
 *
 * Written to be total: every input produces some output, and no input produces an error. An
 * unclosed fence is the case worth naming — the text after it becomes a code block anyway,
 * because that is plainly what the model meant, and because the alternative is a half-rendered
 * reply while a stream is still arriving. Streaming means this function sees unclosed fences
 * constantly, as a matter of course rather than as a malformed edge case.
 */
export function parseTutorProse(source: string): readonly ProseBlock[] {
  const blocks: ProseBlock[] = []
  const lines = source.split('\n')

  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: { language: string | null; lines: string[] } | null = null

  const flushParagraph = (): void => {
    const text = paragraph.join(' ').trim()
    if (text.length > 0) blocks.push({ kind: 'paragraph', text })
    paragraph = []
  }
  const flushList = (): void => {
    if (list !== null && list.items.length > 0) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
    }
    list = null
  }
  const flushCode = (): void => {
    if (code !== null) {
      blocks.push({ kind: 'code', language: code.language, text: code.lines.join('\n') })
    }
    code = null
  }

  for (const line of lines) {
    const fence = FENCE.exec(line)

    if (code !== null) {
      if (fence !== null) flushCode()
      else code.lines.push(line)
      continue
    }

    if (fence !== null) {
      flushParagraph()
      flushList()
      const language = (fence[1] ?? '').trim()
      code = { language: language.length > 0 ? language : null, lines: [] }
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = bullet === null ? NUMBERED.exec(line) : null
    const item = bullet?.[1] ?? numbered?.[1]

    if (item !== undefined) {
      flushParagraph()
      const ordered = numbered !== null
      if (list === null || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push(item.trim())
      continue
    }

    if (line.trim().length === 0) {
      flushParagraph()
      flushList()
      continue
    }

    flushList()
    paragraph.push(line.trim())
  }

  // An unclosed fence still yields its code block; a stream mid-flight is nothing else.
  flushCode()
  flushParagraph()
  flushList()

  return blocks
}

export function TutorProse({ text }: { readonly text: string }): ReactNode {
  const blocks = parseTutorProse(text)

  return (
    <div className={styles.prose}>
      {blocks.map((block, index) => {
        // Blocks have no identity beyond their position in a body of text re-parsed whole.
        const key = index

        if (block.kind === 'code') {
          return (
            <pre className={styles.code} key={key}>
              <code>{block.text}</code>
            </pre>
          )
        }

        if (block.kind === 'list') {
          const items = block.items.map((item, position) => (
            <li key={position}>
              <AuthoredText value={item} />
            </li>
          ))
          return block.ordered ? (
            <ol className={styles.list} key={key}>
              {items}
            </ol>
          ) : (
            <ul className={styles.list} key={key}>
              {items}
            </ul>
          )
        }

        return (
          <p key={key}>
            <AuthoredText value={block.text} />
          </p>
        )
      })}
    </div>
  )
}

import type { ReactNode } from 'react'

import styles from './AuthoredText.module.css'

/**
 * Inline code inside authored prose.
 *
 * Questions and explanations are written by hand and constantly need to name a variable or an
 * operator — "what does `warm` hold", "`==` compares". Those names were being written with
 * backticks and then rendered literally, so the learner read the authoring syntax.
 *
 * This is the whole of the fix: a backtick pair on one line becomes a `<code>` element, and
 * nothing else is interpreted. There is no emphasis, no links, no lists, no escaping rules.
 * A Markdown renderer would bring a dependency, a sanitisation problem and a large surface of
 * syntax that nobody authoring this content wants, in exchange for one feature that is fifteen
 * lines.
 *
 * Safe by construction: every segment is rendered as a React text child, so the content is
 * escaped by React whatever it contains. Nothing here interprets HTML.
 */

export type AuthoredSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'code'; readonly value: string }

/**
 * A pair of backticks around at least one character, not spanning a line break.
 *
 * An unpaired backtick therefore stays exactly as it was typed rather than swallowing the rest
 * of the sentence — the failure mode that makes naive Markdown handling worse than none.
 */
const INLINE_CODE = /`([^`\n]+)`/g

export function parseAuthoredText(source: string): readonly AuthoredSegment[] {
  const segments: AuthoredSegment[] = []
  let index = 0

  for (const match of source.matchAll(INLINE_CODE)) {
    const start = match.index
    const code = match[1]
    if (code === undefined) continue

    if (start > index) segments.push({ kind: 'text', value: source.slice(index, start) })
    segments.push({ kind: 'code', value: code })
    index = start + match[0].length
  }

  if (index < source.length) segments.push({ kind: 'text', value: source.slice(index) })
  return segments
}

/** Renders one piece of authored prose. Nothing but inline code is interpreted. */
export function AuthoredText({ value }: { readonly value: string }): ReactNode {
  return parseAuthoredText(value).map((segment, position) =>
    segment.kind === 'code' ? (
      // Segments have no identity beyond their position in a string that is rendered whole.
      <code className={styles.code} key={position}>
        {segment.value}
      </code>
    ) : (
      segment.value
    ),
  )
}

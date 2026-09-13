'use client'

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  temporarilySetTabFocusMode,
} from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

/**
 * A Python editor for a short exercise, and deliberately nothing more.
 *
 * CodeMirror 6, with the smallest set of extensions that makes writing Python pleasant: syntax
 * colouring, four-space indentation that follows a colon, bracket matching, undo, and line
 * numbers (a traceback names lines, and a learner needs to find them). No autocompletion, no
 * lint markers, no minimap, no command palette — this is one file for a few lines of code, and
 * everything else is an IDE the brief ruled out.
 *
 * **The keyboard.** Tab indents, because in Python indentation is syntax and a Tab that left the
 * editor would make the language hard to type. That traps keyboard users unless there is a way
 * out, so Escape switches CodeMirror into tab-focus mode for the next key: Escape, then Tab, moves
 * on. Ctrl-M (Alt-Shift-M on macOS) toggles the same mode permanently — CodeMirror's own
 * binding. The help text beside the editor says so, because an escape hatch nobody knows about is
 * not one.
 *
 * **The look.** Colours are the application's own tokens, so the editor follows light and dark
 * themes and reads as part of the page rather than a dark IDE panel dropped into it.
 */

const theme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 'var(--radius-md)',
    fontSize: '0.9375rem',
  },
  '&.cm-focused': {
    outline: '2px solid var(--focus-ring)',
    outlineOffset: '2px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
    maxHeight: '24rem',
    overflow: 'auto',
  },
  // The minimum height goes on the content and the gutter together, not the scroller, so the
  // line-number column runs the full height of a short file instead of stopping at its last line.
  '.cm-content, .cm-gutter': {
    minHeight: '9rem',
  },
  '.cm-content': {
    padding: 'var(--space-3) 0',
    caretColor: 'var(--ink)',
  },
  '.cm-line': {
    padding: '0 var(--space-3)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--ground-sunken)',
    color: 'var(--ink-faint)',
    border: 'none',
    borderRight: '1px solid var(--rule)',
    borderTopLeftRadius: 'var(--radius-md)',
    borderBottomLeftRadius: 'var(--radius-md)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 var(--space-2) 0 var(--space-3)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-quiet)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--ink)',
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-quiet)',
    outline: '1px solid var(--rule-strong)',
  },
})

/** Restrained: a few roles, in colours the page already uses for other meanings. */
const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.operatorKeyword], color: 'var(--accent)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--positive)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--caution)' },
  { tag: [tags.comment, tags.lineComment], color: 'var(--ink-faint)', fontStyle: 'italic' },
  { tag: [tags.function(tags.definition(tags.variableName)), tags.definition(tags.className)], fontWeight: '600' },
])

interface Props {
  /** The code the editor opens with. Later changes to this prop are ignored; the editor owns it. */
  readonly initialCode: string
  readonly onChange: (code: string) => void
  readonly labelledBy: string
  readonly describedBy: string
  readonly readOnly?: boolean
  readonly testId: string
}

export function CodeEditor({ initialCode, onChange, labelledBy, describedBy, readOnly = false, testId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const readOnlyRef = useRef(new Compartment())
  // Kept current without recreating the editor, which would lose the cursor and the undo history.
  const onChangeRef = useRef(onChange)
  // What the editor is created with. Read once, on mount: the document is the editor's own after
  // that, and the attributes do not change for the life of an exercise.
  const creationRef = useRef({ initialCode, labelledBy, describedBy, testId, readOnly })

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const created = creationRef.current

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: created.initialCode,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          indentUnit.of('    '),
          EditorState.tabSize.of(4),
          python(),
          syntaxHighlighting(highlighting),
          keymap.of([
            // Before the default keymap, so Escape offers the way out rather than collapsing a
            // selection. See the component comment.
            { key: 'Escape', run: temporarilySetTabFocusMode },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          theme,
          readOnlyRef.current.of(EditorState.readOnly.of(created.readOnly)),
          EditorView.contentAttributes.of({
            'aria-labelledby': created.labelledBy,
            'aria-describedby': created.describedBy,
            'aria-multiline': 'true',
            'data-testid': created.testId,
            spellcheck: 'false',
            autocapitalize: 'off',
            autocorrect: 'off',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })

    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly])

  // min-width: 0 so a long line scrolls inside the editor instead of widening the page at 360px.
  return <div ref={hostRef} style={{ minWidth: 0 }} />
}

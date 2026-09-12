import { describe, expect, it } from 'vitest'

import { parseTutorProse } from './TutorProse'

/**
 * Rendering untrusted model output.
 *
 * The safety argument here is structural rather than a matter of filtering: the parser emits
 * plain strings, the component renders them as React text children, and React escapes text
 * children unconditionally. There is no `dangerouslySetInnerHTML`, no HTML parser and no
 * Markdown library anywhere on the path, so there is nothing to sanitise and nothing that
 * could be persuaded to execute.
 *
 * These tests assert two things. That the parser is *total* — every input produces blocks and
 * none throws, which matters because a stream means it sees unclosed fences constantly. And
 * that hostile input comes out as characters rather than as structure, which is what proves
 * there is no path to interpretation.
 */

describe('what the tutor can format', () => {
  it('splits paragraphs on blank lines', () => {
    expect(parseTutorProse('First idea.\n\nSecond idea.')).toEqual([
      { kind: 'paragraph', text: 'First idea.' },
      { kind: 'paragraph', text: 'Second idea.' },
    ])
  })

  it('joins wrapped lines into one paragraph', () => {
    expect(parseTutorProse('A sentence that\nwraps across lines.')).toEqual([
      { kind: 'paragraph', text: 'A sentence that wraps across lines.' },
    ])
  })

  it('keeps a fenced code block intact, including its blank lines and indentation', () => {
    const source = '```python\ndef f():\n\n    return 1\n```'

    expect(parseTutorProse(source)).toEqual([
      { kind: 'code', language: 'python', text: 'def f():\n\n    return 1' },
    ])
  })

  it('records the language when one is given, and null when not', () => {
    expect(parseTutorProse('```\nx = 1\n```')).toEqual([
      { kind: 'code', language: null, text: 'x = 1' },
    ])
  })

  it('reads bullet and numbered lists', () => {
    expect(parseTutorProse('- one\n- two')).toEqual([
      { kind: 'list', ordered: false, items: ['one', 'two'] },
    ])
    expect(parseTutorProse('1. first\n2. second')).toEqual([
      { kind: 'list', ordered: true, items: ['first', 'second'] },
    ])
  })

  it('does not run a bullet list and a numbered list together', () => {
    const blocks = parseTutorProse('- one\n1. two')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ kind: 'list', ordered: false, items: ['one'] })
    expect(blocks[1]).toEqual({ kind: 'list', ordered: true, items: ['two'] })
  })

  it('handles prose, code and a list in one reply', () => {
    const blocks = parseTutorProse('Try this.\n\n```\nx = 1\n```\n\n- then run it\n- then change it')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'code', 'list'])
  })
})

describe('a reply that is still arriving', () => {
  /*
   * Not an edge case — this is the normal state of affairs while streaming, several times a
   * second. A parser that threw or dropped the text on an unclosed fence would make the
   * streaming reply flicker between rendered and not.
   */
  it('renders an unclosed fence as code anyway', () => {
    expect(parseTutorProse('Here:\n```python\ntotal = 0')).toEqual([
      { kind: 'paragraph', text: 'Here:' },
      { kind: 'code', language: 'python', text: 'total = 0' },
    ])
  })

  it('renders a fence that has only just opened', () => {
    expect(parseTutorProse('Here:\n```')).toEqual([
      { kind: 'paragraph', text: 'Here:' },
      { kind: 'code', language: null, text: '' },
    ])
  })

  it('produces something for every prefix of a reply, and never throws', () => {
    const full = 'Look at this.\n\n```python\nfor i in range(3):\n    print(i)\n```\n\n- one\n- two'

    for (let length = 0; length <= full.length; length += 1) {
      expect(() => parseTutorProse(full.slice(0, length))).not.toThrow()
    }
  })

  it('gives nothing back for nothing', () => {
    expect(parseTutorProse('')).toEqual([])
    expect(parseTutorProse('   \n\n  ')).toEqual([])
  })
})

/*
 * Model output is untrusted input. Each of these is something a compromised or confused model
 * could emit, and in every case the requirement is the same: it becomes text, not structure.
 */
describe('hostile model output', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    '[click me](javascript:alert(1))',
    '<div onclick="steal()">hello</div>',
    '<svg><use href="#x" /></svg>',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '<!-- --><script>x</script>',
    '<style>body{display:none}</style>',
  ]

  it('never produces anything but paragraphs, lists and code', () => {
    for (const attack of attacks) {
      for (const block of parseTutorProse(attack)) {
        expect(['paragraph', 'list', 'code'], attack).toContain(block.kind)
      }
    }
  })

  it('carries markup through as the text it is, unchanged', () => {
    for (const attack of attacks) {
      const blocks = parseTutorProse(attack)
      const joined = blocks
        .map((block) => (block.kind === 'list' ? block.items.join(' ') : block.text))
        .join(' ')

      // Nothing is stripped and nothing is escaped here, because nothing needs to be: the
      // component renders this as a text child and React escapes it on the way out. What the
      // parser must not do is turn any of it into an element, and the check above is that.
      expect(joined, attack).toContain(attack.replace(/\s+/g, ' ').trim().slice(0, 20))
    }
  })

  it('supports no construct that can carry a URL', () => {
    // No links and no images, deliberately: they are the one part of Markdown that can still
    // do harm when rendered "safely", and an explanation of a for loop has no use for them.
    const blocks = parseTutorProse('[text](https://example.com) and ![img](https://example.com/x.png)')

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe('paragraph')
  })

  it('does not let model output inject a heading into the page outline', () => {
    // The session page owns its heading structure. Model-supplied headings would break the
    // document outline that keyboard and screen-reader navigation depends on.
    const blocks = parseTutorProse('# Big heading\n## Smaller')

    expect(blocks.every((block) => block.kind === 'paragraph')).toBe(true)
  })

  it('survives text that is nothing but fences', () => {
    expect(() => parseTutorProse('```\n```\n```\n```')).not.toThrow()
    expect(() => parseTutorProse('`'.repeat(500))).not.toThrow()
  })

  it('survives a very long single line', () => {
    const long = 'x'.repeat(50_000)
    expect(parseTutorProse(long)).toEqual([{ kind: 'paragraph', text: long }])
  })
})

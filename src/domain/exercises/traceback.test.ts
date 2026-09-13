import { describe, expect, it } from 'vitest'

import { learnerTraceback } from './traceback'

/**
 * Captured verbatim from the real interpreter (Pyodide 314.0.6, Python 3.14) by running the
 * programs shown in each test through the execution worker. Not hand-written: the point is that
 * the cleaner handles what the interpreter actually produces, carets and elisions included.
 */

const RUNTIME_ERROR = [
  'Traceback (most recent call last):',
  '  File "/lib/python314.zip/_pyodide/_base.py", line 597, in eval_code_async',
  '    await CodeRunner(',
  '    ...<9 lines>...',
  '    .run_async(globals, locals)',
  '  File "/lib/python314.zip/_pyodide/_base.py", line 411, in run_async',
  '    coroutine = eval(self.code, globals, locals)',
  '  File "main.py", line 5, in <module>',
  '    f([1, 2])',
  '    ~^^^^^^^^',
  '  File "main.py", line 2, in f',
  '    return items[5]',
  '           ~~~~~^^^',
  'IndexError: list index out of range',
  '',
].join('\n')

const SYNTAX_ERROR = [
  'Traceback (most recent call last):',
  '  File "/lib/python314.zip/_pyodide/_base.py", line 597, in eval_code_async',
  '    await CodeRunner(',
  '          ~~~~~~~~~~^',
  '        source,',
  '        ^^^^^^^',
  '    ...<5 lines>...',
  '        optimize=optimize,',
  '        ^^^^^^^^^^^^^^^^^^',
  '    )',
  '    ^',
  '  File "/lib/python314.zip/_pyodide/_base.py", line 285, in __init__',
  '    self.ast = next(self._gen)',
  '               ~~~~^^^^^^^^^^^',
  '  File "/lib/python314.zip/_pyodide/_base.py", line 149, in _parse_and_compile_gen',
  '    mod = compile(source, filename, mode, flags | ast.PyCF_ONLY_AST)',
  '  File "main.py", line 1',
  '    def f(:',
  '          ^',
  'SyntaxError: invalid syntax',
  '',
].join('\n')

describe('a traceback as the learner reads it', () => {
  it('keeps the learner’s own frames, in order, with their lines and carets', () => {
    expect(learnerTraceback(RUNTIME_ERROR)).toBe(
      [
        'Traceback (most recent call last):',
        '  File "main.py", line 5, in <module>',
        '    f([1, 2])',
        '    ~^^^^^^^^',
        '  File "main.py", line 2, in f',
        '    return items[5]',
        '           ~~~~~^^^',
        'IndexError: list index out of range',
      ].join('\n'),
    )
  })

  it('drops every frame from inside the interpreter', () => {
    const cleaned = learnerTraceback(SYNTAX_ERROR)

    expect(cleaned).not.toContain('_pyodide')
    expect(cleaned).not.toContain('CodeRunner')
    expect(cleaned).not.toContain('optimize=optimize')
  })

  it('keeps a syntax error’s pointer to the character', () => {
    expect(learnerTraceback(SYNTAX_ERROR)).toBe(
      [
        'Traceback (most recent call last):',
        '  File "main.py", line 1',
        '    def f(:',
        '          ^',
        'SyntaxError: invalid syntax',
      ].join('\n'),
    )
  })

  it('returns the whole thing when nothing the learner wrote appears in it', () => {
    const internal = [
      'Traceback (most recent call last):',
      '  File "/lib/python314.zip/_pyodide/_base.py", line 597, in eval_code_async',
      '    await CodeRunner(',
      'RuntimeError: something inside the interpreter',
    ].join('\n')

    expect(learnerTraceback(internal)).toBe(internal)
  })
})

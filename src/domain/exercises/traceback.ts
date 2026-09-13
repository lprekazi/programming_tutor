/**
 * A traceback as the learner should read it.
 *
 * Pyodide runs a program through its own machinery, so every traceback begins with frames from
 * inside Pyodide — `/lib/python314.zip/_pyodide/_base.py`, `eval_code_async`, `CodeRunner` —
 * before it reaches a line the learner wrote. Those frames are true and useless: a beginner reading
 * `coroutine = eval(self.code, globals, locals)` above their own mistake learns only that the error
 * is somewhere they cannot see.
 *
 * So the learner's frames are kept, with their source lines and carets, the exception line is kept,
 * and the interpreter's own frames are dropped. If nothing the learner wrote appears at all — an
 * error inside the machinery itself — the whole traceback is returned unchanged, because hiding
 * it would hide the only information there is.
 *
 * Written against tracebacks captured from the real interpreter (Pyodide 314.0.6, Python 3.14),
 * which `traceback.test.ts` uses verbatim.
 */

/** A frame header: `  File "main.py", line 5, in <module>`, or with no `in` for a syntax error. */
const FRAME = /^ {2}File "([^"]*)", line \d+/

/** The file name the worker runs learner code under. */
const LEARNER_FILE = 'main.py'

export function learnerTraceback(traceback: string): string {
  const lines = traceback.replace(/\r\n/g, '\n').trimEnd().split('\n')

  const kept: string[] = []
  let keepingFrame = true
  let sawLearnerFrame = false

  for (const line of lines) {
    const frame = FRAME.exec(line)
    if (frame !== null) {
      keepingFrame = frame[1] === LEARNER_FILE
      if (keepingFrame) sawLearnerFrame = true
      if (keepingFrame) kept.push(line)
      continue
    }

    // Indented lines belong to the frame above them: its source, its carets, its elisions.
    if (line.startsWith('    ')) {
      if (keepingFrame) kept.push(line)
      continue
    }

    // Anything else — the header, the exception line, a chained "During handling" note.
    keepingFrame = true
    kept.push(line)
  }

  return sawLearnerFrame ? kept.join('\n') : traceback.trimEnd()
}

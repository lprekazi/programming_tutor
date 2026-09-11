import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Enforces the boundary the domain layer depends on.
 *
 * `src/domain` holds the tutor's reasoning: the curriculum, the learner-model arithmetic,
 * evidence derivation and scheduling. It must have no I/O. That is not a stylistic
 * preference — it is what makes the arithmetic deterministically testable, and it is the
 * structural reason a language model cannot write learner state without going through
 * `deriveEvidence`.
 *
 * A convention nobody checks is a convention that erodes, so it is checked here.
 */

const DOMAIN_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Imports that would give the domain a dependency on the outside world. */
const FORBIDDEN_IMPORTS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /^@\/db\b|^\.\.\/db\b|\bdrizzle-orm\b|\bbetter-sqlite3\b/, why: 'database access' },
  { pattern: /^@\/llm\b|^\.\.\/llm\b|^openai$|^openai\//, why: 'model provider access' },
  { pattern: /^@\/tutor\b|^\.\.\/tutor\b/, why: 'prompt-layer access' },
  { pattern: /^@\/ui\b|^\.\.\/ui\b|^react$|^react\/|^react-dom/, why: 'user-interface code' },
  { pattern: /^next(\/|$)/, why: 'framework access' },
  { pattern: /^node:(fs|http|https|child_process|net|dns)\b/, why: 'direct system access' },
]

/** Non-determinism that would make the model's behaviour untestable. */
const FORBIDDEN_CALLS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bDate\.now\s*\(/, why: 'reads the clock; the current time must be passed in' },
  { pattern: /\bnew Date\s*\(\s*\)/, why: 'reads the clock; the current time must be passed in' },
  { pattern: /\bDate\.parse\s*\(/, why: 'parses a date; timestamps must be passed in as numbers' },
  { pattern: /\bperformance\.now\s*\(/, why: 'reads a clock' },
  { pattern: /\bMath\.random\s*\(/, why: 'is non-deterministic' },
  { pattern: /\bcrypto\./, why: 'is non-deterministic' },
  { pattern: /\bprocess\.env\b/, why: 'reads configuration; the domain must be told, not ask' },
  { pattern: /\bfetch\s*\(/, why: 'performs network I/O' },
]

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = []

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      found.push(...sourceFilesUnder(path))
      continue
    }
    if (extname(path) !== '.ts') continue
    if (path.endsWith('.test.ts')) continue
    found.push(path)
  }
  return found
}

/** Module specifiers imported by a file, from both static and dynamic imports. */
function importsOf(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) specifiers.push(specifier)
    }
  }
  return specifiers
}

describe('domain layer boundary', () => {
  const files = sourceFilesUnder(DOMAIN_ROOT)

  it('finds the domain sources it is meant to be checking', () => {
    // Guards against the check silently passing because it looked in the wrong place.
    expect(files.length).toBeGreaterThan(5)
  })

  it('imports nothing from the database, the model provider, the UI or the framework', () => {
    const violations: string[] = []

    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        const forbidden = FORBIDDEN_IMPORTS.find((rule) => rule.pattern.test(specifier))
        if (forbidden !== undefined) {
          violations.push(`${file} imports "${specifier}" (${forbidden.why})`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('never reads the clock or uses randomness', () => {
    // The current time is always a parameter, so a scheduling decision made "now" can be
    // reproduced exactly in a test.
    const violations: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const rule of FORBIDDEN_CALLS) {
        if (rule.pattern.test(source)) {
          violations.push(`${file} ${rule.why}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

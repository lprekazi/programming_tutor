import { describe, expect, it } from 'vitest'

import { topologicalOrderOf, validateCurriculum, validateCurriculumData } from './graph'
import type { Concept, ConceptId, Misconception } from './types'

/**
 * Tests for the validator itself, against deliberately broken curricula.
 *
 * The validator is the safety net under hand-authored data. A net that has never been
 * seen to catch anything is not known to work, so each failure it claims to detect is
 * provoked here on purpose.
 *
 * The fixtures cast through `as` because their whole point is to be invalid — the type
 * system would otherwise refuse to express the mistakes being guarded against.
 */

function concept(id: string, prerequisites: string[] = [], difficulty = 0): Concept {
  return {
    id: id as ConceptId,
    title: `Concept ${id}`,
    area: 'fundamentals',
    summary: 'A concept used only in tests.',
    prerequisites: prerequisites as ConceptId[],
    baselineDifficulty: difficulty,
  }
}

function misconception(id: string, relatedConcepts: string[]): Misconception {
  return {
    id: id as Misconception['id'],
    title: `Misconception ${id}`,
    belief: 'Something that is not true about the language.',
    reality: 'What is actually the case, stated plainly.',
    relatedConcepts: relatedConcepts as ConceptId[],
    source: { kind: 'unattributed' },
  }
}

/** A small valid curriculum: a -> b, with one misconception attached. */
const VALID_CONCEPTS = [concept('a'), concept('b', ['a'])]
const VALID_MISCONCEPTIONS = [misconception('m', ['a'])]

function kindsOf(concepts: readonly Concept[], misconceptions: readonly Misconception[]) {
  return validateCurriculumData(concepts, misconceptions).map((problem) => problem.kind)
}

describe('validator on a sound curriculum', () => {
  it('reports nothing', () => {
    expect(validateCurriculumData(VALID_CONCEPTS, VALID_MISCONCEPTIONS)).toEqual([])
  })

  it('accepts an empty curriculum without inventing problems', () => {
    expect(validateCurriculumData([], [])).toEqual([])
  })
})

describe('validator catches structural faults', () => {
  it('detects a duplicated concept id', () => {
    expect(kindsOf([concept('a'), concept('a'), concept('b', ['a'])], [])).toContain(
      'duplicate-concept',
    )
  })

  it('detects a prerequisite that does not exist', () => {
    const problems = validateCurriculumData([concept('a'), concept('b', ['a', 'ghost'])], [])
    expect(problems.map((problem) => problem.kind)).toContain('missing-prerequisite')
    expect(problems.find((problem) => problem.kind === 'missing-prerequisite')?.detail).toContain(
      'ghost',
    )
  })

  it('detects a concept that requires itself', () => {
    expect(kindsOf([concept('a'), concept('b', ['a', 'b'])], [])).toContain('self-prerequisite')
  })

  it('detects a two-concept cycle', () => {
    expect(kindsOf([concept('a', ['b']), concept('b', ['a'])], [])).toContain('cycle')
  })

  it('detects a longer cycle', () => {
    expect(
      kindsOf([concept('a', ['c']), concept('b', ['a']), concept('c', ['b'])], []),
    ).toContain('cycle')
  })

  it('detects a curriculum a learner could never start', () => {
    // Every concept requires another, so nothing is ever reachable.
    expect(kindsOf([concept('a', ['b']), concept('b', ['a'])], [])).toContain('no-entry-concept')
  })

  it('detects a concept disconnected from everything else', () => {
    const problems = validateCurriculumData([...VALID_CONCEPTS, concept('lonely')], [])
    expect(problems.map((problem) => problem.kind)).toContain('orphan-concept')
    expect(problems.find((problem) => problem.kind === 'orphan-concept')?.detail).toContain(
      'lonely',
    )
  })

  it('does not call a single-concept curriculum an orphan', () => {
    expect(kindsOf([concept('only')], [])).toEqual([])
  })
})

describe('validator catches misconception faults', () => {
  it('detects a duplicated misconception id', () => {
    expect(
      kindsOf(VALID_CONCEPTS, [misconception('m', ['a']), misconception('m', ['b'])]),
    ).toContain('duplicate-misconception')
  })

  it('detects a misconception linked to no concept, which could never be surfaced', () => {
    expect(kindsOf(VALID_CONCEPTS, [misconception('m', [])])).toContain('empty-related-concepts')
  })

  it('detects a misconception pointing at a concept that does not exist', () => {
    const problems = validateCurriculumData(VALID_CONCEPTS, [misconception('m', ['ghost'])])
    expect(problems.map((problem) => problem.kind)).toContain('unknown-related-concept')
    expect(problems.find((problem) => problem.kind === 'unknown-related-concept')?.detail).toContain(
      'ghost',
    )
  })
})

describe('validator reports every fault at once', () => {
  it('does not stop at the first problem', () => {
    const problems = validateCurriculumData(
      [concept('a'), concept('a'), concept('b', ['ghost'])],
      [misconception('m', [])],
    )
    const kinds = new Set(problems.map((problem) => problem.kind))

    expect(kinds.has('duplicate-concept')).toBe(true)
    expect(kinds.has('missing-prerequisite')).toBe(true)
    expect(kinds.has('empty-related-concepts')).toBe(true)
  })
})

describe('topological ordering', () => {
  it('places prerequisites before the concepts that need them', () => {
    const ordered = topologicalOrderOf([concept('c', ['b']), concept('a'), concept('b', ['a'])])
    expect(ordered).toEqual(['a', 'b', 'c'])
  })

  it('is stable, following declaration order among equally ready concepts', () => {
    const concepts = [concept('x'), concept('y'), concept('z')]
    expect(topologicalOrderOf(concepts)).toEqual(['x', 'y', 'z'])
    expect(topologicalOrderOf([...concepts].reverse())).toEqual(['z', 'y', 'x'])
  })

  it('throws on a cycle rather than returning a partial order', () => {
    expect(() => topologicalOrderOf([concept('a', ['b']), concept('b', ['a'])])).toThrow(
      /prerequisite cycle/,
    )
  })

  it('ignores prerequisites outside the set being ordered', () => {
    // Missing references are reported by the validator; the ordering must not deadlock on
    // them, or a single typo would be reported as a cycle as well.
    expect(topologicalOrderOf([concept('b', ['ghost'])])).toEqual(['b'])
  })
})

describe('validator regressions found by review', () => {
  it('reports a duplicated id as a duplicate, not as a phantom cycle', () => {
    // The ordering de-duplicates, so comparing its length against the raw input length
    // reported a duplicate as a cycle and sent whoever was fixing it hunting for an edge
    // that did not exist.
    const kinds = kindsOf([...VALID_CONCEPTS, concept('a')], [])

    expect(kinds).toContain('duplicate-concept')
    expect(kinds).not.toContain('cycle')
  })

  it('detects a disconnected island that a learner could never reach', () => {
    // Locally this island looks fine — its root has a dependant, its leaf has a
    // prerequisite — so neither the orphan check nor the cycle check notices it. Only
    // walking forward from the real starting concepts finds it.
    const problems = validateCurriculumData(
      [...VALID_CONCEPTS, concept('island-root', ['island-leaf']), concept('island-leaf', ['island-root'])],
      [],
    )

    const kinds = problems.map((problem) => problem.kind)
    expect(kinds).toContain('cycle')

    // And a non-cyclic island, which previously produced no problems at all.
    const detached = validateCurriculumData(
      [
        concept('a'),
        concept('b', ['a']),
        // Reachable only from itself: 'c' has a prerequisite, so it is not an orphan.
        concept('c', ['d']),
        concept('d', ['c']),
      ],
      [],
    )
    expect(detached.length).toBeGreaterThan(0)
  })

  it('flags a concept whose prerequisites make it unreachable from any start', () => {
    const problems = validateCurriculumData(
      [concept('a'), concept('b', ['a']), concept('stranded', ['nowhere'])],
      [],
    )
    const kinds = problems.map((problem) => problem.kind)

    expect(kinds).toContain('missing-prerequisite')
    expect(kinds).toContain('unreachable-concept')
  })

  it('accepts the real curriculum as fully reachable', () => {
    // The property the curriculum file documents: every concept is reachable from a
    // concept with no prerequisites.
    expect(validateCurriculum()).toEqual([])
  })
})

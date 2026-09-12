import { describe, expect, it } from 'vitest'

import { CONCEPTS, CONCEPTS_BY_ID } from './concepts'
import {
  conceptsInArea,
  dependentsOf,
  entryConcepts,
  getConcept,
  getMisconception,
  isConceptId,
  isMisconceptionId,
  misconceptionsForConcept,
  topologicalOrder,
  transitivePrerequisites,
  validateCurriculum,
} from './graph'
import { MISCONCEPTIONS } from './misconceptions'
import type { Area } from './types'

/**
 * The curriculum is hand-authored data that the scheduler, the learner model and every
 * tutoring prompt depend on. These are the checks that turn a careless edit into a failing
 * build rather than a learner stuck on a concept that can never be reached.
 */

const ALL_AREAS: readonly Area[] = [
  'fundamentals',
  'variables-and-types',
  'expressions',
  'conditionals',
  'loops',
  'functions',
  'collections',
  'debugging',
  'decomposition',
  'object-oriented',
]

describe('curriculum structure', () => {
  it('passes every structural check', () => {
    // Reported as a list so a broken edit shows all its problems at once.
    expect(validateCurriculum()).toEqual([])
  })

  it('has a unique id for every concept', () => {
    expect(CONCEPTS_BY_ID.size).toBe(CONCEPTS.length)
  })

  it('has at least one concept a learner with no history can start on', () => {
    expect(entryConcepts().length).toBeGreaterThan(0)
  })

  it('is acyclic, so every concept can be ordered after its prerequisites', () => {
    const ordered = topologicalOrder()
    expect(ordered).toHaveLength(CONCEPTS.length)

    const position = new Map(ordered.map((id, index) => [id, index]))
    for (const concept of CONCEPTS) {
      for (const prerequisite of concept.prerequisites) {
        expect(position.get(prerequisite)).toBeLessThan(position.get(concept.id)!)
      }
    }
  })

  it('never lists a concept as its own prerequisite, directly or transitively', () => {
    for (const concept of CONCEPTS) {
      expect(transitivePrerequisites(concept.id).has(concept.id)).toBe(false)
    }
  })

  it('covers every competence area the project requires', () => {
    for (const area of ALL_AREAS) {
      expect(conceptsInArea(area).length, `no concepts in area ${area}`).toBeGreaterThan(0)
    }
  })

  it('assigns every concept to one of the known areas', () => {
    for (const concept of CONCEPTS) {
      expect(ALL_AREAS).toContain(concept.area)
    }
  })

  it('gives every concept a finite difficulty prior within the ability scale', () => {
    for (const concept of CONCEPTS) {
      expect(Number.isFinite(concept.baselineDifficulty)).toBe(true)
      expect(concept.baselineDifficulty).toBeGreaterThan(-3)
      expect(concept.baselineDifficulty).toBeLessThan(3)
    }
  })

  it('gives every concept learner-facing text', () => {
    for (const concept of CONCEPTS) {
      expect(concept.title.length).toBeGreaterThan(0)
      expect(concept.summary.length).toBeGreaterThan(0)
      // Titles are shown to a learner, so they should not read like identifiers.
      expect(concept.title).not.toMatch(/[-_]/)
    }
  })

  it('declares prerequisites no harder than the concept that requires them', () => {
    // Not a hard rule of the domain, but a violation almost always means a mis-set prior:
    // a learner would be sent to something harder in order to unlock something easier.
    for (const concept of CONCEPTS) {
      for (const prerequisite of concept.prerequisites) {
        expect(
          getConcept(prerequisite).baselineDifficulty,
          `${prerequisite} is declared harder than ${concept.id}, which depends on it`,
        ).toBeLessThanOrEqual(concept.baselineDifficulty)
      }
    }
  })
})

describe('graph queries', () => {
  it('resolves a known concept and rejects an unknown one', () => {
    expect(getConcept('while-loops').title).toBe('Repeating while something is true')
    // @ts-expect-error - the guard has to hold at runtime too, not only in the type system
    expect(() => getConcept('does-not-exist')).toThrow(/Unknown concept/)
  })

  it('narrows arbitrary strings to concept ids', () => {
    expect(isConceptId('for-loops-and-range')).toBe(true)
    expect(isConceptId('quantum-loops')).toBe(false)
  })

  it('narrows arbitrary strings to misconception ids', () => {
    expect(isMisconceptionId('assign-compares')).toBe(true)
    expect(isMisconceptionId('assign-computes')).toBe(false)
  })

  it('reports what a concept unlocks', () => {
    // Both loop forms rest on conditionals; neither is a prerequisite of the other.
    const afterConditionals = dependentsOf('if-statements').map((concept) => concept.id)
    expect(afterConditionals).toContain('for-loops-and-range')
    expect(afterConditionals).toContain('while-loops')

    expect(dependentsOf('while-loops').map((concept) => concept.id)).toContain('loop-control')
  })

  it('collects prerequisites transitively', () => {
    const prerequisites = transitivePrerequisites('for-loops-and-range')
    // Directly required.
    expect(prerequisites.has('if-statements')).toBe(true)
    // Reached through if-statements -> comparison-operators -> ... -> program-execution.
    expect(prerequisites.has('comparison-operators')).toBe(true)
    expect(prerequisites.has('program-execution')).toBe(true)
    // A sibling, not an ancestor.
    expect(prerequisites.has('while-loops')).toBe(false)
  })

  it('reports no prerequisites for an entry concept', () => {
    expect(transitivePrerequisites('program-execution').size).toBe(0)
  })
})

describe('misconception catalogue', () => {
  it('links every misconception to concepts that exist', () => {
    for (const misconception of MISCONCEPTIONS) {
      expect(misconception.relatedConcepts.length).toBeGreaterThan(0)
      for (const conceptId of misconception.relatedConcepts) {
        expect(CONCEPTS_BY_ID.has(conceptId), `${misconception.id} -> ${conceptId}`).toBe(true)
      }
    }
  })

  it('records provenance for every entry', () => {
    // Entries taken from a published inventory carry its identifier so the wording here
    // can be checked against the source; the rest are explicitly marked as unattributed
    // rather than being passed off as sourced.
    for (const misconception of MISCONCEPTIONS) {
      if (misconception.source.kind === 'progmiscon') {
        expect(misconception.source.id.length).toBeGreaterThan(0)
        expect(misconception.source.url).toMatch(/^https:\/\/progmiscon\.org\//)
      } else {
        expect(misconception.source.kind).toBe('unattributed')
      }
    }
  })

  /*
   * Both fields are quoted straight into feedback a learner reads (`composeFeedback`), so they
   * have to be written *to* them rather than *about* them. One entry described "a learner
   * holding this belief", and the feedback it produced switched from second to third person
   * halfway through a paragraph addressed to the person reading it.
   */
  it('is written to the learner, never about them', () => {
    for (const misconception of MISCONCEPTIONS) {
      expect(misconception.belief, `${misconception.id}.belief`).not.toMatch(
        /learner|student|novice/i,
      )
      expect(misconception.reality, `${misconception.id}.reality`).not.toMatch(
        /learner|student|novice/i,
      )
    }
  })

  it('states both the wrong belief and what is actually true', () => {
    // Feedback is generated from these, so an entry missing either half is unusable.
    for (const misconception of MISCONCEPTIONS) {
      expect(misconception.belief.length, misconception.id).toBeGreaterThan(10)
      expect(misconception.reality.length, misconception.id).toBeGreaterThan(10)
    }
  })

  /*
   * The gap M1 recorded as a limitation and M5 closed. M5 is the first milestone that actually
   * consumes misconception identifiers, so a concept with none is a concept the tutor cannot
   * say anything diagnostic about. Asserted rather than noted, so it cannot quietly reopen when
   * a concept is added.
   */
  it('covers every concept in the curriculum', () => {
    const covered = new Set(MISCONCEPTIONS.flatMap((misconception) => misconception.relatedConcepts))
    const uncovered = CONCEPTS.filter((concept) => !covered.has(concept.id)).map((c) => c.id)

    expect(uncovered, `no misconception mentions: ${uncovered.join(', ')}`).toEqual([])
  })

  it('covers every competence area, including object-oriented', () => {
    const areas = new Set(
      MISCONCEPTIONS.flatMap((misconception) =>
        misconception.relatedConcepts.map((id) => getConcept(id).area),
      ),
    )

    for (const concept of CONCEPTS) {
      expect(areas.has(concept.area), concept.area).toBe(true)
    }
  })

  it('gives a unique identifier and title to every entry', () => {
    const ids = MISCONCEPTIONS.map((misconception) => misconception.id)
    const titles = MISCONCEPTIONS.map((misconception) => misconception.title)

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(titles).size).toBe(titles.length)
  })

  /*
   * Provenance is a claim about where wording came from, and a wrong one is worse than none.
   * Entries taken from the inventory must name an identifier that looks like the inventory's
   * own convention; everything else must say `unattributed` out loud.
   */
  it('names an inventory identifier that matches its own URL', () => {
    for (const misconception of MISCONCEPTIONS) {
      if (misconception.source.kind !== 'progmiscon') continue
      expect(misconception.source.url, misconception.id).toContain(misconception.source.id)
      expect(misconception.source.id, misconception.id).toMatch(/^[A-Z][A-Za-z]+$/)
    }
  })

  it('resolves a known misconception and rejects an unknown one', () => {
    expect(getMisconception('if-is-loop').title).toBe('An if repeats')
    // @ts-expect-error - runtime guard, not only a compile-time one
    expect(() => getMisconception('if-is-fine')).toThrow(/Unknown misconception/)
  })

  it('offers misconceptions to watch for on the concepts most prone to them', () => {
    const conditionals = misconceptionsForConcept('if-statements').map((m) => m.id)
    expect(conditionals).toContain('if-is-loop')
    expect(conditionals).toContain('conditional-is-sequence')

    const aliasing = misconceptionsForConcept('list-mutation-and-aliasing').map((m) => m.id)
    expect(aliasing).toContain('assignment-copies-object')
  })

  it('covers the concepts a beginner most often goes wrong on', () => {
    const covered = new Set(MISCONCEPTIONS.flatMap((m) => m.relatedConcepts))
    for (const conceptId of [
      'variables-and-assignment',
      'if-statements',
      'for-loops-and-range',
      'return-values',
      'list-mutation-and-aliasing',
    ] as const) {
      expect(covered.has(conceptId), `no misconception covers ${conceptId}`).toBe(true)
    }
  })
})

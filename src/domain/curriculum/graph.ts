import { CONCEPTS, CONCEPTS_BY_ID } from './concepts'
import { MISCONCEPTIONS, MISCONCEPTIONS_BY_ID } from './misconceptions'
import type { Area, Concept, ConceptId, Misconception, MisconceptionId } from './types'

/**
 * Queries over the curriculum, plus the validation that keeps it honest.
 *
 * The graph is hand-authored data, so the checks here are the thing standing between a
 * careless edit and a scheduler that deadlocks or a tutor that references a concept which
 * does not exist. They run in tests rather than at startup, because the data is static: a
 * broken curriculum should fail the build, not the learner's session.
 *
 * The validation takes its data as parameters so that the checks themselves can be tested
 * against deliberately broken curricula. A safety net nobody has ever seen catch anything
 * is not known to work.
 */

export function getConcept(id: ConceptId): Concept {
  const concept = CONCEPTS_BY_ID.get(id)
  if (concept === undefined) {
    throw new Error(`Unknown concept: ${id}`)
  }
  return concept
}

export function getMisconception(id: MisconceptionId): Misconception {
  const misconception = MISCONCEPTIONS_BY_ID.get(id)
  if (misconception === undefined) {
    throw new Error(`Unknown misconception: ${id}`)
  }
  return misconception
}

export function isConceptId(value: string): value is ConceptId {
  return CONCEPTS_BY_ID.has(value as ConceptId)
}

export function isMisconceptionId(value: string): value is MisconceptionId {
  return MISCONCEPTIONS_BY_ID.has(value as MisconceptionId)
}

/** Concepts with no prerequisites: where a learner with no history can begin. */
export function entryConcepts(): readonly Concept[] {
  return CONCEPTS.filter((concept) => concept.prerequisites.length === 0)
}

export function conceptsInArea(area: Area): readonly Concept[] {
  return CONCEPTS.filter((concept) => concept.area === area)
}

/** Concepts that list `id` as a prerequisite — what becomes reachable once it is known. */
export function dependentsOf(id: ConceptId): readonly Concept[] {
  return CONCEPTS.filter((concept) => concept.prerequisites.includes(id))
}

/**
 * Every prerequisite of `id`, directly or indirectly.
 *
 * Used to explain to a learner what a concept rests on. Returns ids in no particular order.
 */
export function transitivePrerequisites(id: ConceptId): ReadonlySet<ConceptId> {
  const collected = new Set<ConceptId>()
  const pending: ConceptId[] = [...getConcept(id).prerequisites]

  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined || collected.has(next)) continue
    collected.add(next)
    pending.push(...getConcept(next).prerequisites)
  }
  return collected
}

/** Misconceptions the tutor should watch for while working on a concept. */
export function misconceptionsForConcept(id: ConceptId): readonly Misconception[] {
  return MISCONCEPTIONS.filter((misconception) => misconception.relatedConcepts.includes(id))
}

/**
 * A topological ordering of a concept set, prerequisites before dependants.
 *
 * Not a study plan — the scheduler chooses what to do next from evidence, not from this
 * order. It exists so the curriculum can be displayed and reviewed in a sensible sequence,
 * and it doubles as the cycle check: a graph with a cycle cannot be fully ordered.
 *
 * Throws when the graph contains a cycle.
 */
export function topologicalOrderOf(concepts: readonly Concept[]): readonly ConceptId[] {
  const declared = new Set(concepts.map((concept) => concept.id))
  const remaining = new Map<ConceptId, Set<ConceptId>>(
    // Prerequisites that are not in this set cannot be waited for, so they are ignored
    // here; a missing reference is reported separately as its own problem.
    concepts.map((concept) => [
      concept.id,
      new Set(concept.prerequisites.filter((id) => declared.has(id))),
    ]),
  )
  const ordered: ConceptId[] = []

  while (remaining.size > 0) {
    // Ties are broken by declaration order, so the result is stable.
    const ready = [...remaining.entries()]
      .filter(([, prerequisites]) => prerequisites.size === 0)
      .map(([id]) => id)

    if (ready.length === 0) {
      throw new Error(
        `The curriculum contains a prerequisite cycle among: ${[...remaining.keys()].join(', ')}`,
      )
    }

    for (const id of ready) {
      ordered.push(id)
      remaining.delete(id)
    }
    for (const prerequisites of remaining.values()) {
      for (const id of ready) prerequisites.delete(id)
    }
  }

  return ordered
}

export function topologicalOrder(): readonly ConceptId[] {
  return topologicalOrderOf(CONCEPTS)
}

export interface CurriculumProblem {
  readonly kind:
    | 'duplicate-concept'
    | 'duplicate-misconception'
    | 'missing-prerequisite'
    | 'self-prerequisite'
    | 'cycle'
    | 'no-entry-concept'
    | 'unreachable-concept'
    | 'unknown-related-concept'
    | 'empty-related-concepts'
    | 'orphan-concept'
  readonly detail: string
}

/**
 * Checks every structural property the rest of the system relies on.
 *
 * Returns problems rather than throwing, so a broken edit reports all of its faults at
 * once — fixing curriculum data one error per run is miserable.
 */
export function validateCurriculumData(
  concepts: readonly Concept[],
  misconceptions: readonly Misconception[],
): readonly CurriculumProblem[] {
  const problems: CurriculumProblem[] = []
  const byId = new Map(concepts.map((concept) => [concept.id, concept]))

  const seenConcepts = new Set<string>()
  for (const concept of concepts) {
    if (seenConcepts.has(concept.id)) {
      problems.push({ kind: 'duplicate-concept', detail: `${concept.id} is declared twice` })
    }
    seenConcepts.add(concept.id)

    for (const prerequisite of concept.prerequisites) {
      if (prerequisite === concept.id) {
        problems.push({
          kind: 'self-prerequisite',
          detail: `${concept.id} lists itself as a prerequisite`,
        })
      } else if (!byId.has(prerequisite)) {
        problems.push({
          kind: 'missing-prerequisite',
          detail: `${concept.id} requires ${prerequisite}, which does not exist`,
        })
      }
    }
  }

  if (concepts.length > 0 && concepts.every((concept) => concept.prerequisites.length > 0)) {
    problems.push({
      kind: 'no-entry-concept',
      detail: 'Every concept has a prerequisite, so a new learner could never start',
    })
  }

  try {
    const ordered = topologicalOrderOf(concepts)
    // Compared against the number of *distinct* ids: the ordering de-duplicates, so
    // comparing against the raw length reports a duplicate id as a phantom cycle and sends
    // whoever is fixing it looking for an edge that does not exist.
    if (ordered.length !== byId.size) {
      problems.push({
        kind: 'cycle',
        detail: `Ordered ${String(ordered.length)} of ${String(byId.size)} concepts`,
      })
    }
  } catch (cause: unknown) {
    problems.push({
      kind: 'cycle',
      detail: cause instanceof Error ? cause.message : String(cause),
    })
  }

  // Reachability from where a learner actually starts.
  //
  // An "orphan" check alone misses a disconnected island: an island with its own
  // prerequisite-free root looks locally fine, because the root has a dependant and the
  // leaf has a prerequisite. Only walking forward from the real entry points finds it.
  const entry = concepts.filter((concept) => concept.prerequisites.length === 0)
  if (entry.length > 0) {
    const reachable = new Set<ConceptId>()
    const pending = entry.map((concept) => concept.id)

    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined || reachable.has(next)) continue
      reachable.add(next)
      for (const candidate of concepts) {
        if (candidate.prerequisites.includes(next)) pending.push(candidate.id)
      }
    }

    for (const concept of concepts) {
      // A concept whose prerequisites are unsatisfiable is reported separately; this is
      // about concepts that are wired up correctly but sit on an island of their own.
      if (!reachable.has(concept.id)) {
        problems.push({
          kind: 'unreachable-concept',
          detail: `${concept.id} cannot be reached from any starting concept`,
        })
      }
    }
  }

  // A concept nothing leads to and that leads nowhere is almost certainly an editing
  // mistake: a learner would only ever reach it by exhausting everything else.
  if (concepts.length > 1) {
    for (const concept of concepts) {
      const hasDependents = concepts.some((other) => other.prerequisites.includes(concept.id))
      if (concept.prerequisites.length === 0 && !hasDependents) {
        problems.push({
          kind: 'orphan-concept',
          detail: `${concept.id} has no prerequisites and nothing depends on it`,
        })
      }
    }
  }

  const seenMisconceptions = new Set<string>()
  for (const misconception of misconceptions) {
    if (seenMisconceptions.has(misconception.id)) {
      problems.push({
        kind: 'duplicate-misconception',
        detail: `${misconception.id} is declared twice`,
      })
    }
    seenMisconceptions.add(misconception.id)

    if (misconception.relatedConcepts.length === 0) {
      problems.push({
        kind: 'empty-related-concepts',
        detail: `${misconception.id} is not linked to any concept, so it could never be surfaced`,
      })
    }
    for (const conceptId of misconception.relatedConcepts) {
      if (!byId.has(conceptId)) {
        problems.push({
          kind: 'unknown-related-concept',
          detail: `${misconception.id} refers to ${conceptId}, which does not exist`,
        })
      }
    }
  }

  return problems
}

/** Validates the curriculum this application actually ships. */
export function validateCurriculum(): readonly CurriculumProblem[] {
  return validateCurriculumData(CONCEPTS, MISCONCEPTIONS)
}

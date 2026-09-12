# Programming Tutor

A personalised Python tutor that builds a picture of what a learner understands and adapts
its explanations, questions and practice to it.

It runs locally, for one learner, with no accounts and no deployment.

> **Status: early.** The foundations are in place — client-side Python execution, local
> storage, the model-provider boundary, and the curriculum, learner model and scheduling
> that the tutoring will be driven from. The learner-facing experience is being built
> milestone by milestone. See [Roadmap](#roadmap).

## Why this exists

A conversational assistant will answer whatever a learner thinks to ask. That is a poor fit
for learning to program, because the questions worth asking are exactly the ones a novice
cannot yet formulate — and an assistant that hands over working code removes the struggle
that produces understanding.

This project takes the opposite approach. It maintains an explicit model of what the learner
has demonstrated, chooses what to work on next from that model, and holds back complete
solutions in favour of explanation, questions and progressive hints.

## Principles

- **Evidence, not vibes.** Every change to the learner model is attributable to a specific
  attempt, and is recorded with the reasoning behind it. The language model is never allowed
  to write learner state directly; it judges an attempt, and the application decides what
  that means.
- **No false precision.** Mastery is shown as coarse bands with a separate indication of how
  much evidence sits behind them. There are no percentages, because the estimate does not
  support that precision.
- **Learner code never runs on the server.** All Python executes in the browser, in a
  dedicated worker that can always be terminated.
- **Generated content is untrusted.** Structured output is validated before it is used, and
  generated exercises are executed against their own tests before a learner ever sees them.

## Features

Working today:

- A curriculum of 33 Python concepts as a prerequisite graph, covering everything from how a
  program runs to classes and objects
- A learner model that estimates understanding per concept from evidence, and can explain
  every change it makes in plain language
- Scheduling that decides what to work on next — and says why — never proposing a concept
  whose prerequisites have not been demonstrated
- Spaced review that brings weak and unsettled concepts back
- A closed catalogue of 42 Python misconceptions the tutor is allowed to name, covering every
  concept — 26 drawn from a published inventory, the rest marked in the data as this project's
  own hypotheses rather than sourced claims
- Python execution in the browser via Pyodide, in an isolated worker
- Run and Stop controls, with output streamed as it is produced
- Endless programs terminated on demand or by a wall-clock budget, with a replacement
  interpreter started automatically
- Local SQLite storage with generated, versioned migrations
- A model-provider boundary with a deterministic mock, so the entire test suite runs with no
  API key
- Verification harness that checks a generated exercise's reference solution against its own
  tests
- A system-check page reporting the state of both
- A prompt architecture of ordered blocks — stable policy and curriculum first, learner state
  and task last — with nine strategies, each carrying its own schema, invariants and decision
  about what to do when the model returns something unusable
- Structured model output validated, repaired once, then either failed visibly or replaced by a
  safe fallback — never coerced, never silently wrong
- First-run onboarding and a short adaptive diagnostic that initialises the learner model from
  answers rather than from self-report
- Conversational tutoring with streamed replies, pitched at what the learner has demonstrated,
  cancellable, and recoverable when the provider fails
- Questions asked inside the lesson — multiple choice, "what does this print?", and written
  explanations — chosen from the learner model, with the reason for asking shown
- Deterministic marking wherever the answer is not prose, so assessment works with no provider
  configured at all
- Feedback that names the wrong idea an answer fits and what Python actually does, composed from
  the item and the catalogue so it cannot contradict the mark
- One nudge per question, which counts for less than working it out unaided and never against
  the learner
- A profile that shows, per concept, the dated answers behind every change

Planned, milestone by milestone: programming and debugging exercises with a full hint ladder, the
review and export views, accessibility hardening, evaluation, and optional grounding in uploaded
study material.

## Architecture

```
app/          routes and route handlers (thin; no business logic)
src/domain/   pure TypeScript: curriculum, learner model, scheduling, evidence — no I/O
src/tutor/    prompt architecture: composable blocks, per-intent strategies, validation
src/llm/      provider boundary: interface, OpenAI implementation, deterministic mock
src/db/       Drizzle schema, migrations, repositories
src/python/   Python workers and their typed clients (browser only)
src/ui/       components and design tokens
```

Three decisions shape most of the rest:

**The domain layer has no I/O.** `src/domain` never imports from `src/llm` or `src/db`. The
learner-model arithmetic is therefore pure and deterministically testable, and model output
cannot reach state-mutation paths without passing through an explicit conversion step.

**Prompts are composed from ordered blocks**, stable content first: tutoring policy,
curriculum, then the strategy for this particular call, then the learner's current state,
then the task. Stable-first ordering lets the provider reuse a cached prefix; correctness
never depends on a cache hit.

**Python workers are compiled separately.** Pyodide requires a module worker, and the
application bundler emits classic workers. The workers are built by their own TypeScript
project into `public/workers/`, so they stay type-checked while being served as plain static
modules.

## Requirements

- Node.js 22.12 or later (developed on 24.13)
- npm 10 or later
- A modern browser with WebAssembly and module workers

`better-sqlite3` is a native module; prebuilt binaries cover common platforms, so no build
toolchain is normally needed.

## Setup

```bash
npm install
```

`postinstall` copies the Pyodide runtime into `public/pyodide/` — about 13 MB, not committed.

Create `.env.local` from the template:

```bash
cp .env.example .env.local
```

### Environment variables

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | API key for the tutor's language model. Server-side only; never sent to the browser. |
| `OPENAI_MODEL` | Model identifier. Defaults to the value in `.env.example`. |
| `DATABASE_PATH` | Where the learner database lives. Defaults to `data/tutor.db`. |
| `LLM_PROVIDER` | Set to `mock` to run against the deterministic mock instead of the real API. |

No key is needed for development or for any automated test.

### Database

The schema is defined in `src/db/schema.ts`; migrations are generated, committed, and applied
automatically on first use.

```bash
npm run db:generate   # generate a migration after changing the schema
npm run db:migrate    # apply pending migrations manually
```

The database file is local and is not committed.

## Running

```bash
npm run dev
```

Then open <http://localhost:3000>. `/system-check` reports whether storage and Python are
working.

```bash
npm run build && npm start   # production build
```

## Tests

```bash
npm run check      # typecheck, lint, unit and integration tests
npm test           # unit and integration tests only
npm run test:e2e   # end-to-end tests in a real browser
npm run typecheck
npm run lint
```

The end-to-end suite builds the application and runs it, so it exercises production output
rather than the dev server.

**No test contacts the OpenAI API.** Everything runs against the mock provider, so the suite
is deterministic and needs no key. Testing against the live API is a manual step.

## Limitations

- **Python only.** Other languages can be discussed, but the diagnostic, exercise and
  execution experience is Python, and no parity is claimed for anything else.
- **Mastery estimates are estimates.** Item difficulties are authored priors, not calibrated
  against a population of learners — there is only one learner. The interface deliberately
  avoids implying more precision than the model supports.
- **First load is slow.** Pyodide is roughly 13 MB. It is cached afterwards, and the
  interpreter starts as soon as a page that needs it opens, but a cold start takes seconds.
- **Stopping a program discards interpreter state.** Termination is the only cancellation
  that a runaway loop cannot ignore. Every run starts from a fresh namespace anyway.
- **During exercise verification, a generated reference solution passes through the browser.**
  It is transient and never displayed, but because no Python may run on the server, it cannot
  be kept entirely out of the client. A learner inspecting network traffic at that moment
  could read it.
- **Chromium only.** The end-to-end suite runs one browser; Firefox and WebKit are untested.
- **Accessibility is a target under active work.** Focus management, keyboard operability and
  reduced-motion support are implemented and partly tested. A screen-reader pass has not yet
  been carried out and no such claim is made.
- **Not an evaluated educational intervention.** No study, control group or learning-outcome
  measurement supports it.
- **A written answer needs a model, and may go unmarked.** Multiple-choice and output-prediction
  questions are marked against the item's own answer. A written explanation is read by the model,
  which is allowed to say it cannot tell — and when it says so, or when no provider is
  reachable, the answer is kept, shown as unmarked, and changes nothing about the learner. An
  unmarked answer is better than an invented one.
- **Ten of 33 concepts have no authored question.** A check on one of those is generated, and a
  generated question that fails validation is not asked at all, so the tutor sometimes has
  nothing to ask.

## Roadmap

| Milestone | Scope |
|---|---|
| M0 | Foundations: execution, storage, provider boundary, design system ✅ |
| M1 | Curriculum graph, learner model, evidence, scheduling ✅ |
| M2 | Prompt architecture and the real provider ✅ |
| M3 | Onboarding and diagnostic assessment ✅ |
| M4 | Home, session view, conversational tutoring ✅ |
| M5 | Quizzes, code reading, evaluation and feedback ✅ |
| M6 | Programming exercises, execution and progressive hints |
| M7 | Review scheduling, persistence, reset and export |
| M8 | Accessibility, responsiveness and hardening |
| M9 | Evaluation and documentation |
| M10 | Optional grounding in uploaded study material |

## Licence

Not yet determined.

import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { submitConfidence, submitExperience, submitGoal } from '../actions'
import { StepForm } from './StepForm'
import { getDb } from '@/db/instance'
import { requestNow } from '@/db/request-time'
import { ensureLearner, readProfile, readSelfReport } from '@/db/repositories/learner-repository'
import type { Area } from '@/domain/curriculum/types'

import styles from './page.module.css'

export const metadata: Metadata = { title: 'Getting started' }
export const dynamic = 'force-dynamic'

/**
 * Three short questions before the diagnostic.
 *
 * Only things that change what the tutor does: what they want out of this, how much
 * programming they have done, and how confident they feel. Nothing is asked for the sake of
 * having asked it, and nothing here is treated as evidence of ability.
 *
 * Each answer is saved as it is given rather than all at once at the end, so closing the
 * application after the first question loses nothing.
 */

const STEPS = [
  { id: 'goal', label: 'What you want' },
  { id: 'experience', label: 'Where you are' },
  { id: 'confidence', label: 'How it feels' },
] as const

const AREAS: readonly { id: Area; label: string; hint: string }[] = [
  { id: 'fundamentals', label: 'How programs run', hint: 'Statements, order, output, errors' },
  { id: 'variables-and-types', label: 'Variables and values', hint: 'Names, numbers, text, true and false' },
  { id: 'expressions', label: 'Working things out', hint: 'Arithmetic, comparisons, and / or' },
  { id: 'conditionals', label: 'Making decisions', hint: 'if, elif, else' },
  { id: 'loops', label: 'Repeating things', hint: 'for, while, counting, totals' },
  { id: 'functions', label: 'Your own functions', hint: 'def, arguments, return' },
  { id: 'collections', label: 'Lists and dictionaries', hint: 'Holding many values at once' },
  { id: 'debugging', label: 'Finding what went wrong', hint: 'Reading errors, tracking down bugs' },
  { id: 'decomposition', label: 'Breaking a problem up', hint: 'Turning a task into steps and functions' },
  { id: 'object-oriented', label: 'Classes and objects', hint: 'Defining your own kind of value' },
]

const CONFIDENCE_OPTIONS = [
  { value: 'none', label: 'New to me' },
  { value: 'some', label: 'Some idea' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'confident', label: 'Confident' },
] as const

const EXPERIENCE_OPTIONS = [
  {
    value: 'new-to-programming',
    label: 'I have not written code before',
    hint: 'We will start from the beginning.',
  },
  {
    value: 'other-language',
    label: 'I have programmed, but not in Python',
    hint: 'We will not re-teach what a loop is, but Python does things its own way.',
  },
  {
    value: 'some-python',
    label: 'I have written some Python',
    hint: 'We will find out what has stuck and what has not.',
  },
  {
    value: 'regular-python',
    label: 'I write Python fairly regularly',
    hint: 'We will start with harder questions and work down.',
  },
] as const

function StepIndicator({ current }: { readonly current: number }) {
  return (
    <ol aria-label="Progress through getting started" className={styles.steps}>
      {STEPS.map((step, index) => (
        <li
          aria-current={index === current ? 'step' : undefined}
          className={index === current ? styles.stepCurrent : index < current ? styles.stepDone : styles.step}
          key={step.id}
        >
          <span className={styles.stepNumber}>{index + 1}</span>
          {step.label}
        </li>
      ))}
    </ol>
  )
}

export default function WelcomePage() {
  const db = getDb()
  ensureLearner(db, requestNow())
  const profile = readProfile(db)

  if (profile?.onboardingComplete === true) redirect('/diagnostic')

  const step = profile?.onboardingStep ?? 'goal'
  const saved = readSelfReport(db)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Getting started</p>
        <h1>Three short questions</h1>
        <p className={styles.lead}>
          These shape where the tutor begins. Nothing here counts as an assessment — you will do a
          short one next.
        </p>
      </header>

      <StepIndicator current={step === 'goal' ? 0 : step === 'experience' ? 1 : 2} />

      {step === 'goal' && (
        <StepForm action={submitGoal} submitLabel="Continue" submitTestId="goal-continue">
          <div className={styles.field}>
            <label className={styles.label} htmlFor="goal">
              What would you like to be able to do?
            </label>
            <p className={styles.help} id="goal-help">
              In your own words. It does not need to be precise — &ldquo;read my team&rsquo;s
              scripts&rdquo; or &ldquo;stop being scared of loops&rdquo; are both useful.
            </p>
            <textarea
              aria-describedby="goal-help"
              className={styles.textarea}
              data-testid="goal-input"
              defaultValue={profile?.goal ?? ''}
              id="goal"
              name="goal"
              required
              rows={3}
            />
          </div>

          <fieldset className={styles.fieldset}>
            <legend className={styles.label}>Anything you especially want to get to?</legend>
            <p className={styles.help}>Optional. This affects ordering, not what you are asked.</p>
            <div className={styles.checkboxes}>
              {AREAS.map((area) => (
                <label className={styles.checkbox} key={area.id}>
                  <input name="interests" type="checkbox" value={area.id} />
                  <span>{area.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

        </StepForm>
      )}

      {step === 'experience' && (
        <StepForm
          action={submitExperience}
          back={{ step: 'goal', label: 'Back to what you want' }}
          submitLabel="Continue"
          submitTestId="experience-continue"
        >
          <fieldset className={styles.fieldset}>
            <legend className={styles.label}>How much programming have you done?</legend>
            <div className={styles.choices}>
              {EXPERIENCE_OPTIONS.map((option) => (
                <label className={styles.choice} key={option.value}>
                  <input
                    defaultChecked={profile?.experience === option.value}
                    name="experience"
                    required
                    type="radio"
                    value={option.value}
                  />
                  <span>
                    <span className={styles.choiceLabel}>{option.label}</span>
                    <span className={styles.choiceHint}>{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

        </StepForm>
      )}

      {step === 'confidence' && (
        <StepForm
          action={submitConfidence}
          back={{ step: 'experience', label: 'Back to where you are' }}
          submitLabel="Start the short assessment"
          submitTestId="confidence-continue"
        >
          <div className={styles.field}>
            <p className={styles.label}>How do these feel at the moment?</p>
            <p className={styles.help}>
              Your own sense of it. This decides where the questions start — it is not recorded as
              something you can do, and the tutor will not claim you know anything until you have
              shown it.
            </p>
          </div>

          <table className={styles.grid}>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Topic</span>
                </th>
                {CONFIDENCE_OPTIONS.map((option) => (
                  <th key={option.value} scope="col">
                    {option.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {AREAS.map((area) => (
                <tr key={area.id}>
                  <th className={styles.rowHeader} scope="row">
                    <span className={styles.areaLabel}>{area.label}</span>
                    <span className={styles.areaHint}>{area.hint}</span>
                  </th>
                  {CONFIDENCE_OPTIONS.map((option) => (
                    <td key={option.value}>
                      <label className={styles.radioCell}>
                        <span className="visually-hidden">
                          {area.label}: {option.label}
                        </span>
                        <span aria-hidden="true" className={styles.cellLabel}>
                          {option.label}
                        </span>
                        <input
                          defaultChecked={saved[area.id] === option.value}
                          name={`confidence.${area.id}`}
                          type="radio"
                          value={option.value}
                        />
                      </label>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

        </StepForm>
      )}

      <p className={styles.saved} data-testid="saved-note">
        Your answers are saved as you go. You can close this and come back.
      </p>
    </div>
  )
}

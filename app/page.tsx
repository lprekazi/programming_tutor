import Link from 'next/link'

import styles from './page.module.css'

export default function HomePage() {
  return (
    <div className={styles.intro}>
      <p className={styles.eyebrow}>Python</p>
      <h1 className={styles.title}>A tutor that learns what you know</h1>
      <p className={styles.lead}>
        This is a personalised programming tutor. It works out what you already understand,
        explains ideas at the depth you need, sets questions and short programming tasks, and
        keeps track of the evidence behind every judgement it makes about your progress.
      </p>
      <p className={styles.body}>
        Your work stays on this machine. There is no account to create and nothing is shared.
      </p>
      <p className={styles.actions}>
        <Link className={styles.secondary} href="/system-check">
          Check that everything is working
        </Link>
      </p>
    </div>
  )
}

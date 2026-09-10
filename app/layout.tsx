import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import './globals.css'
import styles from './layout.module.css'

export const metadata: Metadata = {
  title: {
    default: 'Programming Tutor',
    template: '%s · Programming Tutor',
  },
  description:
    'A personalised Python tutor that builds a picture of what you understand and adapts explanations, questions and practice to it.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className={styles.skipLink} href="#main">
          Skip to content
        </a>
        <div className={styles.shell}>
          <main className={styles.main} id="main">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}

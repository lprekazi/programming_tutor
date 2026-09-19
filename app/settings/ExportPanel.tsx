'use client'

import { useCallback, useState } from 'react'

import styles from './page.module.css'

/**
 * Taking a copy of everything the tutor has recorded.
 *
 * A button that fetches rather than a plain download link, for one reason: a link that fails
 * navigates the learner to an error page, and "your data could not be collected" belongs next
 * to the button they pressed. The fetch also gives the action a status to announce, which a
 * link has no way to do.
 *
 * Nothing is uploaded anywhere. The file is built by this application, on this machine, and
 * handed to the browser's own download.
 */

type State =
  | { readonly status: 'idle' }
  | { readonly status: 'working' }
  | { readonly status: 'done'; readonly filename: string; readonly size: number }
  | { readonly status: 'failed'; readonly message: string }

const FAILED = 'Your data could not be collected just now. Nothing has been changed — try again.'

/** Bytes, in the units a person reads. */
function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function filenameFrom(header: string | null): string {
  const match = header === null ? null : /filename="([^"]+)"/.exec(header)
  return match?.[1] ?? 'programming-tutor-export.json'
}

export function ExportPanel() {
  const [state, setState] = useState<State>({ status: 'idle' })

  const download = useCallback(() => {
    setState({ status: 'working' })

    void (async () => {
      try {
        const response = await fetch('/api/export', { cache: 'no-store' })
        if (!response.ok) {
          setState({ status: 'failed', message: FAILED })
          return
        }

        const filename = filenameFrom(response.headers.get('content-disposition'))
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)

        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.append(link)
        link.click()
        link.remove()
        // Released on the next tick; revoking immediately cancels the download in some browsers.
        setTimeout(() => {
          URL.revokeObjectURL(url)
        }, 1000)

        setState({ status: 'done', filename, size: blob.size })
      } catch {
        setState({ status: 'failed', message: FAILED })
      }
    })()
  }, [])

  return (
    <div className={styles.panel}>
      <button
        className={styles.secondary}
        data-testid="export-button"
        disabled={state.status === 'working'}
        onClick={download}
        type="button"
      >
        {state.status === 'working' ? 'Collecting…' : 'Download my data'}
      </button>

      {/* Always in the document, so its first message is announced rather than appearing silently. */}
      <p
        aria-live="polite"
        className={state.status === 'idle' ? 'visually-hidden' : styles.status}
        data-testid="export-status"
      >
        {state.status === 'working' && 'Collecting your data.'}
        {state.status === 'done' &&
          `Saved ${state.filename} to your downloads (${sizeWords(state.size)}).`}
        {state.status === 'failed' && state.message}
        {state.status === 'idle' && ''}
      </p>
    </div>
  )
}

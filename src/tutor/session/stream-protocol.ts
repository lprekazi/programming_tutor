/**
 * The one thing the streaming endpoint and the page that reads it have to agree on.
 *
 * A stream can fail after it has started, by which point the HTTP status line is long gone —
 * so the failure has to travel in the body. This marker is what carries it. It is wrapped in
 * NUL bytes, which tutor prose cannot contain, and the client strips it before anything is
 * displayed or stored.
 *
 * Its own module because the client must not import the route handler to learn it: that would
 * pull the database, the provider and the strategies into the browser bundle to share one
 * string.
 */
export const FAILURE_MARKER = '\u0000tutor-stream-failed\u0000'

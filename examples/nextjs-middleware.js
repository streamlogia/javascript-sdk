/**
 * Next.js App Router — edge/server middleware example.
 *
 * Place this file at the root of your Next.js project as `middleware.js`.
 * It fires on every matched request and logs one entry to the ingestor.
 *
 * Note: Next.js middleware runs on the Edge Runtime, so use `fetch` directly
 * (the SDK's built-in fetch works fine there).
 */

import { NextResponse } from 'next/server'

const INGESTOR_URL = process.env.LOGINGESTOR_BASE_URL
const TOKEN = process.env.LOGINGESTOR_TOKEN
const PROJECT_ID = process.env.LOGINGESTOR_PROJECT_ID

export async function middleware(request) {
  const start = Date.now()
  const response = NextResponse.next()

  // We can't hook into response.finish in edge middleware, so we log the
  // incoming request here and attach timing in the header for the client.
  const entry = {
    projectId: PROJECT_ID,
    level: 'INFO',
    message: `${request.method} ${request.nextUrl.pathname}`,
    source: 'nextjs-edge',
    timestamp: new Date().toISOString(),
    tags: ['http', 'nextjs'],
    meta: {
      method: request.method,
      path: request.nextUrl.pathname,
      durationMs: Date.now() - start,
      userAgent: request.headers.get('user-agent'),
    },
  }

  // Fire-and-forget — don't block the response
  fetch(`${INGESTOR_URL}/v1/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([entry]),
  }).catch(() => {
    // Silently swallow — never let logging break the request
  })

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}

#!/usr/bin/env node

import 'dotenv/config'
import crypto from 'crypto'
import express from 'express'
import { Response } from 'express-serve-static-core'
import cookieSession from 'cookie-session'
import dayjs from 'dayjs'
import { h } from 'preact'
import { Readable } from 'stream'
import { addNoStoreHeaders, asyncHandler, CORE_PUBLIC_DIR, errorHandler, isId, log, renderPage } from '@ipp/core'
import { suggestionStore } from '@ipp/suggestions'
import { readConfig, ReviewConfig } from './config'
import { currentUser, finishLogin, requireAdmin, requireCsrf, session, startLogin } from './auth'
import { applyComment, applyDate, applyLocation, applyName, buildReviewPage, ReviewResult } from './review'
import { immich, ImmichError } from './immich'
import { ASSET_VERSION } from './version'
import { MessagePage, ReviewView, SignInPage } from './view/pages'

/*
  The review service: the owner signs in through PocketID, sees what
  visitors have suggested, and applies or declines each suggestion. It shares
  the suggestions database with IPP and holds an Immich API key that can
  write, so it belongs on a private hostname, never next to IPP's public one.
*/

function fail (message: string): never {
  console.error(dayjs().format() + ' FATAL: ' + message)
  process.exit(1)
}

let config: ReviewConfig
try {
  config = readConfig()
} catch (e) {
  fail((e instanceof Error ? e.message : String(e)) + '. See https://github.com/beniwohli/immich-public-proxy/blob/main/docs/review-suggestions.md')
}

const store = suggestionStore() ?? fail('The suggestions database could not be opened; see the error above.')
const https = config.publicUrl.protocol === 'https:'
const inProduction = process.env.NODE_ENV === 'production'

const app = express()
app.disable('x-powered-by')
// Behind a TLS-terminating proxy, so `req.secure` (and the Secure cookie) follow X-Forwarded-Proto
if (https) app.set('trust proxy', true)

for (const dir of ['public', CORE_PUBLIC_DIR]) {
  app.use('/static/' + ASSET_VERSION, express.static(dir, { immutable: inProduction, maxAge: inProduction ? '365d' : 0 }))
  app.use('/static', express.static(dir))
}

app.get('/healthcheck', (_req, res) => {
  addNoStoreHeaders(res)
  res.send('ok')
})

// Everything else is private to the signed-in owner: never cached, never framed
app.use((_req, res, next) => {
  addNoStoreHeaders(res)
  res.set('X-Frame-Options', 'DENY')
  res.set('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self' " + config.issuer.origin)
  res.set('Referrer-Policy', 'same-origin')
  next()
})
app.use(express.urlencoded({ extended: false, limit: '16kb' }))
app.use(cookieSession({
  name: 'ipp-review',
  // Random unless set, so a restart signs the owner out
  secret: process.env.REVIEW_SESSION_SECRET?.trim() || crypto.randomBytes(32).toString('base64url'),
  httpOnly: true,
  sameSite: 'lax',
  secure: https,
  maxAge: config.sessionHours * 3600_000
}))

/*
  [ROUTE] The review page, or the sign-in page for anyone not signed in
*/
app.get('/', asyncHandler(async (req, res) => {
  const user = currentUser(req)
  if (!user) {
    res.send(renderPage(h(SignInPage, {})))
    return
  }
  const s = session(req)
  const flash = s.flash
  delete s.flash
  const page = await buildReviewPage(store)
  res.send(renderPage(h(ReviewView, { page, user, csrf: s.csrf || '', flash, immichUrl: config.immichPublicUrl })))
}))

/**
 * Show a sign-in step that failed because the provider could not be reached
 * or its configuration was refused, rather than a bare error.
 */
function providerTrouble (res: Response, e: unknown) {
  const detail = e instanceof Error ? e.message : String(e)
  log.error('Could not use the sign-in provider at ' + config.issuer.href + ': ' + detail)
  res.status(502).send(renderPage(h(MessagePage, {
    title: 'Sign-in unavailable',
    message: `The sign-in provider at ${config.issuer.href} could not be used: ${detail}. Check OIDC_ISSUER and that this service can reach it.`,
    signIn: true
  })))
}

/*
  [ROUTE] Sign in, and back from PocketID
*/
app.get('/login', asyncHandler(async (req, res) => {
  try {
    await startLogin(config, req, res)
  } catch (e) {
    providerTrouble(res, e)
  }
}))

app.get('/auth/callback', asyncHandler(async (req, res) => {
  let outcome: Awaited<ReturnType<typeof finishLogin>>
  try {
    outcome = await finishLogin(config, req)
  } catch (e) {
    providerTrouble(res, e)
    return
  }
  if (outcome.ok) {
    res.redirect('/')
    return
  }
  res.status(outcome.status).send(renderPage(h(MessagePage, {
    title: outcome.status === 403 ? 'Not allowed' : 'Sign-in failed',
    message: outcome.message,
    signIn: true
  })))
}))

app.post('/logout', requireCsrf, (req, res) => {
  req.session = null
  res.send(renderPage(h(MessagePage, { title: 'Signed out', message: 'You have signed out of the suggestions review.', signIn: true })))
})

/*
  [ROUTE] A photo's preview, for the face crops and thumbnails. Only for a
  photo that has a suggestion, so a signed-in owner can't use this service
  to browse the library either.
*/
app.get('/photo/:id', requireAdmin, asyncHandler(async (req, res) => {
  const id = req.params.id
  if (!isId(id) || !store.hasAsset(id)) {
    res.status(404).end()
    return
  }
  const upstream = await immich.preview(id)
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status === 404 ? 404 : 502).end()
    return
  }
  res.set('Content-Type', upstream.headers.get('Content-Type') || 'image/jpeg')
  // Private: the page is per owner, but the image can stay in their browser
  res.set('Cache-Control', 'private, max-age=3600')
  Readable.fromWeb(upstream.body as import('stream/web').ReadableStream).pipe(res)
}))

/**
 * Run one review action, keep its outcome for the next page view, and go
 * back to the list. An Immich refusal is shown, not thrown.
 */
function action (run: (id: number, by: string, body: Record<string, unknown>) => Promise<ReviewResult> | ReviewResult) {
  return asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const user = currentUser(req)!
    let result: ReviewResult
    try {
      result = Number.isInteger(id) ? await run(id, user.name, req.body || {}) : { ok: false, message: 'Unknown suggestion' }
    } catch (e) {
      if (!(e instanceof ImmichError)) throw e
      log.warn(e.message)
      result = { ok: false, message: e.message + '. Check that the review service\'s API key has the permissions listed in the docs.' }
    }
    session(req).flash = result
    res.redirect(303, '/')
  })
}

const declined = (ok: boolean): ReviewResult => ok
  ? { ok: true, message: 'Declined' }
  : { ok: false, message: 'That suggestion has already been reviewed' }

/*
  [ROUTE] Apply or decline a suggestion
*/
app.post('/names/:id/apply', requireAdmin, requireCsrf, action((id, by) => applyName(store, id, by)))
app.post('/names/:id/decline', requireAdmin, requireCsrf, action((id, by) => declined(store.declineName(id, by))))
app.post('/dates/:id/apply', requireAdmin, requireCsrf, action((id, by, body) => applyDate(store, id, String(body.date ?? ''), by)))
app.post('/dates/:id/decline', requireAdmin, requireCsrf, action((id, by) => declined(store.declineDate(id, by))))
app.post('/locations/:id/apply', requireAdmin, requireCsrf, action((id, by) => applyLocation(store, id, by)))
app.post('/locations/:id/decline', requireAdmin, requireCsrf, action((id, by) => declined(store.declineLocation(id, by))))
app.post('/comments/:id/apply', requireAdmin, requireCsrf, action((id, by) => applyComment(store, id, by)))
app.post('/comments/:id/decline', requireAdmin, requireCsrf, action((id, by) => store.reviewComment(id, 'declined', by)
  ? { ok: true, message: 'Dismissed' }
  : { ok: false, message: 'That comment has already been reviewed' }))

app.all('*', (_req, res) => {
  res.status(404).send('Not found')
})

app.use(errorHandler)

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
process.on('SIGTERM', () => {
  server.close()
  store.close()
  process.exit(0)
})

const port = Number(process.env.IPP_PORT) || 3000
const server = app.listen(port, () => {
  console.log(dayjs().format() + ' Review service started on port ' + port + ', signing in through ' + config.issuer.href)
})

import crypto from 'crypto'
import * as oidc from 'openid-client'
import { NextFunction, Request, Response } from 'express-serve-static-core'
import { log } from '@ipp/core'
import { ReviewConfig } from './config'

/*
  Sign-in through PocketID, or any OpenID Connect provider: the
  authorization code flow with PKCE, a state and a nonce. Only someone whose
  ID token (or userinfo) carries the admin claim gets a session; everyone
  else is turned away at the callback.

  The session lives in a signed cookie (see index.ts). It holds the
  in-progress login while the visitor is at PocketID, then who signed in,
  until when, and a CSRF token for the review forms.
*/

export interface ReviewSession {
  login?: { state: string, nonce: string, verifier: string }
  user?: { sub: string, name: string, expires: number }
  csrf?: string
  flash?: { ok: boolean, message: string }
}

export function session (req: Request): ReviewSession {
  return (req.session || {}) as ReviewSession
}

let discovered: Promise<oidc.Configuration> | undefined

/** The provider's configuration, discovered once and kept; a failure is retried next time. */
function provider (config: ReviewConfig): Promise<oidc.Configuration> {
  discovered ??= oidc.discovery(
    config.issuer,
    config.clientId,
    config.clientSecret,
    undefined,
    // Plain http only for a provider on a trusted network, such as a test setup
    config.issuer.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined
  ).catch((e: Error) => {
    discovered = undefined
    throw e
  })
  return discovered
}

/** Where the provider sends the browser back to; `REVIEW_PUBLIC_URL` may or may not end in a slash. */
export const callbackUrl = (config: Pick<ReviewConfig, 'publicUrl'>) => new URL('auth/callback', config.publicUrl.href.replace(/\/?$/, '/')).href

/** Send the browser to the provider's sign-in page. */
export async function startLogin (config: ReviewConfig, req: Request, res: Response) {
  const verifier = oidc.randomPKCECodeVerifier()
  const login = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier }
  session(req).login = login
  const url = oidc.buildAuthorizationUrl(await provider(config), {
    redirect_uri: callbackUrl(config),
    scope: 'openid profile email',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: login.state,
    nonce: login.nonce
  })
  res.redirect(url.href)
}

/**
 * Whether the claims mark an admin: the claim is the admin value, or a list
 * that holds it.
 */
export function hasAdminClaim (claims: Record<string, unknown> | undefined, config: Pick<ReviewConfig, 'adminClaim' | 'adminValue'>): boolean {
  const value = claims?.[config.adminClaim]
  return Array.isArray(value) ? value.includes(config.adminValue) : value === config.adminValue
}

export type LoginOutcome =
  | { ok: true }
  | { ok: false, status: number, message: string }

/**
 * Finish the sign-in at the callback: exchange the code, check state, nonce
 * and the ID token, then the admin claim (from the ID token, or else from
 * userinfo, where PocketID may put custom claims).
 */
export async function finishLogin (config: ReviewConfig, req: Request): Promise<LoginOutcome> {
  const s = session(req)
  const login = s.login
  delete s.login
  if (!login) return { ok: false, status: 400, message: 'This sign-in has expired. Please start again.' }

  let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>
  const configuration = await provider(config)
  try {
    tokens = await oidc.authorizationCodeGrant(configuration, new URL(req.originalUrl, config.publicUrl), {
      pkceCodeVerifier: login.verifier,
      expectedState: login.state,
      expectedNonce: login.nonce,
      idTokenExpected: true
    })
  } catch (e) {
    log.warn('Sign-in failed: ' + (e instanceof Error ? e.message : String(e)))
    return { ok: false, status: 400, message: 'Sign-in failed. Please start again.' }
  }

  const claims = tokens.claims()
  if (!claims) return { ok: false, status: 400, message: 'Sign-in failed. Please start again.' }
  let admin = hasAdminClaim(claims, config)
  let profile: Record<string, unknown> = claims
  if (!admin) {
    try {
      profile = await oidc.fetchUserInfo(configuration, tokens.access_token, claims.sub)
      admin = hasAdminClaim(profile, config)
    } catch (e) {
      log.warn('Could not read userinfo for ' + claims.sub + ': ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const name = String(profile.name || profile.preferred_username || profile.email || claims.name || claims.email || claims.sub)
  if (!admin) {
    log.warn(`Refused sign-in for ${name}: no ${config.adminClaim}=${config.adminValue} claim`)
    return { ok: false, status: 403, message: `${name} is not an Immich admin, so cannot review suggestions.` }
  }

  s.user = { sub: claims.sub, name, expires: Date.now() + config.sessionHours * 3600_000 }
  s.csrf = crypto.randomBytes(24).toString('base64url')
  log(`${name} signed in to review suggestions`)
  return { ok: true }
}

/** The signed-in admin, or undefined when nobody is, or the sign-in has expired. */
export function currentUser (req: Request): ReviewSession['user'] {
  const user = session(req).user
  return user && user.expires > Date.now() ? user : undefined
}

/** Let the request through only for a signed-in admin. */
export function requireAdmin (req: Request, res: Response, next: NextFunction) {
  if (currentUser(req)) {
    next()
    return
  }
  if (req.method === 'GET') res.redirect(req.baseUrl + '/')
  else res.status(401).send('Sign in first')
}

/**
 * Check the CSRF token on a form. The session cookie is SameSite=Lax, which
 * already keeps other sites' forms out; the token covers older browsers.
 */
export function requireCsrf (req: Request, res: Response, next: NextFunction) {
  const expected = session(req).csrf
  const given = typeof req.body?._csrf === 'string' ? req.body._csrf : ''
  if (expected && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    next()
    return
  }
  res.status(403).send('This form has expired. Go back, reload the page and try again.')
}

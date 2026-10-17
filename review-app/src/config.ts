/*
  The review service is configured by environment variables only: it has no
  settings visitors would see, so no config.json.
*/

export interface ReviewConfig {
  /** This service's own public URL, for the OpenID Connect redirect */
  publicUrl: URL
  /** PocketID (or any OpenID Connect provider) */
  issuer: URL
  clientId: string
  clientSecret: string
  /** The claim that marks an Immich admin, and the value it must have */
  adminClaim: string
  adminValue: string
  /** Immich as the owner reaches it in a browser, for links to photos and people */
  immichPublicUrl?: string
  /** How long a sign-in lasts */
  sessionHours: number
}

const REQUIRED = ['IMMICH_URL', 'IMMICH_API_KEY', 'REVIEW_PUBLIC_URL', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const

function url (name: string, value: string): URL {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    return parsed
  } catch {
    throw new Error(`${name} is not an http(s) URL: ${value}`)
  }
}

const trimSlash = (value: string) => value.trim().replace(/\/+$/, '')

/** Read and check the environment. Throws one error naming every problem. */
export function readConfig (env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const missing = REQUIRED.filter(name => !env[name]?.trim())
  if (missing.length) throw new Error('Missing required environment variables: ' + missing.join(', '))
  const hours = Number(env.REVIEW_SESSION_HOURS || 8)
  return {
    publicUrl: url('REVIEW_PUBLIC_URL', trimSlash(env.REVIEW_PUBLIC_URL!)),
    issuer: url('OIDC_ISSUER', trimSlash(env.OIDC_ISSUER!)),
    clientId: env.OIDC_CLIENT_ID!.trim(),
    clientSecret: env.OIDC_CLIENT_SECRET!.trim(),
    adminClaim: env.OIDC_ADMIN_CLAIM?.trim() || 'immich_role',
    adminValue: env.OIDC_ADMIN_VALUE?.trim() || 'admin',
    immichPublicUrl: env.IMMICH_PUBLIC_URL?.trim() ? trimSlash(env.IMMICH_PUBLIC_URL) : undefined,
    sessionHours: Number.isFinite(hours) && hours > 0 ? hours : 8
  }
}

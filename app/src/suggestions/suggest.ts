import { Asset, createWindowBudget, getConfigOption, getNumericConfigOption, isId, log, SharedLink } from '@ipp/core'
import { findUnidentifiedFace, peopleEnabled } from '../gallery/people'
import { suggestionStore } from './store'

/*
  Visitors suggest a name for an unidentified face, or an approximate date
  for a photo. Everything a visitor sends is checked here before it reaches
  the database: the asset against the share (done by the route), the face
  against what Immich has now, and the name and date against fixed rules.
*/

export const MAX_NAME_LENGTH = 100
export const MIN_YEAR = 1800

export interface SuggestionsAllowed {
  names: boolean
  dates: boolean
}

/**
 * Which suggestions visitors to this share may make. Names need faces, so
 * they follow `peopleEnabled` as well as `ipp.suggestions.names`. Both need
 * the database to be open.
 */
export function suggestionsFor (share: SharedLink): SuggestionsAllowed {
  const names = !!getConfigOption('ipp.suggestions.names', false) && peopleEnabled(share)
  const dates = !!getConfigOption('ipp.suggestions.dates', false)
  if ((!names && !dates) || !suggestionStore()) return { names: false, dates: false }
  return { names, dates }
}

// Bidi controls can make a name display as something other than what it is
const UNSAFE_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069\u2028\u2029]/gu

/** A suggested name, tidied, or undefined when it isn't a usable name. */
export function cleanName (value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.normalize('NFC').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (!name || [...name].length > MAX_NAME_LENGTH) return undefined
  return name
}

const pad = (n: number) => String(n).padStart(2, '0')

function wholeNumber (value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined
}

/**
 * A suggested date as `YYYY-MM` or `YYYY-MM-DD`, or undefined when it isn't
 * a real date between MIN_YEAR and today. Year and month are required; the
 * day is optional.
 */
export function cleanDate (year: unknown, month: unknown, day: unknown, now = new Date()): string | undefined {
  const y = wholeNumber(year)
  const m = wholeNumber(month)
  if (y === undefined || m === undefined) return undefined
  if (y < MIN_YEAR || m < 1 || m > 12) return undefined
  const thisMonth = now.getUTCFullYear() * 12 + now.getUTCMonth()
  if (y * 12 + (m - 1) > thisMonth) return undefined
  if (day === undefined || day === null || day === '') return `${y}-${pad(m)}`
  const d = wholeNumber(day)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  if (d === undefined || d < 1 || d > daysInMonth) return undefined
  if (Date.UTC(y, m - 1, d) > now.getTime()) return undefined
  return `${y}-${pad(m)}-${pad(d)}`
}

export interface SuggestionResult {
  status: number
  body: { ok: true } | { error: string }
  retryAfterSeconds?: number
}

const fail = (status: number, error: string): SuggestionResult => ({ status, body: { error } })

// Created on first use, after the config has been loaded
let rate: ReturnType<typeof createWindowBudget> | undefined

/**
 * Check and save one suggestion for `asset`, which the route has already
 * found in `share`. `body` is the visitor's JSON: `{ kind: 'name', faceId,
 * name }` or `{ kind: 'date', year, month, day? }`. `visitor` keys the rate
 * limit, per address and share like the upload service.
 */
export async function submitSuggestion (share: SharedLink, asset: Asset, body: unknown, visitor: string): Promise<SuggestionResult> {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const allowed = suggestionsFor(share)

  let save: () => void
  if (input.kind === 'name') {
    if (!allowed.names) return fail(404, 'Name suggestions are turned off')
    const faceId = typeof input.faceId === 'string' && isId(input.faceId) ? input.faceId : undefined
    const name = cleanName(input.name)
    if (!faceId) return fail(400, 'Unknown face')
    if (!name) return fail(400, `Enter a name of up to ${MAX_NAME_LENGTH} characters`)
    const face = await findUnidentifiedFace(asset, faceId)
    if (!face) return fail(409, 'This face has been named or removed in the meantime')
    save = () => suggestionStore()!.addName({ assetId: asset.id, faceId, personId: face.personId, name, box: face.box })
  } else if (input.kind === 'date') {
    if (!allowed.dates) return fail(404, 'Date suggestions are turned off')
    const date = cleanDate(input.year, input.month, input.day)
    if (!date) return fail(400, `Enter a year from ${MIN_YEAR} and a month, not in the future`)
    save = () => suggestionStore()!.addDate({ assetId: asset.id, date })
  } else {
    return fail(400, 'Unknown kind of suggestion')
  }

  rate ??= createWindowBudget({ limit: getNumericConfigOption('ipp.suggestions.rateLimit', 30), windowMs: 60_000 })
  const admitted = rate(visitor + ':' + share.key)
  if (!admitted.ok) {
    return { ...fail(429, 'Too many suggestions at once. Try again in a minute.'), retryAfterSeconds: admitted.retryAfterSeconds }
  }

  try {
    save()
  } catch (e) {
    log.error('Could not save a suggestion for asset ' + asset.id + ': ' + (e instanceof Error ? e.message : String(e)))
    return fail(500, 'Your suggestion could not be saved')
  }
  return { status: 200, body: { ok: true } }
}

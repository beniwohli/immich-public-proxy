import { Asset, getConfigOption, getNumericConfigOption, isId, log, SharedLink } from '@ipp/core'
import { createWindowBudget, suggestionStore } from '@ipp/suggestions'
import { findUnidentifiedFace, peopleEnabled } from '../gallery/people'
import { MapConfig } from '../shared/types'

/*
  Visitors suggest a name for an unidentified face, or for a photo an
  approximate date or the place it was taken, or leave a comment on it. Everything a visitor sends is checked here before it reaches
  the database: the asset against the share (done by the route), the face
  against what Immich has now, and the name and date against fixed rules.
*/

export const MAX_NAME_LENGTH = 100
export const MAX_COMMENT_LENGTH = 1000
export const MAX_PLACE_LABEL_LENGTH = 200

export const DEFAULT_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const DEFAULT_MAP_ATTRIBUTION = '© OpenStreetMap contributors'
const DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org'
export const MIN_YEAR = 1800

export interface SuggestionsAllowed {
  names: boolean
  dates: boolean
  comments: boolean
  locations: boolean
}

const NONE: SuggestionsAllowed = { names: false, dates: false, comments: false, locations: false }

/**
 * Which suggestions visitors to this share may make. Names need faces, so
 * they follow `peopleEnabled` as well as `ipp.suggestions.names`. Both need
 * the database to be open.
 */
export function suggestionsFor (share: SharedLink): SuggestionsAllowed {
  const names = !!getConfigOption('ipp.suggestions.names', false) && peopleEnabled(share)
  const dates = !!getConfigOption('ipp.suggestions.dates', false)
  const comments = !!getConfigOption('ipp.suggestions.comments', false)
  const locations = !!getConfigOption('ipp.suggestions.locations', false)
  if ((!names && !dates && !comments && !locations) || !suggestionStore()) return NONE
  return { names, dates, comments, locations }
}

const configString = (path: string, fallback: string) => {
  const value = getConfigOption(path, fallback)
  return typeof value === 'string' ? value.trim() : fallback
}

/**
 * Where the location dialog's map and place search come from. The visitor's
 * browser fetches both directly, sending only this site's origin as the
 * referrer; the share link in the page URL never reaches them. An empty
 * geocoder URL turns the search off. Only the default tiles get the link to
 * OpenStreetMap's copyright page.
 */
export function mapConfig (): MapConfig {
  const tileUrl = configString('ipp.suggestions.mapTileUrl', DEFAULT_MAP_TILE_URL) || DEFAULT_MAP_TILE_URL
  return {
    tileUrl,
    attribution: configString('ipp.suggestions.mapAttribution', DEFAULT_MAP_ATTRIBUTION),
    attributionUrl: tileUrl === DEFAULT_MAP_TILE_URL ? 'https://www.openstreetmap.org/copyright' : undefined,
    geocoderUrl: configString('ipp.suggestions.geocoderUrl', DEFAULT_GEOCODER_URL).replace(/\/+$/, '') || undefined
  }
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

/**
 * A comment, tidied: line breaks kept (at most one blank line in a row),
 * spaces collapsed within each line. Undefined when empty or too long.
 */
export function cleanComment (value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text || [...text].length > MAX_COMMENT_LENGTH) return undefined
  return text
}

/** Coordinates rounded to 6 places (about 10 cm), or undefined when out of range. */
export function cleanCoordinates (latitude: unknown, longitude: unknown): { latitude: number, longitude: number } | undefined {
  const lat = typeof latitude === 'number' ? latitude : NaN
  const lon = typeof longitude === 'number' ? longitude : NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined
  const round = (n: number) => Math.round(n * 1e6) / 1e6
  return { latitude: round(lat), longitude: round(lon) }
}

/** A place's label, tidied like a name; empty when none was given, undefined when too long. */
export function cleanPlaceLabel (value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') return undefined
  const label = value.normalize('NFC').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  return [...label].length > MAX_PLACE_LABEL_LENGTH ? undefined : label
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
 * limit, per address and share like the upload service. A comment is
 * `{ kind: 'comment', comment }`; a place is `{ kind: 'location', latitude,
 * longitude, label? }`.
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
  } else if (input.kind === 'comment') {
    if (!allowed.comments) return fail(404, 'Comments are turned off')
    const comment = cleanComment(input.comment)
    if (!comment) return fail(400, `Write a comment of up to ${MAX_COMMENT_LENGTH} characters`)
    save = () => suggestionStore()!.addComment({ assetId: asset.id, comment })
  } else if (input.kind === 'location') {
    if (!allowed.locations) return fail(404, 'Place suggestions are turned off')
    const point = cleanCoordinates(input.latitude, input.longitude)
    const label = cleanPlaceLabel(input.label)
    if (!point) return fail(400, 'Choose a place on the map')
    if (label === undefined) return fail(400, `Keep the place name to ${MAX_PLACE_LABEL_LENGTH} characters`)
    save = () => suggestionStore()!.addLocation({ assetId: asset.id, ...point, label })
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

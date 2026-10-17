import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { Asset, AssetType, KeyType, loadConfig, SharedLink } from '@ipp/core'
import { cleanComment, cleanCoordinates, cleanDate, cleanName, cleanPlaceLabel, hasPlace, mapConfig, MAX_COMMENT_LENGTH, MAX_NAME_LENGTH, submitSuggestion } from '../src/suggestions/suggest'

/*
  Visitor suggestions are the one place a public visitor writes anything, so
  these cover the input rules, the checks against the share and Immich, the
  rate limit, and that repeats count up instead of adding rows.
*/

const dir = mkdtempSync(join(tmpdir(), 'ipp-suggestions-'))
const dbFile = join(dir, 'suggestions.sqlite')

function rows (table: string) {
  const db = new DatabaseSync(dbFile)
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

function setConfig (suggestions: Record<string, unknown>) {
  process.env.CONFIG = JSON.stringify({ ipp: { showMetadata: { people: { faces: true } }, suggestions } })
  loadConfig()
}

const ASSET_ID = '11111111-1111-4111-8111-111111111111'
const FACE_ID = '22222222-2222-4222-8222-222222222222'
const NAMED_FACE_ID = '33333333-3333-4333-8333-333333333333'

const asset: Asset = { id: ASSET_ID, key: 'k', keyType: KeyType.key, type: AssetType.image, isTrashed: false }
const share = (key: string, overrides: Partial<SharedLink> = {}): SharedLink => ({
  key, keyType: KeyType.key, type: 'INDIVIDUAL', assets: [asset], expiresAt: null, showMetadata: true, ...overrides
})

const immichFaces = [
  { id: FACE_ID, imageWidth: 1000, imageHeight: 1000, boundingBoxX1: 100, boundingBoxX2: 300, boundingBoxY1: 100, boundingBoxY2: 300, person: { id: 'p1', name: '', isHidden: false } },
  { id: NAMED_FACE_ID, imageWidth: 1000, imageHeight: 1000, boundingBoxX1: 500, boundingBoxX2: 700, boundingBoxY1: 100, boundingBoxY2: 300, person: { id: 'p2', name: 'Alice', isHidden: false } }
]

describe('cleanName', () => {
  it('tidies whitespace', () => {
    expect(cleanName('  Anna \n  Muster ')).toBe('Anna Muster')
  })

  it('drops control and bidi override characters', () => {
    const rlo = String.fromCharCode(0x202e)
    expect(cleanName('Ann' + rlo + 'a' + String.fromCharCode(7))).toBe('Ann a')
  })

  it('refuses empty, too long and non-text names', () => {
    expect(cleanName('   ')).toBeUndefined()
    expect(cleanName('x'.repeat(MAX_NAME_LENGTH + 1))).toBeUndefined()
    expect(cleanName(42)).toBeUndefined()
    expect(cleanName('x'.repeat(MAX_NAME_LENGTH))).toHaveLength(MAX_NAME_LENGTH)
  })
})

describe('cleanComment', () => {
  it('keeps line breaks but tidies spaces and blank lines', () => {
    expect(cleanComment('  Grandma\r\n\r\n\r\n\r\nin   Zurich  \n ')).toBe('Grandma\n\nin Zurich')
  })

  it('drops control and bidi override characters', () => {
    expect(cleanComment('a' + String.fromCharCode(0x202e) + 'b' + String.fromCharCode(0))).toBe('a b')
  })

  it('refuses empty, too long and non-text comments', () => {
    expect(cleanComment(' \n ')).toBeUndefined()
    expect(cleanComment('x'.repeat(MAX_COMMENT_LENGTH + 1))).toBeUndefined()
    expect(cleanComment({})).toBeUndefined()
  })
})

describe('places', () => {
  it('rounds coordinates and refuses ones off the globe', () => {
    expect(cleanCoordinates(47.37690123, 8.54170987)).toEqual({ latitude: 47.376901, longitude: 8.54171 })
    expect(cleanCoordinates(91, 0)).toBeUndefined()
    expect(cleanCoordinates(0, -181)).toBeUndefined()
    expect(cleanCoordinates('47', 8)).toBeUndefined()
    expect(cleanCoordinates(NaN, 8)).toBeUndefined()
  })

  it('tells whether Immich has a place, only when the share shows metadata', () => {
    const located = { ...asset, exifInfo: { latitude: 47.37, longitude: 8.54 } }
    const unlocated = { ...asset, exifInfo: { latitude: null, longitude: null } }
    expect(hasPlace(located, share('p'))).toBe(true)
    expect(hasPlace(unlocated, share('p'))).toBe(false)
    // An album grid item, before its detail is fetched
    expect(hasPlace(asset, share('p'))).toBeUndefined()
    // The answer would itself be hidden metadata
    expect(hasPlace(located, share('p', { showMetadata: false }))).toBeUndefined()
  })

  it('takes an optional label, tidied', () => {
    expect(cleanPlaceLabel(undefined)).toBe('')
    expect(cleanPlaceLabel('  Zurich,   Switzerland ')).toBe('Zurich, Switzerland')
    expect(cleanPlaceLabel('x'.repeat(201))).toBeUndefined()
    expect(cleanPlaceLabel(5)).toBeUndefined()
  })

  it('links the attribution only for the default OpenStreetMap tiles', () => {
    loadConfig()
    expect(mapConfig()).toEqual({
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
      geocoderUrl: 'https://nominatim.openstreetmap.org'
    })
    process.env.CONFIG = JSON.stringify({ ipp: { suggestions: { mapTileUrl: 'https://tiles.example.com/{z}/{x}/{y}.png', geocoderUrl: '' } } })
    loadConfig()
    expect(mapConfig()).toMatchObject({ attributionUrl: undefined, geocoderUrl: undefined })
    delete process.env.CONFIG
    loadConfig()
  })
})

describe('cleanDate', () => {
  const now = new Date('2026-10-16T12:00:00Z')

  it('takes a year and month, and a day when given', () => {
    expect(cleanDate(1987, 6, undefined, now)).toBe('1987-06')
    expect(cleanDate('1987', '6', '', now)).toBe('1987-06')
    expect(cleanDate(1987, 6, 14, now)).toBe('1987-06-14')
  })

  it('refuses dates that do not exist', () => {
    expect(cleanDate(1987, 2, 30, now)).toBeUndefined()
    expect(cleanDate(1987, 13, undefined, now)).toBeUndefined()
    expect(cleanDate(1987.5, 1, undefined, now)).toBeUndefined()
    expect(cleanDate(undefined, 1, undefined, now)).toBeUndefined()
    expect(cleanDate(1987, undefined, undefined, now)).toBeUndefined()
  })

  it('accepts 29 February only in a leap year', () => {
    expect(cleanDate(1988, 2, 29, now)).toBe('1988-02-29')
    expect(cleanDate(1987, 2, 29, now)).toBeUndefined()
  })

  it('refuses dates before 1800 or in the future', () => {
    expect(cleanDate(1799, 12, undefined, now)).toBeUndefined()
    expect(cleanDate(2026, 10, undefined, now)).toBe('2026-10')
    expect(cleanDate(2026, 11, undefined, now)).toBeUndefined()
    expect(cleanDate(2026, 10, 17, now)).toBeUndefined()
  })
})

describe('submitSuggestion', () => {
  beforeAll(() => {
    process.env.IPP_SUGGESTIONS_DB = dbFile
    process.env.IMMICH_URL = 'http://immich:2283'
    process.env.IMMICH_API_KEY = 'secret'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => immichFaces })))
  })
  afterAll(() => {
    vi.unstubAllGlobals()
    delete process.env.IPP_SUGGESTIONS_DB
    delete process.env.IMMICH_API_KEY
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setConfig({ names: true, dates: true, comments: true, locations: true, rateLimit: 3 })
  })

  it('saves a name for an unidentified face, with its box and person', async () => {
    const result = await submitSuggestion(share('s1'), asset, { kind: 'name', faceId: FACE_ID, name: ' Anna ' }, '1.2.3.4')
    expect(result).toEqual({ status: 200, body: { ok: true } })
    expect(rows('face_name_suggestions')).toEqual([expect.objectContaining({
      asset_id: ASSET_ID, face_id: FACE_ID, person_id: 'p1', name: 'Anna', box_x: 0.1, box_width: 0.2
    })])
  })

  it('refuses a name for a face that already has one, or does not exist', async () => {
    expect((await submitSuggestion(share('s2'), asset, { kind: 'name', faceId: NAMED_FACE_ID, name: 'Bob' }, 'v')).status).toBe(409)
    expect((await submitSuggestion(share('s2'), asset, { kind: 'name', faceId: '44444444-4444-4444-8444-444444444444', name: 'Bob' }, 'v')).status).toBe(409)
    expect((await submitSuggestion(share('s2'), asset, { kind: 'name', faceId: 'not-an-id', name: 'Bob' }, 'v')).status).toBe(400)
  })

  it('saves a date', async () => {
    const result = await submitSuggestion(share('s3'), asset, { kind: 'date', year: 1987, month: 6 }, 'v')
    expect(result.status).toBe(200)
    expect(rows('date_suggestions')).toEqual([expect.objectContaining({ asset_id: ASSET_ID, date: '1987-06' })])
  })

  it('saves a comment, tidied', async () => {
    const result = await submitSuggestion(share('s7'), asset, { kind: 'comment', comment: ' At the lake \n\n\n 1980s ' }, 'v')
    expect(result.status).toBe(200)
    expect(rows('photo_comments')).toEqual([expect.objectContaining({ asset_id: ASSET_ID, comment: 'At the lake\n\n1980s' })])
    expect((await submitSuggestion(share('s7'), asset, { kind: 'comment', comment: '   ' }, 'v')).status).toBe(400)
  })

  it('saves a place', async () => {
    const result = await submitSuggestion(share('s8'), asset, { kind: 'location', latitude: 47.3769, longitude: 8.5417, label: 'Zurich' }, 'v')
    expect(result.status).toBe(200)
    expect(rows('location_suggestions')).toEqual([expect.objectContaining({ asset_id: ASSET_ID, latitude: 47.3769, longitude: 8.5417, label: 'Zurich' })])
    expect((await submitSuggestion(share('s8'), asset, { kind: 'location', latitude: 100, longitude: 0 }, 'v')).status).toBe(400)
    // Not for a photo Immich already has a place for
    expect((await submitSuggestion(share('s8'), asset, { kind: 'location', latitude: 1, longitude: 2 }, 'v', true)).status).toBe(409)
  })

  it('refuses what the config or the share does not allow', async () => {
    setConfig({ names: false, dates: false })
    expect((await submitSuggestion(share('s4'), asset, { kind: 'date', year: 1987, month: 6 }, 'v')).status).toBe(404)
    expect((await submitSuggestion(share('s4'), asset, { kind: 'comment', comment: 'Hi' }, 'v')).status).toBe(404)
    setConfig({ names: true, dates: true })
    // Names need faces, which follow the share's "Show metadata" toggle
    expect((await submitSuggestion(share('s4', { showMetadata: false }), asset, { kind: 'name', faceId: FACE_ID, name: 'Anna' }, 'v')).status).toBe(404)
    expect((await submitSuggestion(share('s4'), asset, { kind: 'other' }, 'v')).status).toBe(400)
  })

  it('limits suggestions per visitor and share', async () => {
    const body = { kind: 'date', year: 1990, month: 1 }
    for (let i = 0; i < 3; i++) expect((await submitSuggestion(share('s5'), asset, body, 'busy')).status).toBe(200)
    const limited = await submitSuggestion(share('s5'), asset, body, 'busy')
    expect(limited.status).toBe(429)
    expect(limited.retryAfterSeconds).toBeGreaterThan(0)
    // Another visitor, or another share, has its own budget
    expect((await submitSuggestion(share('s5'), asset, body, 'other')).status).toBe(200)
    expect((await submitSuggestion(share('s6'), asset, body, 'busy')).status).toBe(200)
  })
})

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SuggestionStore } from '@ipp/suggestions'
import { applyComment, applyDate, applyLocation, applyName, cleanFullDate, fullDate, planName } from '../src/review'
import { callbackUrl, hasAdminClaim } from '../src/auth'
import { readConfig } from '../src/config'
import { ImmichFace } from '../src/immich'

/*
  The review service writes to Immich on the owner's click. These cover how
  a name is applied for each state a face can be in, that nothing is written
  when the face changed in the meantime, and who is let in.
*/

const unnamed = (personId = 'p-unnamed'): ImmichFace => ({ id: 'f1', imageWidth: 100, imageHeight: 100, person: { id: personId, name: '' } })
const alone: ImmichFace = { id: 'f1', imageWidth: 100, imageHeight: 100, person: null }
const anna = { id: 'p-anna', name: 'Anna' }

describe('planName', () => {
  it('names an unnamed person, or merges it into someone with that name', () => {
    expect(planName(unnamed(), 'Anna', [])).toEqual({ kind: 'rename', personId: 'p-unnamed' })
    expect(planName(unnamed(), 'anna ', [anna])).toEqual({ kind: 'merge', targetId: 'p-anna', sourceId: 'p-unnamed' })
  })

  it('moves a face with no person to someone with that name, or creates them', () => {
    expect(planName(alone, 'Anna', [anna])).toEqual({ kind: 'assign', targetId: 'p-anna' })
    expect(planName(alone, 'Anna', [])).toEqual({ kind: 'create' })
  })

  it('only matches a whole name, and never a hidden person', () => {
    expect(planName(alone, 'Ann', [anna])).toEqual({ kind: 'create' })
    expect(planName(alone, 'Anna', [{ ...anna, isHidden: true }])).toEqual({ kind: 'create' })
  })

  it('applies nothing to a face that is gone, named or hidden', () => {
    expect(planName(undefined, 'Anna', []).kind).toBe('stale')
    expect(planName({ ...alone, person: { id: 'p', name: 'Berta' } }, 'Anna', [])).toEqual({ kind: 'stale', reason: 'Already named Berta in Immich' })
    expect(planName({ ...alone, person: { id: 'p', name: '', isHidden: true } }, 'Anna', []).kind).toBe('stale')
  })
})

describe('dates', () => {
  it('accepts only real dates, not in the future', () => {
    expect(cleanFullDate('1987-06-14')).toBe('1987-06-14')
    expect(cleanFullDate('1987-02-30')).toBeUndefined()
    expect(cleanFullDate('1987-6-1')).toBeUndefined()
    expect(cleanFullDate('2999-01-01')).toBeUndefined()
    expect(cleanFullDate(undefined)).toBeUndefined()
  })

  it('starts a month-only suggestion on the 1st', () => {
    expect(fullDate('1987-06')).toBe('1987-06-01')
    expect(fullDate('1987-06-14')).toBe('1987-06-14')
  })
})

describe('hasAdminClaim', () => {
  const config = { adminClaim: 'immich_role', adminValue: 'admin' }
  it('wants the claim to be admin, or a list holding admin', () => {
    expect(hasAdminClaim({ immich_role: 'admin' }, config)).toBe(true)
    expect(hasAdminClaim({ immich_role: ['user', 'admin'] }, config)).toBe(true)
    expect(hasAdminClaim({ immich_role: 'user' }, config)).toBe(false)
    expect(hasAdminClaim({ immich_role: 'Admin' }, config)).toBe(false)
    expect(hasAdminClaim({}, config)).toBe(false)
    expect(hasAdminClaim(undefined, config)).toBe(false)
  })
})

describe('callbackUrl', () => {
  it('puts the callback under the public URL, with or without a trailing slash', () => {
    expect(callbackUrl({ publicUrl: new URL('https://review.example.com') })).toBe('https://review.example.com/auth/callback')
    expect(callbackUrl({ publicUrl: new URL('https://review.example.com/') })).toBe('https://review.example.com/auth/callback')
  })
})

describe('readConfig', () => {
  const env = {
    IMMICH_URL: 'http://immich:2283',
    IMMICH_API_KEY: 'k',
    REVIEW_PUBLIC_URL: 'https://review.example.com/',
    OIDC_ISSUER: 'https://id.example.com',
    OIDC_CLIENT_ID: 'id',
    OIDC_CLIENT_SECRET: 'secret'
  }

  it('reads the environment, with defaults for the admin claim', () => {
    const config = readConfig(env)
    expect(config.publicUrl.href).toBe('https://review.example.com/')
    expect(config).toMatchObject({ adminClaim: 'immich_role', adminValue: 'admin', sessionHours: 8 })
  })

  it('names every missing variable', () => {
    expect(() => readConfig({ ...env, OIDC_CLIENT_ID: '', IMMICH_API_KEY: undefined }))
      .toThrow('Missing required environment variables: IMMICH_API_KEY, OIDC_CLIENT_ID')
  })

  it('refuses a URL that is not http(s)', () => {
    expect(() => readConfig({ ...env, OIDC_ISSUER: 'pocketid' })).toThrow('OIDC_ISSUER is not an http(s) URL')
  })
})

describe('applying to Immich', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ipp-review-'))
  let store: SuggestionStore
  let fetchMock: ReturnType<typeof vi.fn>
  let face: ImmichFace
  let people: Array<{ id: string, name: string }>
  let description: string | null

  const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body })

  beforeAll(() => {
    process.env.IMMICH_URL = 'http://immich:2283'
    process.env.IMMICH_API_KEY = 'write-key'
  })
  afterAll(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    store = new SuggestionStore(join(dir, `${Math.random()}.sqlite`))
    face = unnamed()
    people = []
    description = null
    fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname
      if (path === '/api/assets/a' && init.method === 'GET') return json({ id: 'a', exifInfo: { description } })
      if (path === '/api/faces') return json([face])
      if (path === '/api/search/person') return json(people)
      if (init.method === 'POST' && path === '/api/people') return json({ id: 'p-new', name: 'x' })
      return json({})
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  const box = { x: 0, y: 0, width: 0.5, height: 0.5 }
  const writes = () => fetchMock.mock.calls
    .filter(([, init]) => init?.method && init.method !== 'GET')
    .map(([url, init]) => `${init.method} ${new URL(url).pathname} ${init.body}`)

  it('names the person, with the write key, and settles the face', async () => {
    store.addName({ assetId: 'a', faceId: 'f1', personId: 'p-unnamed', name: 'Anna', box })
    store.addName({ assetId: 'a', faceId: 'f1', personId: 'p-unnamed', name: 'Berta', box })

    expect(await applyName(store, 1, 'owner')).toEqual({ ok: true, message: 'Named Anna in Immich' })
    expect(writes()).toEqual(['PUT /api/people/p-unnamed {"name":"Anna"}'])
    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('write-key')
    expect(store.nameById(1)).toMatchObject({ status: 'applied', reviewedBy: 'owner' })
    expect(store.nameById(2)).toMatchObject({ status: 'declined' })
  })

  it('creates a person for a face that has none, and moves the face to them', async () => {
    face = alone
    store.addName({ assetId: 'a', faceId: 'f1', name: 'Anna', box })
    await applyName(store, 1, 'owner')
    expect(writes()).toEqual(['POST /api/people {"name":"Anna"}', 'PUT /api/faces/p-new {"id":"f1"}'])
  })

  it('merges into an existing person of that name', async () => {
    people = [anna]
    store.addName({ assetId: 'a', faceId: 'f1', personId: 'p-unnamed', name: 'Anna', box })
    await applyName(store, 1, 'owner')
    expect(writes()).toEqual(['POST /api/people/p-anna/merge {"ids":["p-unnamed"]}'])
  })

  it('writes nothing when the face was named in the meantime', async () => {
    face = { ...alone, person: { id: 'p', name: 'Carl' } }
    store.addName({ assetId: 'a', faceId: 'f1', name: 'Anna', box })
    expect(await applyName(store, 1, 'owner')).toEqual({ ok: false, message: 'Already named Carl in Immich' })
    expect(writes()).toEqual([])
    expect(store.nameById(1)?.status).toBe('pending')
  })

  it('refuses a suggestion that was already reviewed', async () => {
    store.addName({ assetId: 'a', faceId: 'f1', name: 'Anna', box })
    store.declineName(1, 'owner')
    expect((await applyName(store, 1, 'owner')).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sets the date at noon UTC and settles the photo', async () => {
    store.addDate({ assetId: 'a', date: '1987-06' })
    store.addDate({ assetId: 'a', date: '1990-01' })
    expect(await applyDate(store, 1, '1987-06-14', 'owner')).toEqual({ ok: true, message: 'Set the date to 1987-06-14 in Immich' })
    expect(writes()).toEqual(['PUT /api/assets/a {"dateTimeOriginal":"1987-06-14T12:00:00.000+00:00"}'])
    expect([store.dateById(1)?.status, store.dateById(2)?.status]).toEqual(['applied', 'declined'])
  })

  it('appends a comment to the description after a blank line', async () => {
    description = 'Summer holiday'
    store.addComment({ assetId: 'a', comment: 'At the lake in Zurich' })
    expect(await applyComment(store, 1, 'owner')).toEqual({ ok: true, message: 'Added the comment to the description in Immich' })
    expect(writes()).toEqual(['PUT /api/assets/a {"description":"Summer holiday\\n\\nAt the lake in Zurich"}'])
    expect(store.commentById(1)).toMatchObject({ status: 'applied', reviewedBy: 'owner' })
  })

  it('makes a comment the description when there is none, and never adds it twice', async () => {
    store.addComment({ assetId: 'a', comment: 'Wedding' })
    store.addComment({ assetId: 'a', comment: 'Grandpa' })
    await applyComment(store, 1, 'owner')
    expect(writes()).toEqual(['PUT /api/assets/a {"description":"Wedding"}'])
    description = 'Grandpa and Grandma'
    fetchMock.mockClear()
    await applyComment(store, 2, 'owner')
    expect(writes()).toEqual([])
    expect(store.commentById(2)?.status).toBe('applied')
  })

  it('sets the GPS location and settles the photo', async () => {
    store.addLocation({ assetId: 'a', latitude: 47.3769, longitude: 8.5417, label: 'Zurich' })
    store.addLocation({ assetId: 'a', latitude: 46.5, longitude: 9.88, label: '' })
    expect(await applyLocation(store, 1, 'owner')).toEqual({ ok: true, message: 'Set the location to Zurich in Immich' })
    expect(writes()).toEqual(['PUT /api/assets/a {"latitude":47.3769,"longitude":8.5417}'])
    expect([store.locationById(1)?.status, store.locationById(2)?.status]).toEqual(['applied', 'declined'])
    expect((await applyLocation(store, 2, 'owner')).ok).toBe(false)
  })

  it('refuses a date that is not real', async () => {
    store.addDate({ assetId: 'a', date: '1987-06' })
    expect((await applyDate(store, 1, '1987-02-31', 'owner')).ok).toBe(false)
    expect(writes()).toEqual([])
  })
})

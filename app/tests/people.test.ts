import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Asset, AssetType, KeyType, loadConfig, SharedLink } from '@ipp/core'
import { assetFaces, peopleEnabled, sharePeople, toGalleryFaces } from '../src/gallery/people'
import { peopleIndex } from '../src/gallery/builder'

/*
  Recognised people come from Immich with IPP's own API key, since Immich
  hides faces from shared links. These cover the gating, the cut back to the
  share's own assets, and that only names and boxes leave the module.
*/

function setConfig (config: unknown) {
  process.env.CONFIG = JSON.stringify(config)
  loadConfig()
}

const FACES_ON = { ipp: { showMetadata: { people: { faces: true } } } }

function jsonResponse (body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

const asset = (id: string): Asset => ({ id, key: 'k', keyType: KeyType.key, type: AssetType.image, isTrashed: false })

const share = (overrides: Partial<SharedLink> = {}): SharedLink => ({
  key: 'k',
  keyType: KeyType.key,
  type: 'INDIVIDUAL',
  assets: [],
  expiresAt: null,
  showMetadata: true,
  ...overrides
})

const face = (name: string | undefined, extra: Record<string, unknown> = {}) => ({
  imageWidth: 1000,
  imageHeight: 500,
  boundingBoxX1: 100,
  boundingBoxX2: 300,
  boundingBoxY1: 50,
  boundingBoxY2: 250,
  person: name === undefined ? null : { name, isHidden: false, birthDate: '1990-01-01', sharedWith: [{ email: 'x@y.z' }] },
  ...extra
})

describe('peopleEnabled', () => {
  beforeEach(() => {
    delete process.env.CONFIG
    loadConfig()
    process.env.IMMICH_API_KEY = 'secret'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    delete process.env.IMMICH_API_KEY
    vi.restoreAllMocks()
  })

  it('is off by default', () => {
    expect(peopleEnabled(share())).toBe(false)
  })

  it('is on with the flag and an API key', () => {
    setConfig(FACES_ON)
    expect(peopleEnabled(share())).toBe(true)
  })

  it('stays off without an API key', () => {
    setConfig(FACES_ON)
    delete process.env.IMMICH_API_KEY
    expect(peopleEnabled(share())).toBe(false)
  })

  it('follows the share\'s "Show metadata" kill-switch', () => {
    setConfig(FACES_ON)
    expect(peopleEnabled(share({ showMetadata: false }))).toBe(false)
  })
})

describe('toGalleryFaces', () => {
  it('turns boxes into fractions of the image, with the name only', () => {
    expect(toGalleryFaces([face('Alice')])).toEqual([{ name: 'Alice', x: 0.1, y: 0.1, width: 0.2, height: 0.4 }])
  })

  it('drops unnamed, hidden and unassigned faces', () => {
    expect(toGalleryFaces([
      face(undefined),
      face('  '),
      face('Bob', { person: { name: 'Bob', isHidden: true } })
    ])).toEqual([])
  })

  it('clamps boxes to the image and drops empty ones', () => {
    const [clamped] = toGalleryFaces([face('Alice', { boundingBoxX1: -50, boundingBoxX2: 1200 })])
    expect(clamped.x).toBe(0)
    expect(clamped.width).toBe(1)
    expect(toGalleryFaces([face('Alice', { imageWidth: 0 })])).toEqual([])
    expect(toGalleryFaces([face('Alice', { boundingBoxX2: 100 })])).toEqual([])
  })
})

describe('Immich requests', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.IMMICH_URL = 'http://immich:2283'
    process.env.IMMICH_API_KEY = 'secret'
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    delete process.env.IMMICH_API_KEY
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads an asset\'s faces with the API key', async () => {
    fetchMock.mockResolvedValue(jsonResponse([face('Alice')]))
    const faces = await assetFaces(asset('11111111-1111-1111-1111-111111111111'))
    expect(faces).toEqual([{ name: 'Alice', x: 0.1, y: 0.1, width: 0.2, height: 0.4 }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://immich:2283/api/faces?id=11111111-1111-1111-1111-111111111111')
    expect(init.headers['x-api-key']).toBe('secret')
  })

  it('pages through an album search and keeps only the share\'s assets', async () => {
    const albumId = 'aaaaaaaa-0000-0000-0000-000000000001'
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        assets: {
          items: [
            { id: 'a1', people: [{ name: 'Alice' }, { name: 'Bob', isHidden: true }, { name: '' }] },
            { id: 'not-shared', people: [{ name: 'Carol' }] }
          ],
          nextPage: '2'
        }
      }))
      .mockResolvedValueOnce(jsonResponse({
        assets: { items: [{ id: 'a2', people: [{ name: 'Alice' }, { name: 'Dave' }] }], nextPage: null }
      }))

    const people = await sharePeople(share({ type: 'ALBUM', album: { id: albumId }, assets: [asset('a1'), asset('a2')] }))

    expect(people && Object.fromEntries(people)).toEqual({ a1: ['Alice'], a2: ['Alice', 'Dave'] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('http://immich:2283/api/search/metadata')
    expect(init.headers['x-api-key']).toBe('secret')
    expect(JSON.parse(init.body)).toEqual({ albumIds: [albumId], withPeople: true, size: 1000, page: 2 })
  })

  it('gives no filter when the album search fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 403))
    const people = await sharePeople(share({ type: 'ALBUM', album: { id: 'aaaaaaaa-0000-0000-0000-000000000002' }, assets: [asset('a1')] }))
    expect(people).toBeNull()
  })

  it('reads faces per asset for an individual share', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse(url.endsWith('i1') ? [face('Alice'), face('Bob')] : [face(undefined)]))
    const people = await sharePeople(share({ key: 'individual-1', assets: [asset('i1'), asset('i2')] }))
    expect(people && Object.fromEntries(people)).toEqual({ i1: ['Alice', 'Bob'] })
  })
})

describe('peopleIndex', () => {
  it('lists the most-photographed first, then by name, and maps assets to indices', () => {
    const { names, indicesFor } = peopleIndex(new Map([
      ['a', ['Zoe', 'Bob']],
      ['b', ['Bob']],
      ['c', ['Amy']]
    ]))
    expect(names).toEqual(['Bob', 'Amy', 'Zoe'])
    expect(indicesFor('a')).toEqual([2, 0])
    expect(indicesFor('missing')).toBeUndefined()
  })

  it('is empty without data', () => {
    expect(peopleIndex(null).names).toEqual([])
  })
})

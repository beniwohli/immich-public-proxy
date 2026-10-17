import { AlbumType, apiUrl, Asset, buildUrl, cachedPromise, getConfigOption, log, SharedLink, TtlLruCache } from '@ipp/core'
import { FaceBox } from '@ipp/suggestions'
import { GalleryFace } from '../shared/types'

/*
  Recognised faces and people names.

  Immich never returns people to a shared-link key: `GET /assets/:id` clears
  `people` for shared-link auth, and `/faces` / `/people` refuse it. So this
  feature reads them with an operator-supplied API key (`IMMICH_API_KEY`).

  That key can see more than the share does, so every call here is made only
  for an asset or album that the share key has already resolved, and every
  result is cut back to the share's own asset ids before it leaves this
  module. Only the person's display name and the face box reach the visitor;
  Immich's person record also carries birth dates and sharing users.
*/

/** The subset of Immich's `PersonResponseDto` IPP reads. */
interface ImmichPerson {
  id?: string
  name?: string
  isHidden?: boolean
}

/** The subset of Immich's `AssetFaceResponseDto` IPP reads. */
export interface ImmichFace {
  id: string
  imageWidth: number
  imageHeight: number
  boundingBoxX1: number
  boundingBoxX2: number
  boundingBoxY1: number
  boundingBoxY2: number
  person?: ImmichPerson | null
}

interface ImmichSearchResponse {
  assets?: {
    items?: Array<{ id: string, people?: ImmichPerson[] }>
    nextPage?: string | null
  }
}

// Immich's largest metadata-search page, and a ceiling on pages per album
const SEARCH_PAGE_SIZE = 1000
const MAX_SEARCH_PAGES = 200
// Parallel `/faces` requests when an individual share's names are gathered
const FACES_CONCURRENCY = 8

/*
  Faces per asset id. The key is global, so the id alone is the cache key;
  callers have already checked the id against a share. Holds Promises so a
  gallery render and a lightbox open of the same asset share one call.
*/
const facesCache = new TtlLruCache<Promise<ImmichFace[] | null>>({ ttlMs: 120_000, max: 500 })

/* Names per asset id for a whole share, keyed by album id or share key. */
const peopleCache = new TtlLruCache<Promise<Map<string, string[]> | null>>({ ttlMs: 120_000, max: 100 })

let warnedMissingKey = false

/** The Immich API key from `IMMICH_API_KEY`, or undefined when unset. */
export function apiKey (): string | undefined {
  return process.env.IMMICH_API_KEY?.trim() || undefined
}

/**
 * Whether to show recognised people for this share: the operator turned on
 * `ipp.showMetadata.people.faces`, gave IPP an API key, and the share's own
 * "Show metadata" toggle in Immich is not off.
 */
export function peopleEnabled (share: SharedLink): boolean {
  if (share.showMetadata === false) return false
  if (!getConfigOption('ipp.showMetadata.people.faces', false)) return false
  if (!apiKey()) {
    if (!warnedMissingKey) {
      warnedMissingKey = true
      log.warn('ipp.showMetadata.people.faces is on, but IMMICH_API_KEY is not set. Faces stay hidden. ' +
        'See https://github.com/beniwohli/immich-public-proxy/blob/main/docs/config/metadata.md#people')
    }
    return false
  }
  return true
}

/** A person's display name, or undefined for a hidden or unnamed person. */
function personName (person?: ImmichPerson | null): string | undefined {
  if (!person || person.isHidden) return undefined
  return typeof person.name === 'string' ? person.name.trim() || undefined : undefined
}

/** Unique names in first-seen order. */
function uniqueNames (people: Array<ImmichPerson | null | undefined>): string[] {
  const names = people.map(personName).filter((name): name is string => !!name)
  return [...new Set(names)]
}

/**
 * A face nobody has put a name to: no person yet, or a person Immich grouped
 * but nobody named. A face of a hidden person is never offered for naming.
 */
export function isUnidentified (face: ImmichFace): boolean {
  if (!face.person) return true
  return !face.person.isHidden && !personName(face.person)
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))
// Four places is a tenth of a pixel on a 1000px image, and keeps the JSON short
const round = (value: number) => Math.round(value * 10000) / 10000

/** A face's box as fractions of the image, or undefined when it has no usable box. */
export function faceBox (face: ImmichFace): FaceBox | undefined {
  const { imageWidth: w, imageHeight: h } = face
  if (!(w > 0) || !(h > 0)) return undefined
  const x1 = clamp(Math.min(face.boundingBoxX1, face.boundingBoxX2) / w)
  const x2 = clamp(Math.max(face.boundingBoxX1, face.boundingBoxX2) / w)
  const y1 = clamp(Math.min(face.boundingBoxY1, face.boundingBoxY2) / h)
  const y2 = clamp(Math.max(face.boundingBoxY1, face.boundingBoxY2) / h)
  if (!(x2 > x1) || !(y2 > y1)) return undefined
  return { x: round(x1), y: round(y1), width: round(x2 - x1), height: round(y2 - y1) }
}

/**
 * Turn Immich faces into boxes as fractions of the image, so the client can
 * place them over whatever size the image is shown at. Named faces carry the
 * name. Unidentified faces are dropped, or with `includeUnnamed` (visitors
 * may suggest names) kept with their face id so a suggestion can point at
 * one. Faces of hidden people, and faces with no usable box, are dropped.
 */
export function toGalleryFaces (faces: ImmichFace[], includeUnnamed = false): GalleryFace[] {
  const out: GalleryFace[] = []
  for (const face of faces) {
    const box = faceBox(face)
    if (!box) continue
    const name = personName(face.person)
    if (name) out.push({ name, ...box })
    else if (includeUnnamed && face.id && isUnidentified(face)) out.push({ id: face.id, ...box })
  }
  return out
}

function apiKeyHeaders (): Record<string, string> {
  return { 'x-api-key': apiKey() || '', Accept: 'application/json' }
}

/** `GET /faces?id=` for one asset, cached. Null on any failure (not cached). */
function fetchFaces (assetId: string): Promise<ImmichFace[] | null> {
  return cachedPromise(facesCache, assetId, async () => {
    try {
      const res = await fetch(buildUrl(apiUrl() + '/faces', { id: assetId }), { headers: apiKeyHeaders() })
      if (!res.ok) {
        log.warn('Could not read faces for asset ' + assetId + ' (status ' + res.status + '). ' +
          'Check that IMMICH_API_KEY has the face.read permission.')
        return null
      }
      const body = await res.json()
      return Array.isArray(body) ? body as ImmichFace[] : null
    } catch (e) {
      log.warn('Error reading faces for asset ' + assetId + ': ' + (e instanceof Error ? e.message : String(e)))
      return null
    }
  }, (faces) => faces !== null)
}

/**
 * Face boxes for one asset of a share, for the lightbox: named ones, plus
 * unidentified ones with `includeUnnamed`. The caller must have checked the
 * asset against the share. Undefined on failure.
 */
export async function assetFaces (asset: Asset, includeUnnamed = false): Promise<GalleryFace[] | undefined> {
  const faces = await fetchFaces(asset.id)
  return faces ? toGalleryFaces(faces, includeUnnamed) : undefined
}

/**
 * The unidentified face `faceId` on an asset of a share, for checking a name
 * suggestion against what Immich has now. Undefined when the asset has no
 * such face, or it has been named or hidden since the visitor saw it.
 */
export async function findUnidentifiedFace (asset: Asset, faceId: string): Promise<{ box: FaceBox, personId?: string } | undefined> {
  const face = (await fetchFaces(asset.id))?.find(f => f.id === faceId)
  const box = face && isUnidentified(face) ? faceBox(face) : undefined
  return box ? { box, personId: face?.person?.id } : undefined
}

/**
 * Names per asset across an album, from `POST /search/metadata` with
 * `withPeople`, a page of up to 1000 assets per call. Uses the flat request
 * shape, which every Immich 3.x accepts.
 */
async function searchAlbumPeople (albumId: string): Promise<Map<string, string[]> | null> {
  const out = new Map<string, string[]>()
  try {
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const res = await fetch(apiUrl() + '/search/metadata', {
        method: 'POST',
        headers: { ...apiKeyHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ albumIds: [albumId], withPeople: true, size: SEARCH_PAGE_SIZE, page })
      })
      if (!res.ok) {
        log.warn('Could not list people in album ' + albumId + ' (status ' + res.status + '). ' +
          'Check that IMMICH_API_KEY has the asset.read permission and its user can see the album.')
        return null
      }
      const body = await res.json() as ImmichSearchResponse
      for (const item of body.assets?.items || []) {
        const names = uniqueNames(item.people || [])
        if (item.id && names.length) out.set(item.id, names)
      }
      if (!body.assets?.nextPage) return out
    }
    return out
  } catch (e) {
    log.warn('Error listing people in album ' + albumId + ': ' + (e instanceof Error ? e.message : String(e)))
    return null
  }
}

/** Names per asset for an individual share, one `/faces` call per asset. */
async function facesPeople (assets: Asset[]): Promise<Map<string, string[]> | null> {
  const out = new Map<string, string[]>()
  let failed = false
  let next = 0
  const worker = async () => {
    while (next < assets.length) {
      const asset = assets[next++]
      const faces = await fetchFaces(asset.id)
      if (!faces) {
        failed = true
        continue
      }
      const names = uniqueNames(faces.map(face => face.person))
      if (names.length) out.set(asset.id, names)
    }
  }
  await Promise.all(Array.from({ length: Math.min(FACES_CONCURRENCY, assets.length) }, worker))
  // A partial map would make the filter quietly leave photos out
  return failed ? null : out
}

/**
 * Names of the recognised people in each of a share's assets, keyed by asset
 * id, for the gallery's people filter. Only the share's own assets are in the
 * result. Null when Immich could not be asked, so the gallery shows no filter
 * rather than a wrong one.
 */
export async function sharePeople (share: SharedLink): Promise<Map<string, string[]> | null> {
  const albumId = share.type === AlbumType.album ? share.album?.id : undefined
  const cacheKey = albumId ? 'album:' + albumId : 'share:' + share.key
  const all = await cachedPromise(peopleCache, cacheKey,
    () => albumId ? searchAlbumPeople(albumId) : facesPeople(share.assets),
    (map) => map !== null)
  if (!all) return null
  const out = new Map<string, string[]>()
  for (const asset of share.assets) {
    const names = all.get(asset.id)
    if (names) out.set(asset.id, names)
  }
  return out
}

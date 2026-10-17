import { apiUrl, buildUrl } from '@ipp/core'

/*
  Immich calls made with the review service's API key. Unlike IPP's key, this
  one can write: it names people, moves faces and changes dates. Every write
  follows an owner's click on the review page; none is made on a visitor's say.
*/

/** The subset of Immich's `PersonResponseDto` the review service reads. */
export interface ImmichPerson {
  id: string
  name: string
  isHidden?: boolean
}

/** The subset of Immich's `AssetFaceResponseDto` the review service reads. */
export interface ImmichFace {
  id: string
  imageWidth: number
  imageHeight: number
  person: ImmichPerson | null
}

export interface ImmichAsset {
  id: string
  originalFileName?: string
  fileCreatedAt?: string
  localDateTime?: string
  exifInfo?: {
    dateTimeOriginal?: string | null
    timeZone?: string | null
    description?: string | null
    latitude?: number | null
    longitude?: number | null
    city?: string | null
    country?: string | null
  }
}

export class ImmichError extends Error {
  constructor (readonly status: number, message: string) {
    super(message)
  }
}

function headers (): Record<string, string> {
  return { 'x-api-key': process.env.IMMICH_API_KEY?.trim() || '', Accept: 'application/json' }
}

async function call<T> (method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
  const res = await fetch(buildUrl(apiUrl() + path, query), {
    method,
    headers: body === undefined ? headers() : { ...headers(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { message?: string | string[] } | null
    const message = Array.isArray(detail?.message) ? detail.message.join('; ') : detail?.message
    throw new ImmichError(res.status, `Immich answered ${res.status} to ${method} ${path}` + (message ? `: ${message}` : ''))
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

const id = (value: string) => encodeURIComponent(value)

export const immich = {
  faces: (assetId: string) => call<ImmichFace[]>('GET', '/faces', undefined, { id: assetId }),
  asset: (assetId: string) => call<ImmichAsset>('GET', '/assets/' + id(assetId)),
  /** People whose name matches, as Immich's own search finds them (not hidden ones) */
  searchPeople: (name: string) => call<ImmichPerson[]>('GET', '/search/person', undefined, { name }),
  renamePerson: (personId: string, name: string) => call<ImmichPerson>('PUT', '/people/' + id(personId), { name }),
  createPerson: (name: string) => call<ImmichPerson>('POST', '/people', { name }),
  /** Move one face to `personId` */
  assignFace: (personId: string, faceId: string) => call<ImmichPerson>('PUT', '/faces/' + id(personId), { id: faceId }),
  /**
   * Merge `sourceIds` into `targetId`. The per-person endpoint is deprecated
   * since Immich 3.2.1 but, unlike its replacement, every 3.x has it.
   */
  merge: (targetId: string, sourceIds: string[]) => call<unknown>('POST', '/people/' + id(targetId) + '/merge', { ids: sourceIds }),
  setDate: (assetId: string, dateTimeOriginal: string) => call<ImmichAsset>('PUT', '/assets/' + id(assetId), { dateTimeOriginal }),
  setDescription: (assetId: string, description: string) => call<ImmichAsset>('PUT', '/assets/' + id(assetId), { description }),
  setLocation: (assetId: string, latitude: number, longitude: number) => call<ImmichAsset>('PUT', '/assets/' + id(assetId), { latitude, longitude }),
  /** The preview image, as Immich's raw response, for the review page to show */
  preview: (assetId: string) => fetch(buildUrl(apiUrl() + '/assets/' + id(assetId) + '/thumbnail', { size: 'preview' }), { headers: headers() })
}

/*
 * Types shared between the server (Preact SSR) and the client (gallery).
 * Only put a type here if it crosses the server/client boundary - i.e. it
 * describes data the server serialises into the gallery's init JSON block.
 */

/**
 * Per-asset EXIF / location metadata shown in the info sidebar. Each field
 * is optional - the server only includes a field when either the group's
 * `enableAll` is true (`ipp.showMetadata.exif.enableAll` /
 * `.location.enableAll`) or the field's own per-field flag is true.
 * Strings are plain text (the client uses `textContent`, not `innerHTML`).
 */

export type GroupByDateMode = 'month' | 'day'

export interface GalleryExif {
  dateTimeOriginal?: string // ISO date string; client formats with Intl.DateTimeFormat
  timeZone?: string
  fileName?: string
  width?: number
  height?: number
  fileSizeInByte?: number // raw bytes; client formats for display
  make?: string
  model?: string
  lensModel?: string
  exposureTime?: string
  iso?: number
  fNumber?: number
  focalLength?: number
  city?: string
  state?: string
  country?: string
  latitude?: number
  longitude?: number
}

/**
 * One recognised face, as fractions (0-1) of the displayed image so the
 * client can place it at any size. Only sent when
 * `ipp.showMetadata.people.faces` is on (see `gallery/people.ts`). A named
 * face has `name`; an unidentified one has the Immich face `id` instead, and
 * is only sent when visitors may suggest names.
 */
export interface GalleryFace {
  name?: string
  id?: string
  x: number
  y: number
  width: number
  height: number
}

export interface GalleryItem {
  id: string
  type: 'IMAGE' | 'VIDEO'
  previewUrl: string
  fullUrl?: string
  thumbnailUrl: string
  downloadUrl?: string
  // Pre-stringified JSON describing the video source (used to build a <video>
  // element for video slides in the PhotoSwipe lightbox)
  videoData?: string
  // Playback URL for a motion photo's clip, when the asset has one and
  // ipp.motionPhotos is enabled. Drives the tile badge + lightbox toggle.
  motionUrl?: string
  // Immich uses "description" but this is our caption
  description?: string
  downloadFilename: string
  width?: number
  height?: number
  thumbhash?: string
  fileCreatedAt?: string
  // Photographer's local wall-clock timestamp, used for date grouping. See
  // Asset.localDateTime. Falls back to fileCreatedAt when absent.
  localDateTime?: string
  exif?: GalleryExif
  // Recognised people in this item, as indices into InitParams.people. Drives
  // the gallery's people filter.
  people?: number[]
  // Named face boxes for the lightbox. Baked in for individual shares; album
  // items get theirs from the `/meta/` route with the rest of their detail.
  faces?: GalleryFace[]
  // True for album "grid" items whose exif / description / real download
  // filename haven't been loaded yet. The client fetches them from the
  // `/meta/` route the first time the item opens in the lightbox.
  needsDetail?: boolean
}

/**
 * Per-asset detail fetched on demand from the `/meta/` route when a lazy
 * (`needsDetail`) album item opens in the lightbox. Mirrors the subset of a
 * full asset the gallery actually renders. All fields respect the share's
 * `showMetadata` toggle and the operator's `ipp.showMetadata.*` config.
 */
export interface AssetMetadata {
  exif?: GalleryExif
  description?: string
  downloadFilename?: string
  faces?: GalleryFace[]
}

export interface LightboxConfig {
  showArrows: boolean
  showDownload: boolean
  mobileArrows: boolean
  autoPlayVideos: boolean
  options?: Record<string, unknown>
}

/**
 * Metadata-rendering decisions made server-side and forwarded to the client.
 * Whether to render description in each surface, and whether the sidebar
 * has any content the operator wants surfaced (when false, the client skips
 * registering the sidebar + its toolbar toggle entirely).
 */
export interface MetadataConfig {
  descriptionInCaption: boolean
  descriptionInSidebar: boolean
  sidebarHasContent: boolean
  locationWebLink: boolean
  // Label recognised faces in the lightbox
  faces: boolean
}

/** The location dialog's map tiles and place search. See `mapConfig`. */
export interface MapConfig {
  // Leaflet tile URL template, with {z}, {x} and {y}
  tileUrl: string
  // Plain text, shown on the map
  attribution: string
  attributionUrl?: string
  // Nominatim-compatible search; no search box when unset
  geocoderUrl?: string
}

/**
 * What visitors may suggest, and where to send it: `POST <base>/<assetId>`.
 * See `suggestions/suggest.ts`.
 */
export interface SuggestConfig {
  base: string
  names: boolean
  dates: boolean
  comments: boolean
  locations: boolean
  // Only when `locations` is on
  map?: MapConfig
}

/**
 * Shape of the JSON init block embedded in `gallery.tsx` and consumed by
 * `client/init.ts`. The server writes it via `jsonForInlineScript`; the
 * client reads it via `readInitParams()`.
 */
export interface InitParams {
  items?: GalleryItem[]
  openItem?: number
  lightboxConfig?: LightboxConfig
  metadataConfig?: MetadataConfig
  groupByDate?: GroupByDateMode | false
  metaBase?: string
  // Names of the recognised people across the share, sorted, for the people
  // filter. Items refer to them by index.
  people?: string[]
  // Present when visitors may suggest names or dates
  suggest?: SuggestConfig
}

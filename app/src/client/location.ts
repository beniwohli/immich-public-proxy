// Suggest where a photo was taken: a map dialog with a place search. Leaflet
// (vendored, as an ES module) and its stylesheet load the first time the
// dialog opens, so visitors who never use it fetch nothing extra.
//
// Tiles and searches go from the visitor's browser straight to the servers
// in `state.suggest.map` (OpenStreetMap by default). Both requests use the
// `strict-origin` referrer policy: they see this site's origin, never the
// page URL, which carries the share key.

import { state } from './state.js'
import { ICON_SUGGEST_PLACE } from './icons.js'
import { el, openDialog } from './suggest.js'
import type { GalleryItem, MapConfig } from '../shared/types.js'

// Leaflet and PhotoSwipe types are not bundled with the project.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Leaflet = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LightboxInstance = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PswpInstance = any

const MAX_LABEL_LENGTH = 200
// Nominatim allows one search a second
const SEARCH_INTERVAL_MS = 1000
const REFERRER_POLICY: ReferrerPolicy = 'strict-origin'

let leaflet: Promise<Leaflet> | undefined

function loadLeaflet (): Promise<Leaflet> {
  if (!document.querySelector('link[data-leaflet]')) {
    const link = el('link', { rel: 'stylesheet', href: '/share/static/leaflet/leaflet.css' })
    link.dataset.leaflet = ''
    document.head.appendChild(link)
  }
  // @ts-expect-error - runtime URL resolved by Express static
  leaflet ??= import('/share/static/leaflet/leaflet-src.esm.js') // eslint-disable-line import/no-absolute-path
  return leaflet!
}

/** The map's attribution as HTML: the configured text, escaped, linked when there is a URL. */
function attributionHtml (config: MapConfig): string {
  const text = el('span', { textContent: config.attribution }).innerHTML
  if (!config.attributionUrl) return text
  const link = el('a', { href: config.attributionUrl, target: '_blank', rel: 'noopener noreferrer' })
  link.innerHTML = text
  return link.outerHTML
}

interface Place {
  lat: string
  lon: string
  display_name: string
  boundingbox?: [string, string, string, string]
}

/** Ask the visitor where a photo was taken, on a map. */
function suggestPlace (pswp: PswpInstance, item: GalleryItem, config: MapConfig) {
  const mapEl = el('div', { className: 'ipp-place__map' })
  mapEl.setAttribute('role', 'application')
  mapEl.setAttribute('aria-label', 'Map. Click where the photo was taken.')
  const label = el('input', { type: 'text', name: 'label', maxLength: MAX_LABEL_LENGTH, autocomplete: 'off', className: 'ipp-suggest__input' })
  const chosen = el('p', { className: 'ipp-suggest__hint', textContent: 'No place chosen yet' })
  const results = el('ul', { className: 'ipp-place__results', hidden: true })

  const fields: HTMLElement[] = [
    el('p', {
      className: 'ipp-suggest__hint',
      textContent: config.geocoderUrl
        ? 'Search for a place, or click the map where the photo was taken.'
        : 'Click the map where the photo was taken.'
    })
  ]

  let search: HTMLInputElement | undefined
  let searchButton: HTMLButtonElement | undefined
  if (config.geocoderUrl) {
    search = el('input', { type: 'search', name: 'search', autocomplete: 'off', placeholder: 'Town, street, landmark…', className: 'ipp-suggest__input' })
    search.setAttribute('aria-label', 'Search for a place')
    searchButton = el('button', { type: 'button', className: 'ipp-suggest__button', textContent: 'Search' })
    fields.push(el('div', { className: 'ipp-place__search' }, [search, searchButton]), results)
  }
  fields.push(mapEl, chosen, el('label', { className: 'ipp-suggest__label' }, ['Place name (optional)', label]))

  let point: { latitude: number, longitude: number } | undefined
  openDialog(pswp, {
    title: 'Where was this taken?',
    wide: true,
    fields,
    item,
    read: () => point
      ? { kind: 'location', ...point, label: label.value.trim() }
      : 'Click the map to mark the place'
  })

  loadLeaflet().then((L) => {
    if (!mapEl.isConnected) return
    const known = item.exif?.latitude != null && item.exif?.longitude != null
    const map = L.map(mapEl, { worldCopyJump: true })
      .setView(known ? [item.exif!.latitude, item.exif!.longitude] : [30, 10], known ? 13 : 2)
    map.attributionControl.setPrefix(false)
    L.tileLayer(config.tileUrl, {
      maxZoom: 19,
      referrerPolicy: REFERRER_POLICY,
      attribution: attributionHtml(config)
    }).addTo(map)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#4250af'
    let marker: Leaflet

    const choose = (latitude: number, longitude: number, name?: string) => {
      // Wrap a longitude panned past the date line back into -180..180
      const lon = ((longitude + 540) % 360) - 180
      point = { latitude, longitude: lon }
      if (marker) marker.setLatLng([latitude, longitude])
      else marker = L.circleMarker([latitude, longitude], { radius: 9, color: '#fff', weight: 3, fillColor: accent, fillOpacity: 1 }).addTo(map)
      chosen.textContent = `Chosen: ${latitude.toFixed(5)}, ${lon.toFixed(5)}`
      if (name !== undefined) label.value = name.slice(0, MAX_LABEL_LENGTH)
    }
    map.on('click', (e: { latlng: { lat: number, lng: number } }) => choose(e.latlng.lat, e.latlng.lng))

    if (!search || !searchButton || !config.geocoderUrl) return
    let lastSearch = 0
    const runSearch = async () => {
      const q = search!.value.trim()
      if (!q || Date.now() - lastSearch < SEARCH_INTERVAL_MS) return
      lastSearch = Date.now()
      searchButton!.disabled = true
      results.replaceChildren()
      try {
        const params = new URLSearchParams({ q, format: 'jsonv2', limit: '5', 'accept-language': navigator.language })
        const res = await fetch(`${config.geocoderUrl}/search?${params}`, { referrerPolicy: REFERRER_POLICY, headers: { Accept: 'application/json' } })
        const places = res.ok ? await res.json() as Place[] : []
        if (!places.length) results.append(el('li', { className: 'ipp-place__empty', textContent: 'Nothing found. Try another name, or click the map.' }))
        for (const place of places) {
          const button = el('button', { type: 'button', className: 'ipp-place__result', textContent: place.display_name })
          button.addEventListener('click', () => {
            const lat = Number(place.lat)
            const lon = Number(place.lon)
            const box = place.boundingbox?.map(Number)
            if (box && box.every(Number.isFinite)) map.fitBounds([[box[0], box[2]], [box[1], box[3]]], { maxZoom: 16 })
            else map.setView([lat, lon], 15)
            choose(lat, lon, place.display_name)
            results.hidden = true
          })
          results.append(el('li', {}, [button]))
        }
      } catch {
        results.append(el('li', { className: 'ipp-place__empty', textContent: 'The search is not available right now. Click the map instead.' }))
      } finally {
        results.hidden = false
        searchButton!.disabled = false
      }
    }
    searchButton.addEventListener('click', runSearch)
    // Enter searches; it must not send the suggestion
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        runSearch()
      }
    })
  }).catch(() => {
    mapEl.textContent = 'The map could not be loaded.'
  })
}

/** Register the toolbar button that suggests where the current photo was taken. */
export function registerPlaceSuggestion (lightbox: LightboxInstance) {
  const config = state.suggest?.map
  if (!config) return
  lightbox.on('uiRegister', () => {
    lightbox.pswp.ui.registerElement({
      name: 'suggest-place-button',
      order: 4,
      isButton: true,
      html: ICON_SUGGEST_PLACE,
      onInit: (button: HTMLElement, pswp: PswpInstance) => {
        button.setAttribute('aria-label', 'Suggest where this was taken')
        button.setAttribute('title', 'Suggest where this was taken')
        button.addEventListener('click', () => {
          const item = state.items[pswp.currIndex]
          if (item) suggestPlace(pswp, item, config)
        })
      }
    })
  })
}

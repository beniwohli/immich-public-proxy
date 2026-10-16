// Recognised-face labels in the lightbox: a box round each named face with
// the person's name under it, plus a toolbar toggle to hide them. The boxes
// sit in the slide's zoom wrap, so they pan and zoom with the photo. Only
// registered when the server turned faces on (`metadataConfig.faces`).
// When visitors may suggest names, unidentified faces get a dashed box and a
// "Who is this?" button.

import { state, FACES_STORAGE_KEY } from './state.js'
import { ICON_FACES } from './icons.js'
import { suggestName } from './suggest.js'
import type { GalleryFace, GalleryItem } from '../shared/types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LightboxInstance = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PswpInstance = any

const LAYER_CLASS = 'pswp__faces'

// Sticky like the sidebar: a visitor who hides labels keeps them hidden
let facesHidden = readHidden()

function readHidden (): boolean {
  try {
    return localStorage.getItem(FACES_STORAGE_KEY) === '1'
  } catch (e) {
    return false
  }
}

function writeHidden (hidden: boolean) {
  try {
    localStorage.setItem(FACES_STORAGE_KEY, hidden ? '1' : '0')
  } catch (e) {
    // Private mode / quota - the choice lasts for this page only
  }
}

const hasFaces = (item: GalleryItem | undefined) => !!item && item.type !== 'VIDEO' && !!item.faces?.length

// Names this visitor suggested, by face id, shown on the face until reload
const suggested = new Map<string, string>()

/**
 * The label under an unidentified face: the visitor's own suggestion once
 * sent, otherwise a button to make one. PhotoSwipe treats a press anywhere
 * on the slide as a pan or zoom, so the button keeps its events to itself.
 */
function unnamedLabel (pswp: PswpInstance, item: GalleryItem, face: GalleryFace, rerender: () => void): HTMLElement {
  const mine = face.id && suggested.get(face.id)
  if (mine || !state.suggest?.names) {
    const label = document.createElement('span')
    label.className = 'pswp__face-name pswp__face-name--suggested'
    label.textContent = mine ? 'Suggested: ' + mine : '?'
    return label
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'pswp__face-name pswp__face-ask'
  button.textContent = 'Who is this?'
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'click']) {
    button.addEventListener(type, e => e.stopPropagation())
  }
  button.addEventListener('click', () => suggestName(pswp, item, face, (name) => {
    if (face.id) suggested.set(face.id, name)
    rerender()
  }))
  return button
}

/** Build the layer of face boxes for one item, sized to the displayed image. */
function buildLayer (pswp: PswpInstance, item: GalleryItem, width: number, height: number, rerender: () => void): HTMLElement {
  const layer = document.createElement('div')
  layer.className = LAYER_CLASS
  layer.style.width = width + 'px'
  layer.style.height = height + 'px'
  for (const face of item.faces || []) {
    const box = document.createElement('div')
    box.className = face.name ? 'pswp__face' : 'pswp__face pswp__face--unnamed'
    box.style.left = face.x * 100 + '%'
    box.style.top = face.y * 100 + '%'
    box.style.width = face.width * 100 + '%'
    box.style.height = face.height * 100 + '%'
    if (face.name) {
      const label = document.createElement('span')
      label.className = 'pswp__face-name'
      // Plain text from the server; textContent keeps it that way
      label.textContent = face.name
      box.appendChild(label)
    } else {
      box.appendChild(unnamedLabel(pswp, item, face, rerender))
    }
    layer.appendChild(box)
  }
  return layer
}

/**
 * Register the face layer and its toolbar toggle. The toggle hides itself on
 * slides with no named faces.
 */
export function registerFaces (lightbox: LightboxInstance) {
  lightbox.on('uiRegister', () => {
    lightbox.pswp.ui.registerElement({
      name: 'faces-button',
      order: 5,
      isButton: true,
      html: ICON_FACES,
      onInit: (el: HTMLElement, pswp: PswpInstance) => {
        const render = () => {
          pswp.element?.querySelectorAll('.' + LAYER_CLASS).forEach((layer: Element) => layer.remove())
          const item = state.items[pswp.currIndex]
          el.hidden = !hasFaces(item)
          const label = facesHidden ? 'Show names' : 'Hide names'
          el.setAttribute('aria-label', label)
          el.setAttribute('title', label)
          el.setAttribute('aria-pressed', String(!facesHidden))
          const slide = pswp.currSlide
          const content = slide?.content
          if (facesHidden || !hasFaces(item) || !(slide?.container instanceof HTMLElement)) return
          // PhotoSwipe sizes the image to these; until it has, wait for imageSizeChange
          if (!content?.displayedImageWidth || !content?.displayedImageHeight) return
          slide.container.appendChild(buildLayer(pswp, item, content.displayedImageWidth, content.displayedImageHeight, render))
        }

        el.addEventListener('click', () => {
          facesHidden = !facesHidden
          writeHidden(facesHidden)
          render()
        })
        pswp.on('change', render)
        // The displayed size changes on open, resize and after each zoom,
        // when PhotoSwipe swaps in a sharper resolution
        pswp.on('imageSizeChange', (e: { content: unknown }) => {
          if (e.content === pswp.currSlide?.content) render()
        })
        // A lazy album item's faces arrive with its detail, after open
        state.slideRefreshers.push(render)
        render()
      }
    })
  })
}

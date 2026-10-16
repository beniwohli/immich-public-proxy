// Recognised-face labels in the lightbox: a box round each named face with
// the person's name under it, plus a toolbar toggle to hide them. The boxes
// sit in the slide's zoom wrap, so they pan and zoom with the photo. Only
// registered when the server turned faces on (`metadataConfig.faces`).

import { state, FACES_STORAGE_KEY } from './state.js'
import { ICON_FACES } from './icons.js'
import type { GalleryItem } from '../shared/types.js'

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

/** Build the layer of named boxes for one item, sized to the displayed image. */
function buildLayer (item: GalleryItem, width: number, height: number): HTMLElement {
  const layer = document.createElement('div')
  layer.className = LAYER_CLASS
  layer.style.width = width + 'px'
  layer.style.height = height + 'px'
  for (const face of item.faces || []) {
    const box = document.createElement('div')
    box.className = 'pswp__face'
    box.style.left = face.x * 100 + '%'
    box.style.top = face.y * 100 + '%'
    box.style.width = face.width * 100 + '%'
    box.style.height = face.height * 100 + '%'
    const label = document.createElement('span')
    label.className = 'pswp__face-name'
    // Plain text from the server; textContent keeps it that way
    label.textContent = face.name
    box.appendChild(label)
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
          slide.container.appendChild(buildLayer(item, content.displayedImageWidth, content.displayedImageHeight))
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

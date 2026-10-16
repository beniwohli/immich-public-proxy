// Visitor suggestions from the lightbox: a name for an unidentified face
// (opened from the face's "Who is this?" button in faces.ts), and an
// approximate date for the photo (a toolbar button). Each opens a small
// modal form inside the PhotoSwipe root, so it also works in fullscreen,
// and POSTs to the share's suggest route. Only active when the server sent
// `suggest` in the init block.

import { state } from './state.js'
import { ICON_SUGGEST_DATE } from './icons.js'
import type { GalleryFace, GalleryItem } from '../shared/types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LightboxInstance = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PswpInstance = any

const MAX_NAME_LENGTH = 100
const MIN_YEAR = 1800

/** POST a suggestion; resolves to an error message, or null on success. */
async function send (item: GalleryItem, payload: Record<string, unknown>): Promise<string | null> {
  if (!state.suggest) return 'Suggestions are turned off'
  try {
    const res = await fetch(state.suggest.base + '/' + encodeURIComponent(item.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (res.ok) return null
    const body = await res.json().catch(() => null) as { error?: string } | null
    return body?.error || 'Your suggestion could not be sent'
  } catch (e) {
    return 'Your suggestion could not be sent. Check your connection.'
  }
}

/** Create an element, set its properties and append its children. */
function el<K extends keyof HTMLElementTagNameMap> (tag: K, props: Record<string, unknown> = {}, children: Array<Node | string> = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children)
  return node
}

/**
 * Open a modal form in the lightbox. `read` turns the form into a payload,
 * or a message for the visitor when something is missing. The dialog stops
 * key and pointer events at its edge, so typing never pages the lightbox.
 */
function openDialog (pswp: PswpInstance, opts: {
  title: string
  fields: HTMLElement[]
  item: GalleryItem
  read: () => Record<string, unknown> | string
  onSent?: () => void
}) {
  const error = el('p', { className: 'ipp-suggest__error', hidden: true })
  error.setAttribute('role', 'alert')
  const cancel = el('button', { type: 'button', className: 'ipp-suggest__button', textContent: 'Cancel' })
  const submit = el('button', { type: 'submit', className: 'ipp-suggest__button ipp-suggest__button--primary', textContent: 'Send' })
  const form = el('form', { className: 'ipp-suggest__form' }, [
    el('h2', { className: 'ipp-suggest__title', textContent: opts.title }),
    ...opts.fields,
    error,
    el('div', { className: 'ipp-suggest__actions' }, [cancel, submit])
  ])
  const dialog = el('dialog', { className: 'ipp-suggest' }, [form])

  for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'wheel', 'click']) {
    dialog.addEventListener(type, e => e.stopPropagation())
  }
  // Focus can leave the dialog (its content is replaced after sending), and a
  // key then reaches PhotoSwipe directly: Escape would close the lightbox too
  const ignoreKeys = (e: { preventDefault: () => void }) => e.preventDefault()
  pswp.on('keydown', ignoreKeys)
  dialog.addEventListener('close', () => {
    pswp.off('keydown', ignoreKeys)
    dialog.remove()
  })
  cancel.addEventListener('click', () => dialog.close())
  // A click on the backdrop lands on the dialog itself
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close() })
  pswp.on('destroy', () => dialog.close())

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const payload = opts.read()
    if (typeof payload === 'string') {
      error.textContent = payload
      error.hidden = false
      return
    }
    submit.disabled = true
    error.hidden = true
    const failure = await send(opts.item, payload)
    submit.disabled = false
    if (failure) {
      error.textContent = failure
      error.hidden = false
      return
    }
    opts.onSent?.()
    const close = el('button', { type: 'button', className: 'ipp-suggest__button ipp-suggest__button--primary', textContent: 'Close', onclick: () => dialog.close() })
    form.replaceChildren(
      el('h2', { className: 'ipp-suggest__title', textContent: 'Thank you' }),
      el('p', { className: 'ipp-suggest__hint', textContent: 'Your suggestion has been sent to the owner of these photos.' }),
      el('div', { className: 'ipp-suggest__actions' }, [close])
    )
    close.focus()
  })

  pswp.element.appendChild(dialog)
  dialog.showModal()
}

/** A crop of the photo around one face, so the visitor sees who they are naming. */
function facePreview (item: GalleryItem, face: GalleryFace): HTMLElement {
  const preview = el('div', { className: 'ipp-suggest__face' })
  preview.style.backgroundImage = `url("${item.previewUrl}")`
  preview.style.backgroundSize = `${100 / face.width}% ${100 / face.height}%`
  const position = (start: number, size: number) => size >= 1 ? 0 : (start / (1 - size)) * 100
  preview.style.backgroundPosition = `${position(face.x, face.width)}% ${position(face.y, face.height)}%`
  if (item.width && item.height) {
    preview.style.aspectRatio = String((face.width * item.width) / (face.height * item.height))
  }
  return preview
}

/**
 * Ask the visitor who an unidentified face is. `onSent` gets the name, so
 * the face can show it as this visitor's suggestion.
 */
export function suggestName (pswp: PswpInstance, item: GalleryItem, face: GalleryFace, onSent: (name: string) => void) {
  if (!face.id) return
  const input = el('input', {
    type: 'text',
    name: 'name',
    required: true,
    maxLength: MAX_NAME_LENGTH,
    autocomplete: 'off',
    className: 'ipp-suggest__input'
  })
  // Offer the names already in the share, so a known person is spelled the same
  const listId = 'ipp-suggest-people'
  if (state.people.length) input.setAttribute('list', listId)
  const fields: HTMLElement[] = [
    facePreview(item, face),
    el('label', { className: 'ipp-suggest__label' }, ['Name', input])
  ]
  if (state.people.length) {
    fields.push(el('datalist', { id: listId }, state.people.map(name => el('option', { value: name }))))
  }

  openDialog(pswp, {
    title: 'Who is this?',
    fields,
    item,
    read: () => {
      const name = input.value.trim()
      if (!name) return 'Enter a name'
      return { kind: 'name', faceId: face.id, name }
    },
    onSent: () => onSent(input.value.trim())
  })
  input.focus()
}

/** Ask the visitor when a photo was taken: year and month, day if known. */
function suggestDate (pswp: PswpInstance, item: GalleryItem) {
  const thisYear = new Date().getFullYear()
  const year = el('input', {
    type: 'number',
    name: 'year',
    required: true,
    min: String(MIN_YEAR),
    max: String(thisYear),
    placeholder: String(thisYear),
    inputMode: 'numeric',
    className: 'ipp-suggest__input'
  })
  const monthNames = new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' })
  const month = el('select', { name: 'month', required: true, className: 'ipp-suggest__input' }, [
    el('option', { value: '', textContent: 'Month' }),
    ...Array.from({ length: 12 }, (_, i) =>
      el('option', { value: String(i + 1), textContent: monthNames.format(new Date(Date.UTC(2000, i, 1))) }))
  ])
  const day = el('input', {
    type: 'number',
    name: 'day',
    min: '1',
    max: '31',
    inputMode: 'numeric',
    className: 'ipp-suggest__input'
  })

  openDialog(pswp, {
    title: 'When was this taken?',
    fields: [
      el('p', { className: 'ipp-suggest__hint', textContent: 'A rough guess is fine. Leave the day empty if you don\'t know it.' }),
      el('div', { className: 'ipp-suggest__row' }, [
        el('label', { className: 'ipp-suggest__label' }, ['Year', year]),
        el('label', { className: 'ipp-suggest__label' }, ['Month', month]),
        el('label', { className: 'ipp-suggest__label ipp-suggest__label--short' }, ['Day', day])
      ])
    ],
    item,
    read: () => {
      const y = Number(year.value)
      if (!Number.isInteger(y) || y < MIN_YEAR || y > thisYear) return `Enter a year between ${MIN_YEAR} and ${thisYear}`
      if (!month.value) return 'Choose a month'
      const payload: Record<string, unknown> = { kind: 'date', year: y, month: Number(month.value) }
      if (day.value) payload.day = Number(day.value)
      return payload
    }
  })
  year.focus()
}

/** Register the toolbar button that suggests a date for the current photo. */
export function registerDateSuggestion (lightbox: LightboxInstance) {
  lightbox.on('uiRegister', () => {
    lightbox.pswp.ui.registerElement({
      name: 'suggest-date-button',
      order: 4,
      isButton: true,
      html: ICON_SUGGEST_DATE,
      onInit: (el: HTMLElement, pswp: PswpInstance) => {
        el.setAttribute('aria-label', 'Suggest when this was taken')
        el.setAttribute('title', 'Suggest when this was taken')
        el.addEventListener('click', () => {
          const item = state.items[pswp.currIndex]
          if (item) suggestDate(pswp, item)
        })
      }
    })
  })
}

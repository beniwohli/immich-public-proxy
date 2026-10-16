// Gallery people filter: a row of name chips under the header, rendered by
// the server when the share has recognised people. Picking names narrows
// `state.items` to the items that show every picked person, the same as
// picking several people in Immich's own search; layout, tiles and the
// lightbox then work on the narrowed list.

import { state } from './state.js'
import { exitSelectMode } from './selection.js'
import { refreshLightboxItems } from './lightbox.js'
import { relayout } from './virtualisation.js'

/**
 * Wire the filter chips. No-op when the page has no filter bar (faces off,
 * or nobody named in the share).
 */
export function setupPeopleFilter () {
  const bar = document.getElementById('people-filter')
  if (!bar || !state.people.length) return
  bar.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('.person-chip')
    if (!chip || chip.disabled) return
    const person = Number(chip.dataset.person)
    if (state.peopleFilter.has(person)) state.peopleFilter.delete(person)
    else state.peopleFilter.add(person)
    applyFilter(bar)
  })
}

function applyFilter (bar: HTMLElement) {
  const picked = [...state.peopleFilter]
  state.items = picked.length
    ? state.allItems.filter(item => picked.every(person => item.people?.includes(person)))
    : state.allItems

  // Selections and tile indices refer to the old list
  exitSelectMode()
  refreshLightboxItems()
  relayout()

  // Who else appears in what is on show; anyone else would empty the gallery
  const present = new Set<number>()
  for (const item of state.items) item.people?.forEach(person => present.add(person))
  for (const chip of bar.querySelectorAll<HTMLButtonElement>('.person-chip')) {
    const person = Number(chip.dataset.person)
    const pressed = state.peopleFilter.has(person)
    chip.setAttribute('aria-pressed', String(pressed))
    chip.disabled = !pressed && !present.has(person)
  }

  updateCount()
}

function updateCount () {
  const el = document.getElementById('item-count')
  if (!el) return
  const total = state.allItems.length
  const shown = state.items.length
  const noun = total === 1 ? 'item' : 'items'
  el.textContent = shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`
}

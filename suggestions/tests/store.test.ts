import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { SuggestionStore } from '../src/store'

/*
  The suggestions file is shared by IPP, which adds suggestions, and the
  review service, which settles them. These cover both sides and that a file
  made by an older release still opens.
*/

const dir = mkdtempSync(join(tmpdir(), 'ipp-store-'))
let n = 0
const freshFile = () => join(dir, `s${n++}.sqlite`)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
const name = (faceId: string, value: string, personId?: string) => ({ assetId: 'a', faceId, personId, name: value, box })

describe('SuggestionStore', () => {
  it('counts a repeated suggestion up instead of adding a row, ignoring case', () => {
    const store = new SuggestionStore(freshFile())
    store.addName(name('f', 'Anna', 'p'), new Date('2026-01-01T00:00:00Z'))
    store.addName(name('f', 'anna', 'p'), new Date('2026-01-02T00:00:00Z'))
    store.addName(name('f', 'Berta', 'p'))
    store.addDate({ assetId: 'a', date: '1987-06' })
    store.addDate({ assetId: 'a', date: '1987-06' })

    const [anna, berta] = store.pendingNames().sort((x, y) => x.id - y.id)
    expect(anna).toMatchObject({
      name: 'Anna',
      personId: 'p',
      box,
      timesSuggested: 2,
      status: 'pending',
      firstSuggestedAt: '2026-01-01T00:00:00.000Z',
      lastSuggestedAt: '2026-01-02T00:00:00.000Z'
    })
    expect(berta).toMatchObject({ name: 'Berta', timesSuggested: 1 })
    expect(store.pendingDates()).toEqual([expect.objectContaining({ date: '1987-06', timesSuggested: 2 })])
    store.close()
  })

  it('declines one suggestion, once, and a repeat does not reopen it', () => {
    const store = new SuggestionStore(freshFile())
    store.addName(name('f', 'Anna'))
    const [row] = store.pendingNames()
    expect(store.declineName(row.id, 'admin@example.com')).toBe(true)
    expect(store.declineName(row.id, 'admin@example.com')).toBe(false)
    store.addName(name('f', 'Anna'))
    expect(store.pendingNames()).toEqual([])
    expect(store.nameById(row.id)).toMatchObject({ status: 'declined', reviewedBy: 'admin@example.com', timesSuggested: 2 })
    store.close()
  })

  it('settles every pending name for the face and its person when one is applied', () => {
    const store = new SuggestionStore(freshFile())
    store.addName(name('f1', 'Anna', 'p'))
    store.addName(name('f1', 'Berta', 'p'))
    // Another face of the same person, in another photo
    store.addName({ ...name('f2', 'ANNA', 'p'), assetId: 'b' })
    // An unrelated face stays pending
    store.addName(name('f3', 'Carl', 'q'))

    store.settleName({ faceId: 'f1', personId: 'p', name: 'Anna' }, 'admin')

    const statuses = Object.fromEntries([1, 2, 3, 4].map(id => [store.nameById(id)!.name, store.nameById(id)!.status]))
    expect(statuses).toEqual({ Anna: 'applied', Berta: 'declined', ANNA: 'applied', Carl: 'pending' })
    store.close()
  })

  it('settles every pending date for the photo when one is applied', () => {
    const store = new SuggestionStore(freshFile())
    store.addDate({ assetId: 'a', date: '1987-06' })
    store.addDate({ assetId: 'a', date: '1988-01' })
    store.addDate({ assetId: 'b', date: '1990-01' })

    store.settleDate({ assetId: 'a', date: '1987-06-14' }, 'admin')

    expect([1, 2, 3].map(id => store.dateById(id)!.status)).toEqual(['applied', 'declined', 'pending'])
    store.close()
  })

  it('upgrades a file made before suggestions had a review status', () => {
    const file = freshFile()
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE face_name_suggestions (id INTEGER PRIMARY KEY, asset_id TEXT NOT NULL, face_id TEXT NOT NULL,
        person_id TEXT, name TEXT NOT NULL COLLATE NOCASE, box_x REAL NOT NULL, box_y REAL NOT NULL,
        box_width REAL NOT NULL, box_height REAL NOT NULL, times_suggested INTEGER NOT NULL DEFAULT 1,
        first_suggested_at TEXT NOT NULL, last_suggested_at TEXT NOT NULL, UNIQUE (asset_id, face_id, name));
      CREATE TABLE date_suggestions (id INTEGER PRIMARY KEY, asset_id TEXT NOT NULL, date TEXT NOT NULL,
        times_suggested INTEGER NOT NULL DEFAULT 1, first_suggested_at TEXT NOT NULL, last_suggested_at TEXT NOT NULL,
        UNIQUE (asset_id, date));
      INSERT INTO date_suggestions (asset_id, date, first_suggested_at, last_suggested_at) VALUES ('a', '1987-06', 'x', 'x');
      PRAGMA user_version = 1;
    `)
    old.close()

    const store = new SuggestionStore(file)
    expect(store.pendingDates()).toEqual([expect.objectContaining({ date: '1987-06', status: 'pending' })])
    store.close()
    // Opening an up-to-date file again changes nothing
    new SuggestionStore(file).close()
  })
})

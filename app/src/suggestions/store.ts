import { DatabaseSync } from 'node:sqlite'
import { log } from '@ipp/core'
import { FaceBox } from '../gallery/people'

/*
  Visitor suggestions: names for unidentified faces, and approximate dates for
  photos. They are kept in a SQLite file for the owner to review; nothing is
  written back to Immich.

  A repeat of the same suggestion counts up `times_suggested` on its row
  instead of adding another, so the file stays small and the owner can see
  how many visitors agree.
*/

export const DEFAULT_DB_PATH = '/var/data/suggestions.sqlite'

/** Where the suggestions database lives: `IPP_SUGGESTIONS_DB`, or the default. */
export function dbPath (): string {
  return process.env.IPP_SUGGESTIONS_DB?.trim() || DEFAULT_DB_PATH
}

export interface NameSuggestion {
  assetId: string
  faceId: string
  // Immich's group for the face, when it has one, so a name can be applied
  // to every face of that person at once
  personId?: string
  name: string
  box: FaceBox
}

export interface DateSuggestion {
  assetId: string
  // `YYYY-MM` or `YYYY-MM-DD`
  date: string
}

// Bumped with each schema change; `migrate` brings older files up to date
const SCHEMA_VERSION = 1

export class SuggestionStore {
  private readonly db: DatabaseSync

  constructor (path: string) {
    this.db = new DatabaseSync(path)
    // A second IPP process on the same file waits for the lock instead of failing
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  private migrate () {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version >= SCHEMA_VERSION) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS face_name_suggestions (
        id INTEGER PRIMARY KEY,
        asset_id TEXT NOT NULL,
        face_id TEXT NOT NULL,
        person_id TEXT,
        name TEXT NOT NULL COLLATE NOCASE,
        box_x REAL NOT NULL,
        box_y REAL NOT NULL,
        box_width REAL NOT NULL,
        box_height REAL NOT NULL,
        times_suggested INTEGER NOT NULL DEFAULT 1,
        first_suggested_at TEXT NOT NULL,
        last_suggested_at TEXT NOT NULL,
        UNIQUE (asset_id, face_id, name)
      );
      CREATE TABLE IF NOT EXISTS date_suggestions (
        id INTEGER PRIMARY KEY,
        asset_id TEXT NOT NULL,
        date TEXT NOT NULL,
        times_suggested INTEGER NOT NULL DEFAULT 1,
        first_suggested_at TEXT NOT NULL,
        last_suggested_at TEXT NOT NULL,
        UNIQUE (asset_id, date)
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
  }

  addName (suggestion: NameSuggestion, now = new Date()) {
    const at = now.toISOString()
    this.db.prepare(`
      INSERT INTO face_name_suggestions
        (asset_id, face_id, person_id, name, box_x, box_y, box_width, box_height, first_suggested_at, last_suggested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (asset_id, face_id, name) DO UPDATE SET
        times_suggested = times_suggested + 1,
        last_suggested_at = excluded.last_suggested_at
    `).run(suggestion.assetId, suggestion.faceId, suggestion.personId ?? null, suggestion.name,
      suggestion.box.x, suggestion.box.y, suggestion.box.width, suggestion.box.height, at, at)
  }

  addDate (suggestion: DateSuggestion, now = new Date()) {
    const at = now.toISOString()
    this.db.prepare(`
      INSERT INTO date_suggestions (asset_id, date, first_suggested_at, last_suggested_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (asset_id, date) DO UPDATE SET
        times_suggested = times_suggested + 1,
        last_suggested_at = excluded.last_suggested_at
    `).run(suggestion.assetId, suggestion.date, at, at)
  }

  close () {
    this.db.close()
  }
}

// undefined: not opened yet; null: opening failed, don't retry every request
let store: SuggestionStore | null | undefined

/**
 * The shared store, opened on first use. Null when the file can't be opened
 * (most often: no volume mounted at its folder), logged once.
 */
export function suggestionStore (): SuggestionStore | null {
  if (store !== undefined) return store
  const path = dbPath()
  try {
    store = new SuggestionStore(path)
    log('Saving visitor suggestions to ' + path)
  } catch (e) {
    store = null
    log.error('Could not open the suggestions database at ' + path + ': ' + (e instanceof Error ? e.message : String(e)) +
      '. Suggestions are off. Mount a writable volume at that folder, or set IPP_SUGGESTIONS_DB. ' +
      'See https://docs.ipp.nz/config/suggestions')
  }
  return store
}

import { DatabaseSync } from 'node:sqlite'
import { log } from '@ipp/core'

/*
  Visitor suggestions: names for unidentified faces, and for photos an
  approximate date, the place it was taken, and free-text comments. IPP adds them as visitors send them; the review service lists the
  pending ones, and marks each applied or declined as the owner decides.

  A repeat of the same suggestion counts up `times_suggested` on its row
  instead of adding another, so the file stays small and the owner can see
  how many visitors agree. A repeat leaves the row's status alone: a name the
  owner declined stays declined.

  Both services open the same file. SQLite's own locking keeps their writes
  apart; `busy_timeout` makes one wait for the other instead of failing.
*/

export const DEFAULT_DB_PATH = '/var/data/suggestions.sqlite'

/** Where the suggestions database lives: `IPP_SUGGESTIONS_DB`, or the default. */
export function dbPath (): string {
  return process.env.IPP_SUGGESTIONS_DB?.trim() || DEFAULT_DB_PATH
}

/** A face's box as fractions (0-1) of the image. */
export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
}

export type SuggestionStatus = 'pending' | 'applied' | 'declined'

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

export interface PhotoComment {
  assetId: string
  comment: string
}

export interface LocationSuggestion {
  assetId: string
  latitude: number
  longitude: number
  // What the visitor searched for or chose, such as a place name; may be empty
  label: string
}

interface Reviewed {
  id: number
  timesSuggested: number
  firstSuggestedAt: string
  lastSuggestedAt: string
  status: SuggestionStatus
  reviewedAt: string | null
  reviewedBy: string | null
}

export type NameSuggestionRow = NameSuggestion & Reviewed
export type DateSuggestionRow = DateSuggestion & Reviewed
export type PhotoCommentRow = PhotoComment & Reviewed
export type LocationSuggestionRow = LocationSuggestion & Reviewed

/*
  Each entry brings a file from the version before it to its own version, so
  a file made by any release opens in any later one.
*/
const MIGRATIONS = [
  `
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
  `,
  `
    ALTER TABLE face_name_suggestions ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE face_name_suggestions ADD COLUMN reviewed_at TEXT;
    ALTER TABLE face_name_suggestions ADD COLUMN reviewed_by TEXT;
    CREATE INDEX face_name_suggestions_status ON face_name_suggestions (status, asset_id);
    ALTER TABLE date_suggestions ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE date_suggestions ADD COLUMN reviewed_at TEXT;
    ALTER TABLE date_suggestions ADD COLUMN reviewed_by TEXT;
    CREATE INDEX date_suggestions_status ON date_suggestions (status, asset_id);
  `,
  `
    CREATE TABLE photo_comments (
      id INTEGER PRIMARY KEY,
      asset_id TEXT NOT NULL,
      comment TEXT NOT NULL,
      times_suggested INTEGER NOT NULL DEFAULT 1,
      first_suggested_at TEXT NOT NULL,
      last_suggested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at TEXT,
      reviewed_by TEXT,
      UNIQUE (asset_id, comment)
    );
    CREATE INDEX photo_comments_status ON photo_comments (status, asset_id);
  `,
  `
    CREATE TABLE location_suggestions (
      id INTEGER PRIMARY KEY,
      asset_id TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      times_suggested INTEGER NOT NULL DEFAULT 1,
      first_suggested_at TEXT NOT NULL,
      last_suggested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at TEXT,
      reviewed_by TEXT,
      UNIQUE (asset_id, latitude, longitude)
    );
    CREATE INDEX location_suggestions_status ON location_suggestions (status, asset_id);
  `
]

const REVIEWED_COLUMNS = `
  id, times_suggested AS timesSuggested, first_suggested_at AS firstSuggestedAt,
  last_suggested_at AS lastSuggestedAt, status, reviewed_at AS reviewedAt, reviewed_by AS reviewedBy
`
const NAME_COLUMNS = `
  asset_id AS assetId, face_id AS faceId, person_id AS personId, name,
  box_x AS x, box_y AS y, box_width AS width, box_height AS height, ${REVIEWED_COLUMNS}
`
const DATE_COLUMNS = `asset_id AS assetId, date, ${REVIEWED_COLUMNS}`
const COMMENT_COLUMNS = `asset_id AS assetId, comment, ${REVIEWED_COLUMNS}`
const LOCATION_COLUMNS = `asset_id AS assetId, latitude, longitude, label, ${REVIEWED_COLUMNS}`

type NameRow = Omit<NameSuggestionRow, 'box' | 'personId'> & FaceBox & { personId: string | null }

function toNameRow ({ x, y, width, height, personId, ...rest }: NameRow): NameSuggestionRow {
  return { ...rest, personId: personId ?? undefined, box: { x, y, width, height } }
}

export class SuggestionStore {
  private readonly db: DatabaseSync

  constructor (path: string) {
    this.db = new DatabaseSync(path)
    // The other service may hold the lock for a moment; wait instead of failing
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  private migrate () {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let next = version; next < MIGRATIONS.length; next++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[next])
        this.db.exec(`PRAGMA user_version = ${next + 1}`)
      })
    }
  }

  private transaction<T> (work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
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

  /** Add a visitor's comment on a photo; the exact same text again counts up instead. */
  addComment (comment: PhotoComment, now = new Date()) {
    const at = now.toISOString()
    this.db.prepare(`
      INSERT INTO photo_comments (asset_id, comment, first_suggested_at, last_suggested_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (asset_id, comment) DO UPDATE SET
        times_suggested = times_suggested + 1,
        last_suggested_at = excluded.last_suggested_at
    `).run(comment.assetId, comment.comment, at, at)
  }

  /** Pending comments, oldest first within each photo so they read in order. */
  pendingComments (): PhotoCommentRow[] {
    return this.db.prepare(`
      SELECT ${COMMENT_COLUMNS} FROM photo_comments WHERE status = 'pending'
      ORDER BY (SELECT MAX(last_suggested_at) FROM photo_comments c WHERE c.asset_id = photo_comments.asset_id AND c.status = 'pending') DESC,
        asset_id, first_suggested_at
    `).all() as unknown as PhotoCommentRow[]
  }

  commentById (id: number): PhotoCommentRow | undefined {
    return this.db.prepare(`SELECT ${COMMENT_COLUMNS} FROM photo_comments WHERE id = ?`).get(id) as unknown as PhotoCommentRow | undefined
  }

  /**
   * Mark one pending comment applied (added to the photo's description) or
   * declined (dismissed). False when it was not pending.
   */
  reviewComment (id: number, status: 'applied' | 'declined', by: string, now = new Date()): boolean {
    return this.db.prepare(`
      UPDATE photo_comments SET status = ?, reviewed_at = ?, reviewed_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, now.toISOString(), by, id).changes > 0
  }

  /**
   * Add a visitor's place for a photo. The same point again counts up, and
   * keeps the first label that was given.
   */
  addLocation (location: LocationSuggestion, now = new Date()) {
    const at = now.toISOString()
    this.db.prepare(`
      INSERT INTO location_suggestions (asset_id, latitude, longitude, label, first_suggested_at, last_suggested_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (asset_id, latitude, longitude) DO UPDATE SET
        times_suggested = times_suggested + 1,
        last_suggested_at = excluded.last_suggested_at,
        label = CASE WHEN label = '' THEN excluded.label ELSE label END
    `).run(location.assetId, location.latitude, location.longitude, location.label, at, at)
  }

  /** Pending places, most-agreed first within each photo. */
  pendingLocations (): LocationSuggestionRow[] {
    return this.db.prepare(`
      SELECT ${LOCATION_COLUMNS} FROM location_suggestions WHERE status = 'pending'
      ORDER BY last_suggested_at DESC, asset_id, times_suggested DESC
    `).all() as unknown as LocationSuggestionRow[]
  }

  locationById (id: number): LocationSuggestionRow | undefined {
    return this.db.prepare(`SELECT ${LOCATION_COLUMNS} FROM location_suggestions WHERE id = ?`).get(id) as unknown as LocationSuggestionRow | undefined
  }

  /** Decline one pending place. False when it was not pending. */
  declineLocation (id: number, by: string, now = new Date()): boolean {
    return this.db.prepare(`
      UPDATE location_suggestions SET status = 'declined', reviewed_at = ?, reviewed_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(now.toISOString(), by, id).changes > 0
  }

  /**
   * Record that place `id` was applied to its photo: it counts as applied,
   * every other pending place for that photo as declined.
   */
  settleLocation (id: number, by: string, now = new Date()) {
    this.db.prepare(`
      UPDATE location_suggestions
      SET status = CASE WHEN id = ? THEN 'applied' ELSE 'declined' END, reviewed_at = ?, reviewed_by = ?
      WHERE status = 'pending' AND asset_id = (SELECT asset_id FROM location_suggestions WHERE id = ?)
    `).run(id, now.toISOString(), by, id)
  }

  /** Pending name suggestions, most-agreed first within each face. */
  pendingNames (): NameSuggestionRow[] {
    const rows = this.db.prepare(`
      SELECT ${NAME_COLUMNS} FROM face_name_suggestions WHERE status = 'pending'
      ORDER BY last_suggested_at DESC, asset_id, face_id, times_suggested DESC
    `).all() as unknown as NameRow[]
    return rows.map(toNameRow)
  }

  /** Pending date suggestions, most-agreed first within each photo. */
  pendingDates (): DateSuggestionRow[] {
    return this.db.prepare(`
      SELECT ${DATE_COLUMNS} FROM date_suggestions WHERE status = 'pending'
      ORDER BY last_suggested_at DESC, asset_id, times_suggested DESC
    `).all() as unknown as DateSuggestionRow[]
  }

  nameById (id: number): NameSuggestionRow | undefined {
    const row = this.db.prepare(`SELECT ${NAME_COLUMNS} FROM face_name_suggestions WHERE id = ?`).get(id) as unknown as NameRow | undefined
    return row && toNameRow(row)
  }

  dateById (id: number): DateSuggestionRow | undefined {
    return this.db.prepare(`SELECT ${DATE_COLUMNS} FROM date_suggestions WHERE id = ?`).get(id) as unknown as DateSuggestionRow | undefined
  }

  /** Whether any suggestion, pending or reviewed, is for this photo. */
  hasAsset (assetId: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM face_name_suggestions WHERE asset_id = ?
      UNION ALL SELECT 1 FROM date_suggestions WHERE asset_id = ?
      UNION ALL SELECT 1 FROM photo_comments WHERE asset_id = ?
      UNION ALL SELECT 1 FROM location_suggestions WHERE asset_id = ? LIMIT 1
    `).get(assetId, assetId, assetId, assetId)
  }

  /** Decline one pending name suggestion. False when it was not pending. */
  declineName (id: number, by: string, now = new Date()): boolean {
    return this.db.prepare(`
      UPDATE face_name_suggestions SET status = 'declined', reviewed_at = ?, reviewed_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(now.toISOString(), by, id).changes > 0
  }

  /** Decline one pending date suggestion. False when it was not pending. */
  declineDate (id: number, by: string, now = new Date()): boolean {
    return this.db.prepare(`
      UPDATE date_suggestions SET status = 'declined', reviewed_at = ?, reviewed_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(now.toISOString(), by, id).changes > 0
  }

  /**
   * Record that `name` was applied to a face, and so to its whole person.
   * Every pending suggestion for that face or person is settled: the same
   * name counts as applied, any other name as declined.
   */
  settleName (applied: { faceId: string, personId?: string, name: string }, by: string, now = new Date()) {
    this.db.prepare(`
      UPDATE face_name_suggestions
      SET status = CASE WHEN name = ? THEN 'applied' ELSE 'declined' END, reviewed_at = ?, reviewed_by = ?
      WHERE status = 'pending' AND (face_id = ? OR (person_id IS NOT NULL AND person_id = ?))
    `).run(applied.name, now.toISOString(), by, applied.faceId, applied.personId ?? null)
  }

  /**
   * Record that a date was applied to a photo. Every pending date for it is
   * settled: the applied one, or one it starts with (`1987-06` for
   * `1987-06-14`), as applied; the rest as declined.
   */
  settleDate (applied: { assetId: string, date: string }, by: string, now = new Date()) {
    this.db.prepare(`
      UPDATE date_suggestions
      SET status = CASE WHEN ? = date OR substr(?, 1, length(date)) = date THEN 'applied' ELSE 'declined' END,
        reviewed_at = ?, reviewed_by = ?
      WHERE status = 'pending' AND asset_id = ?
    `).run(applied.date, applied.date, now.toISOString(), by, applied.assetId)
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
    log('Using the suggestions database at ' + path)
  } catch (e) {
    store = null
    log.error('Could not open the suggestions database at ' + path + ': ' + (e instanceof Error ? e.message : String(e)) +
      '. Mount a writable volume at that folder, or set IPP_SUGGESTIONS_DB. ' +
      'See https://github.com/beniwohli/immich-public-proxy/blob/main/docs/config/suggestions.md#storage')
  }
  return store
}

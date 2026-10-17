import { DateSuggestionRow, FaceBox, NameSuggestionRow, SuggestionStore } from '@ipp/suggestions'
import { immich, ImmichAsset, ImmichFace, ImmichPerson } from './immich'

/*
  What a suggestion would do to Immich, worked out from what Immich has now
  rather than from what the visitor saw. The page shows the plan next to each
  suggestion, and applying works the plan out again first, so a face that
  was named in the meantime is never overwritten.
*/

export type NamePlan =
  /** The face's person has no name yet: name it, which names all its faces */
  | { kind: 'rename', personId: string }
  /** Someone already has this name: merge the face's unnamed person into them */
  | { kind: 'merge', targetId: string, sourceId: string }
  /** The face has no person, and someone has this name: move the face to them */
  | { kind: 'assign', targetId: string }
  /** The face has no person, and nobody has this name: create the person */
  | { kind: 'create' }
  /** Nothing to apply any more; only declining is offered */
  | { kind: 'stale', reason: string }

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

/**
 * Work out how to give `face` the name `name`. `face` is undefined when
 * Immich no longer has it; `named` are the people Immich found by that name.
 */
export function planName (face: ImmichFace | undefined, name: string, named: ImmichPerson[]): NamePlan {
  if (!face) return { kind: 'stale', reason: 'This face is no longer in Immich' }
  const person = face.person
  if (person?.isHidden) return { kind: 'stale', reason: 'This face belongs to a person hidden in Immich' }
  if (person?.name.trim()) return { kind: 'stale', reason: `Already named ${person.name} in Immich` }
  const match = named.find(p => !p.isHidden && sameName(p.name, name))
  if (person) return match ? { kind: 'merge', targetId: match.id, sourceId: person.id } : { kind: 'rename', personId: person.id }
  return match ? { kind: 'assign', targetId: match.id } : { kind: 'create' }
}

/** Carry out a plan for `faceId`. Throws an ImmichError when Immich refuses. */
export async function applyNamePlan (plan: NamePlan, faceId: string, name: string): Promise<void> {
  switch (plan.kind) {
    case 'rename':
      await immich.renamePerson(plan.personId, name)
      return
    case 'merge':
      await immich.merge(plan.targetId, [plan.sourceId])
      return
    case 'assign':
      await immich.assignFace(plan.targetId, faceId)
      return
    case 'create': {
      const person = await immich.createPerson(name)
      await immich.assignFace(person.id, faceId)
      return
    }
    case 'stale':
      throw new Error(plan.reason)
  }
}

export type ReviewResult = { ok: true, message: string } | { ok: false, message: string }

/** Apply name suggestion `id` to Immich, then settle every suggestion it decides. */
export async function applyName (store: SuggestionStore, id: number, by: string): Promise<ReviewResult> {
  const row = store.nameById(id)
  if (!row || row.status !== 'pending') return { ok: false, message: 'That suggestion has already been reviewed' }
  const faces = await immich.faces(row.assetId)
  const face = faces.find(f => f.id === row.faceId)
  const plan = planName(face, row.name, await immich.searchPeople(row.name))
  if (plan.kind === 'stale') return { ok: false, message: plan.reason }
  await applyNamePlan(plan, row.faceId, row.name)
  store.settleName({ faceId: row.faceId, personId: row.personId ?? face?.person?.id, name: row.name }, by)
  return { ok: true, message: `Named ${row.name} in Immich` }
}

/** A real calendar date as `YYYY-MM-DD`, or undefined. */
export function cleanFullDate (value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined
  if (date.getTime() > Date.now()) return undefined
  return value
}

/** The first day a suggested date can mean, for the date field: `1987-06` gives `1987-06-01`. */
export const fullDate = (suggested: string) => suggested.length === 7 ? suggested + '-01' : suggested

/**
 * Set a photo's date in Immich to `date` (`YYYY-MM-DD`, chosen by the owner
 * from suggestion `id`), then settle every pending date for that photo.
 * Noon UTC keeps the day the same in every time zone Immich might show it in.
 */
export async function applyDate (store: SuggestionStore, id: number, date: string, by: string): Promise<ReviewResult> {
  const row = store.dateById(id)
  if (!row || row.status !== 'pending') return { ok: false, message: 'That suggestion has already been reviewed' }
  const clean = cleanFullDate(date)
  if (!clean) return { ok: false, message: 'Choose a real date, not in the future' }
  await immich.setDate(row.assetId, `${clean}T12:00:00.000+00:00`)
  store.settleDate({ assetId: row.assetId, date: clean }, by)
  return { ok: true, message: `Set the date to ${clean} in Immich` }
}

// ----- the review page ---------------------------------------------------

export interface NameChoice {
  row: NameSuggestionRow
  plan: NamePlan
}

export interface FaceReview {
  assetId: string
  faceId: string
  box: FaceBox
  // width / height of the face's crop, when Immich still has the face
  aspect?: number
  currentPersonId?: string
  choices: NameChoice[]
}

export interface DateReview {
  assetId: string
  fileName?: string
  // The date Immich has now, as it stores it
  current?: string
  choices: DateSuggestionRow[]
}

export interface ReviewPage {
  faces: FaceReview[]
  dates: DateReview[]
  // Pending counts, including any beyond the page
  pendingFaces: number
  pendingDates: number
  // Photos Immich could not be asked about, so their plans are unknown
  errors: string[]
}

export const PAGE_SIZE = 40

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T, R> (items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Group rows by a key, keeping the order each key first appears in. */
function groupBy<T> (rows: T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const group = groups.get(k)
    if (group) group.push(row)
    else groups.set(k, [row])
  }
  return [...groups.values()]
}

const byVotes = <T extends { timesSuggested: number }>(a: T, b: T) => b.timesSuggested - a.timesSuggested

/**
 * Everything pending, as the review page shows it: name suggestions grouped
 * by face, dates grouped by photo, most recently suggested first, each with
 * what Immich has now. Up to PAGE_SIZE groups of each.
 */
export async function buildReviewPage (store: SuggestionStore): Promise<ReviewPage> {
  const faceGroups = groupBy(store.pendingNames(), row => row.faceId)
  const dateGroups = groupBy(store.pendingDates(), row => row.assetId)
  const errors: string[] = []

  // One request per photo and per name, shared across the page
  const facesByAsset = new Map<string, Promise<ImmichFace[] | null>>()
  const facesOf = (assetId: string) => {
    let pending = facesByAsset.get(assetId)
    if (!pending) {
      pending = immich.faces(assetId).catch((e: Error) => { errors.push(e.message); return null })
      facesByAsset.set(assetId, pending)
    }
    return pending
  }
  const peopleByName = new Map<string, Promise<ImmichPerson[]>>()
  const peopleNamed = (name: string) => {
    const key = name.trim().toLocaleLowerCase()
    let pending = peopleByName.get(key)
    if (!pending) {
      pending = immich.searchPeople(name).catch((e: Error) => { errors.push(e.message); return [] })
      peopleByName.set(key, pending)
    }
    return pending
  }

  const faces = await mapLimit(faceGroups.slice(0, PAGE_SIZE), 6, async (rows): Promise<FaceReview> => {
    const first = rows[0]
    const assetFaces = await facesOf(first.assetId)
    const face = assetFaces?.find(f => f.id === first.faceId)
    const choices = await Promise.all(rows.sort(byVotes).map(async row => ({
      row,
      plan: assetFaces
        ? planName(face, row.name, await peopleNamed(row.name))
        : { kind: 'stale', reason: 'Immich could not be asked about this photo' } as NamePlan
    })))
    return {
      assetId: first.assetId,
      faceId: first.faceId,
      box: first.box,
      aspect: face ? (first.box.width * face.imageWidth) / (first.box.height * face.imageHeight) : undefined,
      currentPersonId: face?.person?.id,
      choices
    }
  })

  const dates = await mapLimit(dateGroups.slice(0, PAGE_SIZE), 6, async (rows): Promise<DateReview> => {
    const asset: ImmichAsset | null = await immich.asset(rows[0].assetId).catch((e: Error) => { errors.push(e.message); return null })
    return {
      assetId: rows[0].assetId,
      fileName: asset?.originalFileName,
      current: asset?.exifInfo?.dateTimeOriginal || asset?.localDateTime || undefined,
      choices: rows.sort(byVotes)
    }
  })

  return { faces, dates, pendingFaces: faceGroups.length, pendingDates: dateGroups.length, errors: [...new Set(errors)] }
}

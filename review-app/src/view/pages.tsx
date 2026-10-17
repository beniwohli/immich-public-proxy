import { ComponentChildren } from 'preact'
import { ThemeScript } from '@ipp/core'
import { ASSET_VERSION } from '../version'
import { DateReview, FaceReview, fullDate, NamePlan, ReviewPage } from '../review'

interface LayoutProps {
  title: string
  user?: { name: string }
  csrf?: string
  children: ComponentChildren
}

function Layout ({ title, user, csrf, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <ThemeScript/>
        <meta charSet="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <meta name="robots" content="noindex"/>
        <title>{title}</title>
        <link rel="icon" href="/static/favicon.ico" type="image/x-icon"/>
        <link rel="stylesheet" href={`/static/${ASSET_VERSION}/theme.css`}/>
        <link rel="stylesheet" href={`/static/${ASSET_VERSION}/review.css`}/>
      </head>
      <body>
        <header id="header">
          <div class="header-text">
            <h1>{title}</h1>
            {user && <p class="subtitle">Signed in as {user.name}</p>}
          </div>
          {user && csrf && (
            <form method="post" action="/logout" class="header-actions">
              <input type="hidden" name="_csrf" value={csrf}/>
              <button type="submit" class="button">Sign out</button>
            </form>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}

export function SignInPage () {
  return (
    <Layout title="Suggestions">
      <section class="panel">
        <p>Review the names and dates visitors have suggested for your shared photos, and apply the ones you agree with to Immich.</p>
        <a class="button button--primary" href="/login">Sign in with PocketID</a>
      </section>
    </Layout>
  )
}

export function MessagePage ({ title, message, signIn }: { title: string, message: string, signIn?: boolean }) {
  return (
    <Layout title={title}>
      <section class="panel">
        <p>{message}</p>
        {signIn && <a class="button" href="/login">Sign in again</a>}
      </section>
    </Layout>
  )
}

interface ReviewViewProps {
  page: ReviewPage
  user: { name: string }
  csrf: string
  flash?: { ok: boolean, message: string }
  immichUrl?: string
}

const photoLink = (immichUrl: string | undefined, assetId: string) => immichUrl ? `${immichUrl}/photos/${encodeURIComponent(assetId)}` : undefined
const personLink = (immichUrl: string | undefined, personId: string) => immichUrl ? `${immichUrl}/people/${encodeURIComponent(personId)}` : undefined

function Hidden ({ csrf }: { csrf: string }) {
  return <input type="hidden" name="_csrf" value={csrf}/>
}

function Votes ({ count }: { count: number }) {
  return <span class="votes">{count === 1 ? '1 visitor' : `${count} visitors`}</span>
}

/** What applying a name will do in Immich, in words. */
function planText (plan: NamePlan, name: string): string {
  switch (plan.kind) {
    case 'rename': return `Names this person ${name}, in every photo they are in`
    case 'merge': return `Merges this person into the existing ${name}`
    case 'assign': return `Adds this face to the existing ${name}`
    case 'create': return `Creates ${name} with this face`
    case 'stale': return plan.reason
  }
}

/** The face, cropped from the photo's preview with the stored box. */
function FaceCrop ({ review }: { review: FaceReview }) {
  const { x, y, width, height } = review.box
  const position = (start: number, size: number) => size >= 1 ? 0 : (start / (1 - size)) * 100
  const style = {
    backgroundImage: `url("/photo/${encodeURIComponent(review.assetId)}")`,
    backgroundSize: `${100 / width}% ${100 / height}%`,
    backgroundPosition: `${position(x, width)}% ${position(y, height)}%`,
    aspectRatio: review.aspect ? String(review.aspect) : '1'
  }
  return <div class="face" style={style} role="img" aria-label="The face to name"/>
}

function FaceCard ({ review, csrf, immichUrl }: { review: FaceReview, csrf: string, immichUrl?: string }) {
  const photo = photoLink(immichUrl, review.assetId)
  const person = review.currentPersonId && personLink(immichUrl, review.currentPersonId)
  return (
    <article class="card">
      <div class="card__media">
        <FaceCrop review={review}/>
        <div class="card__links">
          {photo && <a href={photo} target="_blank" rel="noopener noreferrer">Photo in Immich</a>}
          {person && <a href={person} target="_blank" rel="noopener noreferrer">Person in Immich</a>}
        </div>
      </div>
      <ul class="choices">
        {review.choices.map(({ row, plan }) => (
          <li class="choice" key={row.id}>
            <div class="choice__text">
              <strong>{row.name}</strong> <Votes count={row.timesSuggested}/>
              <p class={plan.kind === 'stale' ? 'plan plan--stale' : 'plan'}>{planText(plan, row.name)}</p>
            </div>
            <div class="choice__actions">
              {plan.kind !== 'stale' && (
                <form method="post" action={`/names/${row.id}/apply`}>
                  <Hidden csrf={csrf}/>
                  <button type="submit" class="button button--primary">Apply</button>
                </form>
              )}
              <form method="post" action={`/names/${row.id}/decline`}>
                <Hidden csrf={csrf}/>
                <button type="submit" class="button">Decline</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </article>
  )
}

const today = () => new Date().toISOString().slice(0, 10)

/** A suggested date in words: `1987-06` as "June 1987", `1987-06-14` as "14 June 1987". */
function dateText (date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const value = new Date(Date.UTC(y, m - 1, d || 1))
  return new Intl.DateTimeFormat('en-GB', d ? { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(value)
}

function DateCard ({ review, csrf, immichUrl }: { review: DateReview, csrf: string, immichUrl?: string }) {
  const photo = photoLink(immichUrl, review.assetId)
  return (
    <article class="card">
      <div class="card__media">
        <img class="thumb" src={`/photo/${encodeURIComponent(review.assetId)}`} alt={review.fileName || 'The photo'} loading="lazy"/>
        <div class="card__links">
          {photo && <a href={photo} target="_blank" rel="noopener noreferrer">Photo in Immich</a>}
        </div>
        <p class="current">Now in Immich: {review.current ? review.current.slice(0, 10) : 'no date'}</p>
      </div>
      <ul class="choices">
        {review.choices.map(row => (
          <li class="choice" key={row.id}>
            <div class="choice__text">
              <strong>{dateText(row.date)}</strong> <Votes count={row.timesSuggested}/>
              {row.date.length === 7 && <p class="plan">No day given; pick one, or keep the 1st</p>}
            </div>
            <div class="choice__actions">
              <form method="post" action={`/dates/${row.id}/apply`} class="date-form">
                <Hidden csrf={csrf}/>
                <input type="date" name="date" value={fullDate(row.date)} max={today()} required aria-label="Date to set"/>
                <button type="submit" class="button button--primary">Apply</button>
              </form>
              <form method="post" action={`/dates/${row.id}/decline`}>
                <Hidden csrf={csrf}/>
                <button type="submit" class="button">Decline</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </article>
  )
}

function More ({ shown, total }: { shown: number, total: number }) {
  return total > shown ? <p class="more">Showing {shown} of {total}. Review these to see the rest.</p> : null
}

export function ReviewView ({ page, user, csrf, flash, immichUrl }: ReviewViewProps) {
  const nothing = !page.faces.length && !page.dates.length
  return (
    <Layout title="Suggestions" user={user} csrf={csrf}>
      {flash && <p class={flash.ok ? 'flash' : 'flash flash--error'} role="status">{flash.message}</p>}
      {page.errors.map(error => <p class="flash flash--error" key={error}>{error}</p>)}
      {nothing && <section class="panel"><p>Nothing to review. New suggestions appear here as visitors send them.</p></section>}
      {page.faces.length > 0 && (
        <section>
          <h2>Names <span class="count">{page.pendingFaces}</span></h2>
          <More shown={page.faces.length} total={page.pendingFaces}/>
          {page.faces.map(review => <FaceCard key={review.faceId} review={review} csrf={csrf} immichUrl={immichUrl}/>)}
        </section>
      )}
      {page.dates.length > 0 && (
        <section>
          <h2>Dates <span class="count">{page.pendingDates}</span></h2>
          <More shown={page.dates.length} total={page.pendingDates}/>
          {page.dates.map(review => <DateCard key={review.assetId} review={review} csrf={csrf} immichUrl={immichUrl}/>)}
        </section>
      )}
    </Layout>
  )
}

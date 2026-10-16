---
prefix: ipp.suggestions
---

# Suggestions

Visitors can help identify old or undated photos: they suggest a name for a face nobody has named yet, and when a
photo was taken. Configured under `ipp.suggestions`. Both are off by default.

IPP does not change anything in Immich. Suggestions are saved to a SQLite database for you to review, and you apply
the ones you agree with in Immich yourself.

## Example

Let visitors suggest names and dates:

```json
{
  "ipp": {
    "showMetadata": {
      "people": { "faces": true }
    },
    "suggestions": {
      "names": true,
      "dates": true
    }
  }
}
```

## `names`

**Type:** `bool` · **Default:** `false`

Show a dashed box with a "Who is this?" button on each face in the lightbox that has no name in Immich, and let visitors suggest one. Needs [`showMetadata.people.faces`](/config/metadata#people) and its API key, as the faces come from there.

Faces of people you have hidden in Immich are never offered. Before saving, IPP checks with Immich that the face is
still there and still has no name. The name field offers the names already in the share, so a known person keeps the
same spelling.

## `dates`

**Type:** `bool` · **Default:** `false`

Add a calendar button to the lightbox toolbar for suggesting when a photo was taken. Visitors give a year and a month, and the day if they know it.

Dates from 1800 up to the current month are accepted.

## `rateLimit`

**Type:** `int` · **Default:** `30`

Suggestions accepted per minute from one visitor address to one share. Over the limit, IPP answers `429` with the time to wait in `Retry-After`. `0` turns the limit off.

The address is the one that connects to IPP. Behind a reverse proxy every visitor has the proxy's address, so the limit
covers each share as a whole.

## Storage

Suggestions are saved to `/var/data/suggestions.sqlite`, or to the path in the
[`IPP_SUGGESTIONS_DB`](/config/environment-variables#ipp-suggestions-db) environment variable. The IPP image's file
system is read-only and IPP runs as user `1000`, so mount a folder there that this user can write to:

```yaml
services:
  immich-public-proxy:
    # ...
    volumes:
      - ./ipp-data:/var/data
```

```bash
mkdir -p ipp-data && sudo chown 1000:1000 ipp-data
```

If IPP cannot open the database at startup, it logs an error and offers no suggestions.

Each suggestion is one row. The same suggestion made again counts up `times_suggested` on its row instead of adding
another, so you can see how many visitors agree. Nothing about the visitor is stored.

| Table                   | Columns                                                                                                                                                      |
|-------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `face_name_suggestions` | `asset_id`, `face_id`, `person_id` (Immich's group for the face, if any), `name`, `box_x` / `box_y` / `box_width` / `box_height` (fractions of the image), `times_suggested`, `first_suggested_at`, `last_suggested_at` |
| `date_suggestions`      | `asset_id`, `date` (`YYYY-MM` or `YYYY-MM-DD`), `times_suggested`, `first_suggested_at`, `last_suggested_at`                                                   |

The asset id opens the photo in Immich at `https://your-immich/photos/<asset_id>`. To list the most agreed-on names:

```bash
sqlite3 ipp-data/suggestions.sqlite "SELECT asset_id, name, times_suggested FROM face_name_suggestions ORDER BY times_suggested DESC"
```

---
prefix: ipp.suggestions
---

# Suggestions

> [!NOTE]
> Suggestions are part of the [beniwohli/immich-public-proxy](https://github.com/beniwohli/immich-public-proxy) fork, not of
> upstream IPP: they keep a database, which upstream rules out.

Visitors can help identify old or undated photos: they suggest a name for a face nobody has named yet, and when and
where a photo was taken, and leave comments on photos. Configured under `ipp.suggestions`. All are off by default.

IPP does not change anything in Immich. Suggestions are saved to a SQLite database. Review them, and apply the ones
you agree with to Immich in one click, with the optional [review service](/review-suggestions), or read the database
yourself as described [below](#storage).

## Example

Let visitors suggest names, dates and places, and comment on photos:

```json
{
  "ipp": {
    "showMetadata": {
      "people": { "faces": true }
    },
    "suggestions": {
      "names": true,
      "dates": true,
      "locations": true,
      "comments": true
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

## `locations`

**Type:** `bool` · **Default:** `false`

Add a map button to the lightbox toolbar for suggesting where a photo was taken. Visitors search for a place or click the map, and can name the place. The map and the search are described under [`mapTileUrl`](#maptileurl) and [`geocoderUrl`](#geocoderurl).

The map and the search load straight from the visitor's browser, from OpenStreetMap by default, and only when the
dialog is opened. Those servers see the visitor's IP address and your site's address, but never the page URL, which
carries the share key. The [review service](/review-suggestions) can set an accepted place as the photo's GPS location
in Immich.

## `mapTileUrl`

**Type:** `string` · **Default:** `"https://tile.openstreetmap.org/{z}/{x}/{y}.png"`

The map tiles for the place dialog, as a URL template with `{z}`, `{x}` and `{y}`. The default is OpenStreetMap's own tile server, which is fine for the light use a share sees, under its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Point it at your own or a commercial tile server for heavier use.

## `mapAttribution`

**Type:** `string` · **Default:** `"© OpenStreetMap contributors"`

The credit shown on the map, as plain text. Tile providers require one; change it to match your `mapTileUrl`. With the default tiles it links to OpenStreetMap's copyright page.

## `geocoderUrl`

**Type:** `string` · **Default:** `"https://nominatim.openstreetmap.org"`

The place search, as the base URL of a [Nominatim](https://nominatim.org)-compatible API. The default is OpenStreetMap's public instance; the dialog searches only when the visitor presses Enter or Search, at most once a second, as its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) asks. An empty string removes the search box, leaving only clicking on the map.

## `comments`

**Type:** `bool` · **Default:** `false`

Add a comment button to the lightbox toolbar, so visitors can tell you about a photo: who is in it, where it was taken, what was happening. Comments are up to 1000 characters and keep their line breaks.

The [review service](/review-suggestions) can add a comment to the end of the photo's description in Immich, or
dismiss it.

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

Each suggestion is one row, with a `status` of `pending`, `applied` or `declined`, and `reviewed_at` / `reviewed_by`
once the [review service](/review-suggestions) has settled it. The same suggestion made again counts up `times_suggested` on its row instead of adding
another, so you can see how many visitors agree. Nothing about the visitor is stored.

| Table                   | Columns                                                                                                                                                      |
|-------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `face_name_suggestions` | `asset_id`, `face_id`, `person_id` (Immich's group for the face, if any), `name`, `box_x` / `box_y` / `box_width` / `box_height` (fractions of the image), `times_suggested`, `first_suggested_at`, `last_suggested_at`, `status`, `reviewed_at`, `reviewed_by` |
| `location_suggestions`  | `asset_id`, `latitude`, `longitude`, `label`, `times_suggested`, `first_suggested_at`, `last_suggested_at`, `status`, `reviewed_at`, `reviewed_by` |
| `photo_comments`        | `asset_id`, `comment`, `times_suggested`, `first_suggested_at`, `last_suggested_at`, `status`, `reviewed_at`, `reviewed_by` |
| `date_suggestions`      | `asset_id`, `date` (`YYYY-MM` or `YYYY-MM-DD`), `times_suggested`, `first_suggested_at`, `last_suggested_at`, `status`, `reviewed_at`, `reviewed_by`                                                   |

The asset id opens the photo in Immich at `https://your-immich/photos/<asset_id>`. To list the most agreed-on names:

```bash
sqlite3 ipp-data/suggestions.sqlite "SELECT asset_id, name, times_suggested FROM face_name_suggestions ORDER BY times_suggested DESC"
```

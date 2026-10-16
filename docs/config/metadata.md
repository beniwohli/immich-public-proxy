---
prefix: ipp.showMetadata
---

# Metadata

Configured under `ipp.showMetadata`. The lightbox includes a slide-in info sidebar (toggle with the **i** key or the info button in the toolbar) that surfaces whatever metadata you opt into here.

## Example

Show the description in the sidebar only (not as a lightbox caption), expose camera EXIF, and reveal place names but not the GPS coordinates:

```json
{
  "ipp": {
    "showMetadata": {
      "description": { "caption": false, "sidebar": true },
      "exif": {
        "dateTimeOriginal": true,
        "timeZone": true,
        "make": true,
        "model": true,
        "lensModel": true,
        "exposureTime": true,
        "iso": true,
        "fNumber": true,
        "focalLength": true
      },
      "location": { "city": true, "state": true, "country": true }
    }
  }
}
```

## Overview

| Group         | Type     | Description                                                                                                      |
|---------------|----------|------------------------------------------------------------------------------------------------------------------|
| `description` | `object` | Where to show the description: `{ "caption": bool, "sidebar": bool }`. See [Description](#description).          |
| `exif`        | `object` | Camera / file EXIF group, one opt-in flag per field. See [EXIF group](#exif-group).                              |
| `location`    | `object` | Location group (city / state / country / GPS), one opt-in flag per field. See [Location group](#location-group). |
| `people`      | `object` | Recognised people: face labels in the lightbox and a filter by name. Needs an API key. See [People](#people).    |

Every field defaults to `false` and is sent to visitors only when its flag is `true`. There is no master switch, so a field IPP adds in a future release stays hidden until you turn it on.

The share's **"Show metadata"** toggle in Immich overrides everything here. When it is off, IPP hides the description, EXIF, location and people data and the info sidebar, whatever these settings say.

The info sidebar and its toolbar button only appear when at least one field is turned on: `description.sidebar`, or any displayable `exif` or `location` field. `exif.timeZone` on its own does not count, as it only changes how the date is shown.

## Description

Under `ipp.showMetadata.description`.

| Option    | Type   | Default | Description                                                 |
|-----------|--------|---------|-------------------------------------------------------------|
| `caption` | `bool` | `false` | Show the description below the photo as a lightbox caption. |
| `sidebar` | `bool` | `false` | Show the description at the top of the info sidebar.        |

Set both to show in both places; set neither and the description is not included at all.

## EXIF group

Under `ipp.showMetadata.exif`.

| Option             | Type   | Default | Description                                                                                                       |
|--------------------|--------|---------|-------------------------------------------------------------------------------------------------------------------|
| `dateTimeOriginal` | `bool` | `false` | Show the date the photo was taken (per EXIF), in the photographer's local time - matching Immich's own sidebar.   |
| `timeZone`         | `bool` | `false` | Show and use the photo's timezone when formatting the date. Only applies when `dateTimeOriginal` is also enabled. |
| `fileName`         | `bool` | `false` | Show the original filename.                                                                                       |
| `dimensions`       | `bool` | `false` | Show width x height and megapixel count.                                                                          |
| `fileSize`         | `bool` | `false` | Show the file size.                                                                                               |
| `make`             | `bool` | `false` | Camera manufacturer (e.g. "Canon").                                                                               |
| `model`            | `bool` | `false` | Camera model (e.g. "EOS R5").                                                                                     |
| `lensModel`        | `bool` | `false` | Lens model.                                                                                                       |
| `exposureTime`     | `bool` | `false` | Shutter speed (e.g. "1/200").                                                                                     |
| `iso`              | `bool` | `false` | ISO sensitivity.                                                                                                  |
| `fNumber`          | `bool` | `false` | Aperture f-number.                                                                                                |
| `focalLength`      | `bool` | `false` | Focal length in millimetres.                                                                                      |

## Location group

Under `ipp.showMetadata.location`.

| Option    | Type   | Default | Description                                                                                                                                                         |
|-----------|--------|---------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `city`    | `bool` | `false` | Show city.                                                                                                                                                          |
| `state`   | `bool` | `false` | Show state / region.                                                                                                                                                |
| `country` | `bool` | `false` | Show country.                                                                                                                                                       |
| `gps`     | `bool` | `false` | Show GPS coordinates.                                                                                                                                               |
| `webLink` | `bool` | `true`  | Show an "Open in OpenStreetMap" link below the coordinates. The link does not pass the share URL on to the map provider. Has no effect unless `gps` is also `true`. |

## People

Under `ipp.showMetadata.people`.

| Option  | Type   | Default | Description                                                                                                                                                                   |
|---------|--------|---------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `faces` | `bool` | `false` | Label recognised faces with the person's name in the lightbox, and show a row of names above the gallery to filter it by person. Needs `IMMICH_API_KEY`, as described below. |

Only people you have named in Immich are shown, and never people you have hidden there. To let visitors suggest names
for the faces nobody has named yet, see [Suggestions](/config/suggestions). Picking several names shows
the photos that have all of them in, as Immich's own search does. Visitors can hide the labels with the face button in
the lightbox toolbar.

Immich does not give face data to a shared link, so IPP reads it with an API key of its own. Create one in Immich under
**Account Settings → API Keys**, signed in as the user who owns the shares, and give it only these permissions:

- `face.read`, for the face boxes and names in the lightbox;
- `asset.read`, for the names across an album, which the gallery filter needs.

Pass it to IPP as the [`IMMICH_API_KEY`](/config/environment-variables#immich-api-key) environment variable. Without it,
`faces` has no effect and IPP logs a warning.

The key can read more than a share does, so IPP only uses it for photos the visitor's share link has already been
checked to contain, and sends visitors nothing but each person's name and face box. Even so, it is a credential
with read access to the whole library of its user: keep it out of the config file and anywhere else that is
shared, and turn `faces` on only if you are happy for share visitors to see the names you have given people.

In a shared album, the names come from the key's user: people that only another member of the album has named are not
shown.

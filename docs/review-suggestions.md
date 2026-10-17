# Review visitor suggestions

When [suggestions](/config/suggestions) are on, visitors can suggest names for faces nobody has named, when and where
photos were taken, and comment on photos. The review service is a small private web page where you go through them, sign in with PocketID, and
apply the ones you agree with to Immich with one click, or decline them.

> [!NOTE]
> The review service, visitor suggestions and face labels are part of the
> [beniwohli/immich-public-proxy](https://github.com/beniwohli/immich-public-proxy) fork, not of upstream IPP. No
> image is published for them: you build the images from a checkout of the fork, as below.

> [!IMPORTANT]
> The review service holds an Immich API key that can **change your library**: it names people, moves faces and sets
> dates. Only someone PocketID marks as an Immich admin can sign in, and nothing is changed except on their click.
> Still, give it a hostname of its own, not IPP's public one.

## Contents

- [How it works](#how-it-works)
- [What you need](#what-you-need)
- [Create the API key](#create-the-api-key)
- [Add a client in PocketID](#add-a-client-in-pocketid)
- [Add the review service](#add-the-review-service)
- [Reviewing](#reviewing)
- [Environment variables](#environment-variables)

## How it works

The review service is a third, optional container, `immich-public-proxy-review`. It reads the same
`suggestions.sqlite` as IPP, so both mount the same folder. IPP adds suggestions as visitors send them; the review
service marks each one applied or declined. A suggestion you declined stays declined, even when another visitor
suggests it again.

Nothing is changed in Immich until you click **Apply**. Before each change, the review service asks Immich how things
stand now, so a face somebody named in the meantime is left alone.

## What you need

- IPP with [suggestions](/config/suggestions) turned on, and its database on a volume.
- [PocketID](https://pocket-id.org), or another OpenID Connect provider, that gives Immich admins a claim saying so. The
  default is `immich_role` set to `admin`, the claim Immich's own OAuth login reads.
- A hostname for the review service, such as `review.example.com`, behind HTTPS.

## Create the API key

In Immich, signed in as the user who owns the shares, open **Account Settings → API Keys**, create a key, and give it
these permissions:

| Permission      | Used for                                       |
|-----------------|------------------------------------------------|
| `asset.read`    | Reading a photo's date, place and description  |
| `asset.view`    | Showing the photo and the face on the page     |
| `asset.update`  | Setting a photo's date, place and description  |
| `face.read`     | Checking the face is still unnamed             |
| `face.update`   | Moving a face to a person                      |
| `person.read`   | Finding a person who already has the name      |
| `person.create` | Creating a person for a face that has none     |
| `person.update` | Naming a person                                |
| `person.merge`  | Merging an unnamed person into a named one     |

This is a different key from the read-only one IPP uses for faces. Don't give IPP this one.

## Add a client in PocketID

In PocketID, under **OIDC Clients**, add a client:

- **Callback URL**: `https://review.example.com/auth/callback`
- **PKCE**: on is fine; the review service always uses it.

Note the client ID and secret for the next step. The review service lets in anyone whose ID token or userinfo carries
the admin claim, so if you already set `immich_role` for Immich's own login, there is nothing more to do. If not, add
it as a custom claim on your user or on an admin group in PocketID.

## Add the review service

Build the images from a checkout of the fork, from the repository root. IPP needs the fork's build too, for faces
and suggestions:

```bash
docker build --build-arg PACKAGE_VERSION=4.0.0-fork -t immich-public-proxy-fork .
```

```bash
docker build -f Dockerfile.review --build-arg PACKAGE_VERSION=4.0.0-fork -t immich-public-proxy-review .
```

Change `PACKAGE_VERSION` whenever you rebuild changed code, so visitors' browsers fetch the new scripts instead of
cached ones.

Then add the review service next to IPP in your compose file. Both mount the same folder at `/var/data`:

```yaml
services:
  immich-public-proxy:
    image: immich-public-proxy-fork
    # ... as before, with:
    volumes:
      - ./ipp-data:/var/data

  ipp-review:
    image: immich-public-proxy-review
    container_name: ipp-review
    restart: always
    ports:
      - "3002:3000"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges
    volumes:
      - ./ipp-data:/var/data
    environment:
      IMMICH_URL: http://your-internal-immich-server:2283
      IMMICH_API_KEY: the-key-with-write-permissions
      IMMICH_PUBLIC_URL: https://photos.example.com
      REVIEW_PUBLIC_URL: https://review.example.com
      OIDC_ISSUER: https://id.example.com
      OIDC_CLIENT_ID: your-client-id
      OIDC_CLIENT_SECRET: your-client-secret
    healthcheck:
      test: curl -sf -m 4 http://localhost:3000/healthcheck -o /dev/null || exit 1
      start_period: 10s
      timeout: 5s
```

Docker looks for these images locally because they aren't published anywhere. If your tool tries to pull them
anyway, add `pull_policy: never` to both services.

Point `review.example.com` at port `3002` in your reverse proxy. The service must be at the root of its hostname,
not under a path.

## Reviewing

Open `https://review.example.com` and sign in. The page lists:

- **Names**, one card per face: the face cut out of the photo, each name visitors suggested with how many suggested
  it, and what **Apply** will do in Immich:
  - *Names this person*: the face belongs to a person Immich grouped but nobody named. Every photo of them gets the
    name.
  - *Merges this person into the existing …*: someone already has that name, so the unnamed person joins them.
  - *Adds this face to the existing …* or *Creates … with this face*: the face had no person of its own.

  Applying one name declines the others for that face and person.
- **Dates**, one card per photo, with its current date in Immich. **Apply** sets the date you pick, which starts as the
  suggested one (the 1st of the month when no day was given). The time is set to noon UTC, so the day stays the same
  in every time zone.

- **Places**, one card per photo, with where Immich has it now. Each suggested place shows its name and coordinates,
  which open on OpenStreetMap. **Apply** sets them as the photo's GPS location in Immich and declines the other places
  suggested for it.
- **Comments**, one card per photo, with its current description in Immich. **Add to description** adds the comment
  to the end of the description, after a blank line, so you can tidy it up in Immich afterwards. **Dismiss** keeps it
  out of Immich.

Links open the photo or person in Immich when `IMMICH_PUBLIC_URL` is set.

## Environment variables

| Variable                | Required | Description                                                                                                     |
|-------------------------|----------|-----------------------------------------------------------------------------------------------------------------|
| `IMMICH_URL`            | Yes      | Immich as reached from the container, as for IPP.                                                               |
| `IMMICH_API_KEY`        | Yes      | The key with the permissions above.                                                                             |
| `REVIEW_PUBLIC_URL`     | Yes      | The review service's own public URL. The callback URL is this with `/auth/callback`.                            |
| `OIDC_ISSUER`           | Yes      | PocketID's URL, such as `https://id.example.com`.                                                               |
| `OIDC_CLIENT_ID`        | Yes      | From the PocketID client.                                                                                       |
| `OIDC_CLIENT_SECRET`    | Yes      | From the PocketID client.                                                                                       |
| `IMMICH_PUBLIC_URL`     | No       | Immich as you open it in a browser, for links to photos and people.                                             |
| `OIDC_ADMIN_CLAIM`      | No       | The claim that marks an admin. Default `immich_role`.                                                           |
| `OIDC_ADMIN_VALUE`      | No       | The value it must have, or hold if it is a list. Default `admin`.                                               |
| `REVIEW_SESSION_HOURS`  | No       | How long a sign-in lasts. Default `8`.                                                                          |
| `REVIEW_SESSION_SECRET` | No       | Signs the session cookie. Unset, a random one is made at each start, so a restart signs you out.                 |
| `IPP_SUGGESTIONS_DB`    | No       | Path to the database, as for IPP. Default `/var/data/suggestions.sqlite`.                                       |
| `IPP_PORT`              | No       | Port inside the container. Default `3000`.                                                                      |

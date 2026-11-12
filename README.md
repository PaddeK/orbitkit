# orbitkit

Companion tools for [BookOrbit](https://bookorbit.app) in one container. Turn on the features you want:

| Feature | Turned on by | What it does |
|---|---|---|
| [EPUB Check](#epub-check) | `EPUB_CHECK_ENABLED` | Validates every EPUB in your library with [epubveri](https://github.com/veripublica/epubveri), shows the result on each book in BookOrbit, and repairs books on request. |
| [PocketBook Sync](#pocketbook-sync) | `POCKETBOOK_SYNC_ENABLED` | Sends the reading progress of PocketBook's built-in reader (via PocketBook Cloud) to BookOrbit. |
| [OPDS Proxy](#opds-proxy) | `OPDS_PROXY_ENABLED` | Makes password-protected OPDS catalogs usable from e-readers that can't log in, such as PocketBook. |

Each feature runs on its own: its own settings (all starting with its prefix `EPUB_CHECK_`, `POCKETBOOK_SYNC_` or
`OPDS_PROXY_`), its own port, its own folder in the data volume and its own loop. A failing one (say, PocketBook Cloud
is down) only logs errors and retries; the others carry on. orbitkit replaces the separate tools orbitcheck,
pocketorbit and opds-proxy, see [Migrating](#migrating-from-orbitcheck-pocketorbit-and-opds-proxy).

## Quick start

Add orbitkit to the stack that runs BookOrbit, with the features you want; [`compose.example.yaml`](compose.example.yaml)
has all of them:

```yaml
services:
  orbitkit:
    image: ghcr.io/paddek/orbitkit:latest
    restart: unless-stopped
    ports:
      - "8601:8601" # OPDS Proxy
      - "8602:8602" # EPUB Check report pages
    volumes:
      - orbitkit-data:/data
    environment:
      BOOKORBIT_URL: http://bookorbit:3000
      BOOKORBIT_PUBLIC_URL: https://books.example.org
      BOOKORBIT_API_KEY: ${BOOKORBIT_API_KEY}
      EPUB_CHECK_ENABLED: "true"
      EPUB_CHECK_REPORT_URL: http://192.168.1.10:8602

volumes:
  orbitkit-data:
```

Then `docker logs -f orbitkit`. Every line names the feature it comes from:

```
2026-10-30 12:00:00 INFO orbitkit 1.0.0 with epub-check, pocketbook-sync, opds-proxy
2026-10-30 12:00:00 INFO [epub-check] epubveri 0.35.0+16d7735, epubsana 0.36.0+73dd926; checking every 300s
2026-10-30 12:00:00 INFO [epub-check] reports on port 8602 (BookOrbit login with "Manage libraries" required), linked in BookOrbit as http://192.168.1.10:8602
2026-10-30 12:00:00 INFO [pocketbook-sync] syncing every 300s as device "PocketBook Era Color"
2026-10-30 12:00:00 INFO [opds-proxy] listening on port 8601
2026-10-30 12:00:01 INFO [epub-check] BookOrbit: logged in as orbitkit
```

Images are built for amd64 and arm64. `latest` follows the main branch; releases are also tagged by version
(`1.2.3`, `1.2`, `1`). To build the image yourself: `docker build -t orbitkit https://github.com/PaddeK/orbitkit.git`.

## Configuration

Every variable can also be read from a file by appending `_FILE` to its name (e.g.
`BOOKORBIT_PASSWORD_FILE=/run/secrets/bookorbit_password`), for Docker secrets. Without any `*_ENABLED`, orbitkit
exits with a message listing them.

Shared by the features:

| Variable | Default | Purpose |
|---|---|---|
| `BOOKORBIT_URL` | required by EPUB Check and PocketBook Sync | BookOrbit base URL as orbitkit reaches it, without `/api/…`; in the same stack e.g. `http://bookorbit:3000`. |
| `BOOKORBIT_PUBLIC_URL` | `BOOKORBIT_URL` | Where your browser reaches BookOrbit, for links. Set it when `BOOKORBIT_URL` is an internal address. |
| `BOOKORBIT_API_KEY` | required by EPUB Check, or the two below | A BookOrbit API key (BookOrbit 3.8 or newer), see [BookOrbit access](#bookorbit-access). |
| `BOOKORBIT_USER`, `BOOKORBIT_PASSWORD` | | A BookOrbit web login (not the KOReader one), for EPUB Check without an API key. |
| `DATA_DIR` | `/data` | Where each feature keeps its folder: `epub-check/`, `pocketbook-sync/`, `opds-proxy/`. |

The settings of each feature, including its dry run, are in its section below.

The image is a single compiled executable on [distroless](https://github.com/GoogleContainerTools/distroless)
(amd64 and arm64): no shell, so `docker exec … sh` won't work; `docker logs` is where to look. It runs as uid `1000`.
A named volume just works; for a bind mount, give the host directory to that user (`sudo chown 1000:1000 /path/on/host`),
otherwise the container exits with a hint saying exactly that.

The container reports itself unhealthy when one of its features is: EPUB Check or PocketBook Sync had no successful
cycle for two intervals, or a port does not answer. `docker inspect --format '{{json .State.Health}}' orbitkit` says
which.

## EPUB Check

Checks every EPUB in your BookOrbit library against the EPUB specification with
[epubveri](https://github.com/veripublica/epubveri), and shows the result on each book in BookOrbit.

```
BookOrbit ──(new or changed EPUBs)──▶ EPUB Check: epubveri ──(custom fields)──▶ BookOrbit
                                              ├──▶ report pages: every finding with code, file and line
                                              └──▶ epubsana: proposed fixes, repaired copy to download
```

BookOrbit accepts any EPUB that is a ZIP file; it does not validate them. A broken EPUB uploads fine and only
causes trouble later, in a reader or on an e-reader. EPUB Check catches these: a missing file, a broken table of
contents, invalid XHTML, wrong media types, and everything else epubcheck reports. epubveri is a pure-Rust, JVM-free
alternative to the W3C's epubcheck with the same message codes (`RSC-005`, `OPF-030`, …), compiled to WebAssembly,
so there is no Java in the image.

How it works:

1. **List** the books in BookOrbit every few minutes and pick out their EPUB files.
2. **Check** each new or changed EPUB (by size) with epubveri: it is downloaded, validated in memory, and dropped.
   For a book with findings, [epubsana](https://github.com/veripublica/epubsana) plans its repair on the same
   copy and tries the fixes that are safe to apply without asking, together with orbitkit's own fixes and the
   epublift upgrade if they are turned on (see below). A new version of a tool checks every book again.
3. **Write** the verdict to four custom fields of the book in BookOrbit, which EPUB Check creates on its first run:

   | Field | Type | Value |
   |---|---|---|
   | EPUB check | text | `valid`, `warnings`, `errors`, `fatal`, or `not checked` (e.g. too large) |
   | EPUB errors | number | errors, including fatal ones |
   | EPUB warnings | number | warnings |
   | EPUB report | link | the book's report page (only with `EPUB_CHECK_REPORT_URL`) |

   EPUB Check finds its fields by these labels (the same as orbitcheck's): if you rename one in BookOrbit, EPUB Check
   creates a new field with the label above. Fields are only written when a value changes. With several EPUBs in one book, the worst status and the summed
   counts win. You can filter and sort your library by these fields like by built-in ones, e.g. *EPUB errors
   greater than 0*.
4. **Serve** the report pages on port 8602: an overview of all books with problems, and per book every finding
   with its severity, code, place in the EPUB and message.
5. **Repair on request.** Below the findings, a book's page lists every fix epubsana proposes, with its reason and
   the exact edits. Safe fixes are ticked; fixes that change something visible (dropping a missing image,
   repointing a link) wait for you to tick them. *Check selection* shows what your choice achieves and which
   findings remain; *Download repaired EPUB* sends you `<name>_fixed.epub`. epubsana undoes any fix that made the
   book worse.

EPUB Check doesn't change books in BookOrbit unless you turn on `EPUB_CHECK_REPLACE_IN_LIBRARY` and press a button;
by default repairs only touch the copy you download. epubsana fixes the defects that have exactly one correct repair;
the rest (like a broken link whose target is unclear) is a job for Sigil or calibre.

### BookOrbit access

EPUB Check uses BookOrbit's web API, with an **API key** (BookOrbit 3.8 or newer) or, without one, a **login**. A key
is the better choice: there is no password in orbitkit's settings, you can narrow it down to what EPUB Check needs, and
revoke it on its own.

The key, or the user, needs access to the libraries to check and these permissions:

- **Download books** (`library_download`), to read the files,
- **Edit metadata** (`library_edit_metadata`), to set the custom fields. BookOrbit also requires the Editor or
  Owner role on each library for that (*Settings → Libraries → Access*),
- **Manage libraries** (`manage_libraries`), to create the custom fields on the first run and to ask for a library
  scan after replacing a book. Without it, create the fields from the table above yourself (same labels and types),
  and EPUB Check uses them.

**API key:** create one under *Settings → You → API keys* with access **Read and write** and the three permissions
above, limited to the libraries to check if you like, and set it as `BOOKORBIT_API_KEY`. A key acts as the user who
created it and can do at most what that user can; an admin's key works, a key of a user of its own is tidier. That
user needs the *Create API keys* permission, and API keys must be allowed under *Settings → Admin → API keys*. With a
key, `BOOKORBIT_USER` and `BOOKORBIT_PASSWORD` are not used.

**Login:** without a key, EPUB Check logs in like BookOrbit's apps do, with a normal BookOrbit user (`BOOKORBIT_USER`
and `BOOKORBIT_PASSWORD`, not KOReader credentials). orbitkit keeps a session like BookOrbit's apps (shown as
*orbitkit* among the user's sessions) in `epub-check/state.json` (mode `0600`), so it does not log in on every run.
Revoking the session there makes it log in again with the password.

### Settings

| Variable | Default | Purpose |
|---|---|---|
| `EPUB_CHECK_ENABLED` | `false` | `true` turns EPUB Check on. |
| `EPUB_CHECK_DRY_RUN` | `false` | `true`: check, but change nothing in BookOrbit, see [Dry run](#dry-run). |
| `EPUB_CHECK_PORT` | `8602` | Port of the report pages. |
| `EPUB_CHECK_REPORT_URL` | none | The address your browser reaches the report pages at, e.g. `http://192.168.1.10:8602` or `https://books.example.org/api/orbitkit`. Each book in BookOrbit then links to its report page. Without it, there is no *EPUB report* field; the pages still work. |
| `EPUB_CHECK_REQUIRE_LOGIN` | `true` | Only BookOrbit users with *Manage libraries* see the report pages, see [Signing in](#signing-in-to-the-report-pages). `false` only if something else protects the port. |
| `EPUB_CHECK_BASE_PATH` | none | Also serve the pages below this path, e.g. `/api/orbitkit`, to put them under BookOrbit's address. |
| `EPUB_CHECK_INTERVAL` | `300` | Seconds between looking for new and changed books (at least 60). |
| `EPUB_CHECK_MAX_FILE_SIZE_MB` | `200` | Bigger EPUBs are not downloaded and show as `not checked`. epubveri and epubsana hold the whole file in memory. |
| `EPUB_CHECK_FIXES` | `false` | `true`: offer orbitkit's own fixes for defects epubsana does not repair, see below. |
| `EPUB_CHECK_EPUBLIFT` | `false` | `true`: offer upgrading EPUB 2 books to EPUB 3 with epublift (included in the image), see below. |
| `EPUB_CHECK_EPUBLIFT_PATH` | `epublift` | The epublift program, outside the image: a path, or a name looked up in `PATH`. |
| `EPUB_CHECK_REPLACE_IN_LIBRARY` | `false` | `true`: offer to replace books in the library with their repaired version, see below. Needs the library mounted read-write. Has no effect in a dry run. |

`epub-check/state.json` holds the BookOrbit session, the size and result of each checked file and the values last
written. `epub-check/reports/` holds the findings and epubsana's plan for each file; repaired books are made on
request and never stored. Deleting both is safe: every book is checked again, and changed values are written once
more.

### Dry run

With `EPUB_CHECK_DRY_RUN=true` you can see what EPUB Check finds in your library before it writes anything to
BookOrbit. It affects EPUB Check only; the other features run as configured.

What still happens:

- EPUB Check logs in to BookOrbit (the session shows up among the user's sessions), lists the books and downloads
  every new or changed EPUB to check it. These are reads; BookOrbit's data stays as it is.
- Findings and repair plans are kept in `epub-check/`, and the report pages work as usual, including *Check
  selection* and *Download repaired EPUB*: those only ever touch the copy you download.

What does not happen, and is logged instead:

- No custom fields are created or enabled for a library (`dry run: would create custom field "EPUB check"`).
- No field values are set on books (`dry run: would set EPUB check=errors, EPUB errors=2, … on "Moby Dick"`).
- No book in the library is replaced and no library scan is started: the replace and upload buttons don't appear,
  even with `EPUB_CHECK_REPLACE_IN_LIBRARY=true`.

When you turn the dry run off, the books are not checked again; the first cycle afterwards creates the fields and
writes every value the dry run held back.

### Signing in to the report pages

The report pages show your library and, with `EPUB_CHECK_REPLACE_IN_LIBRARY`, can change it. So by default only
BookOrbit users with the *Manage libraries* permission (or superusers) see them. There are two ways in:

- **Under BookOrbit's address, without signing in again.** BookOrbit's login cookie is sent only to BookOrbit's
  address and to paths below `/api`. Route `https://books.example.org/api/orbitkit/` to orbitkit's port 8602 and set
  `EPUB_CHECK_BASE_PATH=/api/orbitkit`: whoever is signed in to BookOrbit in that browser is signed in to the reports,
  and BookOrbit itself says who they are. With a Cloudflare tunnel, add a public hostname rule for the same host with
  path `^/api/orbitkit` (above BookOrbit's rule) pointing to `http://orbitkit:8602`; with Caddy,
  `handle /api/orbitkit* { reverse_proxy orbitkit:8602 }` before BookOrbit's `reverse_proxy`. BookOrbit's cookie
  lasts 15 minutes after its last use in BookOrbit; when it has run out, the login page offers to open BookOrbit,
  which renews it.
- **On any other address** (e.g. `http://192.168.1.10:8602` on your LAN), EPUB Check shows a login page. Enter your
  BookOrbit user name and password; orbitkit sends them to BookOrbit and keeps nothing but the session BookOrbit
  hands out (listed as *orbitkit EPUB Check* among your sessions in BookOrbit). A login ends after 12 hours without
  use, after 7 days, when you sign out, or when the session is ended in BookOrbit, which orbitkit asks every five
  minutes; losing the permission locks the user out within the same five minutes.

The pages are served at both places at once, so both ways work side by side. `/healthz` stays open for monitoring.

### orbitkit's own fixes

epubsana fixes the defects it can be certain about, and declines the rest. Some common ones it does not cover have
exactly one correct repair too; with `EPUB_CHECK_FIXES=true` EPUB Check offers orbitkit's own, marked *orbitkit* in
the list of fixes. Each looks for exactly one pattern and leaves everything else alone:

| Fix | Repair | |
|---|---|---|
| A `dcterms:modified` with fractions of a second (`2026-10-24T04:01:37.489Z`) | Drop the fraction | safe |
| EPUB 2 attributes on metadata in an EPUB 3 package (`opf:scheme`, `opf:role`, `opf:file-as`, under any prefix) | Move the value into the EPUB 3 form, `<meta refines="#id" property="identifier-type\|role\|file-as">` | safe; left alone where an EPUB 3 refinement says something else |
| `<meta refines="#id">` of an element that does not exist any more | Remove it | safe |
| Amazon conversion leftovers (`data-AmznRemoved…`) | Remove them, unless a stylesheet uses them | safe |
| `<link rel="stylesheet">` to a file that is not in the book | Remove the link: a missing stylesheet styles nothing | safe |
| Page-list entries (NCX and navigation document) whose page markers are not in the book | Remove them; renumber the NCX's `playOrder` | safe |
| An empty `<guide>` | Remove it | safe |
| BookOrbit's EPUB 3 series metas in an EPUB 2 package (`belongs-to-collection`) | Remove them where `calibre:series` says the same; otherwise move the series there | safe, or to confirm |

The first three and the last are produced by BookOrbit's *Write metadata to files*, the first and the last in nearly
every book it writes. Only the files a fix names change; every other file in the EPUB is copied byte for byte.

### Upgrading EPUB 2 books to EPUB 3 (epublift)

Many EPUB 2 books, especially conversions of Kindle books, contain markup only EPUB 3 allows: `epub:type`, `role`,
`<section>`, `<nav>`. Stripping it would lose information; upgrading the book to EPUB 3 makes it valid. With
`EPUB_CHECK_EPUBLIFT=true`, [epublift](https://github.com/ePubLift/epublift) does that: package version 3.0, an EPUB 3
navigation document (the EPUB 2 table of contents stays for older readers), documents declared as HTML5. Afterwards
orbitkit's own fixes run again on the upgraded book, since some leftovers (such as Amazon's) only become fixable then.

The upgrade changes the book's format version, so it is always a fix to confirm, never part of *replace with safe
fixes*. It is only offered where it makes the book better: EPUB Check tries it while checking the book, and
epublift 4.5.1 sometimes leaves `valign` or `cellspacing` behind when the book's CSS sets the same property, which
EPUB 3 does not allow.

### How fixes are applied

epubsana's fixes first, on the book as it is; then orbitkit's own, one at a time; then the epublift upgrade. Each of
orbitkit's steps is undone again unless it lowers the number of errors without making any kind of error more
frequent, as epubsana does with its own. The result shows what happened to each fix.

### Replacing books in the library

By default EPUB Check never changes your library: repairs only touch the copy you download. With
`EPUB_CHECK_REPLACE_IN_LIBRARY=true`, more buttons appear:

- **Replace in BookOrbit** on a book's page, next to *Download repaired EPUB*: the book in your library becomes the
  repaired version, with the fixes you ticked.
- **Replace N books in BookOrbit with their safe fixes** on the overview: every book whose safe fixes remove errors
  gets exactly those, after a confirmation page listing them. It runs in the background; the page shows the progress.
- **Your own fixed version** on a book's page, for what no tool fixes automatically: download the current file, repair
  it in Sigil or calibre, and upload it. EPUB Check checks the upload and shows its findings next to the library's,
  pointing out a different title inside the book or more errors than before; only after you confirm does it replace the
  book. Unconfirmed uploads are deleted after an hour.

EPUB Check writes the file where BookOrbit has it, so mount the library into orbitkit **at the same path as in the
BookOrbit container**, read-write, writable for uid 1000:

```yaml
    volumes:
      - orbitkit-data:/data
      - /path/to/books:/books   # the same mount as BookOrbit's
    environment:
      EPUB_CHECK_REPLACE_IN_LIBRARY: "true"
```

What happens on a replacement:

1. The file on disk must be byte for byte the one BookOrbit served and EPUB Check repaired; if it changed in the
   meantime, nothing is replaced.
2. The original goes to `epub-check/backups/<file ID>/` in orbitkit's volume. To restore one:
   `docker cp orbitkit:/data/epub-check/backups/<file ID>/<name> /path/to/books/…`.
3. The repaired book is written next to the original (a hidden `.orbitkit-tmp` file BookOrbit ignores) and renamed
   over it, so BookOrbit never sees half a book.
4. EPUB Check asks BookOrbit to scan the library (this needs the *manage libraries* permission; otherwise the change
   shows up with BookOrbit's next scan). The file keeps its ID in BookOrbit, so reading progress, annotations and
   bookmarks stay with the book; its old hash moves to the file's hash history, so copies already on e-readers keep
   matching for KOReader sync.

Replacing a file keeps its name and place. Most fixes only touch the package files (OPF, NCX), and the text stays where
it was. Fixes inside a chapter (for example wrapping stray text in a `<div>`) change its structure, so an exact
position in that chapter, like a highlight, can end up slightly off; percentage progress is not affected.

### Limitations

- **Changes are noticed by file size.** A file replaced by one of exactly the same size is not checked again
  (deleting `epub-check/state.json` checks everything).
- **"Write metadata to files" in a library's settings** makes BookOrbit write metadata, custom fields included,
  into the book file whenever metadata is saved, so also when EPUB Check sets its fields. That changes the
  EPUB; EPUB Check checks it once more and then leaves it alone. The setting is off by default.
- Only EPUB files are checked; KEPUB and other formats are skipped.

## PocketBook Sync

Keeps BookOrbit up to date with what you read in the **built-in reader of a PocketBook** e-reader, without KOReader
or anything else installed on the device. It can also send the books of a BookOrbit collection to the reader, see
[Sending a collection to the reader](#sending-a-collection-to-the-reader).

```
PocketBook reader ──(built-in cloud sync)──▶ PocketBook Cloud ──(polled)──▶ PocketBook Sync ──(KOReader sync API)──▶ BookOrbit
```

BookOrbit syncs reading progress with Kobo devices and KOReader, but not with PocketBook's own reader. That reader
does sync its reading position to PocketBook Cloud, though. PocketBook Sync polls PocketBook Cloud every few minutes
and forwards each book's percentage to BookOrbit through the same API the BookOrbit KOReader plugin uses, so the
e-reader appears in BookOrbit like a KOReader device.

How it works:

1. **List** your books in PocketBook Cloud with their reading percentage and status.
2. **Fingerprint** each new book once: it is downloaded (streamed, not kept) to compute KOReader's partial MD5,
   the ID BookOrbit uses to recognise a file.
3. **Match** the fingerprints with BookOrbit. Books it doesn't recognise are listed under
   *Settings → KOReader → Books to Review* in BookOrbit, where you can link them to a library book once.
   Unmatched books are checked again on every cycle, so links take effect without a restart.
4. **Send** the percentage of every matched book whose progress changed, with PocketBook's timestamp.
   BookOrbit ignores a value older than progress it already has (e.g. from its web reader or another device),
   unless it reaches further into the book.

### Setup

1. **BookOrbit:** go to *Settings → KOReader*, turn on **Progress sync** and create credentials. Your user needs the
   `koreader_sync` permission. You don't need to download the KOReader plugin.
2. **PocketBook:** under *Settings → Accounts and Synchronization → PocketBook Cloud*, log in and turn on **Autosync**
   and **Auto-upload**, so books you add to the reader (also via OPDS) are uploaded with their reading position.

   > If uploading a book fails with *"not enough space"* although the cloud is almost empty, the reader is logged
   > in to PocketBook Cloud without a shop. Log out and log in again, choosing your shop (e.g. Pocketbook.de).
3. **orbitkit:** set `POCKETBOOK_SYNC_ENABLED=true` and the settings below. To see what would be sent first, add
   `POCKETBOOK_SYNC_DRY_RUN=true`.

### Settings

| Variable | Default | Purpose |
|---|---|---|
| `POCKETBOOK_SYNC_ENABLED` | `false` | `true` turns PocketBook Sync on. |
| `POCKETBOOK_SYNC_DRY_RUN` | `false` | `true`: log the progress it would send instead of sending it, see [Dry run](#dry-run-1). |
| `POCKETBOOK_SYNC_EMAIL` | required | PocketBook Cloud login. |
| `POCKETBOOK_SYNC_PASSWORD` | required | PocketBook Cloud password. |
| `POCKETBOOK_SYNC_SHOP` | first shop | Only if your account belongs to several PocketBook shops: the shop's alias (e.g. `pocketbook_de`, shown in the log) or name. |
| `POCKETBOOK_SYNC_KOREADER_USER` | required | Username of the KOReader credentials from BookOrbit's *Settings → KOReader*. |
| `POCKETBOOK_SYNC_KOREADER_PASSWORD` | required | Their password. |
| `POCKETBOOK_SYNC_DEVICE_NAME` | `PocketBook` | How the e-reader is named in BookOrbit. |
| `POCKETBOOK_SYNC_DEVICE_ID` | random | Device ID reported to BookOrbit. Only read on the first start, then kept in `pocketbook-sync/state.json`. |
| `POCKETBOOK_SYNC_INTERVAL` | `300` | Seconds between polls (at least 30). |
| `POCKETBOOK_SYNC_COLLECTION` | | Name of a BookOrbit collection whose books are sent to the reader, see [Sending a collection to the reader](#sending-a-collection-to-the-reader). |
| `POCKETBOOK_SYNC_BOOKORBIT_API_KEY` | required with a collection | A BookOrbit API key of the collection's owner (BookOrbit 3.8 or newer): read access with the *Download books* permission. |
| `POCKETBOOK_SYNC_CLOUD_COLLECTION` | the collection's name | The PocketBook Cloud collection the books go into (3 to 255 characters); the reader shows it as a shelf. |

It uses `BOOKORBIT_URL`, but not `BOOKORBIT_USER`: KOReader sync has credentials of its own.
`pocketbook-sync/state.json` holds the PocketBook Cloud tokens, the device ID, each book's fingerprint and the last
value sent, and which books of the collection are in the cloud. Deleting it is safe: books are downloaded and
fingerprinted again, unchanged progress is sent once more, and the collection's books are found in the cloud instead of
being uploaded twice.

### Sending a collection to the reader

Add a book to a collection in BookOrbit, and it shows up on the PocketBook at its next sync:

```
BookOrbit collection ──(API key)──▶ PocketBook Sync ──(upload)──▶ PocketBook Cloud ──(built-in cloud sync)──▶ PocketBook reader
```

On every cycle, PocketBook Sync reads the collection and uploads each new book to PocketBook Cloud. It also adds the book to
a cloud collection of the same name, which the reader shows as a shelf too. The file sent is the book's EPUB, or else
the first of FB2, MOBI, AZW3, PDF, DjVu, CBZ, CBR, DOCX, DOC, RTF and TXT it has. It is BookOrbit's file as it is, so
the progress sync recognises it right away.

- **Removing a book from the collection** leaves it in the cloud and on the reader, with its reading position. Remove it on
  the reader when you are done with it. A book deleted on the reader stays deleted, even while it is still in the
  collection; remove it from the collection and add it again to send it again.
- **A book that is in the cloud already**, e.g. downloaded through OPDS earlier, is not uploaded a second time; it only
  joins the collection.
- **Books without a format PocketBook reads** (audiobooks, for example) are skipped, and the log says so once.
- When the **cloud storage is full**, the rest of the collection waits and follows once there is room.

Setup:

1. **BookOrbit:** create a collection (*Create collection*), e.g. *PocketBook*, and add books to it with *Add to
   Collection*. Then create an API key under *Settings → You → API keys*: access **Read**, permission **Download
   books**, and limit it to the libraries the collection draws from if you like. The key acts as you, so it sees your
   collections; your user needs the *Create API keys* permission, and API keys must be
   allowed under *Settings → Admin → API keys*.
2. **orbitkit:** set `POCKETBOOK_SYNC_COLLECTION=PocketBook` and `POCKETBOOK_SYNC_BOOKORBIT_API_KEY=bok_…`. The log
   shows `sending the BookOrbit collection "PocketBook" of <you> to the PocketBook collection "PocketBook"` at the start, and every
   upload. With `POCKETBOOK_SYNC_DRY_RUN=true`, it logs what it would upload instead.


### Dry run

With `POCKETBOOK_SYNC_DRY_RUN=true` you can see which books PocketBook Sync recognises and what it would send, before
any progress reaches BookOrbit. It affects PocketBook Sync only; the other features run as configured.

What still happens:

- PocketBook Sync logs in to PocketBook Cloud, lists your books and downloads each new one once to fingerprint it.
- It asks BookOrbit which books it knows. BookOrbit answers that question by keeping its list of unknown books up to
  date, so books it does not recognise **do** appear under *Settings → KOReader → Books to Review* (and leave it once
  they match). Without this step a dry run could not tell which books would be synced. Nothing is linked and no
  progress is touched.

What does not happen, and is logged instead:

- No reading progress is sent (`[dry run] would send "Moby Dick": 26% (as of 2026-10-28T23:15:29Z)`).
- No book of the collection is uploaded (`[dry run] would upload "Moby Dick" to PocketBook Cloud as Moby Dick.epub (812345 bytes)`).
  The books are still downloaded from BookOrbit, to find those the cloud has already.

Since nothing counts as sent during a dry run, the first cycle after you turn it off sends the current percentage of
every matched book once. BookOrbit keeps whatever is newer, so progress made elsewhere in the meantime is not
overwritten by an older value.

### Limitations

- **Percentages only.** PocketBook Cloud reports whole percents, not an exact position. BookOrbit stores the
  percentage; other devices open the book at about that point rather than on the exact page.
- **One way.** Progress goes from the PocketBook to BookOrbit, not back.
- **The book file must be in PocketBook Cloud** (Auto-upload on the reader, or upload it on cloud.pocketbook.digital).
  It is recognised automatically when it is byte-identical to BookOrbit's file, which is the case for books
  downloaded from BookOrbit's OPDS feed. Converted or edited copies need a one-time link in BookOrbit.
- **Unofficial API.** PocketBook Cloud's API is not made for others; PocketBook Sync uses the one its web app uses,
  as described at [cloud.pocketbook.digital](https://cloud.pocketbook.digital/). If PocketBook changes it, syncing
  stops and the log shows the HTTP errors.
- Audiobooks are skipped.

## OPDS Proxy

Makes password-protected OPDS catalogs (BookOrbit, Calibre-Web, Kavita, …) usable from e-readers whose
built-in OPDS client can't handle authentication, such as PocketBook.

```
e-reader ──(no password, secret reader URL)──▶ OPDS Proxy ──(HTTP Basic auth)──▶ your OPDS server
```

The proxy fetches every feed with the upstream credentials and rewrites all links (navigation, pagination,
search, OpenSearch description, covers, downloads) to point back through itself. The reader never sees the
upstream server or needs a password. A plain reverse proxy can't do this: the upstream's links don't carry the
proxy's access token, so everything past the first page fails.

Everything is configured in a small web UI on its port:

```
Server (e.g. BookOrbit, Calibre-Web)            several servers side by side
 └─ Account (a login on that server)            e.g. one per family member, or anonymous
     └─ Reader URL (one per device)             revocable, shows when it was last used
```

Each reader URL logs in upstream as its account, so the server keeps reading progress, permissions and
logs per person even though the e-readers themselves never enter a password.

Extra normalisation for picky readers:

- Absolute URLs everywhere, XML declaration with double quotes, plain `application/atom+xml` media type.
- Book and cover links end in a real filename (`…/_f/<id>/Some Title.epub`, `…/cover.jpg`) for readers that
  derive the saved filename or format from the URL.
- Downloads are streamed with `Content-Disposition` and `Range` support. A `HEAD` request reports the size; the
  download itself comes chunked, without `Content-Length`, because Bun sends streamed responses that way.
- Sort links that BookOrbit puts into book entries (`rel="http://opds-spec.org/sort/series"`) are dropped: PocketBook
  would download the series feed instead of the book.

The OPDS Proxy only forwards what readers ask for and writes nothing on its own, so it has no dry run.

### Setup

1. Set `OPDS_PROXY_ENABLED=true`, publish port 8601 and look in the log for the one-time setup code (or set your own
   with `OPDS_PROXY_SETUP_CODE=$(openssl rand -hex 8)`).
2. Open `http://<docker-host>:8601/admin`, enter the setup code and choose an admin password.
3. **Add server**: its OPDS root URL plus the first account (username/password, or empty for anonymous access).
   The URL must be reachable *from the container*; in the same Docker stack use the service name,
   e.g. `http://bookorbit:3000/api/v1/opds`. The login is tested on save.
4. **Create a reader URL** for your device under that account, e.g. `http://192.168.0.10:8601/k7m2-x9qp-4rtw-b8nd/`.
   Add more accounts on the server page if several people read from the same server.
5. On the e-reader, add that URL as an OPDS catalog and leave username and password empty.

### Settings

Servers, accounts and reader URLs live in `opds-proxy/config.json` (mode `0600`).

| Variable | Default | Purpose |
|---|---|---|
| `OPDS_PROXY_ENABLED` | `false` | `true` turns the OPDS Proxy on. |
| `OPDS_PROXY_PORT` | `8601` | Port of the proxy and its admin UI. |
| `OPDS_PROXY_SETUP_CODE` | random, printed in the log | Your own code for the first-start setup page (at least 12 characters, no placeholders like `change-me`). Ignored once the admin password is set. |
| `OPDS_PROXY_ADMIN_PASSWORD` | – | Sets the admin password on every start and skips setup. Changes made in the UI are overwritten on the next restart, so mainly use it to reset a forgotten password, then remove it. |
| `OPDS_PROXY_PUBLIC_URL` | from the `Host` and `X-Forwarded-Proto` headers | Externally visible base URL for the links in the feeds, e.g. `https://opds.example.org`. Tunnels and reverse proxies that end TLS (Cloudflare Tunnel, Caddy, Traefik, nginx with `X-Forwarded-Proto`) need nothing; set it if yours rewrites `Host` or sends no `X-Forwarded-Proto`, so the links don't come out as `http://`. |
| `OPDS_PROXY_UPSTREAM_TIMEOUT` | `60` | Seconds to wait for the upstream to answer (not counting download time). |

## Migrating from orbitcheck, pocketorbit and opds-proxy

orbitkit runs the same code, so their data carries over: copy each tool's volume into the matching folder of
orbitkit's volume, before orbitkit's first start:

| Tool | Becomes | Its `/data` goes to |
|---|---|---|
| orbitcheck | EPUB Check | `/data/epub-check` |
| pocketorbit | PocketBook Sync | `/data/pocketbook-sync` (keeps the device ID, so BookOrbit sees the same device) |
| opds-proxy | OPDS Proxy | `/data/opds-proxy` (keeps the reader URLs) |

For example, with the old containers stopped:

```sh
docker volume create orbitkit-data
docker run --rm -v orbitkit-data:/to -v orbitcheck-data:/from/epub-check -v pocketorbit-data:/from/pocketbook-sync \
  -v opds-proxy-data:/from/opds-proxy busybox sh -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to'
```

The settings get the feature's prefix; orbitkit logs a warning for every old name it finds and ignores it:

| Before | orbitkit |
|---|---|
| orbitcheck `REPORT_URL`, `PORT`, `CHECK_INTERVAL`, `MAX_FILE_SIZE_MB` | `EPUB_CHECK_REPORT_URL`, `EPUB_CHECK_PORT` (default now `8602`), `EPUB_CHECK_INTERVAL`, `EPUB_CHECK_MAX_FILE_SIZE_MB` |
| orbitcheck `ORBITCHECK_FIXES`, `EPUBLIFT`, `EPUBLIFT_PATH`, `REPLACE_IN_LIBRARY` | `EPUB_CHECK_FIXES`, `EPUB_CHECK_EPUBLIFT`, `EPUB_CHECK_EPUBLIFT_PATH`, `EPUB_CHECK_REPLACE_IN_LIBRARY` |
| orbitcheck `REPORT_USER`, `REPORT_PASSWORD` | gone: the report pages take a BookOrbit login (`EPUB_CHECK_REQUIRE_LOGIN`) |
| orbitcheck `DRY_RUN` | `EPUB_CHECK_DRY_RUN` |
| pocketorbit `PB_EMAIL`, `PB_PASSWORD`, `PB_SHOP`, `PB_API_URL` | `POCKETBOOK_SYNC_EMAIL`, `POCKETBOOK_SYNC_PASSWORD`, `POCKETBOOK_SYNC_SHOP`, `POCKETBOOK_SYNC_API_URL` |
| pocketorbit `BOOKORBIT_USER`, `BOOKORBIT_PASSWORD` (KOReader credentials) | `POCKETBOOK_SYNC_KOREADER_USER`, `POCKETBOOK_SYNC_KOREADER_PASSWORD`; `BOOKORBIT_USER` is now the web login of EPUB Check |
| pocketorbit `DEVICE_NAME`, `DEVICE_ID`, `SYNC_INTERVAL`, `DRY_RUN` | `POCKETBOOK_SYNC_DEVICE_NAME`, `POCKETBOOK_SYNC_DEVICE_ID`, `POCKETBOOK_SYNC_INTERVAL`, `POCKETBOOK_SYNC_DRY_RUN` |
| opds-proxy `PORT`, `PUBLIC_URL`, `SETUP_CODE`, `ADMIN_PASSWORD`, `UPSTREAM_TIMEOUT` | `OPDS_PROXY_PORT` (default now `8601`), `OPDS_PROXY_PUBLIC_URL`, `OPDS_PROXY_SETUP_CODE`, `OPDS_PROXY_ADMIN_PASSWORD`, `OPDS_PROXY_UPSTREAM_TIMEOUT` |

A leftover `DRY_RUN` therefore does not put any feature into a dry run; set the feature's own variable.

With `EPUB_CHECK_FIXES` on, EPUB Check checks every book once more after the move, since its fixes are now named
*orbitkit* in the reports; that only rewrites the custom fields where a value differs.

## Security

- **Each feature has its own port.** Publish only the ones you use. The OPDS Proxy's reader URLs are meant to be
  reachable from e-readers; EPUB Check's report pages can change your library. Keeping them on separate ports means
  exposing one never exposes the other.
- **EPUB Check's report pages** need a BookOrbit login with *Manage libraries* (see
  [Signing in](#signing-in-to-the-report-pages)). Session cookies are random, HttpOnly and SameSite=Strict; forms
  posted from other sites are refused; ten failed logins from one address make it wait 15 minutes, on top of
  BookOrbit's own lockout. Passwords typed on the login page are only sent on to BookOrbit. Use HTTPS (a reverse proxy)
  if the port is reachable from outside your network. `BOOKORBIT_API_KEY`, or else the password of `BOOKORBIT_USER`,
  is only sent to BookOrbit; a login's session is kept in `epub-check/state.json` (mode `0600`).
- **OPDS Proxy reader URLs are the credential.** Anyone who knows one can browse and download as its account. Tokens
  are ~78 bits, lowercase and without look-alike characters so they can be typed on an e-reader keyboard. Give each
  device its own URL and revoke it when a device is lost. The admin UI has its own password (argon2id), rate-limited
  logins and the same cookie and form protections. Upstream passwords are stored in plain text in
  `opds-proxy/config.json`, because the proxy has to send them; use dedicated OPDS users where you can. The proxy only
  forwards requests inside the upstream's OPDS path.
- **PocketBook Sync needs the PocketBook password in plain text**, since PocketBook Cloud has no app tokens. It is
  only sent to `cloud.pocketbook.digital`; the resulting tokens are stored in `pocketbook-sync/state.json` (mode
  `0600`). The KOReader credentials only work for BookOrbit's KOReader endpoints, but those include browsing and
  downloading your library; rotate them under *Settings → KOReader* if they leak. The PocketBook client ID and secret
  in the code are the public ones shipped in PocketBook's web app.

## Development

Requires [Bun](https://bun.sh) 1.4 or newer.

```sh
bun install
bun test            # unit and integration tests (fake BookOrbit, PocketBook Cloud and OPDS server included)
bun run typecheck
bun run build       # standalone executable in dist/, as used in the Docker image

# One EPUB Check cycle against a real BookOrbit, changing nothing (state in ./data)
EPUB_CHECK_ENABLED=true EPUB_CHECK_DRY_RUN=true BOOKORBIT_URL=… BOOKORBIT_API_KEY=… bun run once

# Crawl a running OPDS Proxy like a reader would; reports broken or leaking links
bun run opds-crawl http://localhost:8601/<token>/ --search whale
```

Layout: `src/index.ts` is the entry point (`--healthcheck`, `--once`) that starts the features that are on;
`src/config.ts` and `src/settings.ts` read the environment, `src/health.ts` is the healthcheck, `src/login.ts` the
BookOrbit login for web pages, `src/bookorbit.ts` the client for BookOrbit's web API and `src/http.ts` the HTTP
helpers. Each feature has a folder with an `index.ts` that creates it and a `config.ts` with its settings:

- `src/epub-check/`: `check.ts` is the check cycle, `validator.ts` and `repairer.ts` wrap epubveri and epubsana,
  `fixes.ts` holds orbitkit's own fixes (`series.ts` the one for BookOrbit's series metas) with `zip.ts` to rewrite
  files inside an EPUB, `epublift.ts` runs epublift, `replace.ts` replaces books in the library, `upload.ts` keeps
  uploads until they are confirmed, `report.ts` serves the report pages, and `wasm.ts` loads the WebAssembly (Bun
  can't import `.wasm` modules the way the packages expect, so they are instantiated by hand and embedded into the
  executable).
- `src/pocketbook-sync/`: `sync.ts` is the sync cycle, `collection.ts` sends a BookOrbit collection to the cloud,
  `pocketbook.ts` and `koreader.ts` are the API clients, `fingerprint.ts` KOReader's partial MD5 computed while
  streaming, `state.ts` the state file.
- `src/opds-proxy/`: `proxy/` holds the OPDS rewriting (`mapper.ts` URL mapping, `rewrite.ts` XML, `handler.ts`
  request forwarding), `admin/` the web UI (server-rendered HTML, no build step), `store.ts` the config file.

## License

[AGPL-3.0](LICENSE), the license of epubveri, epubsana and epublift, which the image includes.

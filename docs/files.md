---
title: "Files: uploads and agent outputs in one library"
status: reference
updated: 2026-09-25
---

# Files: uploads and agent outputs in one library

You sent Ledger a CSV last week and it produced a report. Today you want either
file without remembering which conversation it was in. Files is the place to
find both, inspect them, download a copy, and return to the discussion.

The page is called **Files**. The storage concept and agent tools continue to
be called **artifacts**. This is a view over the existing store, not another
file store and not a browser of the host's filesystem.

## Files and Canvas have different jobs

- **Canvas** shows a file or result in the context of the conversation you are
  working in. Keep it, including its existing file tiles and download action.
- **Files** is the owner's library across conversations, agents and groups.
  It helps you find something again after the conversation has moved on.
- Both use the same artifact ids, preview components and download endpoints.
  Opening a file on either surface does not create a copy or run an agent.

## What belongs in the library

The default view is **All files**, with two additional origin filters:

- **Created by agents:** outputs published to the artifact store by agent runs,
  including reports, edited images and exported data.
- **Uploaded by you:** files sent through the dashboard, Telegram or another
  supported surface. Being processed by an agent does not change their origin.

Both filters describe origin, not file type or which agent currently uses it.
Where an agent saved or imported an existing external file, the detail view
says "Saved by @handle", not that the agent authored its contents. Legacy
entries whose origin cannot be established remain in All files with "Origin
unknown"; do not guess from a filename or from an absent source surface.

Include durable, non-deleted files already in the store, not just files saved
after this page ships. A published output remains visible even if its run later
fails. Missing bytes are an unavailable-file state, not a reason to erase its
metadata or pretend the file is usable.

Do not include:

- Eager uploads still in an unsent composer, or abandoned upload drafts.
- Temporary browser/computer observations unless explicitly saved as artifacts.
- Arbitrary host files, command stdout, tool chips or charts with no stored file.
- Tombstoned artifacts in ordinary library results.

An upload becomes a library entry when it is durably attached to an accepted
message or surface record, without waiting for a successful model answer.
This lifecycle already exists: uploads are stored eagerly, discarded when
removed from the tray, swept after a day if unsent, and retained once a message
carries them. Preserve it rather than introducing a second retention policy.
Opening Files must not retain an abandoned draft or trigger its deletion.

## The page

Files is the sixth primary dashboard destination, beside Chat, rather than
buried in Settings. Its icon must read as files at a glance at the rail's
icon-only width: use a recognisable file or stacked-documents shape from the
existing visual vocabulary, with a Files tooltip and accessible name.
Routes are `#/files` and `#/files/<artifactId>`. Filters can accompany
either route; browser back restores the previous list and scroll position.
These are authenticated dashboard links, not public sharing links.

Start with a compact list, newest first. Each entry shows:

- Thumbnail for supported images; otherwise the existing file-family icon.
- Filename, or "Untitled file" when no name was recorded.
- File family and size, including a legitimate zero-byte size when present.
- Origin, responsible agent when known, and stored date in the owner's timezone.
- Associated agent/group context, with a count when there are multiple contexts.

The first version has case-insensitive filename search and combinable filters
for origin and file family only. It does not search file contents. Family means Image, PDF,
Spreadsheet, Document, Code, Audio, Video, Archive or File; reuse the existing
family classification rather than exposing only the store's four broad kinds.

Agent, group and date filters are a follow-up, not part of the first-version
query surface. The associations and conversation links still ship in v1.
Group membership alone does not associate every room file with every member.
Missing or retired agents retain their recorded ids and an unavailable-agent
label; their files do not vanish.

Selecting an entry opens a detail/preview panel while keeping the list in
place. On narrow screens it opens the detail view with a clear Back to Files
action. Selection has a stable URL and survives refresh. Every detail view has
a prominent **Download** action and a **Conversations** section. With one
conversation, offer "Open conversation"; with several, let the owner choose.
Use the existing individual-agent or group route as appropriate. Missing
conversation history is explained, not rendered as a broken link.

Loading, no files yet, no filter matches, preview unavailable, file unavailable
and request failure are distinct states. Search, filters, rows and preview
controls work with the keyboard and have accessible names. Selecting another
file resets the old preview's loading and error state; stale responses cannot
replace the newly selected file.

## Previews: explicit capabilities, honest fallbacks

Previewing never edits the original. Download always retrieves the original
bytes, not a preview, extracted text or thumbnail.

The first version adds no preview dependency and bundles no PDF engine or
Office parser. Reuse existing components and platform capabilities.

| Family | First-version preview |
| --- | --- |
| Supported raster image | Fit-to-panel image, preserving aspect ratio. |
| PDF | Browser-native viewer using the existing Canvas `DocumentView` PDF `<object>` pattern; Download fallback when the viewer is unavailable. No page rendering engine in the application bundle. |
| Plain text, Markdown, code | Escaped, bounded text with preserved whitespace; no executable HTML. |
| CSV / TSV | Read-only table, first 200 rows and 30 columns, with an explicit truncation notice. |
| Office documents and spreadsheets, audio, video, archives, other | Metadata/download only in v1. No Office parsing or extraction promise. |

Text previews stop at 100,000 characters and state when truncated. CSV/TSV
cells are displayed as data, never evaluated as formulas. Parsing must handle
quoted fields and embedded newlines correctly, not merely split on commas. Do not
install software, invoke host execution, call an LLM or send file contents to
an external conversion service just because someone opens a preview.

Application-owned text/table parsing requires explicit input-size, memory and
execution-time limits, documented and tested with its implementation, in
addition to the display limits above. Reuse existing upload limits where
applicable. Exceeding a preview limit leaves the original downloadable and
explains why the preview was skipped. Office containers and archives are not
unpacked for previews.

HTML, SVG, scripts and embedded active content must not execute on the
dashboard origin. Keep the passive-image allowlist; render other formats as
escaped text or download-only. PDFs use the browser viewer's isolation rather
than a JavaScript renderer in the page; the `<object>` tag or same-origin URL
validation alone is not a security sandbox. Verify the embedding and response
headers on supported browsers, and use Download when safe embedding is not
supported. Do not grant document content access to dashboard scripts or
credentials. Reuse these preview capabilities in Canvas so the two surfaces do
not develop different renderers or security rules.

The Canvas PDF renderer exists, but the artifact `/preview` endpoint currently
serves only passive raster images. Connecting the browser-native PDF viewer to
an authenticated, PDF-specific inline response is integration work, not an
already-working artifact preview. Keep the image allowlist and attachment-only
handling of other active formats intact.

## Provenance and conversation links

Keep `core.artifacts` as the metadata store and bytes under `BUDDI_DATA_DIR`.
Existing ids, references and download URLs stay valid. Add an owner-facing
metadata projection; do not send storage paths or internal surface/chat ids to
the browser merely to draw the library.

The existing row has `created_by`, source fields and one `conversation_id`, but
that is not a complete usage history: deduplication can reuse an artifact in
another conversation. Library membership and conversation links must use durable
many-to-many associations between artifacts and conversations, not only that
single column. Record available message/run provenance and distinguish uploaded,
produced and reused associations from trusted ingestion/runtime context.

Association writes are idempotent and survive retries. Backfill from existing
artifact metadata, `artifact_ref` blocks, surface attachment records and known
structured output descriptors where attribution is demonstrable. Never infer
provenance from arbitrary assistant prose. Preserve unknowns when historical
records cannot establish an origin or a conversation.

The group runner, individual runner and attachment paths write the association
when they write the reference, in the same transaction wherever one exists,
so the library never lags the transcript. Where there is no transaction today,
make the reference and association one atomic write operation rather than
relying on a later indexing job.

One list item represents one artifact id; reuse can give it several conversation
links. Identical bytes with distinct existing artifact ids remain distinct
entries. Do not introduce cross-context hash merging as part of this feature.
When saving returns a deduplicated row, still record the current use and its
provenance; do not overwrite the original creator with the latest agent.

A file a colleague made through `agent.delegate` is used in two conversations:
the colleague's, where it was saved, and the one that asked, where the runtime
records it with the delegation's result, credited to the colleague. The Files
page lists it once with both links, and the asking thread draws it under the
asking agent's message and on the Delegation card.

An output and an uploaded source in the same conversation are shown together
under that conversation's files. This alone does not prove "created from".
Only show a derivation link if the producing tool explicitly recorded it;
automatic lineage inference and a version graph are postponed.

## Documents agents write

An agent granted `artifacts.write` saves a document into Files itself, so the
owner never has to paste an answer into Word:

```
artifacts.write { title, format: 'markdown' | 'csv' | 'json', content, folder? }
  → { artifactId, filename, title, format, version, mime, sizeBytes, folder?, unchanged?, note }
```

- **What is stored.** Markdown as a `.md` file; a table as a `.csv` (`json`
  takes an array of objects, an array of arrays with a header first, or
  `{ columns, rows }`, and is stored as the CSV it describes). At most
  1,000,000 characters. The title becomes the file's name only, cleaned of
  separators, control characters and leading dots; the bytes are stored
  content-addressed like every other artifact, so no input reaches the disk as a
  path. `folder` is a short label kept as the file's caption: Files shows it at
  the start of the row and under **Filed under**, and search finds it.
- **Provenance.** The file is credited to the agent and the conversation the
  call ran in, the same as any file a run produced, and appears under the
  answer in the chat.
- **Versions.** Writing the same title again in the same conversation saves a
  new file, `Title (v2).md`, then `(v3)`; the earlier ones stay. Exactly the
  same bytes again are not a copy: the tool says nothing new was saved. Outside a
  conversation (a mission) every write is version 1.
- **Tier `auto`.** Its only effect is a new file in the owner's own library,
  never an overwrite and nothing outside buddi, like the memory writes. It is
  granted per agent like any tool; the catalogue's Researcher, Writer, Chief of
  Staff and CFO come with it.

**Downloads are made by buddi, not the model.** A Markdown file's Download in
Files and on its canvas card is a menu: PDF, Word (.docx), then the `.md` as
written; a CSV's is Excel (.xlsx), then the `.csv`. The gateway converts on
`GET /api/artifacts/<id>/export/<md|pdf|docx|csv|xlsx>` (dashboard session or
API token), in pure JavaScript with no browser and nothing fetched: PDF with
pdfmake (MIT, Roboto from pdfmake, Apache-2.0), Word with docx (MIT), Excel
with write-excel-file (MIT). Headings, lists, task lists, tables, links (http,
https and mailto only), code and quotes carry over; an image is its alt text.
Sources over 2 MB are downloaded as they are (413). In a Telegram conversation
the Markdown file is sent as itself and then as a PDF.

The shipped skill `examples/skills/writing-a-document.md` tells an agent with
the tool when a file beats a chat answer and how to shape one: title and date
first, the answer up front, tables only for comparisons, sources last.

## Files agents download

A file a page hands an agent in the browser (a transactions CSV, a statement)
is registered here like any other, credited to the agent, captioned
"Downloaded from <site>", with source surface `browser`, the run id and the
address it came from (docs/browser.md, "Downloads"). The agent passes its id
to the plugin that imports it.

Reading a file back is capped: `artifacts.text` returns at most 16 KB, with
`note: "16 KB of 35 KB; use artifacts.describe or the plugin's import tool"`
when there was more, so a reply built from it cannot overflow. The tool's
description, and `browser.act`'s, tell agents that a statement or CSV goes to
the owning plugin's import tool by id, never into the reply.

## API and access boundaries

Add owner-authenticated, read-only library endpoints:

- `GET /api/artifacts`: metadata with search (filename and caption), origin and family filters;
  simple page-based pagination, default 50 entries and maximum 100 per page.
- `GET /api/artifacts/<id>`: detail metadata and paginated conversation links.
- Reuse `/api/artifacts/<id>/download` and `/preview` for their supported
  formats; add bounded text/table preview data and the PDF-specific inline path
  described above. Do not turn the passive-image endpoint into an arbitrary embed.

Use deterministic newest-first ordering by `(created_at, id)`. Validate page
numbers, identifiers and filter values; parameterize search. Changing search
or filters resets to the first page. Refresh restarts the listing to include
new arrivals; v1 does not promise a snapshot across concurrent writes or
filter-bound cursor pagination. Deduplicate by artifact id when appending pages.
The browser must not load the entire store or all
transcripts to search, filter or establish conversation links. Index the
metadata/associations needed for these queries. Preview work is lazy, never
part of fetching a list page.

An artifact with multiple associations still produces one list entry, not one
per conversation. Display dates in the owner's timezone; date-range querying
is deferred with agent/group filtering.

Normal dashboard authentication protects metadata, thumbnails, extracted text
and bytes, including access through Tailscale. No public bearer links, raw host
paths, directory traversal, or third-party thumbnail requests. Derived previews
follow the source artifact's availability and access checks, including after
tombstoning; a cached preview must not resurrect a deleted file.

This owner-facing library does not change agent grants, memory scopes or file
access policy. In particular, it must not expose a new owner-wide library API
as an automatically granted agent tool. Existing `artifacts.*` tools remain
separate; this spec does not claim they already enforce conversation-level
isolation. `artifacts.write` (above) only adds files; it reads nothing new.

## Acceptance checks

1. A sent dashboard CSV and a Telegram upload appear under Uploaded by you;
   a published agent report appears under Created by agents. Both appear in All.
2. Legacy owner ids and literal `owner` values are classified using known owner
   identity, not mislabelled as agents. Unverifiable history stays unknown.
3. Reusing one artifact in two conversations shows one entry with both links;
   the association is visible as soon as its reference is written, including
   retries and deduplicated saves.
4. A file produced in a group names its producing agent and links to the group,
   not to a fabricated individual conversation.
5. Regression-check the existing upload lifecycle: uploading without sending
   does not add a permanent library entry, sending retains it even if the agent
   fails, and draft discard/orphan cleanup cannot remove a sent file.
6. Filename search, origin/family filters and page-based pagination work
   with equal timestamps, new arrivals, missing creators and no matching files.
7. Existing and new files open by stable URL, download their original bytes,
   and return to the right conversation. Missing/deleted files fail clearly.
8. Preview limits and malformed files fail without hanging the page. Text/code
   and CSV are inert; PDFs use the browser-native viewer or a Download fallback.
   Office files stay download-only, with no new preview dependency. Untrusted
   file content cannot execute in the dashboard's scripting context.
9. Unauthenticated metadata, preview and download requests are refused. Safe
   raster previews and existing Canvas/chat downloads continue to work.
10. Desktop and narrow-screen navigation, keyboard interaction, back/refresh,
    loading/error states and rapid file switching have UI tests. Files is the
    sixth place and remains recognisable at the rail's icon-only width.

## Build order

1. Metadata/provenance projection, durable associations and historical backfill;
   tests for owner identity, deduplication, group attribution and draft lifecycle.
2. Filename/origin/family queries and page-based metadata/detail APIs, with
   access and query tests.
3. Files navigation, list, filters, stable detail routes, download and
   conversation links, initially reusing the existing preview/fallback.
4. Dependency-free previews shared with Canvas: raster images, bounded text/code
   and CSV/TSV, and browser-native PDF embedding, with security/resource tests.
   All other formats remain metadata/download fallbacks.
5. End-to-end checks across individual chats, groups and Telegram-origin files.

Follow-up after v1: agent filtering, then group filtering, then date filtering,
using the associations established in step 1. Agent filtering will match the
recorded creator or use in an individual conversation; group filtering will
match use or production in that group's conversations. Date ranges will use
the owner's timezone, translated to inclusive-start/exclusive-end UTC bounds.
Filter-bound cursor pagination can follow if actual library size warrants it.

Postponed: Office parsing, application-bundled PDF rendering, folders, tags,
renaming, file-content search, versioning, inferred
lineage, bulk actions, public sharing, cloud-drive sync, host-folder browsing,
an in-browser editor and automatic file analysis. Standalone uploads directly
to Files and attaching a library file to a new chat are later additions; v1
collects what existing conversations and agent runs already save. Deletion,
trash/restore and permanent byte cleanup need their own lifecycle design; the
existing draft-discard endpoint must not be repurposed as library deletion.

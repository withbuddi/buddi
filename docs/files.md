# Files: uploads and agent outputs in one library

Status: implementation contract, not built. Agreed 2026-09-20.

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

An output and an uploaded source in the same conversation are shown together
under that conversation's files. This alone does not prove "created from".
Only show a derivation link if the producing tool explicitly recorded it;
automatic lineage inference and a version graph are postponed.

## API and access boundaries

Add owner-authenticated, read-only library endpoints:

- `GET /api/artifacts`: metadata with filename search, origin and family filters;
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
isolation.

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

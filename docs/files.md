---
title: "Files: uploads and agent outputs in one library"
status: reference
updated: 2026-10-13
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
Routes are `#/files` and `#/files/<fileId>`, the same address across a
file's versions and after a Restore (`?v=<n>` shows an older version); an
older link naming a version's id opens its file. Filters can accompany
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
Spreadsheet, Document, Presentation, Code, Audio, Video, Archive or File:
one rule, `@buddi/core/file-families` (`familyOf`, and the same as SQL for the
filter), which classifies Office files by `officeKindOf` first (a .docx is a
Document, a .xlsx a Spreadsheet, a .pptx a Presentation), never by the "xml"
or "zip" in their mime.

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

The first version added no preview dependency and bundled no PDF engine.
Office documents have their own renderers, loaded only when one is opened
(**Office documents** below).

| Family | First-version preview |
| --- | --- |
| Supported raster image | Fit-to-panel image, preserving aspect ratio. |
| PDF | Browser-native viewer using the existing Canvas `DocumentView` PDF `<object>` pattern; Download fallback when the viewer is unavailable. No page rendering engine in the application bundle. |
| Plain text, Markdown, code | Escaped, bounded text with preserved whitespace; no executable HTML. |
| CSV / TSV | Read-only table, first 200 rows and 30 columns, with an explicit truncation notice. |
| Word, Excel, PowerPoint (.docx, .xlsx, .pptx) | Drawn by buddi in the browser, at most 20 MB: see **Office documents**. |
| Legacy and Apple Office formats, audio, video, archives, other | Metadata/download only; an Office file of any kind also has Open in app. |

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
escaped text or download-only (Office documents are parsed into inert
markup in a sandboxed frame, a table or a canvas: below). PDFs use the browser viewer's isolation rather
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

One list item represents one file (`core.files`), across its versions; reuse
can give it several conversation links, gathered from all its versions.
Identical bytes in distinct files remain distinct entries. Do not introduce cross-context hash merging as part of this feature.
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
artifacts.write { title, format?: 'markdown' | 'csv' | 'json' | 'docx' | 'xlsx' | 'pdf', content, folder?, fileId?, readVersion?, confirmedRebuild? }
  → { artifactId, fileId, filename, title, format, version, mime, sizeBytes, folder?, unchanged?, rebuilt?, note }
```

- **A Word, Excel or PDF file when that is what was asked for.** `docx` and
  `pdf` take Markdown, `xlsx` a table (CSV, or JSON as below); buddi's
  exporter makes the file and those bytes are what is stored — a `.docx` with
  the Word mime, a version like any other — so the owner gets the document
  itself, previewed as one on the Canvas and in Files and opened in his own
  app. Writing it again (by title in that format, or by `fileId` in Markdown
  or a table) rebuilds its next version; see **Office documents** for who
  may. `markdown` (the default) is for notes and drafts nobody asked to be
  Word; the turn's context says so once to every agent that writes files.

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
- **Versions.** `fileId` writes the next version of that file (the title is
  then ignored; the file keeps its name). Without it, the title names the file
  of that name in this conversation, compared ignoring case, and a new file
  when there is none; a title that differs by more than case is a new file.
  Exactly the same bytes as the newest version are not a copy: the tool says
  nothing new was saved. Outside a conversation (a mission) every write is a new
  file. See **Versions** below.
- **Tier `auto`.** Its only effect is a new file, or a new version of one, in
  the owner's own library — never an overwrite and nothing outside buddi, like
  the memory writes. It is granted per agent like any tool; the catalogue's
  Researcher, Writer, Chief of Staff and CFO come with it.

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

## Versions

A file is a row of `core.files`: its name (never with a version mark), its
type, its conversation, who made it, and — for a command's output — the
workspace path it was captured from. Every row of `core.artifacts` is one of
its **versions**: a number from 1, the bytes (content-addressed on disk), and
who wrote that version (`created_by`: the agent, or `owner` for an upload, a
save on the Canvas or a Restore). Versions are appended and never rewritten;
the **newest** version is the highest-numbered live one. A file's counter
(`next_version`) only goes up, so a number is never given twice, even after a
deleted version is purged.

What makes a new version:

- `artifacts.write` by `fileId`, or by a title that names an existing file in
  the conversation (above); a plugin's `files.save` with `version.of`, or with
  `version: { base, ext }` the same way (host API 1.34).
- A command's output captured again from the same workspace path in the same
  conversation (`host.exec` `outputs`): two paths that share a name are two
  files. Unchanged bytes are the newest version again, not a new one.
- The owner's save on the Canvas, and **Restore as newest** in Files.

Two versions may hold the same bytes (a Restore does); re-sending an
attachment into the same chat is still the same file, not a new version.
Bytes are written beside their path and renamed into it, so a path only ever
names whole bytes, and a blob is checked (size and hash) before it is reused
and written again if it is not those bytes.

One lock per file serialises every change to it — a version, a delete, an
undelete — and the title or workspace path that names a file is locked while
it is looked up or created, so two writes at once never make two files.

Files lists each file once, as its newest version, with "N versions" beside
its date. A file's page lists its versions, newest first, with who wrote each
("You, restored v2" for a Restore), View, **Restore as newest** and Delete
version. A download names its version: the second version of `Plan.md` is
`Plan (v2).md` when downloaded (`/download` and `/export/…`), never in Files.

`GET /api/files/<id>` is the one view of a file the Canvas and Files read: the
file, its newest version, and its versions (and, for the Files page, where it
was used). Any version's id names its file
there, in `canvas.open`, and in `artifacts.write`'s `fileId`.

### Conflicts

Every save names the version it started from. A version saved since — by
buddi, a command, another tab — refuses it, with one shape everywhere:
`409 { error, conflict, current?, workspaceText? }`, where `conflict` is
`newer` (with `current`, the version that won), `workspace` (a command changed
the copy in its workspace since; `workspaceText` is what it holds) or `busy`.
The editor and Restore answer it the same way, under one phrase: "This file
changed since you opened it", with **Show theirs** and **Keep mine**.

An agent's write is refused the same way when the newest version is not its
own and it did not say it read it: `readVersion` is the version it read
(`artifacts.text` returns it), and a newer one than that is refused too, with
what to read.

## The editor

A text file on the Canvas opens in an editor — one tab per file, kept by its
file id across every version, write and open. The tab shows the newest
version; when buddi writes a newer one, an unchanged view updates in place
and marks the changed lines, and an unsaved edit is never replaced (the bar
above). Save (⌘S/Ctrl+S) is `POST /api/files/<id>/versions { base, text }`:
a new version by `owner`. Files over 1 MB, and text that is not UTF-8, open
read-only. Which files are text is one rule, `@buddi/core/text-files`, applied
by the page and the server alike.

An edit lives in the page while the tab is open, even when it goes to the
back; closing the tab, or the page, asks first. What the owner typed while a
save was out — even an edit undone back to the old text — stays as an edit
over the version just saved.

### Edited by you

Three things keep the agent from dropping the owner's version afterwards:

- **Back into the workspace — unconfined workspaces only.** A command's
  output belongs to the workspace of the agent that made the file, in its
  conversation; whoever writes later versions does not change that. The
  owner's save writes there too only while every command that ever ran in
  that workspace ran unconfined, as the owner's own user (a plain
  `host.exec`): such a process can already write anywhere he can, so a save
  racing it opens no escape. Once a sandboxed run (a skill bundle's script)
  has used the workspace, it is marked — outside the workspace, where nothing
  it runs can remove the mark — and the owner's saves stay in Files only: a
  process that run left behind could swap a folder under the save's path
  checks (Node cannot open relative to a directory handle) and reach outside
  its sandbox through the save. The agent is then told its workspace copy is
  out of date. Where it does write, it writes only
  inside that workspace, only while the copy still holds what buddi last read
  or wrote there (a copy a command changed since is the `workspace` conflict),
  never through a link (every folder on the way is checked before and after),
  staged beside the copy and renamed over it once the save is committed, and
  only while no `host.exec` command is running in any conversation (`busy`):
  a command elsewhere may use any workspace as its cwd, and none starts while
  the save holds the lock. A copy that cannot be written is reported ("Saved
  in Files; the workspace copy couldn't be updated"), and saving again retries.
- **Said on every turn while it is true.** For the files of the conversation
  an agent made or wrote whose newest version is the owner's, the turn's
  context says so — "The newest version of <file> is the owner's (vN, saved
  <time>); you last wrote vM" — and how to build on it with the tools the
  agent holds: the workspace copy when the save was written back there,
  otherwise `artifacts.text` then `artifacts.write { fileId, readVersion }`.
  Once the agent has read his version (`artifacts.text`, `artifacts.describe`
  or a plugin's `files.read` record the version read) or written the file
  again, it is not said.
- **Refused unread.** As above: a write over the owner's newest version
  without `readVersion` is refused.

How agents work with files is said once, in the turn's context, for the tools
they hold: change a file by its `fileId` rather than a new title, prefer
`artifacts.write` to shell redirection, show a file with `canvas.open
{ fileId }` rather than pasting it, and never read buddi's own data directory
or call its HTTP API from a command.

## Deletion

A file's ⋯ menu has **Delete file** (all its versions, after a confirm), and
each version **Delete version** (the one before becomes the newest; the last one
takes the file with it). Both are soft and serialised with writes by the
file's lock: a conversation that carried the file shows it as deleted,
nothing on disk or in a workspace changes, and **Undo**
(`POST /api/files/<id>/undelete`) brings back exactly what was deleted. A
version written after a deleted one gets the next number, never a deleted
one's. An agent asked to write or open a deleted file is told the owner
deleted it.

After 30 days the hourly artifact sweep removes deleted versions, files left
with none, and the bytes no remaining version stores; each blob is checked
and unlinked under its own lock, the one a save holds until its row is in, so
a save adopting the same bytes meanwhile keeps them.

On the Canvas a deleted file's tab goes, unless it holds an unsaved edit:
then the edit stays on screen with **Save as new file**, which makes a new
file of the owner's in the conversation (`POST /api/files`) — always a new
file, listed in Files whether or not a conversation is named, sharing bytes
on disk with any file that holds the same ones but never becoming that file.
What he types while it is being made stays as an edit.

## Office documents

A Word document, a workbook or a deck is a file like any other: one row of
`core.files`, its mime never changing, numbered versions. Which files these
are is one rule, `@buddi/core/office-files` (`officeKindOf`), beside the text
rule and applied by the page and the server alike: the Open XML mime, or the
`.docx`/`.xlsx`/`.pptx` extension when the type was not given. `.doc`, `.xls`,
`.ppt`, Pages, Numbers, Keynote and OpenDocument files are not read; they
are downloaded, or opened in the owner's app.

**Seeing one.** `ArtifactPreview` stays the one preview switch, on the
Canvas and in Files; an Office file goes to `OfficePreview`, which fetches the
version's bytes from `/preview` (same auth; at most 20 MB, past that 413 and
Download only) and loads one renderer for its kind, never part of the
dashboard's bundle, never kept by the offline worker:

| Kind | Renderer | What is drawn |
| --- | --- | --- |
| .docx | docx-preview (Apache-2.0), into an `<iframe sandbox="allow-same-origin">` with no scripts | its pages, images inlined; comments, tracked changes and embedded HTML left out |
| .xlsx | read-excel-file (MIT) for values, `@buddi/core/sheet` for the look, buddi's own table | a tab per sheet, the first 1,000 rows and 50 columns of each: values, number formats, fonts' weight and colour, fills, borders, alignment, widths, row heights, merges, frozen rows and columns, conditional colour (`cellIs`, `expression`, text rules); a formula without a value computed (**Composed workbooks** below); charts, colour scales and data bars not drawn |
| .pptx | @silurus/ooxml (MIT; Rust/WASM parser, Canvas 2D), about 1.4 MB gzipped with its parser and worker | slide by slide on a canvas, Previous and Next; its Google Fonts option stays off |

An Office file or a PDF a call made — `artifacts.write { format }` or a
command's output — opens as its file's tab (`file:<fileId>`) in this preview,
the same rule as a text file (`opensAsFileTab`, `canvas/file-tabs.ts`): a
write is the file, a command's files come after its own tab. A PDF is one
rule too, `isPdf` in `office-files`: its mime, or `.pdf` on an untyped file
(`UNTYPED_MIMES`), for its family, its tab and the server's preview alike.
The Word preview maps Office font names to what the computer has (Calibri to
Carlito, Helvetica Neue, Arial; Cambria to Caladea, Georgia; and so on) with
`@font-face` `local()` rules in its frame, the real font first.

A render is made in the browser from the version's bytes and thrown away
with the tab: nothing derived is stored. The Canvas card shows the file's
newest version and who wrote it, and draws a newer one when it arrives.

**What the agent sees.** `artifacts.describe` and `artifacts.text` read
Office files like PDFs, with the same caps: a document's text (mammoth,
BSD-2-Clause), each sheet as CSV under a `## <sheet>` heading with the sheet
count, each slide's text under `## Slide n` with the slide count.
`artifacts.write { fileId, readVersion, format, content }` onto a .docx
(Markdown) or a .xlsx (`csv` or `json`) stores the next version in that
format, made by the download's exporter (`export/document.ts`, in its worker
with its limits), and the reply says the formatting was rebuilt from the
text, not kept. Text that does not fit the file is refused (a table for a
Word file). A write never changes a file's format, and:

- over a newest version an agent wrote it is rebuilt freely;
- over one the owner wrote (a file he sent, a save in Word) only with his
  yes on an approval card: the refusal tells the agent to read it and tell
  him, and `confirmedRebuild: true` then raises the card; the write runs
  only as the action he approved (`rebuildNeed`, in core; nothing the model
  passes is enough);
- a file whose newest version a program composed is changed by editing that
  program (**Composed documents** below); written from text only once the
  owner asked for it (`confirmedRebuild`);
- a .pptx is never written from text; a deck is composed.

**Open in app.** On an Office file's Canvas card and its page in Files,
beside Download. `POST /api/files/<id>/open` exports the newest version to a
working copy the server names itself — `<data>/open/<fileId>/<name>`, the name
cleaned by the file-name rule — and hands it to the computer's default app
(`open`, `xdg-open`, PowerShell's Start-Process; no shell command line). A
nonzero exit from the opener is an error (502); no answer in ten seconds is
said as "opening", not as success. Beside the copy, `.buddi.json` keeps the
session: the version the copy is based on, what buddi last put there or
brought back (hash, size, time) and its state, so a restart resumes the watch
and brings back what was saved while buddi was down.

One lock per file covers everything a session does. A change is read once
it held still, through a handle that follows no link, and only if it is the
same file, size and time after the read and a whole package of its kind
(the limits below); anything else is looked at again later. It is imported
through the owner's one save (`saveOwnerBytes`, the file's lock, over the
version the copy is based on), a version by `owner` like an edit on the
Canvas. The app's lock and scratch files are never imported. A version saved
meanwhile refuses it with the one conflict shape, and the page shows the same
bar — "This file changed since you opened it", **Keep mine** (saved over it)
or **Show theirs** (the watch stops; his copy stays on disk, with **Save mine
as new file** while it holds work Files lacks): `POST
/api/files/<id>/open/resolve { keep: 'mine'|'theirs'|'new' }`. Reopening
never writes over a copy that holds anything Files does not: it is brought
back, or raises the bar.

A copy is removed only when it holds exactly what Files has and no app holds
it (its lock file is beside it): after two idle hours, after a day, or once
he kept theirs. Every access — reading, writing, the record, the sweep —
checks each folder from the data dir down with lstat and refuses a link or a
junction. Only from a dashboard on the computer buddi runs on, never through
a proxy such as Tailscale Serve (its forwarding headers make the request
remote): elsewhere the routes refuse and the button is off, saying so.

**Package limits.** Every Office package is checked from its zip directory
before anything is inflated — at most 2,000 parts, 50 MB per part and 200 MB
in all, no ZIP64 (`OFFICE_ZIP_LIMITS`, `officePackageProblem` in core) — by
the page before a previewer parses it, by the server before it extracts text
(in a worker thread with a 256 MB heap, stopped after 15 seconds), and by
Open in app before it imports a save.

Not in this phase: editing in the Canvas, converting to PDF (LibreOffice),
charts, comments and tracked changes.

## Composed documents

Markdown through `artifacts.write` is the quick path: notes, drafts,
anything the owner reads in the chat or edits himself. When he will send,
print or present it — a letter, an offer, an invoice, a report under his
name, any deck, a budget or a model — or asks for a look, an agent holding
`artifacts.compose` writes a small JavaScript program against one library
and buddi runs it: `docx` (MIT) for a Word document, `pptxgenjs` (MIT; 2.6
MB unpacked, its only real dependencies jszip and image-size) for a
PowerPoint deck, `write-excel-file` (MIT, 4.1.1; 2.7 MB unpacked, its one
dependency fflate) for an Excel workbook. The bytes
it returns are the file's next version, and the program is kept beside that
version, so a later change edits the program and keeps the design.

```
artifacts.compose { kind: 'docx'|'pptx'|'xlsx', program, title?, fileId?, readVersion?, folder?, attachments?: fileId[], dryRun?, confirmedRebuild? }
  → { artifactId, fileId, version, filename, mime, sizeBytes, render, console?, unchanged?, note }
artifacts.compose { fileId, source: true }  → { fileId, version, artifactId, kind, library, libraryVersion, program, note }
artifacts.compose { guide: 'docx'|'pptx'|'xlsx'|'layout' }  → { guide, text }
artifacts.view { fileId }  → { id, fileId, version, width, height, shown, note } and the picture, once
```

The program is an ES module whose default export, `async (ctx) => bytes`,
returns the file (`Packer.toBuffer(doc)`, `pres.write({ outputType:
'nodebuffer' })`, `Buffer.from(await (await writeXlsxFile(sheets,
options).toBlob()).arrayBuffer())`). `ctx.files` holds the pictures named in `attachments`
(PNG, JPEG, GIF or BMP from Files, at most ten and 20 MB): the only way an
image gets in. `artifacts.view` shows the agent a picture first — upright,
at most 1568 px on its long side and about 1 MB as a JPEG, as an image beside
the result, sent once and never stored in the transcript; a model that takes
no images reads a line saying so in its place. The picture is decoded in a
worker thread with a 256 MB heap and 15 s, and a PNG's compressed pixels are
inflated with a cap first — to exactly what its header promises — so a tiny
file that unpacks into gigabytes is refused before any decoder sees it.

**One save, the same rules.** Title, folder, versions by `fileId`,
`readVersion` and the conflict refusal are `artifacts.write`'s, through the
same save (`files.save`, host API 1.35, with `composed`) under the file's
one lock; the mime never changes and a program for another kind is refused.
The rebuild rule reads both ways (`rebuildNeed`, in core), on the newest
version alone: a composed or an agent's newest version is composed again
freely; one the owner wrote (a save in Word, Open in app, a file he sent)
only with his yes on a card. The refusal names his version so the agent
reads it (`artifacts.text`), carries his changes into the program and tells
him; `confirmedRebuild: true` then raises the card — "Rebuild <file>? Your
edits in v3 would be replaced by buddi's program; formatting rebuilt." —
bound to the file, the version replaced and a hash of the program, and the
call runs only as the action he approved (a version saved meanwhile changes
the card's envelope, and nothing is written). The other way,
`artifacts.write` from text onto a composed file is refused with "change it
by editing its program"; `confirmedRebuild` there says the owner asked for
the Markdown rebuild. `dryRun`
runs the program and stores nothing, for trying a layout; every real run is
a stored version (the same bytes again are not).

**Where the program lives.** `core.compose_sources` (one row per composed
version: the kind, the library and its version, the Node it ran under and
the program, at most 200 KB), deleted with its version by the purge. Owner
versions have none. **Restore as newest** copies the row with the bytes, so a
restored composed version is composed. `GET /api/files/<id>` marks each
version `composed`; Files says "Made by a program" on such a version with
**View program**, which shows it read-only (`GET
/api/files/<id>/versions/<n>/source`); a version's row says "with a
program". The Canvas opens a composed file as its file tab, like any Office
file a call made.

**The render summary.** Every compose reply carries `render`, read back from
the bytes in the extractor's worker (15 s, 256 MB) by a cheap pass over the
XML: for a document the page size and paper, margins, fonts, body size, the
heading outline, an estimate of the pages, explicit breaks, tables (rows ×
columns), pictures, header and footer, and the first 2,000 characters; for a
deck the slide size, fonts, each slide's title, text and shape count, and
**warnings** — a shape past the slide's edge, or text estimated (characters
× size against the box) to spill out of its box; for a workbook
(`XlsxRender`) each sheet's name, rows × columns, header row, frozen rows
and columns, the columns given a width, counts of styled cells, formulas,
merges and conditional rules, the number formats used, its first 40
formulas as `{ cell, formula, value }` (the value as the sheet shows it,
through the preview's formatter) and `errors` — a formula whose value is an
error, or that buddi could not compute. Nothing is drawn; the owner is the
eye, and for a sheet the numbers are the check. The guides end with a
checklist the agent reads against it. A self-check by picture is not in
this phase.

### Composed workbooks

A program imports `write-excel-file` and the runner resolves it to the
library's **universal** build (`toBlob()`, fflate only); `write-excel-file/node`
(node:fs, node:stream) and `/browser` are refused by name. fflate is loaded
through its plain build, since its Node build reaches for `node:module` and
worker threads, and the library's async zip is given its own synchronous one
(fflate would start a worker for a part over 160 KB, and there are none in
the sandbox), so the built-ins stay the allowlist below. Sheets are rows of
cell objects: fonts, fills, borders per side, alignment and wrap, number
formats, widths, row heights, merges, frozen rows and columns, formulas,
conditional formatting (`cellIs`-style and formula rules), several sheets.
No charts, data validation, named ranges or pivot tables: the guide says to
tell the owner.

**The fill.** write-excel-file, like openpyxl, writes a formula and no
value, so a sheet in Quick Look, Telegram, mail or on a phone would show
empty totals. After every xlsx compose — and never on an upload, a
command's output or an owner's save: buddi never changes bytes it did not
make — the extractor's worker (15 s, 256 MB) runs the sheet engine over the
workbook and writes each formula's value into the sheet XML (`<v>`, typed
`t="str"`, `"b"` or `"e"` where it is not a number) and `calcPr
fullCalcOnLoad="1"` into `workbook.xml`, so Excel and Numbers recompute on
open: buddi's value is a preview, the app's is the truth. The stored
version is the filled bytes; the program is kept as written. A formula the
engine could not compute stays without a value and is named in
`render.errors`. If the fill itself fails, the program's bytes are kept and
the preview computes. `artifacts.write format xlsx` has no formulas and is
untouched.

**The sheet engine**, `@buddi/core/sheet`: one module, browser-safe like
`office-files`, with two callers, the fill and the preview (the artifacts
plugin reaches what it uses through `@buddi/core/plugin`, like the Office
rule).

- `readWorkbook`: every cell's cached value, formula (shared formulas
  expanded) and format, and per sheet its widths, row heights, frozen pane,
  merges and conditional rules. `readStyles`: `styles.xml` (number formats,
  fonts, fills, borders, cell formats, the formats conditional rules apply)
  and `theme1.xml`'s colour slots with tint, resolved to one style per cell
  format. read-excel-file stays what reads values and dates for the agent's
  CSV and the preview's table.
- `evaluate`: fast-formula-parser (MIT, 1.0.19 pinned; chevrotain, jstat,
  bessel, bahttext; about 300 KB minified, loaded only when a formula needs
  computing — in the page its own chunk) over buddi's cell reader, plus
  buddi's own COUNTA, COUNTBLANK, SUMIFS, COUNTIFS, AVERAGEIFS, MATCH and
  SUBTOTAL (which skips the subtotals in its range, as Excel does), and
  never WEBSERVICE. Caps: 20,000 formula cells a workbook, 2 s a sheet.
  A circular reference is `#REF!`, a function it does not know `#NAME?`,
  and a formula reading one of those is not computed either; each is listed
  with its reason. Not HyperFormula (GPL).
- `formatCell`: ssf (Apache-2.0, 0.11.2, SheetJS's format engine) for
  `#,##0.00`, `0%`, `[Red]` sections, dates and `[$€-407]`; the one
  formatter of the preview and the render summary.
- `conditionalStyles`: `cellIs`, `expression` (its formula moved for each
  cell, as Excel reads it) and the text rules, in priority order with
  `stopIfTrue`; colour scales, data bars and icon sets are not drawn.

**The preview** draws the values, then the look over them; a formula
without a value (an openpyxl file, an upload) is computed in the page and
the sheet's footer says "Totals calculated by buddi"; a cell it could not
compute shows its error. The owner's bytes are only read. Fonts stay the
table's; borders are hairline, 1 px and 2 px for thin, medium and thick;
widths are characters × 7 px.

**Which tool.** Both tools' descriptions and the turn's files policy carry
one rule (`SHEET_RULE`): `artifacts.write` format `xlsx` for a flat table
the owner asked for as a spreadsheet (one sheet, header bold and frozen, no
formulas); `artifacts.compose` kind `xlsx` for anything with a formula, a
number format, an input cell or several sheets, or asked as a budget,
model, tracker, plan or calculator. After two failed runs the agent writes
the table with `artifacts.write` format `xlsx`, the numbers worked out as
values, and says so.

**Rebuilding over his numbers.** The rebuild rule is the documents' one. An
owner's version of a workbook holds the numbers he typed: the refusal tells
the agent to read it (`artifacts.text`, the values his app saved, as CSV)
and carry the inputs he changed into the program's data — never a formula's
result — then `confirmedRebuild` raises the card.

**The sandbox.** A child Node, never buddi's own process, and only ever
inside the OS sandbox: Node's permission model is not a boundary by itself
(Node says so; an SQL `ATTACH` through `node:sqlite`, for one, is outside its
checks), so it is one layer of several, not the wall.

- **The OS sandbox**, the one skill scripts run under, handed to every
  plugin as `ctx.buddi.confinement` (host API 1.35): `sandbox-exec` on macOS
  (network, writes outside the work folder, `process-fork` and every signal
  but to itself denied — it cannot kill or poke buddi, its parent — and only
  the system, Node, the libraries and the work folder readable; of Homebrew
  only its programs, libraries and certificates), bubblewrap
  `--unshare-all` on Linux (its own namespaces, nothing of the owner's
  bound). Without one compose does not run.
- **Node's permission model**: `node --permission --allow-fs-read=<work>
  --allow-fs-read=<library>… --disallow-code-generation-from-strings
  --max-old-space-size=384 run.mjs` (and `--no-experimental-webstorage` on
  Node 25+). Nothing else is allowed: no `--allow-fs-write`,
  `--allow-child-process`, `--allow-worker`, `--allow-addons`,
  `--allow-wasi`, `--allow-inspector`, and no `--allow-net`, so on Node 25
  and later the network is denied here too. No `eval`, no `new Function`.
  Readable: the run's own folder (`<data>/plugins-data/artifacts/compose/run-<id>/`,
  removed after the run) and the real folders of `docx`, `pptxgenjs`,
  `write-excel-file` and their dependencies, each `realpath`ed so no granted folder holds a link.
- **The runner** resolves every import itself, and loads code only from a
  file in the work folder or a granted library (never a `data:` or `blob:`
  URL, which would be `eval` by another name): the program may import only
  its library, and a program or library only the built-ins `buffer`,
  `events`, `path`, `stream`, `string_decoder`, `url` and `util` (what docx
  and pptxgenjs were traced to use; write-excel-file's universal build
  needs none). Every other built-in — `fs`, `net`,
  `child_process`, `worker_threads`, `vm`, `sqlite`, `inspector`, `module`…
  — is refused; pptxgenjs's own `fs` and `https` imports get a module that
  refuses when used. Before the program runs it removes
  `process.getBuiltinModule`, `binding`, `dlopen` and `report`, and the
  network globals (`fetch`, `WebSocket`…). Where the libraries are installed
  reaches it on fd 4, read and closed before the program runs, never as a
  file the program could read.
- **Limits**: 20 s on the clock (then the whole process group is killed),
  30 s of CPU (`ulimit -t`), 384 MB of heap, and — because the heap limit
  does not count Buffers — the group's resident memory sampled every 100 ms
  (`ps` on macOS, `/proc` on Linux) and the group killed past 512 MB; on
  Linux a 1 GB data limit too (`ulimit -d`). A 200 KB program, 20 MB back;
  the environment is `PATH` only, no keys. One run at a time per
  conversation, four in the service.
- **What comes back** on fd 3 is one frame, checked before it is believed:
  `B` and the file's bytes, or `E` and an error object of short strings.
  Anything else — a program can write fd 3 itself — is the program's error,
  never a fault in buddi. The console stays text (its tail, 64 KB of each
  stream, kept).
- Errors come back to the agent as one line it can act on — `program_error`
  (the message, and the program's own frames as `program.mjs:line:col`),
  `forbidden` (what it tried: load `node:fs`, write a file, use the
  network…), `timeout`, `memory`, `too_large`, `not_a_package`,
  `unavailable` — with no path of buddi's. The conversation's first failed
  run brings the guide with it. After two failed runs the agent writes the
  document with `artifacts.write` format `docx` and says so.

**Platforms.** macOS: runs (sandbox-exec). Linux: runs with bubblewrap;
without it compose is off and the doctor says to install it. Windows: off —
there is no OS sandbox buddi can use there without administrator rights;
Windows support is planned. Only a Node with this year's permission-model
security fixes runs it: 22.23.2, 24.18.1 or 26.5.1 and later on those lines
(the July 2026 releases: CVE-2026-58043, -58039, -56847), or a later line;
buddi.app and the installers carry 26.11.1. Off, the tool refuses with the
reason and `buddi doctor`'s **compose** row says it.

**What agents are told.** The tool's description and, once per turn, the
files policy: compose a designed or "professional" document, keep plain
notes in Markdown, which tool makes a spreadsheet, change a composed file
by reading and editing its program, and fall back to `artifacts.write`
format `docx` (a sheet: `xlsx` with values) after two failed runs. The
guides (`packages/tools/artifacts/guides/`: docx, pptx, xlsx, layout) are
fetched with `{ guide }` (a docx, pptx or xlsx guide comes with the layout
one), never put in the prompt, and the first failed run in a conversation
brings its guide unasked. Tier `auto`, granted
per agent: the first assistant holds it through `artifacts.*`; the
catalogue's Writer, Chief of Staff and CFO name `artifacts.compose` and
`artifacts.view` in their entries (buddi-market).

Not in this phase: templates, pixel previews or PDFs of composed files, a
self-check by picture, charts, data validation, named ranges and pivot
tables in a workbook, filling values into files buddi did not compose,
editing them on the Canvas, and merging an owner's Word edits back into a
program.

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

Owner-authenticated library endpoints (writes are the owner's, never an agent's):

- `GET /api/artifacts`: one entry per file (its newest version) with search
  (name and caption), origin and family filters; default 50 entries and
  maximum 100 per page.
- `GET /api/artifacts/<id>`: one version's detail, the file's versions and its
  paginated conversation links.
- `/api/files/<id>`: the file and its versions, its newest text, a new
  version (save or Restore), delete, undelete; `POST /api/files` for a new
  text file. See **Versions**, **The editor** and **Deletion**.
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
   Office files are drawn by buddi's own lazy renderers (below). Untrusted
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

Postponed: application-bundled PDF rendering, folders, tags,
renaming, file-content search, inferred lineage, bulk actions, public
sharing, cloud-drive sync, host-folder browsing and automatic file analysis.
Standalone uploads directly to Files and attaching a library file to a new
chat are later additions. Versions, the editor and deletion are above; the
composer's draft-discard endpoint (`DELETE /api/artifacts/<id>`) stays the
composer's, separate from deleting from Files.

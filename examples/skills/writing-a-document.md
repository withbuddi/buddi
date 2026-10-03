---
name: writing-a-document
description: When to save a document into Files with artifacts.write instead of answering in the chat, and how to shape it so it prints and exports well.
provenance: owner
source: house rule — the owner should never have to paste an answer into Word
created: 2026-10-02
---

This applies only when you have `artifacts.write`. Without it, answer in the chat and never promise a file.

**File or chat.** Write a file when the owner asks for one ("a report", "a document", "something I can print or send", "a spreadsheet"), or when what you made is long or structured enough that they will keep it: a comparison, a plan, a letter, a table of more than a dozen rows. A quick answer, a few bullets or one number stays in the chat. When in doubt, answer in the chat and offer the file in one line.

**After writing.** Say in one or two sentences what is in it and that it is in Files. The owner downloads it from there as PDF or Word (a table as Excel or CSV); on Telegram it arrives as a file. Never tell them to copy it into another program, and never paste the whole document into the chat as well.

**Shape.**
- First line: the title as a `#` heading. Second line: the date, in words (2 October 2026).
- Open with the answer or the summary in two or three sentences, then the detail.
- `##` sections with plain names. Prose for reasoning; a list for steps or items; a table when the reader compares things across the same columns.
- Sources last, under `## Sources`: one per line, the title and the link.
- Keep it plain: no emoji, no decoration, no HTML, no images. Code blocks only for code or exact values someone will type.

**Tables.** A table on its own (numbers to sort, sum or chart) is `format: 'json'` as an array of objects, or `csv`; give numbers as numbers, without currency signs or thousands separators, and put the unit in the column name ("Price (EUR)"). A table inside a report stays a Markdown table.

**Revising.** To change a document, write it again under the same title: that saves a new version and keeps the earlier one. Keep the title stable; a new title is a new document.

/**
 * `artifacts.write` — an agent saves a document into the owner's Files.
 *
 * A capability any agent can be granted, not a document agent: the report a
 * Researcher wrote lands in Files as a Markdown file (a table as a CSV), and
 * buddi itself turns it into PDF, Word or Excel when the owner downloads it.
 * The model never produces a binary format.
 *
 * Tier `auto`, like the memory writes: the only effect is a new file in the
 * owner's own library, credited to the agent and its conversation, never an
 * overwrite and never anything outside buddi. A file the owner does not want
 * is one Delete away.
 *
 * Nothing in the input reaches the disk as a path. The title becomes the
 * file's *name* only; the bytes are stored content-addressed by the host
 * (`artifacts/<yyyy>/<mm>/<sha256>.<ext>`).
 */
import type { ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import {
  FORMAT_FILE,
  MAX_DOCUMENT_CHARS,
  MAX_FOLDER_CHARS,
  MAX_TITLE_CHARS,
  nextVersion,
  parseJsonTable,
  safeName,
  toCsv,
  versionedName,
  type DocumentFormat,
} from '../document.js';

const writeInput = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('The document title, e.g. "Heat pumps compared". It names the file; write it as a person would, not as a file name.'),
  format: z
    .enum(['markdown', 'csv', 'json'])
    .describe("'markdown' for a report or any prose; 'csv' for a table as CSV text; 'json' for a table as an array of objects (saved as CSV). A table can be downloaded as Excel, Markdown as PDF or Word."),
  content: z
    .string()
    .min(1)
    .max(MAX_DOCUMENT_CHARS)
    .describe(`The whole document. At most ${MAX_DOCUMENT_CHARS.toLocaleString('en-US')} characters.`),
  folder: z
    .string()
    .trim()
    .min(1)
    .max(MAX_FOLDER_CHARS)
    .optional()
    .describe('A short label to file it under, e.g. "Taxes 2026". Shown with the file and found by search.'),
}).strict();

export interface WrittenDocument {
  artifactId: string;
  filename: string;
  title: string;
  format: DocumentFormat;
  version: number;
  mime: string;
  sizeBytes: number;
  folder?: string;
  /** True when these exact bytes were already in Files: nothing new was written. */
  unchanged?: boolean;
  note: string;
}

export const write: ToolDefinition<z.infer<typeof writeInput>, WrittenDocument> = {
  name: 'artifacts.write',
  description:
    "Save a document into the owner's Files: a report, a plan, a letter, a table. Use it when the owner asks for a file, or when what you made is long or structured enough that they will want to keep, print or send it; a short answer stays in the chat. The owner downloads it from Files as PDF or Word (Markdown) or Excel (tables) — never tell them to paste it into another program. Writing the same title again in this conversation saves a new version; the earlier one stays.",
  tier: 'auto',
  producesArtifacts: true,
  input: writeInput,
  async execute(input, ctx) {
    const files = ctx.buddi?.files;
    if (!files) throw new Error('Files is not available to this agent');
    const { mime, ext } = FORMAT_FILE[input.format];
    const title = input.title.replace(/\s+/g, ' ');
    const base = safeName(title, MAX_TITLE_CHARS, 'Document');
    const folder = input.folder === undefined ? undefined : safeName(input.folder, MAX_FOLDER_CHARS, '') || undefined;

    let text: string;
    if (input.format === 'json') {
      const table = parseJsonTable(input.content);
      text = toCsv(table.columns, table.rows);
    } else if (input.format === 'csv') {
      text = input.content.replace(/\r?\n/g, '\r\n');
      if (!text.endsWith('\r\n')) text += '\r\n';
    } else {
      text = input.content.endsWith('\n') ? input.content : `${input.content}\n`;
    }
    if (text.trim() === '') throw new Error('the document is empty');

    // Versions are counted among this conversation's files. The library is
    // read newest first; a document being revised is among its latest files.
    // Outside a conversation (a mission, a test) every write is version 1.
    const conversationId = ctx.conversationId;
    const siblings = conversationId
      ? (await files.list({ limit: 100 })).filter((row) => row.conversationId === conversationId)
      : [];
    const version = nextVersion(base, ext, siblings.map((row) => row.filename));
    const filename = versionedName(base, ext, version);

    const saved = await files.save({
      bytes: Buffer.from(text, 'utf8'),
      mime,
      filename,
      ...(folder === undefined ? {} : { caption: folder }),
    });
    const unchanged = saved.filename !== filename;
    const kind = input.format === 'markdown' ? 'PDF or Word' : 'Excel or CSV';
    return {
      artifactId: saved.id,
      filename: saved.filename ?? filename,
      title,
      format: input.format,
      // The file that already held these bytes keeps its own version number.
      version: unchanged ? Math.max(1, nextVersion(base, ext, [saved.filename]) - 1) : version,
      mime: saved.mime,
      sizeBytes: saved.sizeBytes,
      ...(folder === undefined ? {} : { folder }),
      ...(unchanged ? { unchanged: true } : {}),
      note: unchanged
        ? `These exact contents are already in Files as ${saved.filename ?? 'an earlier file'}; nothing new was saved.`
        : `Saved to Files as ${filename}. The owner can open it there and download it as ${kind}.`,
    };
  },
};

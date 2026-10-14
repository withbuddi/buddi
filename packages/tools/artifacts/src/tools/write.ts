/**
 * `artifacts.write` — an agent saves a document into the owner's Files.
 *
 * A capability any agent can be granted, not a document agent: the report a
 * Researcher wrote lands in Files as a Markdown file (a table as a CSV), and
 * buddi itself turns it into PDF, Word or Excel when the owner downloads it.
 * The model never produces a binary format.
 *
 * Tier `auto`, like the memory writes: the only effect is a new file, or a
 * new version of one, in the owner's own library, credited to the agent and
 * its conversation, never an overwrite and never anything outside buddi. A
 * file the owner does not want is one Delete away. Writing over a version
 * someone else wrote (the owner's edit on the Canvas) is refused until the
 * agent has read it (`readVersion`).
 *
 * Nothing in the input reaches the disk as a path. The title becomes the
 * file's *name* only; the bytes are stored content-addressed by the host
 * (`artifacts/<yyyy>/<mm>/<sha256>.<ext>`).
 */
import { safeFileName, type ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import {
  FORMAT_FILE,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_CHARS,
  MAX_FOLDER_CHARS,
  MAX_TITLE_CHARS,
  parseJsonTable,
  toCsv,
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
    .enum(['markdown', 'csv', 'json', 'docx', 'xlsx', 'pdf'])
    .optional()
    .describe("What the file is. 'docx' (a Word document), 'pdf' or 'xlsx' (an Excel workbook) when the owner asked for that kind of file: content is Markdown for docx and pdf, a table (CSV text or a JSON array of objects) for xlsx, and buddi makes the file. 'markdown' for notes and drafts, 'csv' or 'json' for a table kept as CSV."),
  content: z
    .string()
    .min(1)
    .max(MAX_DOCUMENT_CHARS)
    .describe(`The whole document, as Markdown (or a table for csv, json and xlsx). At most ${MAX_DOCUMENT_CHARS.toLocaleString('en-US')} characters (512 KiB).`),
  folder: z
    .string()
    .trim()
    .min(1)
    .max(MAX_FOLDER_CHARS)
    .optional()
    .describe('A short label to file it under in Files, e.g. "Taxes 2026". Shown with the file and found by search; not a folder on the owner\'s computer.'),
  fileId: z
    .string()
    .uuid()
    .optional()
    .describe('The fileId of an existing file (from artifacts.list, artifacts.text or an earlier write) to save the next version of; it keeps its name and the title is ignored.'),
  readVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The version you read (artifacts.text returns it). Required when the newest version is not yours — the owner edited the file: read it, keep their changes, then pass its version.'),
  confirmedRebuild: z
    .boolean()
    .optional()
    .describe("Only for a Word (.docx) or Excel (.xlsx) file the owner made or sent: writing it rebuilds it from your text and loses its formatting, so ask the owner first and pass true only once they agreed. Not needed for a file buddi made."),
}).strict();

export interface WrittenDocument {
  /** This version's id. */
  artifactId: string;
  /** The file it is a version of: what a later write names as `fileId`. */
  fileId: string;
  filename: string;
  title: string;
  format: DocumentFormat;
  version: number;
  mime: string;
  sizeBytes: number;
  folder?: string;
  /** True when these exact bytes were already in Files: nothing new was written. */
  unchanged?: boolean;
  /** An Office file rebuilt from the text: its formatting was not kept. */
  rebuilt?: boolean;
  note: string;
}

export const write: ToolDefinition<z.infer<typeof writeInput>, WrittenDocument> = {
  name: 'artifacts.write',
  description:
    "Save a document into the owner's Files — buddi's own storage, not a folder on their computer (a folder label like “Desktop” is not their desktop): a report, a plan, a letter, a table. Use it when the owner asks for a file, or when what you made is long or structured enough that they will want to keep, print or send it; a short answer stays in the chat. Asked for a Word document, a PDF or a spreadsheet, write that format (docx, pdf, xlsx) and buddi makes the file from your Markdown or table; a Markdown file downloads as PDF or Word too. Never tell them to paste it into another program, and never convert it yourself (no pandoc). Writing the same title again in this conversation saves its next version; the earlier ones stay. To change an existing file, pass its fileId. A Word (.docx) or Excel (.xlsx) file named by fileId takes Markdown or a table and is rebuilt from it in its own format (its formatting is not kept; for one the owner made or sent, ask them first and pass confirmedRebuild); a PowerPoint file is not written here. A designed document the owner will send, print or present — a letter, an offer, a report under their name, a deck — is made with artifacts.compose when you hold it; a file it composed is changed by editing its program there.",
  tier: 'auto',
  sideEffect: true,
  producesArtifacts: true,
  input: writeInput,
  async execute(input, ctx) {
    const files = ctx.buddi?.files;
    if (!files) throw new Error('Files is not available to this agent');
    const format = input.format ?? 'markdown';
    const { mime, ext } = FORMAT_FILE[format];
    const title = input.title.replace(/\s+/g, ' ');
    const base = safeFileName(title, MAX_TITLE_CHARS, 'Document');
    const folder = input.folder === undefined ? undefined : safeFileName(input.folder, MAX_FOLDER_CHARS, '') || undefined;

    let text: string;
    const json = format === 'json' || (format === 'xlsx' && /^\s*[[{]/.test(input.content));
    if (json) {
      const table = parseJsonTable(input.content);
      text = toCsv(table.columns, table.rows);
    } else if (FORMAT_FILE[format].table) {
      text = input.content.replace(/\r?\n/g, '\r\n');
      if (!text.endsWith('\r\n')) text += '\r\n';
    } else {
      text = input.content.endsWith('\n') ? input.content : `${input.content}\n`;
    }
    if (text.trim() === '') throw new Error('the document is empty');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      throw new Error(`the document is ${Math.ceil(bytes.length / 1024)} KiB once saved; at most ${MAX_DOCUMENT_BYTES / 1024} KiB. Split it into parts.`);
    }

    // The next version of the file named by fileId, else of this title's file in
    // the conversation, else a new file: resolved and saved by Files under one lock.
    const fallbackName = `${base}.${ext}`;
    const saved = await files.save({
      bytes,
      mime,
      filename: fallbackName,
      version: {
        base, ext,
        ...(input.fileId === undefined ? {} : { of: input.fileId }),
        ...(input.readVersion === undefined ? {} : { readVersion: input.readVersion }),
        ...(input.confirmedRebuild === true ? { confirmedRebuild: true } : {}),
      },
      ...(folder === undefined ? {} : { caption: folder }),
    });
    // The newest version already holds these bytes: nothing new was written.
    const unchanged = saved.existed === true;
    const filename = saved.filename ?? fallbackName;
    const version = saved.version;
    const kind = saved.mime === 'text/markdown' ? 'PDF or Word' : saved.mime === 'text/csv' ? 'Excel or CSV' : 'it is';
    const rebuilt = saved.rebuilt === true;
    return {
      artifactId: saved.id,
      fileId: saved.fileId,
      filename,
      title,
      format,
      version,
      mime: saved.mime,
      sizeBytes: saved.sizeBytes,
      ...(folder === undefined ? {} : { folder }),
      ...(unchanged ? { unchanged: true } : {}),
      ...(rebuilt ? { rebuilt: true } : {}),
      note: unchanged
        ? `These exact contents are already v${version} of ${filename} in Files; nothing new was saved.`
        : rebuilt
        ? `Saved ${filename} v${version} in Files, rebuilt from your text: its formatting was not preserved from v${version - 1}. Tell the owner so. To change it again, write with fileId "${saved.fileId}".`
        : `Saved to Files${folder === undefined ? '' : ` under "${folder}"`} as ${filename}, v${version} (buddi's Files, not the computer's desktop or disk). The owner can open it there${kind === 'it is' ? ', or in their own app,' : ''} and download it ${kind === 'it is' ? 'as it is' : `as ${kind}`}; no conversion needed. To change it later, write with fileId "${saved.fileId}".`,
    };
  },
};

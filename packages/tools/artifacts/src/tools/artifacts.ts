/**
 * Tools over the artifact store.
 *
 * All three are reads over `core.artifacts` and the file the row points at, so
 * the family is tier `auto`. Nothing here writes, and nothing here reaches
 * outside the data dir: a tool argument is an artifact id, never a path.
 *
 * The division of labour matters. An agent handed a photo or a short PDF simply
 * *sees* it — the runtime sends it as a multimodal block. These tools are for
 * what looking cannot do: enumerate what is in the store, and pull text out of a
 * long document so it can be searched and quoted rather than eyeballed.
 */
import type { FileRow, ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import {
  DESCRIBE_TEXT_CHARS,
  MAX_TEXT_CHARS,
  extractText,
  imageDimensions,
  isExtractable,
} from '../extract.js';

const kindInput = z
  .enum(['document', 'image', 'audio', 'other'])
  .describe("Restrict to one kind: 'document' (PDFs, text), 'image', 'audio', 'other'.");

const listInput = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('How many artifacts to return, newest first. Defaults to 20.'),
  kind: kindInput.optional(),
});

/** What a tool result says about one artifact. Metadata only — never bytes. */
export interface ArtifactSummary {
  id: string;
  kind: string;
  mime: string;
  filename: string | null;
  sizeBytes: number;
  caption: string | null;
  createdAt: string | null;
}

function summarize(row: FileRow): ArtifactSummary {
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    caption: row.caption,
    createdAt: row.createdAt,
  };
}

export const list: ToolDefinition<
  z.infer<typeof listInput>,
  { artifacts: ArtifactSummary[]; count: number }
> = {
  name: 'artifacts.list',
  description:
    'List the files the owner has sent you or that a run produced — statements, photos, documents — newest first. Metadata only: id, kind, mime, filename, size, caption. Use it to find the id of something the owner refers to ("the statement I sent yesterday"), then read it with artifacts.describe.',
  tier: 'auto',
  input: listInput,
  async execute(input, ctx) {
    const rows = await ctx.buddi!.files!.list({
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    });
    return { artifacts: rows.map(summarize), count: rows.length };
  },
};

const idInput = z.object({
  id: z.string().uuid().describe('The artifact id, as returned by artifacts.list.'),
});

export interface ArtifactDescription extends ArtifactSummary {
  /** Extracted text for PDFs and text files, truncated. Absent otherwise. */
  text?: string;
  pages?: number;
  truncated?: boolean;
  /** Pixel size for the image formats whose header says so cheaply. */
  width?: number;
  height?: number;
  /** Why there is no text, when there is none. */
  note?: string;
}

/** Shared by describe and text: the row, or a refusal the model can read. */
async function requireArtifact(id: string, ctx: ToolContext): Promise<FileRow> {
  const row = await ctx.buddi!.files!.get(id);
  if (!row) {
    throw new Error(`no artifact ${id} (it may have been deleted); try artifacts.list`);
  }
  return row;
}

export const describe: ToolDefinition<z.infer<typeof idInput>, ArtifactDescription> = {
  name: 'artifacts.describe',
  untrusted: 'file',
  description:
    `Look inside one artifact: its metadata plus, for a PDF or a text file, the first ${DESCRIBE_TEXT_CHARS.toLocaleString('en-US')} characters of its text. This is how you read a long statement — cheaper and more searchable than looking at the pages. For an image you are shown the picture itself, so this returns only metadata and, where it is cheap to tell, the pixel size.`,
  tier: 'auto',
  input: idInput,
  async execute(input, ctx) {
    const row = await requireArtifact(input.id, ctx);
    const out: ArtifactDescription = summarize(row);

    if (isExtractable(row.mime)) {
      const bytes = await ctx.buddi!.files!.read(row.id);
      const extracted = await extractText(bytes, row.mime, DESCRIBE_TEXT_CHARS);
      out.text = extracted.text;
      out.truncated = extracted.truncated;
      if (extracted.pages !== undefined) out.pages = extracted.pages;
      if (extracted.truncated) {
        out.note = `Text truncated at ${DESCRIBE_TEXT_CHARS} characters; artifacts.text returns more.`;
      }
      if (extracted.text.trim() === '') {
        out.note =
          'This document has no text layer (it is probably a scan). Ask the owner to send it as an image if you need to read it.';
      }
      return out;
    }

    if (row.kind === 'image') {
      const bytes = await ctx.buddi!.files!.read(row.id);
      const size = imageDimensions(bytes);
      if (size) {
        out.width = size.width;
        out.height = size.height;
      }
      out.note = 'Images are shown to you directly — ask the owner to attach it if you need to see it.';
      return out;
    }

    out.note = `No text can be extracted from ${row.mime}.`;
    return out;
  },
};

const textInput = z.object({
  id: z.string().uuid().describe('The artifact id, as returned by artifacts.list.'),
  maxChars: z
    .number()
    .int()
    .positive()
    .max(MAX_TEXT_CHARS)
    .optional()
    .describe(
      `How much text to return. Defaults to the full document, capped at ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters.`,
    ),
});

export const text: ToolDefinition<
  z.infer<typeof textInput>,
  { id: string; text: string; pages?: number; truncated: boolean; chars: number }
> = {
  name: 'artifacts.text',
  untrusted: 'file',
  description:
    'Return the full extracted text of a PDF or text artifact, for when artifacts.describe truncated what you needed. Long: ask for it only when you are going to read or quote the whole thing.',
  tier: 'auto',
  input: textInput,
  async execute(input, ctx) {
    const row = await requireArtifact(input.id, ctx);
    if (!isExtractable(row.mime)) {
      throw new Error(
        `artifact ${row.id} is ${row.mime}; text can only be extracted from PDFs and text files`,
      );
    }
    const bytes = await ctx.buddi!.files!.read(row.id);
    const extracted = await extractText(bytes, row.mime, input.maxChars ?? MAX_TEXT_CHARS);
    return {
      id: row.id,
      text: extracted.text,
      ...(extracted.pages === undefined ? {} : { pages: extracted.pages }),
      truncated: extracted.truncated,
      chars: extracted.text.length,
    };
  },
};

/**
 * `artifacts.view` — look at a picture in Files (docs/files.md, "Composed
 * documents"): the owner's photo, a logo, before composing with it.
 *
 * The picture goes to the model as an image beside the result, once, the
 * way a browser screenshot does (the tool's `image`), never stored in the
 * transcript: made upright and smaller first — at most 1568 pixels on its
 * long side and about 1 MB as a JPEG — so a phone photo costs what a model
 * can use. The file in Files is not changed. A model that takes no images
 * is told so in its place (the runtime's note).
 */
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { imageDimensions } from '../extract.js';
import { PixelsError, fitPictureContained, sniffRaster } from '../pixels.js';

/** What a model is shown of a picture, at most. */
export const VIEW_LIMITS = { longSide: 1568, maxBytes: 1024 * 1024 } as const;

/** Pictures waiting for the runtime to take them for the next model call, by a ref the result carries. */
const pending = new Map<string, { mime: string; data: string; at: number }>();

function keep(mime: string, bytes: Buffer): string {
  const now = Date.now();
  for (const [ref, held] of pending) if (now - held.at > 120_000) pending.delete(ref);
  const ref = randomUUID();
  pending.set(ref, { mime, data: bytes.toString('base64'), at: now });
  return ref;
}

/** The picture a view result names, once. */
export function takeView(ref: string): { mime: string; data: string } | undefined {
  const held = pending.get(ref);
  pending.delete(ref);
  return held ? { mime: held.mime, data: held.data } : undefined;
}

/** Formats a model takes as they are, when they are already small enough. */
const PASSED_AS_IS = new Set(['image/gif', 'image/webp']);

const viewInput = z.object({
  fileId: z.string().uuid().describe('The picture: a fileId (its newest version) or a version id, from artifacts.list.'),
}).strict();

export interface ViewedPicture {
  id: string;
  fileId: string;
  version: number;
  filename: string | null;
  /** What the file is, and how big. */
  mime: string;
  width: number | null;
  height: number | null;
  /** What you are shown: a smaller JPEG, or the file as it is. */
  shown: { mime: string; width: number | null; height: number | null; sizeBytes: number } | null;
  /** The runtime's handle on the picture; not for you. */
  ref?: string;
  note: string;
}

export const view: ToolDefinition<z.infer<typeof viewInput>, ViewedPicture> = {
  name: 'artifacts.view',
  untrusted: 'file',
  description:
    `Look at a picture in Files — a photo or a logo the owner sent, before you put it in a document (artifacts.compose attachments) or describe it. You are shown it as an image, made smaller (at most ${VIEW_LIMITS.longSide} px on its long side); the file itself is unchanged. Pictures only (PNG, JPEG, GIF, WebP); for a document's text use artifacts.text.`,
  tier: 'auto',
  input: viewInput,
  async execute(input, ctx) {
    const files = ctx.buddi?.files;
    if (!files) throw new Error('Files is not available to this agent');
    const row = await files.get(input.fileId);
    if (!row) throw new Error(`there is no file ${input.fileId} in Files that you can read; find it with artifacts.list`);
    const mime = row.mime.toLowerCase().split(';')[0]!.trim();
    if (row.kind !== 'image' || !mime.startsWith('image/')) {
      throw new Error(`${row.filename ?? 'that file'} is ${row.mime}, not a picture; read a document with artifacts.text`);
    }
    const bytes = await files.read(row.id);
    const size = imageDimensions(bytes);
    const base = { id: row.id, fileId: row.fileId, version: row.version, filename: row.filename, mime: row.mime, width: size?.width ?? null, height: size?.height ?? null };
    if (sniffRaster(bytes)) {
      try {
        const fitted = await fitPictureContained(bytes, { longSide: VIEW_LIMITS.longSide, maxBytes: VIEW_LIMITS.maxBytes });
        return {
          ...base, width: fitted.sourceWidth, height: fitted.sourceHeight,
          shown: { mime: 'image/jpeg', width: fitted.width, height: fitted.height, sizeBytes: fitted.jpeg.length },
          ref: keep('image/jpeg', fitted.jpeg),
          note: `The picture follows this result as an image, ${fitted.width} × ${fitted.height} px (the file is ${fitted.sourceWidth} × ${fitted.sourceHeight}). Pass its fileId in artifacts.compose attachments to use it.`,
        };
      } catch (err) {
        if (!(err instanceof PixelsError)) throw err;
        return { ...base, shown: null, note: `This picture cannot be shown: ${err.message}` };
      }
    }
    const small = size !== null && Math.max(size.width, size.height) <= VIEW_LIMITS.longSide && bytes.length <= VIEW_LIMITS.maxBytes;
    if (PASSED_AS_IS.has(mime) && small) {
      return {
        ...base,
        shown: { mime, width: size.width, height: size.height, sizeBytes: bytes.length },
        ref: keep(mime, bytes),
        note: 'The picture follows this result as an image, as it is.',
      };
    }
    return {
      ...base, shown: null,
      note: PASSED_AS_IS.has(mime)
        ? `This ${mime === 'image/gif' ? 'GIF' : 'WebP'} is too large to show (buddi makes only JPEG and PNG pictures smaller). Ask the owner for a JPEG or PNG.`
        : `buddi cannot show a ${row.mime} picture; ask the owner for a JPEG or PNG.`,
    };
  },
  image: async (output) => (output.ref ? takeView(output.ref) : undefined),
};

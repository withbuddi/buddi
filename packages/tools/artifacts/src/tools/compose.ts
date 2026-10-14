/**
 * `artifacts.compose` — a designed Word document or PowerPoint deck, made by
 * a small program the agent writes (docs/files.md, "Composed documents").
 *
 * The program is an ES module against one library — `docx` for a .docx,
 * `pptxgenjs` for a .pptx — whose default export returns the file's bytes.
 * buddi runs it confined (`compose/sandbox.ts`), checks the bytes are a
 * whole package, says what it looks like (`render.ts`), and stores the
 * bytes as the file's next version, with the program beside it, through the
 * same save as `artifacts.write`: one lock per file, the same refusals, the
 * same versions by `fileId`. A later change reads the program back
 * (`source: true`) and edits it, so the design is kept.
 *
 * Tier `auto`, like `artifacts.write`: its only effect is a new file, or a
 * new version of one, in the owner's own library. `dryRun` runs the program
 * and stores nothing.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OFFICE_MIME, officePackageProblem, safeFileName, type ToolContext, type ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { MAX_FOLDER_CHARS, MAX_TITLE_CHARS } from '../document.js';
import { imageDimensions, renderOffice } from '../extract.js';
import type { OfficeRender } from '../render.js';
import { COMPOSE_LIBRARY, libraryClosure, type ComposeKind } from '../compose/libraries.js';
import { rebuildDescription, rebuildTier } from './rebuild.js';
import { COMPOSE_LIMITS, composeAvailability, runCompose, type ComposeAttachment, type ComposeErrorCode } from '../compose/sandbox.js';

/** The guides `guide` returns, written for buddi (packages/tools/artifacts/guides). */
export const COMPOSE_GUIDES = ['docx', 'pptx', 'layout'] as const;
const GUIDES_DIR = new URL('../../guides/', import.meta.url);

/** The images a program may be handed, by mime, with the type `docx`'s ImageRun names them by. */
const IMAGE_TYPES: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' };

/** The rule an agent is given, in this tool's description and once in the turn's context. */
export const COMPOSE_RULE =
  'When the owner wants a designed or "professional" document — a letter, an offer, an invoice, a report under their name, or any deck — compose it with artifacts.compose; plain notes and drafts stay Markdown with artifacts.write. ' +
  "Read the guide first (artifacts.compose { guide: 'docx' | 'pptx' }). " +
  'To change a composed file, read its program (artifacts.compose { fileId, source: true }), edit it and compose again with that fileId. ' +
  'After two failed runs, fall back to artifacts.write with format docx and tell the owner.';

const composeInput = z.object({
  kind: z.enum(['docx', 'pptx']).optional()
    .describe("What to make: 'docx' (Word, written with the docx library) or 'pptx' (PowerPoint, written with pptxgenjs)."),
  program: z.string().min(1).max(COMPOSE_LIMITS.programBytes).optional()
    .describe("The program: an ES module that imports only its library ('docx' or 'pptxgenjs') and has `export default async (ctx) => bytes`, returning the file as a Buffer (docx: Packer.toBuffer(doc); pptxgenjs: pres.write({ outputType: 'nodebuffer' })). ctx.files holds the attached images ({ fileId, name, mime, type, width, height, bytes, base64, dataUri }). No network, no files, no eval."),
  title: z.string().trim().min(1).max(200).optional()
    .describe('The document title for a new file, e.g. "Offer to Northwind". It names the file. Ignored with fileId.'),
  fileId: z.string().uuid().optional()
    .describe('An existing file to write the next version of (from an earlier compose, artifacts.list or artifacts.text). With source: true, the file (or a version) whose program to read.'),
  readVersion: z.number().int().positive().optional()
    .describe('The version you read. Required when the newest version is not yours (the owner edited it).'),
  folder: z.string().trim().min(1).max(MAX_FOLDER_CHARS).optional()
    .describe('A short label to file it under in Files, e.g. "Clients".'),
  attachments: z.array(z.string().uuid()).max(10).optional()
    .describe('Images from Files to hand the program (their fileIds), at most 10 and 20 MB in all. Look at one first with artifacts.view.'),
  dryRun: z.boolean().optional()
    .describe('Run the program and say what it would make, without saving anything. For trying a layout.'),
  confirmedRebuild: z.boolean().optional()
    .describe("Only when the newest version is the owner's own (a save in Word, a file he sent) and you told him you will replace it: buddi then shows him a card, and saves only if he approves it."),
  source: z.literal(true).optional()
    .describe('With fileId: return the program a composed version was made from, to edit it.'),
  guide: z.enum(COMPOSE_GUIDES).optional()
    .describe("Return the design guide: 'docx', 'pptx', or 'layout' (type, colour and spacing for both)."),
}).strict();

type ComposeInput = z.infer<typeof composeInput>;

export interface ComposedDocument {
  artifactId: string;
  fileId: string;
  version: number;
  filename: string;
  mime: string;
  sizeBytes: number;
  folder?: string;
  render: OfficeRender | { error: string };
  console?: { stdout?: string; stderr?: string };
  unchanged?: true;
  note: string;
}

export type ComposeOutput =
  | ComposedDocument
  | { dryRun: true; kind: ComposeKind; sizeBytes: number; render: OfficeRender | { error: string }; console?: { stdout?: string; stderr?: string }; note: string }
  | { fileId: string; version: number; artifactId: string; kind: string; library: string; libraryVersion: string; program: string; note: string }
  | { guide: string; text: string };

/** A refusal the model reads: its code first, so it can tell a broken program from a refused write. */
function refuse(code: ComposeErrorCode | 'not_a_package' | 'invalid', message: string, console?: { stdout: string; stderr: string }): never {
  const tail = (label: string, text?: string): string => {
    if (!text || text.trim() === '') return '';
    const cut = text.length > 2_000 ? `…${text.slice(-2_000)}` : text;
    return `\n${label}:\n${cut.trimEnd()}`;
  };
  const advice = code === 'program_error' || code === 'forbidden' || code === 'not_a_package'
    ? '\nFix the program and run it again (the guide: artifacts.compose { guide }). After two failed runs, write the document with artifacts.write format docx instead and tell the owner.'
    : '';
  throw new Error(`${code}: ${message}${tail('stdout', console?.stdout)}${tail('stderr', console?.stderr)}${advice}`);
}

const shownConsole = (c: { stdout: string; stderr: string }): { stdout?: string; stderr?: string } | undefined => {
  const out = {
    ...(c.stdout.trim() === '' ? {} : { stdout: c.stdout.length > 4_000 ? `…${c.stdout.slice(-4_000)}` : c.stdout }),
    ...(c.stderr.trim() === '' ? {} : { stderr: c.stderr.length > 4_000 ? `…${c.stderr.slice(-4_000)}` : c.stderr }),
  };
  return Object.keys(out).length === 0 ? undefined : out;
};

/** A guide, with the shared one on type and layout after a docx or pptx guide: one call is enough. */
async function guideText(name: string): Promise<{ guide: string; text: string }> {
  const read = (which: string): Promise<string> => readFile(new URL(`${which}.md`, GUIDES_DIR), 'utf8');
  const text = name === 'layout' ? await read('layout') : `${await read(name)}\n\n${await read('layout')}`;
  return { guide: name, text };
}

/** Conversations already handed the guide with a failed run: it rides along once, on the first. */
const guided = new Set<string>();

/** The file a compose would write, as the host's save names it. */
function targetOf(input: ComposeInput): { base: string; ext: string; of?: string } {
  const base = safeFileName((input.title ?? 'Document').replace(/\s+/g, ' '), MAX_TITLE_CHARS, 'Document');
  return { base, ext: input.kind ?? 'docx', ...(input.fileId === undefined ? {} : { of: input.fileId }) };
}

/** The images named, read from Files: only pictures a document can hold, and 20 MB in all. */
async function readAttachments(ids: readonly string[], ctx: ToolContext): Promise<ComposeAttachment[]> {
  const files = ctx.buddi!.files!;
  const out: ComposeAttachment[] = [];
  let total = 0;
  for (const id of ids) {
    const row = await files.get(id);
    if (!row) refuse('invalid', `there is no file ${id} in Files that you can read; find it with artifacts.list`);
    const mime = row.mime.toLowerCase().split(';')[0]!.trim();
    const type = IMAGE_TYPES[mime];
    if (!type) refuse('invalid', `${row.filename ?? id} is ${row.mime}; a document can hold PNG, JPEG, GIF or BMP pictures`);
    total += row.sizeBytes;
    if (total > COMPOSE_LIMITS.attachmentsBytes) refuse('invalid', `the attachments come to more than ${COMPOSE_LIMITS.attachmentsBytes / 1024 / 1024} MB`);
    const bytes = await files.read(row.id);
    const size = imageDimensions(bytes);
    out.push({ fileId: row.fileId, name: row.filename ?? `image-${out.length + 1}.${type}`, mime, type, width: size?.width ?? null, height: size?.height ?? null, bytes });
  }
  return out;
}

/** The render summary, or why there is none: never a reason to fail a run that made a whole file. */
async function render(bytes: Buffer, kind: ComposeKind): Promise<OfficeRender | { error: string }> {
  try {
    return await renderOffice(bytes, kind);
  } catch (err) {
    return { error: `buddi could not read the layout back (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** What the reply says about the result's look: the warnings first, then the checklist. */
function lookNote(summary: OfficeRender | { error: string }): string {
  if ('error' in summary) return '';
  if (summary.kind === 'pptx') {
    return summary.warnings.length > 0
      ? ` ${summary.warnings.length} layout warning(s) in render.warnings: fix them before you show it.`
      : ' Check render against the guide\'s checklist before you show it.';
  }
  return ` About ${summary.pages.estimated} page(s); check render against the guide's checklist before you show it.`;
}

export const compose: ToolDefinition<ComposeInput, ComposeOutput> = {
  name: 'artifacts.compose',
  description:
    `Make a designed Word document (.docx) or PowerPoint deck (.pptx) in the owner's Files by writing a small JavaScript program against one library (docx or pptxgenjs); buddi runs it confined (no network, no files, no other packages), checks the file and stores it as a version you can keep changing by fileId. Every reply says what the file looks like (render: page or slide size, fonts, outline, pages, overflow warnings). ${COMPOSE_RULE}`,
  tier: 'auto',
  sideEffect: true,
  producesArtifacts: true,
  timeoutMs: 120_000,
  input: composeInput,
  // A card for the owner only when it would replace his own version and the agent says it asked him (`rebuild.ts`).
  tierFor: async (input, ctx) => (input.program === undefined || input.dryRun === true
    ? { tier: 'auto' }
    : rebuildTier(ctx, targetOf(input), true, input.confirmedRebuild)),
  describe: (input, ctx) => rebuildDescription(ctx, targetOf(input), true, input.program ?? ''),
  async execute(input, ctx) {
    if (input.guide !== undefined) return guideText(input.guide);
    const files = ctx.buddi?.files;
    if (!files) throw new Error('Files is not available to this agent');

    if (input.source === true) {
      if (input.fileId === undefined) refuse('invalid', 'say which file: source: true needs its fileId');
      const found = await files.source(input.fileId);
      if (!found) {
        const row = await files.get(input.fileId);
        refuse('invalid', row
          ? `v${row.version} of ${row.filename ?? 'that file'} was not made by a program (the owner saved it, or artifacts.write made it); read it with artifacts.text and write a program that carries its content`
          : `there is no file ${input.fileId} in Files that you can read`);
      }
      return {
        fileId: found.fileId, version: found.version, artifactId: found.artifactId, kind: found.kind,
        library: found.library, libraryVersion: found.libraryVersion, program: found.program,
        note: `The program of v${found.version}. Edit it and compose again with fileId "${found.fileId}" and readVersion ${found.version}.`,
      };
    }

    if (input.kind === undefined || input.program === undefined) {
      refuse('invalid', "give kind ('docx' or 'pptx') and program, or ask for { guide } or { fileId, source: true }");
    }
    if (input.title === undefined && input.fileId === undefined && input.dryRun !== true) {
      refuse('invalid', 'give the document a title, or the fileId of the file to change');
    }
    const kind = input.kind;
    const confinement = ctx.buddi!.confinement;
    const availability = composeAvailability({ confinement: confinement.kind });
    if (!availability.available) refuse('unavailable', availability.reason ?? 'composed documents are off here');

    const attachments = await readAttachments(input.attachments ?? [], ctx);
    const run = await runCompose({
      kind, program: input.program, attachments,
      root: path.join(ctx.buddi!.dir.path, 'compose'),
      availability,
      confine: (work, opts) => confinement.argv(work, opts),
      ...(ctx.conversationId === undefined ? {} : { conversationId: ctx.conversationId }),
    });
    if (!run.ok) {
      // The first failure in a conversation brings the guide with it, unasked.
      if ((run.code === 'program_error' || run.code === 'forbidden') && ctx.conversationId && !guided.has(ctx.conversationId)) {
        guided.add(ctx.conversationId);
        refuse(run.code, `${run.message}\n\nThe guide, for this and the next run:\n\n${(await guideText(kind)).text}`, run.console);
      }
      refuse(run.code, run.message, run.console);
    }
    const problem = officePackageProblem(run.bytes, kind);
    if (problem) refuse('not_a_package', `what the program returned is not a whole .${kind}: ${problem}. Return ${kind === 'docx' ? 'await Packer.toBuffer(doc)' : "await pres.write({ outputType: 'nodebuffer' })"}.`, run.console);
    const summary = await render(run.bytes, kind);
    const consoleOut = shownConsole(run.console);

    if (input.dryRun === true) {
      return {
        dryRun: true, kind, sizeBytes: run.bytes.length, render: summary,
        ...(consoleOut ? { console: consoleOut } : {}),
        note: `Nothing was saved: this was a dry run.${lookNote(summary)} Compose again without dryRun to save it.`,
      };
    }

    const { base } = targetOf(input);
    const folder = input.folder === undefined ? undefined : safeFileName(input.folder, MAX_FOLDER_CHARS, '') || undefined;
    const library = COMPOSE_LIBRARY[kind];
    const saved = await files.save({
      bytes: run.bytes,
      mime: OFFICE_MIME[kind],
      filename: `${base}.${kind}`,
      version: {
        base, ext: kind,
        ...(input.fileId === undefined ? {} : { of: input.fileId }),
        ...(input.readVersion === undefined ? {} : { readVersion: input.readVersion }),
      },
      composed: { kind, program: input.program, library, libraryVersion: libraryClosure().versions[library] ?? '', nodeVersion: process.versions.node },
      ...(folder === undefined ? {} : { caption: folder }),
    });
    const filename = saved.filename ?? `${base}.${kind}`;
    const unchanged = saved.existed === true;
    return {
      artifactId: saved.id,
      fileId: saved.fileId,
      version: saved.version,
      filename,
      mime: saved.mime,
      sizeBytes: saved.sizeBytes,
      ...(folder === undefined ? {} : { folder }),
      render: summary,
      ...(consoleOut ? { console: consoleOut } : {}),
      ...(unchanged ? { unchanged: true as const } : {}),
      note: unchanged
        ? `These exact bytes are already v${saved.version} of ${filename}; nothing new was saved.`
        : `Saved ${filename} v${saved.version} in Files, made by your program, which is kept with it.${lookNote(summary)} The owner sees it on the Canvas and can open it in Word${kind === 'pptx' ? ' or PowerPoint' : ''}. To change it, read the program with { fileId: "${saved.fileId}", source: true } and compose again with that fileId.`,
    };
  },
};

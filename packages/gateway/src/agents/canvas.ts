/**
 * The `canvas.*` tools — how an agent puts something in front of the owner.
 *
 * The dashboard draws two kinds of thing. Most of the time it draws a *tool
 * result*, using the view descriptor the tool's own plugin ships: the agent
 * asks for a cashflow projection, the finance plugin says "that is a
 * timeseries, points in `days`", and the canvas obeys. That path needs no
 * agent involvement at all and is the one to prefer, because the picture is
 * then guaranteed to be of real data the tool actually returned.
 *
 * These two tools are the other kind: the agent has worked something out that
 * no single tool result covers — three cards compared side by side, a table it
 * assembled from two reads, the shape of an answer it is about to give — and
 * wants it drawn. So `canvas.show` takes the *rendered* data directly, in the
 * shape the renderer expects, and `canvas.clear` takes it back down.
 * `canvas.open` puts one of the owner's own files in front of him.
 *
 * Three properties, all deliberate:
 *
 *  - **Nothing here persists.** The call sits in the transcript, and the
 *    transcript is what the page reads. There is no canvas table, no state to
 *    reconcile and nothing to clean up when a conversation is deleted.
 *  - **Nothing here is an effect.** Tier `auto`: drawing a chart changes
 *    nothing outside the page, so an approval prompt would be noise.
 *  - **The renderers are the platform's, not the plugin's.** The same seven
 *    shapes `views.ts` names, and no domain vocabulary anywhere — an agent
 *    describing "a cashflow chart" would be putting finance into the platform
 *    through the back door.
 */
import { ToolRefusal, createPluginHost, currentVersion, getFile, hostBindingOf, resolveFileId, type CoreToolContext, type PluginManifest, type ToolDefinition, type ZodToolDefinition } from '@buddi/core';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { z } from 'zod';

/** Plugin family name. Three tools, no schema, no tables. */
export const CANVAS_PLUGIN = 'canvas';

/** How many rows, bars or pairs one deliberate view may carry. */
export const MAX_CANVAS_ROWS = 200;
export const MAX_CANVAS_SERIES = 6;

const unit = z
  .enum(['number', 'currency', 'percent', 'text', 'date'])
  .describe('How the digits should read. Not a unit system — just their shape.');

const tone = z
  .enum(['good', 'warning', 'critical', 'neutral'])
  .describe('What this value means, if anything: good, warning, critical. Never decoration.');

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const timeseries = z.object({
  x: z.array(z.string()).min(1).max(MAX_CANVAS_ROWS).describe('The x axis, one label per point — usually YYYY-MM-DD dates.'),
  series: z
    .array(
      z.object({
        label: z.string().min(1),
        values: z.array(z.number().nullable()).max(MAX_CANVAS_ROWS).describe('One value per x, same order and same length.'),
        unit: unit.optional(),
      }),
    )
    .min(1)
    .max(MAX_CANVAS_SERIES),
  currency: z.string().length(3).optional().describe("ISO code, when unit is 'currency'."),
  referenceLines: z
    .array(z.object({ value: z.number(), label: z.string().min(1), tone: tone.optional() }))
    .max(4)
    .optional()
    .describe('Horizontal rules: a floor, a limit, a target. Draw the line that changes the decision.'),
});

const table = z.object({
  columns: z
    .array(
      z.object({
        label: z.string().min(1),
        unit: unit.optional(),
        currency: z.string().length(3).optional(),
      }),
    )
    .min(1)
    .max(12),
  rows: z
    .array(z.array(cell))
    .max(MAX_CANVAS_ROWS)
    .describe('One array per row, values in column order. Ragged rows are padded, never re-ordered.'),
  empty: z.string().optional().describe('What to show when there are no rows.'),
});

const bars = z.object({
  bars: z
    .array(
      z.object({
        label: z.string().min(1),
        value: z.number(),
        max: z.number().optional().describe('Full scale for this bar, when each has its own — a credit limit, a budget.'),
        tone: tone.optional(),
      }),
    )
    .min(1)
    .max(MAX_CANVAS_ROWS),
  unit: unit.optional(),
  currency: z.string().length(3).optional(),
});

const keyvalue = z.object({
  pairs: z
    .array(
      z.object({
        label: z.string().min(1),
        value: cell,
        unit: unit.optional(),
        currency: z.string().length(3).optional(),
        tone: tone.optional(),
      }),
    )
    .min(1)
    .max(24),
});

const document = z.object({
  text: z.string().min(1).max(20_000).describe('Markdown. For something worth reading beside the conversation, not for the answer itself.'),
  title: z.string().min(1).max(80).optional(),
});

const structured = z.object({
  value: z.unknown().describe('Any JSON. The last resort: prefer a shape above when one fits.'),
});

/**
 * The input, discriminated on the renderer, so the data is checked against the
 * thing that will draw it. A model that sends bars for a timeseries is refused
 * with zod's own message rather than producing an empty panel.
 */
const canvasShowInput = z.discriminatedUnion('renderer', [
  z.object({ renderer: z.literal('timeseries'), title: z.string().min(1).max(60).optional(), data: timeseries }),
  z.object({ renderer: z.literal('table'), title: z.string().min(1).max(60).optional(), data: table }),
  z.object({ renderer: z.literal('bars'), title: z.string().min(1).max(60).optional(), data: bars }),
  z.object({ renderer: z.literal('keyvalue'), title: z.string().min(1).max(60).optional(), data: keyvalue }),
  z.object({ renderer: z.literal('document'), title: z.string().min(1).max(60).optional(), data: document }),
  z.object({ renderer: z.literal('structured'), title: z.string().min(1).max(60).optional(), data: structured }),
]);

export type CanvasShowInput = z.infer<typeof canvasShowInput>;

/**
 * The description is the whole of the policy here, so it says the two things a
 * model gets wrong: draw only what a tool result does not already show, and
 * only when the shape carries meaning the sentence cannot.
 */
export const canvasShow: ZodToolDefinition<CanvasShowInput, { shown: true; renderer: string }> = {
  name: 'canvas.show',
  description:
    'Draw something on the canvas beside this conversation, when you have worked out something worth seeing that no single tool result already shows — three cards compared, a table you assembled from two reads, a trend you computed. The canvas already draws tool results by itself, so do NOT use this to re-show a result you just got: that is duplication, and the automatic version is drawn from the real data. Do not use it as decoration, and never for one number or a sentence — say those. Choose the shape by what the data is: timeseries for something over time, bars for parts of a whole or one figure per name, table for rows and columns, keyvalue for a handful of labelled figures, document for a passage worth reading beside the chat, structured only when nothing else fits. Every figure must come from a tool result or from the owner; never draw a number you invented.',
  tier: 'auto',
  input: canvasShowInput,
  async execute(input) {
    // Nothing to persist and nothing to send: the call itself, sitting in the
    // transcript, IS the instruction. The page reads it from there.
    return { shown: true, renderer: input.renderer };
  },
};

const canvasClearInput = z.object({});

export const canvasClear: ToolDefinition<z.infer<typeof canvasClearInput>, { cleared: true }> = {
  name: 'canvas.clear',
  description:
    'Take down whatever is currently on the canvas, when the conversation has moved on and what is drawn would now mislead. Rarely needed: showing something else replaces it, and the owner can close a panel themselves.',
  tier: 'auto',
  input: canvasClearInput,
  async execute() {
    return { cleared: true };
  },
};

const canvasOpenInput = z
  .object({
    fileId: z.string().uuid().describe('The file’s fileId, from artifacts.list, artifacts.text or a write (a version’s id names its file too).'),
  })
  .strict();

export type CanvasOpenInput = z.infer<typeof canvasOpenInput>;

/**
 * Open one of the owner's files on the canvas: the dashboard draws its
 * current version in the file's own tab (the editor for a text file, the
 * preview for anything else) and brings it to the front; on Telegram it is
 * sent as the file. The call in the transcript is the instruction, as with
 * `canvas.show`; the tool only checks the file is there. By id only: find
 * it with artifacts.list first, so a name never picks the wrong file.
 */
export const canvasOpen: ToolDefinition<CanvasOpenInput, { opened: true; fileId: string; artifactId: string; version: number; filename: string | null; mime: string; note: string }> = {
  name: 'canvas.open',
  description:
    'Open one of the owner’s files on the canvas by its fileId (from artifacts.list), at its newest version: they can read it there, and edit a text file.',
  tier: 'auto',
  input: canvasOpenInput,
  async execute(input, toolCtx) {
    // A platform tool: core runs it on its own context, with the pool.
    const ctx = toolCtx as CoreToolContext;
    // Looked up as the artifacts tools look a file up (their host's `files.get`): the same scope, one rule.
    const found = await createPluginHost(hostBindingOf(artifactsManifest), ctx).files!.get(input.fileId);
    if (!found) {
      const fileId = await resolveFileId(ctx.db, input.fileId);
      const gone = fileId ? await getFile(ctx.db, fileId) : null;
      if (gone?.deletedAt) throw new ToolRefusal(`File ${gone.id} was deleted from Files by the owner. Do not open or recreate it unless they ask.`);
      throw new ToolRefusal(`There is no file ${input.fileId} in Files. Find it with artifacts.list.`);
    }
    const file = await getFile(ctx.db, found.fileId);
    const current = file ? await currentVersion(ctx.db, file.id) : null;
    if (!file || !current) throw new ToolRefusal(`File ${found.fileId} was deleted from Files by the owner. Do not open or recreate it unless they ask.`);
    // The page draws it by its type: the editor for text, the preview for the rest.
    return {
      opened: true, fileId: file.id, artifactId: current.id, version: current.version, filename: file.name, mime: file.mime,
      note: `Open at v${current.version}, its newest version.`,
    };
  },
};

/** The manifest. No schema, no migrations — this plugin owns no data at all. */
export function createCanvasManifest(): PluginManifest {
  return {
    name: CANVAS_PLUGIN,
    version: '0.1.0',
    schema: CANVAS_PLUGIN,
    migrationsDir: '',
    tools: [canvasShow, canvasClear, canvasOpen],
  };
}

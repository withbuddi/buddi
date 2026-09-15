/**
 * Turning a transcript into the things the canvas can show.
 *
 * Everything here reads the conversation's own `tool_use` / `tool_result`
 * pairs. No agent was asked to do anything differently, no persona changed, so
 * this works on a conversation from last month and on a mission that ran at
 * 6am while nobody was watching, exactly as it works on the run happening now.
 *
 * Precedence, highest first:
 *
 *   1. `canvas.show` — the agent said what to show. An explicit intention beats
 *      any inference about a tool it also happened to call.
 *   2. A view descriptor declared by the plugin that owns the tool.
 *   3. `structured` — a readable view of the JSON.
 *
 * A gated call that is waiting on a human overrides all three with the
 * `envelope` view, because an unapproved action is the most important thing on
 * the screen.
 *
 * Not every result becomes a tab. A tab is worth having when the canvas can
 * show something the conversation cannot — a table with rows, a chart with
 * points, a document, a decision to make. A result whose whole content is a
 * sentence, and an acknowledgement of a write (`{ok: true, recorded: 1}`), are
 * already in the answer; drawing them again beside it says nothing twice. That
 * judgement is `earnsTab`, and it reads the *shape* of the result — this file
 * knows the name of no tool.
 *
 * A failure is the exception in both directions: it always keeps its tab, so
 * nothing that went wrong is ever hidden, and it never takes the screen away
 * from the chart the owner is reading.
 *
 * Every renderable that does get a tab also says whether it is *substantial* —
 * whether it has rows, points, figures or a document in it — which is what the
 * canvas uses to decide where to look.
 */
import { applyDescriptor } from './resolve';
import { inferShape } from './infer';
import { isKnownRenderer } from './registry';
import { humanise } from './resolve';
import type { Renderable, RendererName, ViewDescriptor } from './types';
import type { ChatBlock, ChatMessage } from '../chat/types';

/** The tool family the agent uses to drive the canvas on purpose. */
export const CANVAS_SHOW = 'canvas.show';
export const CANVAS_CLEAR = 'canvas.clear';

/**
 * How many renderables the canvas keeps. Only the last few are on the strip;
 * the rest are one click away behind the overflow, so this is how far back the
 * owner can reach rather than how wide the tab bar is allowed to grow.
 */
export const MAX_RENDERABLES = 12;

export interface RenderableInput {
  messages: ChatMessage[];
  descriptors: ViewDescriptor[];
  /** Approvals known to be awaiting a decision, by the tool-use id that gated. */
  awaiting?: Map<string, string>;
}

/**
 * The canvas contents for a conversation, oldest first, capped at the last
 * few. `canvas.clear` empties what came before it and nothing after.
 */
export function renderablesFrom({ messages, descriptors, awaiting }: RenderableInput): Renderable[] {
  const byTool = new Map(descriptors.map((descriptor) => [descriptor.tool, descriptor]));
  const uses = new Map<string, { name: string; input: unknown; at: string | null }>();
  let collected: Renderable[] = [];

  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_use') {
        uses.set(block.id, { name: block.name, input: block.input, at: message.at ?? null });

        // `canvas.show` is drawn from the call, not the result: the agent has
        // already said what it wants shown, and the result only confirms it.
        if (block.name === CANVAS_SHOW) {
          const shown = fromCanvasShow(block.id, block.input, message.at ?? null);
          if (shown) collected.push(shown);
        }
        if (block.name === CANVAS_CLEAR) collected = [];
        continue;
      }

      if (block.type !== 'tool_result') continue;
      if (block.name === CANVAS_SHOW || block.name === CANVAS_CLEAR) continue;

      const use = uses.get(block.toolUseId);
      const at = message.at ?? use?.at ?? null;
      const tool = block.name || use?.name || 'tool';

      // A call that stopped on a gate is an envelope, whatever it would
      // otherwise have drawn.
      const approvalId = awaiting?.get(block.toolUseId) ?? approvalIdOf(block);
      if (approvalId) {
        collected.push({
          id: block.toolUseId,
          tool,
          title: 'Approval',
          renderer: 'envelope',
          props: { approvalId },
          at,
          tone: 'warning',
          source: 'approval',
          substantial: true,
        });
        continue;
      }

      if (block.ok === false) {
        collected.push({
          id: block.toolUseId,
          tool,
          title: labelFor(tool),
          renderer: 'structured',
          props: { value: block.error ?? block.output ?? null, failed: true },
          at,
          tone: 'critical',
          source: 'fallback',
          // A failure is news, but it is news the chat already delivered, and
          // it has nothing to draw. It waits in a tab with a red dot.
          substantial: false,
        });
        continue;
      }

      const descriptor = byTool.get(tool);
      if (descriptor) {
        const { renderer, props } = applyDescriptor(descriptor, block.output);
        if (!earnsTab(renderer, props)) continue;
        collected.push({
          id: block.toolUseId,
          tool,
          title: descriptor.title ?? labelFor(tool),
          renderer,
          props,
          at,
          source: 'descriptor',
          substantial: hasSubstance(renderer, props),
        });
        continue;
      }

      const props = { value: block.output };
      if (!earnsTab('structured', props)) continue;
      collected.push({
        id: block.toolUseId,
        tool,
        title: labelFor(tool),
        renderer: 'structured',
        props,
        at,
        source: 'fallback',
        substantial: hasSubstance('structured', props),
      });
    }
  }

  return capped(collected);
}

/**
 * The last few, plus any decision still waiting further back. A conversation
 * that ran long is allowed to push a chart off the end; it is not allowed to
 * push away the one thing the owner has to answer.
 */
function capped(collected: Renderable[]): Renderable[] {
  if (collected.length <= MAX_RENDERABLES) return collected;
  const cut = collected.length - MAX_RENDERABLES;
  const rescued = collected.slice(0, cut).filter((item) => item.source === 'approval');
  return [...rescued, ...collected.slice(cut)];
}

/**
 * `canvas.show {renderer, title, data}` — the data is already in the
 * renderer's own shape, so there is no descriptor and no mapping. An unknown
 * renderer name still shows, as structured.
 */
function fromCanvasShow(id: string, input: unknown, at: string | null): Renderable | null {
  if (input === null || typeof input !== 'object') return null;
  const { renderer, title, data } = input as { renderer?: unknown; title?: unknown; data?: unknown };
  const name = typeof renderer === 'string' && isKnownRenderer(renderer) ? (renderer as RendererName) : 'structured';
  return {
    id,
    tool: CANVAS_SHOW,
    title: typeof title === 'string' && title.trim() !== '' ? title : 'Shown',
    renderer: name,
    props: name === 'structured' && !isKnownRenderer(String(renderer)) ? { value: data } : data,
    at,
    // The agent asked for this to be shown. That settles it.
    substantial: true,
    source: 'canvas',
  };
}

/**
 * Does this result earn a tab at all?
 *
 * The canvas sits beside the answer, not inside it, so a tab is worth having
 * only when it holds something the answer cannot hold: rows, points, bars,
 * figures, a document, a decision. Three kinds of result fail that test and
 * are dropped:
 *
 *  - one whose whole content is a string — an agent's prose, quoted back;
 *  - a receipt for a write, `{ok: true, recorded: 1}`, which states that
 *    something happened rather than showing what it was;
 *  - an empty result, and a shape nothing can draw.
 *
 * Each of those is already in the conversation, in words, a moment earlier.
 *
 * Three kinds always earn one, whatever their shape: a failure — a tab is the
 * only place a reason can be read in full, and hiding one would be hiding bad
 * news; a decision waiting on the owner; and anything the agent explicitly
 * asked to be shown.
 */
export function earnsTab(renderer: RendererName, props: unknown): boolean {
  const record = (props ?? {}) as Record<string, unknown>;
  if (record['failed'] === true) return true;
  if (hasSubstance(renderer, props)) return true;
  // A result that reports its own failure while the call "succeeded" is still
  // news. The structured view is where its reason can be read in full.
  if (renderer === 'structured' && inferShape(record['value']).kind === 'error') return true;
  return false;
}

/**
 * Is there anything in here worth taking the screen for?
 *
 * Shape only: rows, points, bars, pairs, a document body. An empty table and a
 * chart with no points are both honest results and both worth *keeping* — they
 * are simply not worth interrupting for.
 */
export function hasSubstance(renderer: RendererName, props: unknown): boolean {
  const record = (props ?? {}) as Record<string, unknown>;
  switch (renderer) {
    case 'timeseries':
      return count(record['points']) > 0;
    case 'bars':
      return count(record['bars']) > 0;
    case 'keyvalue':
      return count(record['pairs']) > 0;
    case 'document':
      return Boolean(record['text']) || Boolean(record['src']);
    case 'envelope':
      return true;
    case 'table': {
      const groups = Array.isArray(record['groups']) ? (record['groups'] as unknown[]) : [];
      return groups.some((group) => count((group as Record<string, unknown>)['rows']) > 0);
    }
    default: {
      // The fallback has to read the value, because its whole job is to work
      // out what the value is.
      const shape = inferShape(record['value'], { failed: record['failed'] === true });
      if (shape.kind === 'table') return shape.rows.length > 0;
      // A descriptor is a plugin author's judgement and is trusted at one row.
      // An inferred list or record is a *guess*, so it has to carry a few
      // values before it is allowed to interrupt what is already on screen.
      if (shape.kind === 'list') return shape.items.length >= MIN_ITEMS;
      // One object of facts is a view when it is a set of *figures* — money,
      // counts, dates, laid out to be read across. An acknowledgement
      // (`{ok: true, recorded: 1}`), and an answer whose fields are prose and
      // the names of who said it, are sentences: the chat has them already.
      if (shape.kind === 'record') return figures(shape.pairs) >= MIN_FIGURES;
      return false;
    }
  }
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Items an inferred list needs before it is a list rather than an aside. */
const MIN_ITEMS = 3;

/** Figures one object needs before it is a view rather than a receipt. */
const MIN_FIGURES = 3;

/**
 * How many of these pairs are figures — an amount, a count, a date. A string
 * is a word, and words are what the answer is made of; a number laid out
 * beside other numbers is the thing a paragraph is bad at.
 */
function figures(pairs: Array<{ type: string }>): number {
  return pairs.filter((pair) => pair.type === 'number' || pair.type === 'currency' || pair.type === 'date').length;
}

/**
 * The action id a gated call left behind. The gate is reported in the result,
 * and different tools word it differently, so this looks for the identifier
 * rather than for a sentence.
 */
export function approvalIdOf(block: Extract<ChatBlock, { type: 'tool_result' }>): string | null {
  for (const candidate of [block.error, block.output]) {
    const found = findApprovalId(candidate, 0);
    if (found) return found;
  }
  return null;
}

function findApprovalId(value: unknown, depth: number): string | null {
  if (depth > 3 || value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const reason = record['reason'];
  const direct = record['actionId'] ?? record['approvalId'];
  if (typeof direct === 'string' && direct !== '') {
    // Only when this really is a gate: an id alone is not a pending decision.
    if (reason === undefined || reason === 'approval-required') return direct;
  }
  for (const child of Object.values(record)) {
    const found = findApprovalId(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** `orchard.forecast` → `Orchard · Forecast`. A label, not a tool name. */
export function labelFor(tool: string): string {
  const parts = tool.split('.');
  if (parts.length === 1) return humanise(tool);
  return parts.map((part) => humanise(part)).join(' · ');
}

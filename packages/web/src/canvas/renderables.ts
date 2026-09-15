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
 * Every renderable also says whether it is *substantial* — whether it has rows,
 * points, figures or a document in it. A tool that returned nothing, or failed,
 * or produced a shape nothing can draw still gets a tab, but the canvas does
 * not throw away the chart the owner is reading in order to show it.
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

/** How many renderables the tabs hold. Enough to go back to the chart. */
export const MAX_RENDERABLES = 8;

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

      collected.push({
        id: block.toolUseId,
        tool,
        title: labelFor(tool),
        renderer: 'structured',
        props: { value: block.output },
        at,
        source: 'fallback',
        substantial: hasSubstance('structured', { value: block.output }),
      });
    }
  }

  return collected.slice(-MAX_RENDERABLES);
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
      if (shape.kind === 'list') return shape.items.length >= 3;
      // A two-field acknowledgement — `{ok: true, recorded: 1}` — is a receipt
      // for a write, not a view. It keeps its tab; it does not take the screen.
      if (shape.kind === 'record') return shape.pairs.length >= 3;
      return false;
    }
  }
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
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

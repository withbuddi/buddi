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
 */
import { applyDescriptor } from './resolve';
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
        });
        continue;
      }

      if (block.ok === false) {
        collected.push({
          id: block.toolUseId,
          tool,
          title: labelFor(tool),
          renderer: 'structured',
          props: { value: block.error ?? block.output ?? 'The call failed with no detail.' },
          at,
          tone: 'critical',
          source: 'fallback',
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
    source: 'canvas',
  };
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

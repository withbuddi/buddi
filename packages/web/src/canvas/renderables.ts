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
import { inferShape, isSubstantialResult } from './infer';
import { isKnownRenderer } from './registry';
import { humanise } from './resolve';
import type { Renderable, RendererName, ViewDescriptor } from './types';
import type { ChatBlock, ChatMessage } from '../chat/types';
import { commandResult } from './command-result';

/**
 * One agent asking another. Its call is drawn as the colleague's own run —
 * the one place this file names a tool, and it names a *platform* tool rather
 * than a plugin's: a delegation is a second conversation of the owner's, and
 * nothing about its shape says so.
 */
export const DELEGATE_TOOL = 'agent.delegate';

/** What the delegate panel is handed: where the work went, and how it ended. */
export interface DelegatePanelProps {
  conversationId: string;
  agentId: string;
  runId: string | null;
  /** The delegation's own result, once the call has come back. */
  result: { ok: boolean; text: string | null } | null;
}

/**
 * Where a delegate call sent its work, from the call's recorded input.
 *
 * The server writes the ids onto the call the moment the colleague's
 * conversation exists — before the answer, which is the point: the panel
 * follows the run live rather than appearing when it is over.
 */
export function delegationOf(input: unknown): { conversationId: string; agentId: string; runId: string | null } | null {
  if (input === null || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const conversationId = record['conversationId'];
  if (typeof conversationId !== 'string' || conversationId === '') return null;
  const agentId = record['agentId'] ?? record['agent'];
  return {
    conversationId,
    agentId: typeof agentId === 'string' ? agentId : '',
    runId: typeof record['runId'] === 'string' ? record['runId'] : null,
  };
}

/** The colleague's words out of a delegate result, whichever half it came in. */
function delegateText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  const text = (value as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : null;
}

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
  /**
   * Tools whose results a live platform panel is already drawing, by name.
   *
   * A browser session is the case this exists for: while one is alive, the
   * canvas holds a single panel showing the screen and every step taken on it,
   * and a tab per call would bury that panel under a dozen copies of itself.
   * The *names* come from the page, which knows what its panel covers; this
   * file still knows none. A call stopped on a gate is never folded — a
   * decision waiting on the owner outranks any panel.
   */
  folded?: ReadonlySet<string>;
}

/**
 * The canvas contents for a conversation, oldest first, capped at the last
 * few. `canvas.clear` empties what came before it and nothing after.
 */
export function renderablesFrom({ messages, descriptors, awaiting, folded }: RenderableInput): Renderable[] {
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
        // A delegation draws the colleague's run, from the call: the ids are
        // on it long before the answer is.
        if (block.name === DELEGATE_TOOL) {
          const ref = delegationOf(block.input);
          if (ref) {
            collected.push({
              id: block.id,
              tool: DELEGATE_TOOL,
              title: 'Delegation',
              renderer: 'delegate',
              props: { ...ref, result: null } satisfies DelegatePanelProps,
              at: message.at ?? null,
              source: 'delegate',
              // A colleague at work is the most interesting thing on the
              // screen while it is happening.
              substantial: true,
            });
          }
        }
        continue;
      }

      if (block.type !== 'tool_result') continue;
      if (block.name === CANVAS_SHOW || block.name === CANVAS_CLEAR) continue;

      const use = uses.get(block.toolUseId);
      const at = message.at ?? use?.at ?? null;
      const tool = block.name || use?.name || 'tool';

      // The delegate panel is already on the canvas, drawn from the call. The
      // result does not open a second tab: it finishes the one that is there,
      // and the colleague's answer stays on it as the summary.
      const delegate = collected.find((item) => item.source === 'delegate' && item.id === block.toolUseId);
      if (delegate) {
        delegate.props = {
          ...(delegate.props as DelegatePanelProps),
          result: { ok: block.ok, text: delegateText(block.ok ? block.output : block.error ?? block.output) },
        } satisfies DelegatePanelProps;
        if (!block.ok) delegate.tone = 'critical';
        continue;
      }

      // A call that stopped on a gate is an envelope, whatever it would
      // otherwise have drawn.
      const approvalId = block.approval ? approvalIdOf(block) : awaiting?.get(block.toolUseId) ?? approvalIdOf(block);
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

      // A live panel already draws this call, success or failure alike: its
      // step list is where the action and its reason are read.
      if (folded?.has(tool)) continue;

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
        // A declared view is the plugin author's judgement that this result is
        // worth looking at. It keeps its tab even when it came back empty —
        // "no rows this month" is an answer, drawn the way its author meant.
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

      const props = { value: commandResult(block.output) ? { input: use?.input, output: block.output } : block.output };
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
 * One rule, decided from the result itself and never from the name of the
 * tool that produced it. A tab is earned when the result is *substantial*:
 *
 *  - its plugin declared a view for it, or
 *  - it carries an artifact or a document, or
 *  - its shape is rows, a list of a few, or enough separate values to be worth
 *    laying out — the thresholds are in `infer.ts`.
 *
 * Everything else is quiet: an acknowledgement (`{ok: true, recorded: 1}`), a
 * record of three or four fields, an answer that is entirely prose, an empty
 * result. The conversation said all of it a moment earlier, and the tool row
 * in the transcript still expands to the whole thing on demand.
 *
 * Two kinds earn a tab whatever their shape: a failure — a tab is the only
 * place a reason can be read in full, and hiding one would be hiding bad news
 * — and a decision waiting on the owner. Neither is substantial: they keep a
 * tab without taking the screen. Anything the agent explicitly asked to be
 * shown bypasses this entirely.
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
 * Shape only: rows, points, bars, pairs, a document body, a file, or enough
 * values that a panel reads better than a paragraph. An empty table and a
 * chart with no points are both honest results drawn by a declared view: they
 * are worth *keeping*, and simply not worth interrupting for.
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
    // A frame with nothing to point at is a box: the tab is earned by there
    // being a process to look at.
    case 'preview':
      return Boolean(record['target']);
    case 'envelope':
      return true;
    case 'table': {
      const groups = Array.isArray(record['groups']) ? (record['groups'] as unknown[]) : [];
      return groups.some((group) => count((group as Record<string, unknown>)['rows']) > 0);
    }
    default: {
      if (commandResult(record['value'])) return true;
      // A failure draws its reason, not a view: it keeps its tab and stays put.
      if (record['failed'] === true) return false;
      // The fallback has to read the value, because its whole job is to work
      // out what the value is. The thresholds live in `infer.ts`.
      return isSubstantialResult(record['value']);
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
  if (block.approval) return block.approval.state === 'pending' ? block.approval.id : null;
  for (const candidate of [block.error, block.output]) {
    const found = findApprovalId(candidate, 0);
    if (found) return found;
  }
  return null;
}

/**
 * Small results stay quiet, but every recorded call can be inspected on
 * demand.
 *
 * `redactInputOf` names tools whose arguments carry what the owner typed —
 * the page knows which those are; this file does not — and their input is
 * drawn with the typed strings held back. An inspector is a panel on a shared
 * screen, and a password does not stop being one because the call recording it
 * is three days old.
 */
export function inspectToolCall(
  messages: ChatMessage[],
  id: string,
  options: { redactInputOf?: ReadonlySet<string> } = {},
): Renderable | null {
  const blocks = messages.flatMap(message => message.blocks);
  const call = blocks.find(block => block.type === 'tool_use' && block.id === id);
  if (call?.type !== 'tool_use') return null;
  const result = blocks.find(block => block.type === 'tool_result' && block.toolUseId === id);
  const input = options.redactInputOf?.has(call.name) ? redacted(call.input) : call.input;
  return {
    id, tool: call.name, title: labelFor(call.name), renderer: 'structured',
    props: { value: { input, ...(result?.type === 'tool_result'
      ? { status: result.approval?.state ?? (result.ok ? 'completed' : 'failed'), output: result.output, ...(result.error ? { error: result.error } : {}) }
      : { status: 'Awaiting result' }) } },
    at: null, source: 'fallback', substantial: false,
  };
}

/** The same arguments with anything that was typed replaced, one level deep. */
const TYPED_KEYS = new Set(['value', 'text', 'password', 'secret', 'code']);
function redacted(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = TYPED_KEYS.has(key) && typeof value === 'string' ? '— withheld —' : redacted(value);
  }
  return out;
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

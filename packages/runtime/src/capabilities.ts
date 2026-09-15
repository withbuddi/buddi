/**
 * The capability matrix (codex review, "Wire formats and budgets": *wire
 * compatibility is not behavioural equivalence*).
 *
 * Two adapters implementing one interface does not make two providers
 * interchangeable. Chat Completions cannot take a PDF part; Messages can.
 * Tool results are content blocks inside a user turn on one wire and separate
 * `role: 'tool'` messages on the other. Rather than let those differences
 * surface as a 400 from a foreign host — with the owner's data already in the
 * request body — the loop asks this matrix *before* it builds a request and
 * degrades to something the model can see and talk about.
 *
 * The booleans describe **this installation's adapter**, not the wire's
 * theoretical reach: neither adapter streams and neither cancels today, so both
 * say so. When an adapter grows the ability, its row changes and the loop
 * follows without being edited.
 */
import type { ProviderKind } from '@buddi/core';
import type { ContentBlock, NeutralMessage } from './anthropic.js';

/** How a wire carries the answer to a tool call. */
export type ToolResultOrdering =
  /** Anthropic: `tool_result` blocks inside the next user turn, any order. */
  | 'blocks-in-user-turn'
  /** OpenAI: one `role:'tool'` message per call, keyed by `tool_call_id`. */
  | 'tool-messages';

export interface ProviderCapabilities {
  kind: ProviderKind;
  /** Can the adapter deliver tool arguments incrementally as they arrive? */
  streamingToolArgs: boolean;
  /** Can a request carry image bytes? */
  multimodalImage: boolean;
  /** Can a request carry a PDF (or any non-image document)? */
  document: boolean;
  toolResultOrdering: ToolResultOrdering;
  /** May one assistant turn propose several tool calls at once? */
  parallelToolCalls: boolean;
  /** Can an in-flight request be aborted by the caller? */
  cancellation: boolean;
  /** Does the response report token usage? */
  usageReporting: boolean;
  /**
   * Can the *provider* run a web search on its own servers, inside one
   * response, on the credential this run already uses?
   *
   * Not "does the vendor sell a search product": this is the same honesty rule
   * as the rest of the matrix — it describes what **this installation's
   * adapter** implements. OpenAI has server-side search on the Responses API
   * and on the `-search-preview` chat models; the adapter in this repository
   * speaks plain Chat Completions and does neither, so its row says `false`
   * and Scout's `web.*` grant resolves to the plugin's own `web.search`.
   */
  nativeWebSearch: boolean;
}

const MATRIX: Record<ProviderKind, ProviderCapabilities> = {
  anthropic: {
    kind: 'anthropic',
    // The Messages API streams `input_json_delta`; this adapter does not read
    // the stream, so the honest answer for the port is `false`.
    streamingToolArgs: false,
    multimodalImage: true,
    document: true,
    toolResultOrdering: 'blocks-in-user-turn',
    parallelToolCalls: true,
    cancellation: false,
    usageReporting: true,
    // Verified live against /v1/messages with a subscription token: the
    // `web_search_20250305` server tool answers on the credential buddi
    // already holds, with no second key and no second bill. See `search.ts`.
    nativeWebSearch: true,
  },
  openai: {
    kind: 'openai',
    streamingToolArgs: false,
    multimodalImage: true,
    // Chat Completions has no document part. This is the compatibility cost of
    // that wire, named here rather than discovered as a 400.
    document: false,
    toolResultOrdering: 'tool-messages',
    parallelToolCalls: true,
    cancellation: false,
    usageReporting: true,
    // A deliberate `false`, not an oversight. Chat Completions' own
    // `web_search_options` is accepted only by the `gpt-4o-*-search-preview`
    // models — turning it on would silently repin Scout's model — and the
    // Responses API, where the general `web_search` tool lives, is a different
    // wire with a different request shape, a different content-block model and
    // different citation objects. That is an adapter, not a flag. Until one
    // exists this row is the truth, and the loop reads it: Scout keeps
    // `web.search` through Tavily and nothing is half-built.
    nativeWebSearch: false,
  },
};

/** The matrix row for a provider. Unknown kinds are a programming defect. */
export function providerCapabilities(kind: ProviderKind): ProviderCapabilities {
  const row = MATRIX[kind];
  if (!row) throw new Error(`providerCapabilities: unknown provider kind "${kind}"`);
  return row;
}

/**
 * What the port assumes of a provider that does not declare its own row — the
 * native wire this runtime was built on. Test doubles rely on it.
 */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = MATRIX.anthropic;

/**
 * What the model is shown in place of an attachment its provider cannot take.
 *
 * It says *which* attachment, *why*, and what to do about it, because the model
 * is the one that has to explain the gap to the owner. Silence here would look
 * to the model like the owner never attached anything.
 */
export function unsupportedAttachmentText(
  block: Extract<ContentBlock, { type: 'image' | 'document' }>,
  caps: ProviderCapabilities,
): string {
  const what =
    block.type === 'document'
      ? `${block.name ? `"${block.name}" ` : ''}(${block.mime})`
      : `(${block.mime})`;
  const noun = block.type === 'document' ? 'document' : 'image';
  return (
    `[${noun} ${what} was not sent: this agent runs on the ${caps.kind} provider, ` +
    `whose wire cannot carry ${noun === 'document' ? 'documents' : 'images'}. ` +
    'Tell the owner you cannot read the file here, and ask them to paste the ' +
    'text, or to ask an agent on a provider that accepts it.]'
  );
}

/** Does this block need a capability the provider does not have? */
function unsupported(block: ContentBlock, caps: ProviderCapabilities): boolean {
  if (block.type === 'image') return !caps.multimodalImage;
  if (block.type === 'document') return !caps.document;
  return false;
}

/**
 * Replace every block the provider cannot carry with a visible placeholder.
 *
 * Applied to what is *sent*, never to what is persisted: the transcript keeps
 * the artifact reference, so the same history sent to an Anthropic agent
 * tomorrow still carries the real file.
 */
export function degradeContent(
  content: readonly ContentBlock[],
  caps: ProviderCapabilities,
): ContentBlock[] {
  return content.map((block) =>
    unsupported(block, caps)
      ? {
          type: 'text' as const,
          text: unsupportedAttachmentText(
            block as Extract<ContentBlock, { type: 'image' | 'document' }>,
            caps,
          ),
        }
      : block,
  );
}

/** `degradeContent` over a whole history. Returns the same array when nothing changes. */
export function degradeMessages(
  messages: readonly NeutralMessage[],
  caps: ProviderCapabilities,
): NeutralMessage[] {
  return messages.map((message) => {
    const content = degradeContent(message.content, caps);
    return content.every((block, i) => block === message.content[i])
      ? message
      : { role: message.role, content };
  });
}

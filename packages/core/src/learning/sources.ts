/**
 * Which untrusted inputs were in a run's context.
 *
 * Derived from the messages the model was actually shown — the replayed
 * history and this run's own turns — never from what the model says it read.
 * Three signals, in order of how much they can be trusted:
 *
 *  1. **A tool that declares its output untrusted** (`ToolDefinition.untrusted`):
 *     `web.read` is a page, `email.read` is mail, whatever the result says.
 *     Counted only when the call answered: a refused call carried no text.
 *  2. **The platform's fences**, wherever they appear: the quoted-mail and
 *     watcher-finding fences a wake prompt carries, a provider's own web
 *     search results.
 *  3. **A tool that says so in its result** without declaring it — a plugin
 *     installed from elsewhere that stamps "untrusted" on what it returns.
 *     Better an unnamed mark than none.
 *
 * Pure: no database, no registry — the caller hands over a lookup.
 */
import { MAX_SOURCES, type UntrustedKind, type UntrustedSource } from './types.js';

/** The slice of a runtime message this reads. Structural, so core needs no runtime types. */
export interface ProvenanceMessage {
  role: string;
  content: readonly unknown[];
}

type Block = Record<string, unknown>;

const isBlock = (value: unknown): value is Block => value !== null && typeof value === 'object';

/** Input fields that name what a call was about, in the order they are preferred. */
const REF_FIELDS = ['url', 'query', 'q', 'messageId', 'threadId', 'uid', 'id', 'path', 'command', 'artifactId'];

function refOf(input: unknown): string | undefined {
  if (!isBlock(input)) return undefined;
  for (const field of REF_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim() !== '') return clip(value.trim());
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function clip(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A platform fence, by what it says it fences. */
const FENCE = /<<<([^<>]*UNTRUSTED[^<>]*)>>>/g;

function fenceKind(label: string): UntrustedKind {
  if (/MAIL/i.test(label)) return 'mail';
  if (/FINDING/i.test(label)) return 'finding';
  if (/PAGE|WEB/i.test(label)) return 'web';
  if (/CHAT|MESSAGE/i.test(label)) return 'chat';
  return 'other';
}

function fences(text: string): UntrustedKind[] {
  const kinds: UntrustedKind[] = [];
  for (const match of text.matchAll(FENCE)) kinds.push(fenceKind(match[1] ?? ''));
  return kinds;
}

/**
 * A result that marks itself: the shouted notice the web and mail plugins
 * stamp, or an `untrusted` field. Case-sensitive on purpose — an agent file
 * that merely *mentions* untrusted mail is not untrusted text.
 */
const SAYS_SO = /UNTRUSTED|"untrusted"\s*:/;

/** Tools whose results never count as a source by the "says so" rule: the learning tools themselves. */
const SELF = /^learning\./;

export function deriveUntrustedSources(
  messages: readonly ProvenanceMessage[],
  untrustedKindOf: (tool: string) => UntrustedKind | undefined,
): UntrustedSource[] {
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const message of messages) {
    for (const block of message.content) {
      if (isBlock(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        calls.set(block.id, { name: block.name, input: block.input });
      }
    }
  }

  const found: UntrustedSource[] = [];
  const seen = new Set<string>();
  const add = (source: UntrustedSource): void => {
    const key = `${source.kind}|${source.via}|${source.ref ?? ''}`;
    if (seen.has(key) || found.length >= MAX_SOURCES) return;
    seen.add(key);
    found.push(source);
  };

  for (const message of messages) {
    for (const block of message.content) {
      if (!isBlock(block)) continue;
      if (block.type === 'tool_result') {
        if (block.is_error === true) continue;
        const call = typeof block.tool_use_id === 'string' ? calls.get(block.tool_use_id) : undefined;
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        const name = call?.name ?? 'unknown';
        const ref = refOf(call?.input);
        const declared = call ? untrustedKindOf(call.name) : undefined;
        if (declared) {
          add({ kind: declared, via: name, ...(ref ? { ref } : {}) });
          continue;
        }
        const fenced = fences(content);
        if (fenced.length > 0) {
          for (const kind of fenced) add({ kind, via: name, ...(ref ? { ref } : {}) });
          continue;
        }
        if (!SELF.test(name) && SAYS_SO.test(content)) add({ kind: 'other', via: name, ...(ref ? { ref } : {}) });
      } else if (block.type === 'text' && message.role === 'user' && typeof block.text === 'string') {
        for (const kind of fences(block.text)) add({ kind, via: 'prompt' });
      } else if (block.type === 'provider_native') {
        add({ kind: 'web', via: 'native-search' });
      }
    }
  }
  return found;
}

/**
 * The owner turn a run is answering: how many user messages so far carried
 * words rather than only tool results. 1 for the first thing said.
 */
export function ownerTurn(messages: readonly ProvenanceMessage[]): number {
  let turns = 0;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.content.some((block) => isBlock(block) && block.type === 'text')) turns++;
  }
  return Math.max(turns, 1);
}

/** One line per source, for a card or a log. */
export function describeUntrustedSource(source: UntrustedSource): string {
  const what: Record<UntrustedKind, string> = {
    web: 'web page',
    mail: 'mail',
    file: 'file',
    chat: 'chat message',
    finding: 'watcher data',
    other: 'untrusted output',
  };
  return `${what[source.kind]}${source.ref ? ` ${source.ref}` : ''} (${source.via})`;
}

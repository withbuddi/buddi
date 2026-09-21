/**
 * The projection: what one agent is shown of a room it shares.
 *
 * A group transcript has many speakers; a provider knows two roles. So each
 * model call receives the transcript re-read for the agent about to speak:
 *
 *  - its own turns are its assistant history, content and tool pairing kept;
 *  - the owner's turns are user turns;
 *  - every other speaker becomes attributed room context in a user turn,
 *    built from the stored speaker, never from the text — `@ledger said: …`;
 *    another agent's tool results are room data, never this agent's own tool
 *    history, so nothing a colleague did is replayed as something it did.
 *
 * Adjacent room context collapses into one user turn, so the sequence the
 * provider sees alternates the way a conversation does. Nothing here can turn
 * a member's words into a system line or a grant: every projected block is a
 * user-role text block, and the only assistant turns are the agent's own.
 * (docs/groups.md, "The projection".)
 */
import type { ContentBlock, NeutralMessage } from './anthropic.js';

/** One stored turn, as `core.messages` holds it for a group conversation. */
export interface StoredTurn {
  role: 'user' | 'assistant';
  /** As stored; a row written by any version of the runtime, so read loosely. */
  content: ReadonlyArray<ContentBlock | { type: string; [key: string]: unknown }>;
  /** `'owner'`, an agent id, `'room'` for an orchestration note, or null on legacy rows. */
  speaker: string | null;
}

export const OWNER_SPEAKER = 'owner';
export const ROOM_SPEAKER = 'room';

/** How much of a colleague's tool output is carried as room data. */
export const ROOM_TOOL_RESULT_CHARS = 1200;

export interface ProjectionInput {
  turns: readonly StoredTurn[];
  /** The agent about to speak. */
  agentId: string;
  /** Agent id to handle, for `@handle said:`. An unknown id is shown by its id. */
  handles: ReadonlyMap<string, string>;
}

export function projectTranscript(input: ProjectionInput): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  const label = (speaker: string): string => `@${input.handles.get(speaker) ?? speaker}`;

  const blocksOf = (turn: StoredTurn): ContentBlock[] => turn.content.map((b) => cloneBlock(b as ContentBlock));

  const pushRoom = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const last = out[out.length - 1];
    // Room context runs together into one user turn; a user turn that holds
    // the agent's own tool results is left alone so pairing survives.
    if (last && last.role === 'user' && (last as RoomTurn).room === true) {
      const block = last.content[last.content.length - 1];
      if (block && block.type === 'text') block.text = `${block.text}\n\n${trimmed}`;
      else last.content.push({ type: 'text', text: trimmed });
      return;
    }
    const turn: RoomTurn = { role: 'user', content: [{ type: 'text', text: trimmed }], room: true };
    out.push(turn);
  };

  /*
   * Tool calls the agent made that have not been answered yet. Anything that
   * arrives while any of them is open — a member's contribution inside
   * group.ask, the agent's own request to the next member, the owner speaking
   * — is held back until every one of them is answered, so the calls and
   * their results stay adjacent, which every provider requires. What was held
   * follows the results, in the order it came.
   */
  const outstanding = new Set<string>();
  type Held = { kind: 'room'; text: string } | { kind: 'own'; blocks: ContentBlock[] } | { kind: 'owner'; blocks: ContentBlock[] };
  let held: Held[] = [];
  const pushOwn = (blocks: ContentBlock[]): void => {
    const last = out[out.length - 1];
    if (last && last.role === 'assistant' && !(last as RoomTurn).room) last.content.push(...blocks);
    else out.push({ role: 'assistant', content: blocks });
  };
  const flushHeld = (): void => {
    for (const item of held) {
      if (item.kind === 'room') pushRoom(item.text);
      else if (item.kind === 'own') pushOwn(item.blocks);
      else out.push({ role: 'user', content: item.blocks });
    }
    held = [];
  };
  const room = (text: string): void => {
    if (outstanding.size > 0) held.push({ kind: 'room', text });
    else pushRoom(text);
  };

  for (const turn of input.turns) {
    const speaker = turn.speaker;

    // The agent's own words and its own tool results: history, as it was.
    // A user-role row it authored with no tool result in it is coordination
    // it wrote (a request to a member), so it is its own words, not an
    // instruction to it. Consecutive own turns of one role run together.
    if (speaker === input.agentId) {
      const blocks = blocksOf(turn);
      const answers = blocks.some((b) => b.type === 'tool_result');
      if (turn.role === 'user' && answers) {
        out.push({ role: 'user', content: blocks });
        for (const b of blocks) if (b.type === 'tool_result') outstanding.delete(b.tool_use_id);
        if (outstanding.size === 0) flushHeld();
        continue;
      }
      if (outstanding.size > 0) { held.push({ kind: 'own', blocks }); continue; }
      pushOwn(blocks);
      for (const b of blocks) if (b.type === 'tool_use') outstanding.add(b.id);
      continue;
    }

    // The owner: a user turn, with files and text as they were sent. A legacy
    // row with no speaker and the user role was the owner too.
    if (speaker === OWNER_SPEAKER || (speaker === null && turn.role === 'user' && !turn.content.some((b) => b.type === 'tool_result'))) {
      const blocks = blocksOf(turn).filter((b) => b.type !== 'tool_result');
      if (outstanding.size > 0) held.push({ kind: 'owner', blocks });
      else out.push({ role: 'user', content: blocks });
      continue;
    }

    // A note the orchestration wrote: the room speaking.
    const blocks = blocksOf(turn);
    if (speaker === ROOM_SPEAKER) {
      room(textOf(blocks));
      continue;
    }

    // Another agent, or a legacy assistant row: attributed room context.
    const who = speaker === null ? 'a colleague' : label(speaker);
    if (turn.role === 'assistant') {
      const said = textOf(blocks);
      const used = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => `[${who} used ${b.name}]`);
      room([said === '' ? '' : `${who} said:\n${said}`, ...used].filter(Boolean).join('\n'));
    } else {
      const results = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => `[${who}'s tool ${b.is_error ? 'failed' : 'returned'}: ${clip(b.content, ROOM_TOOL_RESULT_CHARS)}]`);
      const said = textOf(blocks);
      room([said === '' ? '' : `${who} said:\n${said}`, ...results].filter(Boolean).join('\n'));
    }
  }
  // Calls still open at the end belong to the run about to answer them; what
  // was held follows, so nothing is lost — it is simply last.
  outstanding.clear();
  flushHeld();

  return out.map(({ role, content }) => ({ role, content }));
}

type RoomTurn = NeutralMessage & { room?: true };

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cloneBlock(block: ContentBlock): ContentBlock {
  return JSON.parse(JSON.stringify(block)) as ContentBlock;
}

/** How much of an agent's own tool output stays in its projection. */
export const OWN_TOOL_RESULT_CHARS = 8000;

/* ------------------------------------------------------------------ *
 * Observations: evidence for one step, not for the conversation
 * ------------------------------------------------------------------ */

/**
 * The tools whose results are an observation: a page (or window) tree, a list
 * of targets and a screenshot reference, thousands of characters each. The
 * computer driver returns the same shape as the browser one on purpose
 * (`packages/tools/browser/src/computer.ts`), so one rule covers both.
 */
export const OBSERVATION_TOOLS: readonly string[] = ['browser.act', 'browser.status', 'computer'];

/**
 * How many observations stay whole. Two, not one: the model needs the page it
 * is acting on *and* the page before it, to tell "the click worked" from "the
 * click did nothing". A third adds cost without adding an answer.
 */
export const OBSERVATIONS_KEPT_WHOLE = 2;

/**
 * Older observations, reduced to what a person would remember of them.
 *
 * A browsing session is a dozen page trees, and eleven of them are already
 * spent: the agent acted on them and moved on. What it still needs from those
 * is where it was and whether the step worked — `URL, title, action, ok` —
 * which is one line instead of four thousand characters. The latest two stay
 * exactly as they were, because those are the ones it is still working in.
 *
 * Only what is *sent* changes. The transcript on disk keeps every observation
 * whole, so nothing is lost and the reduction is recomputed on every call.
 */
export function compactObservations(
  messages: readonly NeutralMessage[],
  keepWhole: number = OBSERVATIONS_KEPT_WHOLE,
): NeutralMessage[] {
  // Which calls were observations, and what they were asked to do. A result
  // names only the call it answers, so the name comes from the call.
  const calls = new Map<string, { name: string; action: string }>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      if (!OBSERVATION_TOOLS.includes(block.name)) continue;
      const input = block.input as { action?: unknown } | null;
      const action = typeof input?.action === 'string' ? input.action : '';
      calls.set(block.id, { name: block.name, action });
    }
  }
  if (calls.size === 0) return messages.map((m) => ({ role: m.role, content: m.content }));

  // The observations, oldest first, by where they sit.
  const found: Array<{ message: number; block: number }> = [];
  messages.forEach((message, mi) => {
    message.content.forEach((block, bi) => {
      if (block.type === 'tool_result' && calls.has(block.tool_use_id)) found.push({ message: mi, block: bi });
    });
  });
  const compact = found.slice(0, Math.max(0, found.length - Math.max(0, keepWhole)));
  if (compact.length === 0) return messages.map((m) => ({ role: m.role, content: m.content }));

  const at = new Set(compact.map((p) => `${p.message}:${p.block}`));
  return messages.map((message, mi) => ({
    role: message.role,
    content: message.content.map((block, bi) => {
      if (!at.has(`${mi}:${bi}`) || block.type !== 'tool_result') return block;
      const call = calls.get(block.tool_use_id)!;
      return { ...block, content: observationLine(call, block.content, block.is_error === true) };
    }),
  }));
}

/** `[browser.act click — Accounts (https://…) — ok]`, and nothing else. */
function observationLine(
  call: { name: string; action: string },
  content: string,
  failed: boolean,
): string {
  const seen = observationOf(content);
  const parts = [
    call.action ? `${call.name} ${call.action}` : call.name,
    seen?.title ?? '',
    seen?.url ?? '',
    failed ? 'failed' : 'ok',
  ].filter((part) => part !== '');
  return `[earlier observation, summarised: ${parts.join(' — ')}; the whole of it is in the transcript]`;
}

/** URL and title out of one observation. Never the tree, never the text. */
function observationOf(content: string): { url: string; title: string } | null {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  const seek = (node: unknown, depth: number): { url: string; title: string } | null => {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    const record = node as Record<string, unknown>;
    const page = (record.observation ?? record.page) as Record<string, unknown> | undefined;
    if (page && typeof page.url === 'string' && page.url !== '') {
      return { url: clip(page.url, 200), title: clip(String(page.title ?? ''), 120) };
    }
    if (Array.isArray(node)) {
      for (const part of node) {
        const found = seek(part, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return seek(value, 0);
}

/** The room could not be made to fit the cap. The run must not proceed blind. */
export class ProjectionOverflow extends Error {
  override readonly name = 'ProjectionOverflow';
  constructor(readonly chars: number, readonly cap: number) {
    super(`the room is ${chars} characters and cannot be reduced to the group's cap of ${cap}`);
  }
}

/**
 * A projection that fits, or an error. The reductions, in order, each
 * re-measured before the next: an agent's own tool results are clipped to a
 * size a model can carry; the oldest turns after the opening are dropped, a
 * call together with its result; images and documents become a one-line
 * reference, oldest first, since a picture is worth more characters than
 * any cap; long text and results are clipped. Every marker written counts.
 * If the room still does not fit, this refuses rather than sending a room
 * the provider would refuse, or silently sending less than it claims.
 * (docs/groups.md, "Memory".)
 */
export function boundProjection(messages: NeutralMessage[], maxChars: number): NeutralMessage[] {
  // A copy: the caller's history is the run's own and must not be clipped in place.
  const kept: NeutralMessage[] = compactObservations(messages).map((m) => ({ role: m.role, content: m.content.map((b) => cloneBlock(b)) }));
  const size = (): number => kept.reduce((sum, m) => sum + JSON.stringify(m.content).length, 0);

  // 0. Spent observations reduced to a line (above), before anything is
  //    dropped: a page tree the agent has finished with is the cheapest thing
  //    in the room to give up, and giving it up may mean no turn is lost.
  // 1. Own tool results, clipped.
  for (const m of kept) {
    m.content = m.content.map((b) =>
      b.type === 'tool_result' && b.content.length > OWN_TOOL_RESULT_CHARS
        ? { ...b, content: `${b.content.slice(0, OWN_TOOL_RESULT_CHARS)}\n[…truncated: the result was ${b.content.length} characters; the whole of it is in the transcript]` }
        : b);
  }
  if (size() <= maxChars) return kept;

  // 2. Oldest turns after the opening, whole, a call with its answer.
  let dropped = 0;
  while (size() > maxChars && kept.length > 2) {
    const victim = kept.splice(1, 1)[0]!;
    dropped += 1;
    const next = kept[1];
    if (victim.role === 'assistant' && next && next.role === 'user' && next.content.some((b) => b.type === 'tool_result')) {
      kept.splice(1, 1);
      dropped += 1;
    }
  }
  if (dropped > 0) {
    kept.splice(1, 0, { role: 'user', content: [{ type: 'text', text: `[${dropped} earlier turn${dropped === 1 ? '' : 's'} of this room left out for room: the transcript keeps them.]` }] });
  }
  if (size() <= maxChars) return kept;

  // 3. Pictures and documents become references, oldest first.
  for (const m of kept) {
    if (size() <= maxChars) break;
    m.content = m.content.map((b) =>
      b.type === 'image' ? { type: 'text' as const, text: `[an image (${b.mime}) was here; left out to fit the room]` }
      : b.type === 'document' ? { type: 'text' as const, text: `[a document (${b.mime}${b.name ? `, "${b.name}"` : ''}) was here; left out to fit the room]` }
      : b);
  }
  if (size() <= maxChars) return kept;

  // 4. Long text and results, clipped, oldest first. The marker itself is
  // paid for in the cut, so the result is never over by its own length.
  const MARK = '\n[…clipped to fit]';
  const bare = (t: string): string => t.replace(/\n\[…clipped to fit\]$/, '');
  // Measured as JSON, which is how it is sent. Each round trims the first
  // block that still has room to give by what is over, plus a margin for
  // the marker's escaping; a few rounds settle it.
  for (let round = 0; round < 64 && size() > maxChars; round += 1) {
    const over = size() - maxChars + 8;
    let trimmed = false;
    for (const m of kept) {
      for (const b of m.content) {
        if (b.type === 'text' && bare(b.text).length > 200) {
          const raw = bare(b.text);
          b.text = `${raw.slice(0, Math.max(200, raw.length - over))}${MARK}`;
          trimmed = true;
        } else if (b.type === 'tool_result' && bare(b.content).length > 200) {
          const raw = bare(b.content);
          b.content = `${raw.slice(0, Math.max(200, raw.length - over))}${MARK}`;
          trimmed = true;
        }
        if (trimmed) break;
      }
      if (trimmed) break;
    }
    if (!trimmed) break;
  }
  const finalSize = size();
  if (finalSize > maxChars) throw new ProjectionOverflow(finalSize, maxChars);
  return kept;
}

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
   * A tool call the agent made that has not been answered yet. Anything the
   * room said in between — a member's contribution inside group.ask — is held
   * back until the answer, so the call and its result stay adjacent, which
   * every provider requires; the held context follows the result.
   */
  let awaitingResult = false;
  let held: string[] = [];
  const flushHeld = (): void => {
    for (const text of held) pushRoom(text);
    held = [];
  };
  const room = (text: string): void => {
    if (awaitingResult) held.push(text);
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
      const role: NeutralMessage['role'] = turn.role === 'user' && !answers ? 'assistant' : turn.role;
      if (role === 'assistant' && !answers) flushHeld();
      const last = out[out.length - 1];
      if (last && last.role === 'assistant' && role === 'assistant' && !(last as RoomTurn).room) {
        last.content.push(...blocks);
      } else {
        out.push({ role, content: blocks });
      }
      if (answers) { awaitingResult = false; flushHeld(); }
      if (role === 'assistant' && blocks.some((b) => b.type === 'tool_use')) awaitingResult = true;
      continue;
    }

    // The owner: a user turn, with files and text as they were sent. A legacy
    // row with no speaker and the user role was the owner too.
    if (speaker === OWNER_SPEAKER || (speaker === null && turn.role === 'user' && !turn.content.some((b) => b.type === 'tool_result'))) {
      if (awaitingResult) {
        // The owner spoke while a call was open (a resumed request): their
        // words wait for the result too, as room context.
        held.push(textOf(blocksOf(turn)));
        continue;
      }
      out.push({ role: 'user', content: blocksOf(turn).filter((b) => b.type !== 'tool_result') });
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
  // A call still open at the end (the run that is about to answer it) keeps
  // its held context for after; nothing is lost, it is simply last.
  awaitingResult = false;
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

/**
 * A projection that fits. Two bounds, in this order: a tool result the agent
 * itself received is clipped to a size a model can carry, with a line saying
 * the whole of it stays in the transcript; then, if the room is still over
 * `maxChars`, the oldest turns go first — except the opening owner turn,
 * which is the request everyone is answering. Every call is made through
 * this, so a request that outgrows its cap ends with a shorter room, never
 * with a provider refusing the whole thing. (docs/groups.md, "Memory".)
 */
export function boundProjection(messages: NeutralMessage[], maxChars: number): NeutralMessage[] {
  // A copy: the caller's history is the run's own and must not be clipped in place.
  const clipped = messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => cloneBlock(b)).map((b) => {
      if (b.type === 'tool_result' && b.content.length > OWN_TOOL_RESULT_CHARS) {
        return { ...b, content: `${b.content.slice(0, OWN_TOOL_RESULT_CHARS)}\n[…truncated: the result was ${b.content.length} characters; the whole of it is in the transcript]` };
      }
      return b;
    }),
  }));
  const size = (m: NeutralMessage): number => JSON.stringify(m.content).length;
  let total = clipped.reduce((sum, m) => sum + size(m), 0);
  if (total <= maxChars) return clipped;
  // Drop from the second turn on, oldest first, whole turns at a time, but
  // never split a tool_use from its result: a dropped assistant turn takes
  // the user turn that answers it.
  const kept = [...clipped];
  let dropped = 0;
  while (total > maxChars && kept.length > 2) {
    const victim = kept[1]!;
    kept.splice(1, 1);
    total -= size(victim);
    dropped += 1;
    const next = kept[1];
    if (victim.role === 'assistant' && next && next.role === 'user' && next.content.some((b) => b.type === 'tool_result')) {
      kept.splice(1, 1);
      total -= size(next);
      dropped += 1;
    }
  }
  if (dropped > 0) {
    kept.splice(1, 0, { role: 'user', content: [{ type: 'text', text: `[${dropped} earlier turn${dropped === 1 ? '' : 's'} of this room left out for room: the transcript keeps them.]` }] });
  }
  // Two turns can still be over the cap when one of them is huge: clip the
  // largest text and tool-result blocks until it fits, oldest first.
  let over = kept.reduce((sum, m) => sum + size(m), 0) - maxChars;
  for (const m of kept) {
    if (over <= 0) break;
    for (const b of m.content) {
      if (over <= 0) break;
      if (b.type === 'text' && b.text.length > 200) {
        const cut = Math.min(b.text.length - 200, over);
        b.text = `${b.text.slice(0, b.text.length - cut)}\n[…clipped to fit]`;
        over -= cut;
      } else if (b.type === 'tool_result' && b.content.length > 200) {
        const cut = Math.min(b.content.length - 200, over);
        b.content = `${b.content.slice(0, b.content.length - cut)}\n[…clipped to fit]`;
        over -= cut;
      }
    }
  }
  return kept;
}

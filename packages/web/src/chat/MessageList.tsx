/**
 * The conversation itself.
 *
 * The two turns are told apart by shape, not by a label: what the owner said
 * is a tinted bubble pushed to the right edge of the column; what the agent
 * said is prose against the page, under the agent's own name, at a line length
 * you can actually read. A message that carries only a tool result — which is
 * how a transcript records the server's half of a call — prints nothing at
 * all, because "USER" over an empty box is noise.
 *
 * Tool calls appear inline as they happen — the tool's human label and the
 * seconds it has been running — because a column that goes quiet for forty
 * seconds looks broken, and a spinner does not say what is taking the time.
 * Every recorded call opens its result or an on-demand input/output inspector.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { approvalIdOf, DELEGATE_TOOL, labelFor } from '../canvas/renderables';
import { isPreviewable, previewUrl, type AttachmentBlock } from './attachments';
import { DiffLines } from '../canvas/views/DiffLines';
import { FileTile } from './FileTile';
import { gistFor } from './gist';
import { toolBodyFor, type ToolBody } from './tool-body';
import { Markdown, MarkdownAgents } from './markdown';
import { addedWhileWorking, offerTurnLabel, type ChatAgent, type ChatBlock, type ChatMessage, type ChatRun } from '../chat/types';
import { AgentAvatar } from '../ui';

/**
 * The answer as it is being written: what has arrived of this turn's thinking
 * and text, and when each began, so "thought for 4s" can be said truthfully.
 */
export interface LiveTurnView {
  runId: string;
  turn: number;
  text: string;
  thinking: string;
  thinkingStartedAt: number | null;
  textStartedAt: number | null;
  /** The transcript now holds this turn; it is hidden once the refresh shows it. */
  settled: boolean;
}

/** A tool call that has not come back yet. */
export interface LiveCall {
  toolUseId: string;
  name: string;
  startedAt: number;
}

export function MessageList({
  messages,
  live,
  now,
  onOpen,
  working = false,
  partial = null,
  agents,
  speakers,
  coordinatorId,
  workingAs,
  onOpenFile,
  children,
  agentName,
  emptyHint,
  empty,
  plain = false,
  workingLine,
  runs,
}: {
  messages: ChatMessage[];
  live: LiveCall[];
  /** Passed in so the elapsed counter ticks without this component owning a clock. */
  now: number;
  onOpen: (toolUseId: string) => void;
  /**
   * The agent is on it and has not said anything yet. Drawn where the reply
   * will land, under the agent's name, so the column never goes quiet between
   * the owner's message and the first word back.
   */
  working?: boolean;
  /** The turn being written right now, if any. */
  partial?: LiveTurnView | null;
  /** Every agent, so an `@handle` in an answer opens that agent. */
  agents?: ChatAgent[];
  /** In a room: every agent, so a turn can carry its speaker's face and name. */
  speakers?: ChatAgent[];
  coordinatorId?: string;
  /** Who is working, when the room says so; falls back to `agentName`. */
  workingAs?: string;
  /** A file in the thread was clicked: show it on the canvas. */
  onOpenFile?: (attachment: AttachmentBlock) => void;
  children?: ReactNode;
  /** Whose turn the agent's turn is. Shown once per run of its messages. */
  agentName?: string;
  emptyHint: string;
  /**
   * What an empty thread shows instead of `emptyHint`: an agent's own opening,
   * built by the page because it is the page that holds the roster. A node
   * rather than a string because it carries a face and buttons.
   */
  empty?: ReactNode;
  /**
   * Draw what was said and nothing else: no folded thoughts, no tool rows.
   *
   * First run uses it. An owner meeting their assistant for the first time is
   * shown one line saying it is looking around and then what it said; the
   * machinery of a turn is the chat's business, and the chat still shows all
   * of it.
   */
  plain?: boolean;
  /** The whole sentence to show while the agent is working, in place of the default. */
  workingLine?: string;
  /**
   * The conversation's runs, so a run that ran out of budget is marked as one.
   * The agent already says so in its own words; this is the fact under it.
   */
  runs?: ChatRun[];
}): JSX.Element {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, live.length, working, partial?.text.length, partial?.thinking.length, Boolean(children)]);

  const writing = partial && !partial.settled && (partial.text !== '' || partial.thinking !== '');

  const shown = messages.filter((message) => (message.blocks ?? []).some(isVisible));
  const stops = budgetStops(shown, runs ?? []);

  return (
    <MarkdownAgents.Provider value={agents ?? speakers ?? []}>
    <div className="wb-messages" data-testid="messages">
      {shown.length === 0 && live.length === 0 ? (
        empty ?? <p className="wb-chat-empty">{emptyHint}</p>
      ) : null}

      {shown.map((message, index) => {
        // In a room the speaker decides the side: the owner's turns are the
        // owner's, everything else is a member speaking, tool results included.
        const speaker = message.speaker ?? null;
        const mine = speakers ? speaker === 'owner' || (speaker === null && message.role === 'user') : message.role === 'user';
        const roomNote = speakers && speaker === 'room';
        const who = speakers && speaker && speaker !== 'owner' && speaker !== 'room' ? speakers.find((a) => a.id === speaker) ?? null : null;
        // The name is a heading for a run of turns, not a stamp on each one.
        const previous = shown[index - 1];
        const opensTurn = index === 0 || (speakers ? (previous?.speaker ?? null) !== speaker : previous!.role !== message.role);
        if (roomNote) {
          return (
            <div key={message.id} className="wb-msg wb-msg-room" data-role="room">
              {(message.blocks ?? []).filter((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text').map((b, i) => <span key={i}>{b.text}</span>)}
            </div>
          );
        }
        // The coordinator bringing a member in is coordination, not prose:
        // one line saying who asked whom for what, the whole request on click.
        // A decided action coming back is not a turn anybody took: it is the
        // result of something the owner already approved, drawn where the call
        // that asked for it is drawn — a tool row, not a bubble in their column.
        const decided = (message.blocks ?? []).filter(
          (b): b is Extract<ChatBlock, { type: 'approval_result' }> => b.type === 'approval_result',
        );
        if (decided.length > 0) {
          return (
            <div key={message.id} className="wb-msg" data-role="assistant" data-testid="approval-result">
              {decided.map((block, i) => <ApprovalResult key={i} block={block} />)}
            </div>
          );
        }
        /*
         * A turn the owner started by clicking a chip.
         *
         * What the model was given is the sentence the agent wrote; what the
         * owner did was click "Send it". Both are true, and the thread shows
         * the one they did — the sentence is the title, a hover away, so
         * nothing is hidden about what was actually asked.
         */
        // Typed while the agent was working. The bubble is the owner's, with
        // one quiet line above it saying when it went in — so a correction
        // that arrived mid-run does not read as the question that started it.
        const interjected = message.role === 'user' && addedWhileWorking(speaker);
        const offerLabel = message.role === 'user' ? offerTurnLabel(speaker) : null;
        if (offerLabel) {
          const asked = (message.blocks ?? [])
            .filter((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          return (
            <div key={message.id} className="wb-msg" data-role="user" data-testid="offer-turn">
              <div className="wb-bubble wb-bubble-offer" title={asked}>{offerLabel}</div>
            </div>
          );
        }

        const ask = speakers && who && message.role === 'user' ? askedFor(message) : null;
        if (ask) {
          // The member asked is whoever answers next; the request names only the asker.
          const next = shown.slice(index + 1).find((m) => m.role === 'assistant' && m.speaker && m.speaker !== who!.id);
          const target = next?.speaker ? speakers!.find((a) => a.id === next.speaker) : undefined;
          return (
            <details key={message.id} className="wb-msg wb-msg-room wb-msg-ask" data-role="room">
              <summary>{who!.name} asked {target?.name ?? 'a member'}{ask.request ? `: ${ask.request.length > 120 ? `${ask.request.slice(0, 119)}…` : ask.request}` : ''}</summary>
              {ask.request ? <p>{ask.request}</p> : null}
            </details>
          );
        }
        const stop = stops.get(message.id) ?? null;
        return (
          <div key={message.id} className="wb-msg" data-role={mine || interjected ? 'user' : 'assistant'}>
            {interjected ? (
              <div className="wb-msg-added" data-testid="added-while-working">added while working</div>
            ) : null}
            {opensTurn && !mine && !interjected ? (
              <div className="wb-msg-who">
                {who && speakers ? <AgentAvatar agents={speakers} id={who.id} size="sm" /> : null}
                <span>{who ? who.name : (agentName ?? 'Assistant')}</span>
                {who && coordinatorId === who.id ? <span className="wb-msg-role">coordinator</span> : null}
              </div>
            ) : null}
            {/* The files a message carries sit together, before its words: the
                thing you handed over, then what you said about it. */}
            {files(message).length > 0 ? (
              <div className="wb-msg-files" role="list" aria-label="Files sent with this message">
                {files(message).map((block) => (
                  <span role="listitem" key={block.artifactId}>
                    <FileTile
                      name={block.filename ?? 'Untitled file'}
                      mime={block.mime}
                      sizeBytes={block.sizeBytes}
                      thumbnail={isPreviewable(block.mime) ? previewUrl(block.artifactId) : null}
                      {...(onOpenFile ? { onOpen: () => onOpenFile(block) } : {})}
                    />
                  </span>
                ))}
              </div>
            ) : null}
            {(message.blocks ?? []).map((block, blockIndex) => {
              // A run of delegations that were all refused is one piece of
              // news, not four. See `refusedRun`.
              const run = refusedRun(message.blocks ?? [], blockIndex, messages);
              if (run === 'inside') return null;
              if (run) return <RefusedDelegations key={blockIndex} refusals={run.refusals} />;
              if (block.type === 'thinking') {
                if (plain || block.text.trim() === '') return null;
                return <Thought key={blockIndex} text={block.text} />;
              }
              if (block.type === 'text') {
                // The owner's words stay exactly as typed; the agent's are
                // markdown, because that is how a model writes a list.
                return block.text.trim() === '' ? null : mine ? (
                  <div key={blockIndex} className="wb-bubble">{block.text}</div>
                ) : (
                  <div key={blockIndex} className="wb-bubble" data-rich="true"><Markdown text={block.text} /></div>
                );
              }
              if (block.type === 'attachment') return null;
              if (block.type === 'tool_use') {
                if (plain) return null;
                const result = findResult(messages, block.id);
                return (
                  <ToolRow
                    key={blockIndex}
                    label={labelFor(block.name)}
                    tool={block.name}
                    ok={result?.ok ?? null}
                    running={result === null}
                    status={result && approvalIdOf(result) ? 'Awaiting approval' : result?.approval?.state}
                    gist={gistFor(block.name, block.input)}
                    body={result ? toolBodyFor(result.output) : null}
                    opens
                    onOpen={() => onOpen(block.id)}
                  />
                );
              }
              return null;
            })}
            {stop ? (
              <div className="wb-msg-budget" data-testid="budget-stop">{budgetLine(stop)}</div>
            ) : null}
          </div>
        );
      })}

      {writing ? (
        <div className="wb-msg" data-role="assistant" data-testid="live-turn">
          {shown.at(-1)?.role !== 'assistant' || workingAs ? <div className="wb-msg-who">{workingAs ?? agentName ?? 'Assistant'}</div> : null}
          {partial.thinking !== '' && !plain ? (
            <Thought
              text={partial.thinking}
              live={partial.text === ''}
              seconds={secondsBetween(partial.thinkingStartedAt, partial.textStartedAt ?? now)}
            />
          ) : null}
          {partial.text !== '' ? <div className="wb-bubble" data-live="true" data-rich="true"><Markdown text={partial.text} /><span className="wb-caret" aria-hidden="true" /></div> : null}
        </div>
      ) : null}

      {working && live.length === 0 && !writing ? (
        <div className="wb-msg" data-role="assistant" data-testid="working">
          {shown.at(-1)?.role !== 'assistant' || workingAs ? <div className="wb-msg-who">{workingAs ?? agentName ?? 'Assistant'}</div> : null}
          <span className="wb-working" role="status" aria-live="polite">
            {workingLine ?? `${workingAs ?? agentName ?? 'The agent'} is working`}
            <span className="wb-dots" aria-hidden="true"><i /><i /><i /></span>
          </span>
        </div>
      ) : null}

      {live.map((call) => (
        <div key={call.toolUseId} className="wb-msg" data-role="assistant">
          <ToolRow
            label={labelFor(call.name)}
            tool={call.name}
            ok={null}
            running
            elapsed={Math.max(0, Math.round((now - call.startedAt) / 1000))}
            opens={false}
            onOpen={() => onOpen(call.toolUseId)}
          />
        </div>
      ))}
      {children}
      <div ref={bottom} />
    </div>
    </MarkdownAgents.Provider>
  );
}

/** One refused delegation: who was asked, and what the refusal said. */
export interface Refusal {
  /** The id the model passed, which is the colleague it meant to ask. */
  target: string;
  /** The refusal, verbatim. */
  message: string;
}

/** `(allowed: ledger, postman)` out of a refusal, when it carries one. */
export function allowedIn(message: string): string | null {
  return /\(allowed: ([^)]*)\)/.exec(message)?.[1]?.trim() || null;
}

/**
 * The runtime's word for "you may not ask that agent". The prefix, not a
 * guess: `createDelegateTool` writes every authorization refusal with it.
 */
export const REFUSAL_PREFIX = 'delegation refused:';

/**
 * Is this block the head of a run of refused delegations?
 *
 * A model that has guessed a colleague's id guesses several, one after the
 * other, in the same turn. Four red rows saying the same thing is the tool
 * reporting itself rather than the turn reporting the work, so a run of two
 * or more collapses into one row that names every id it tried and the list it
 * was given.
 *
 * Only *refusals* — a delegation the installation would not allow. A
 * delegation that was allowed and then failed is news about the work: the
 * colleague threw, the provider was unreachable, the nested run ran out of
 * turns. Folding those into "delegation refused 3 times" would hide three
 * different errors behind a sentence that is not true of any of them, so
 * anything that is not a refusal keeps its own row.
 *
 * Returns `'inside'` for the blocks the head already speaks for.
 */
export function refusedRun(
  blocks: readonly ChatBlock[],
  index: number,
  messages: ChatMessage[],
): { refusals: Refusal[] } | 'inside' | null {
  const refusalAt = (at: number): Refusal | null => {
    const block = blocks[at];
    if (!block || block.type !== 'tool_use' || block.name !== DELEGATE_TOOL) return null;
    const result = findResult(messages, block.id);
    if (!result || result.ok !== false) return null;
    const message = typeof result.error === 'string' ? result.error : String(result.error ?? '');
    if (!message.trimStart().startsWith(REFUSAL_PREFIX)) return null;
    const input = (block.input ?? {}) as Record<string, unknown>;
    return {
      target: typeof input['agent'] === 'string' && input['agent'] !== '' ? input['agent'] : 'a colleague',
      message,
    };
  };

  if (!refusalAt(index)) return null;
  if (refusalAt(index - 1)) return 'inside';
  const refusals: Refusal[] = [];
  for (let at = index; ; at += 1) {
    const refusal = refusalAt(at);
    if (!refusal) break;
    refusals.push(refusal);
  }
  return refusals.length < 2 ? null : { refusals };
}

/**
 * The collapsed row: how many were refused, who was asked, and — folded — the
 * individual rows exactly as they would have been drawn.
 */
function RefusedDelegations({ refusals }: { refusals: Refusal[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const allowed = refusals.map((refusal) => allowedIn(refusal.message)).find((list) => list !== null) ?? null;
  const named = refusals.map((refusal) => refusal.target);
  const shown = named.slice(0, 3);
  const summary =
    `Delegation refused ${refusals.length} times: ${shown.join(', ')}${named.length > shown.length ? ', …' : ''}` +
    (allowed ? ` (allowed: ${allowed})` : '');
  return (
    <div className="wb-refusals" data-testid="delegation-refusals" data-open={open || undefined}>
      <button type="button" className="wb-tool" data-ok={false} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="wb-tool-mark" data-ok="false" aria-hidden="true" />
        <span className="wb-tool-label">{summary}</span>
        <ArrowIcon />
      </button>
      {open ? (
        <div className="wb-refusals-list">
          {refusals.map((refusal, index) => (
            <div className="wb-refusal" key={index}>
              <span className="wb-tool" data-static="true" data-ok={false}>
                <span className="wb-tool-mark" data-ok="false" aria-hidden="true" />
                <span className="wb-tool-label">{labelFor(DELEGATE_TOOL)} · {refusal.target}</span>
                <span className="wb-tool-elapsed">refused</span>
              </span>
              {/* What it actually said. Opened, the owner wants the reason,
                  not four copies of the word "refused". */}
              <p className="wb-refusal-why">{refusal.message}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function secondsBetween(from: number | null, to: number): number | null {
  if (from === null) return null;
  return Math.max(0, Math.round((to - from) / 1000));
}

/**
 * What the model thought, folded. Live, it is the line the column shows while
 * there is nothing else to show — "Thinking", with the clock — and it folds
 * the moment the answer starts. After the fact it is a quiet row that opens.
 */
export function Thought({ text, live = false, seconds = null }: { text: string; live?: boolean; seconds?: number | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = live
    ? `Thinking${seconds !== null && seconds > 0 ? ` · ${seconds}s` : ''}`
    : seconds !== null && seconds > 0 ? `Thought for ${seconds}s` : 'Thoughts';
  return (
    <div className="wb-thought" data-live={live || undefined} data-open={open || undefined}>
      <button type="button" className="wb-thought-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {live ? <span className="wb-dots" aria-hidden="true"><i /><i /><i /></span> : <ThoughtIcon />}
        <span>{label}</span>
        <ArrowIcon />
      </button>
      {open ? <div className="wb-thought-text"><Markdown text={text} /></div> : null}
    </div>
  );
}

function ThoughtIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.2 9.6a3.6 3.6 0 1 1 4.6 0v1.2H4.2z" /><path d="M5.2 12.2h2.6" />
    </svg>
  );
}

/**
 * The coordinator's request to a member, as the runtime words it: the member's
 * handle and the request itself, lifted out of the framing around them.
 */
function askedFor(message: ChatMessage): { handle: string; request: string } | null {
  const text = (message.blocks ?? []).find((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text')?.text ?? '';
  const match = /You are a member of the group "[^"]*"\. @([\w-]+), the coordinator, asks you now:\n\n([\s\S]*?)(?:\n\nAnswer for the room|$)/.exec(text);
  if (!match) return null;
  return { handle: match[1]!, request: match[2]!.trim() };
}

function files(message: ChatMessage): AttachmentBlock[] {
  return (message.blocks ?? []).filter((block): block is AttachmentBlock => block.type === 'attachment');
}

/**
 * Which message a run stopped on, for the runs that ran out of budget.
 *
 * The loop's own closing line is the last thing a budgeted run writes, so the
 * run's last assistant message before `finishedAt` is the one the marker
 * belongs under. The verdict itself is not on the message — it is on the run,
 * where the transcript endpoint already sends it — so a reloaded history shows
 * the marker exactly as the live run did.
 *
 * `noticed` is what makes that safe. A delegate's run and a room member's both
 * end on the same `stopped: 'max_turns'` and write into windows that overlap
 * the run the owner is watching, but they say nothing in the transcript — so
 * there is no closing line to sit under, and they are not marked.
 */
function budgetStops(shown: readonly ChatMessage[], runs: readonly ChatRun[]): Map<string, ChatRun> {
  /*
   * Both ends or nothing. A run row with no start (an unpaired `run.finished`
   * from an older installation) has no window, and a message with no timestamp
   * is in nobody's window — either one, matched loosely, hangs the marker off
   * whatever message happens to be last and tells the owner a reply that
   * finished cleanly ran out of budget.
   */
  const windowed = runs.filter((run) => run.startedAt !== null && run.finishedAt !== null);
  const holds = (run: ChatRun, message: ChatMessage): boolean =>
    message.at !== '' && message.at >= run.startedAt! && message.at <= run.finishedAt!;
  /** A run that started later and ended earlier: a delegate, or a member the coordinator asked. */
  const inside = (inner: ChatRun, outer: ChatRun): boolean =>
    inner !== outer
    && inner.startedAt! >= outer.startedAt!
    && inner.finishedAt! <= outer.finishedAt!
    && (inner.startedAt! > outer.startedAt! || inner.finishedAt! < outer.finishedAt!);

  const out = new Map<string, ChatRun>();
  for (const run of windowed) {
    if (run.stopped !== 'max_turns' && run.stopped !== 'max_tokens') continue;
    // Only a run that said so, and only a run that knows which one it is. An
    // unnamed finish event is paired positionally by the server, onto the
    // first run still open — which in a room is somebody else's.
    if (run.noticed !== true || run.runId === null) continue;
    let last: ChatMessage | null = null;
    for (const message of shown) {
      if (message.role !== 'assistant' || !holds(run, message)) continue;
      last = message;
    }
    // A room's runs overlap: the coordinator's spans the member's. A message
    // written inside a nested run is that run's, so the outer run's budget is
    // not what the owner is looking at, and nothing is said under it.
    if (last === null || windowed.some((other) => inside(other, run) && holds(other, last!))) continue;
    if (!out.has(last.id)) out.set(last.id, run);
  }
  return out;
}

/** The quiet line under the last message of a run that ran out of budget. */
export function budgetLine(run: ChatRun): string {
  if (run.stopped === 'max_tokens') return 'Length limit reached · answer cut off';
  const steps = run.turns;
  // No count rather than a made-up one: an unpaired finish event carries none.
  if (steps === null) return 'Turn budget reached';
  return `Turn budget reached · ${steps} ${steps === 1 ? 'step' : 'steps'}`;
}

/** A block worth a line on screen. A bare tool result is not one. */
function isVisible(block: ChatBlock): boolean {
  if (block.type === 'text' || block.type === 'thinking') return block.text.trim() !== '';
  return block.type === 'tool_use' || block.type === 'attachment' || block.type === 'approval_result';
}

/**
 * What the owner approved, and how it went: the tool's own label, the state the
 * action row holds, and the result itself one click away. Built out of the tool
 * row's parts because that is what it is — the other half of a call the thread
 * already shows.
 */
function ApprovalResult({ block }: { block: Extract<ChatBlock, { type: 'approval_result' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ok = block.state === 'succeeded';
  return (
    <div className="wb-approval" data-open={open || undefined}>
      <button
        type="button"
        className="wb-tool"
        data-ok={ok}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="wb-tool-mark" data-ok={ok ? 'true' : 'false'} aria-hidden="true" />
        <span className="wb-tool-label">{block.name === '' ? 'Approved action' : labelFor(block.name)}</span>
        <span className="wb-tool-elapsed">{block.state}</span>
        <ArrowIcon />
      </button>
      {open ? <pre className="wb-approval-output mono">{stringify(block.output)}</pre> : null}
    </div>
  );
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

/** How many diff lines a row unfolds before it points at the canvas for the rest. */
const INLINE_DIFF_LINES = 40;

export function ToolRow({
  label,
  tool,
  ok,
  running,
  elapsed,
  opens,
  onOpen,
  status,
  gist = null,
  body = null,
}: {
  label: string;
  tool: string;
  ok: boolean | null;
  running: boolean;
  elapsed?: number;
  /** Whether the canvas has a panel for this call. */
  opens: boolean;
  onOpen: () => void;
  status?: string;
  /** One line out of the call's arguments — the path, the command. See `gist.ts`. */
  gist?: string | null;
  /** What the row unfolds into, in place. See `tool-body.ts`. */
  body?: ToolBody | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const marks = (
    <>
      {running ? (
        <span className="wb-pulse" aria-hidden="true" />
      ) : (
        <span className="wb-tool-mark" data-ok={status === 'Awaiting approval' || status === 'approved' || status === 'executing' ? 'pending' : ok === false ? 'false' : 'true'} aria-hidden="true" />
      )}
      <span className="wb-tool-label">{label}</span>
      {gist ? <span className="wb-tool-gist mono" data-testid="tool-gist">{gist}</span> : null}
      {elapsed === undefined ? null : <span className="wb-tool-elapsed">{elapsed}s</span>}
      {status || ok === false ? <span className="wb-tool-elapsed">{status ?? 'failed'}</span> : null}
    </>
  );
  const flags = {
    'data-ok': ok === null ? undefined : ok,
    'data-running': running,
    'data-gist': gist ? true : undefined,
  };

  /*
   * A row with something to read in place is two controls, not one: the row
   * itself unfolds it, and the arrow at the end still opens the canvas. Two
   * buttons side by side rather than one inside the other — a button in a
   * button is not a thing a keyboard or a screen reader can use.
   */
  if (body) {
    return (
      <div className="wb-toolcall" data-open={open || undefined}>
        <div className="wb-tool" data-split="true" {...flags}>
          <button
            type="button"
            className="wb-tool-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronIcon />
            {marks}
          </button>
          {opens ? (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button type="button" className="wb-tool-open" aria-label="Open on the canvas" onClick={onOpen}>
                  <ArrowIcon />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="ui-tip" sideOffset={6}>
                  <span className="ui-tip-title">Open on the canvas</span>
                  <span className="ui-tip-hint mono">{tool}</span>
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          ) : null}
        </div>
        {open ? <ToolBodyView body={body} onOpen={opens ? onOpen : null} /> : null}
      </div>
    );
  }

  if (!opens) {
    return (
      <span className="wb-tool" data-static="true" {...flags}>
        {marks}
      </span>
    );
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className="wb-tool" {...flags} onClick={onOpen}>
          {marks}
          <ArrowIcon />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="ui-tip" sideOffset={6}>
          <span className="ui-tip-title">Open on the canvas</span>
          <span className="ui-tip-hint mono">{tool}</span>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * A row, unfolded: a change as its diff, a command as what it printed. Bounded
 * — the chat is a column to scroll past, and the whole of it is on the canvas.
 */
function ToolBodyView({ body, onOpen }: { body: ToolBody; onOpen: (() => void) | null }): JSX.Element {
  const more = onOpen ? { label: 'Open on the canvas', onClick: onOpen } : undefined;
  if (body.kind === 'diff') {
    return (
      <div className="wb-tool-body" data-kind="diff" data-testid="tool-body">
        <DiffLines text={body.diff} limit={INLINE_DIFF_LINES} {...(more ? { more } : {})} />
      </div>
    );
  }
  const facts = [
    body.exitCode === null ? null : `exit ${body.exitCode}`,
    body.elapsedMs === null ? null : seconds(body.elapsedMs),
  ].filter((fact): fact is string => fact !== null);
  return (
    <div className="wb-tool-body" data-kind="command" data-testid="tool-body">
      <div className="wb-tool-command">
        <code className="mono">{body.command}</code>
        {facts.length > 0 ? (
          <span className="wb-tool-facts" data-failed={body.exitCode !== null && body.exitCode !== 0 ? true : undefined}>
            {facts.join(' · ')}
          </span>
        ) : null}
      </div>
      {body.output ? <pre className="wb-tool-output">{body.output}</pre> : null}
    </div>
  );
}

/** `1234` → `1.2s`; under a second stays in milliseconds. */
function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function ChevronIcon(): JSX.Element {
  return (
    <svg
      className="wb-tool-chevron"
      width="11"
      height="11"
      viewBox="0 0 11 11"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.8 4.2 5.5 6.9l2.7-2.7" />
    </svg>
  );
}

function ArrowIcon(): JSX.Element {
  return (
    <svg
      className="wb-tool-arrow"
      width="13"
      height="13"
      viewBox="0 0 13 13"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.8 2.6 9 6.5l-4.2 3.9" />
    </svg>
  );
}

function findResult(
  messages: ChatMessage[],
  toolUseId: string,
): Extract<ChatBlock, { type: 'tool_result' }> | null {
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_result' && block.toolUseId === toolUseId) return block;
    }
  }
  return null;
}

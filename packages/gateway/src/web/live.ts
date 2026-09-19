/**
 * The answer as it is being written, for whoever is watching.
 *
 * The event log is durable and ordered, and every fact about a run goes
 * through it — except this one. A model writing at thirty tokens a second
 * would be thirty rows a second, read back by a poll, for text that is
 * replaced by the real message the moment the turn ends. So the pieces live
 * here, in memory, per conversation: a page that is connected gets each one
 * as it arrives, a page that connects mid-turn gets what has been written so
 * far, and a page that reconnects after the turn is over gets nothing — the
 * message is in the transcript, where the log already told it to look.
 *
 * A *turn* is one provider call. A run with tool calls has several, and each
 * settles (its text is now in the transcript) before the next begins; the page
 * keys what it draws by turn so a settle never erases the next turn's words.
 */
import type { CompletionDelta } from '@buddi/runtime';

export interface LiveTurn {
  runId: string;
  turn: number;
  text: string;
  thinking: string;
  startedAt: number;
}

export type LiveFrame =
  | { event: 'live'; data: { runId: string; turn: number; kind: 'text' | 'thinking'; text: string } }
  | { event: 'live.settle'; data: { runId: string; turn: number } }
  | { event: 'live.snapshot'; data: LiveTurn };

type Listener = (frame: LiveFrame) => void;

export class LiveTurns {
  readonly #turns = new Map<string, LiveTurn>();
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #counters = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** A piece of this conversation's current turn. Opens the turn if none is open. */
  append(conversationId: string, runId: string, delta: CompletionDelta): void {
    let turn = this.#turns.get(conversationId);
    if (!turn || turn.runId !== runId) {
      const n = (this.#counters.get(conversationId) ?? 0) + 1;
      this.#counters.set(conversationId, n);
      turn = { runId, turn: n, text: '', thinking: '', startedAt: this.#now() };
      this.#turns.set(conversationId, turn);
    }
    if (delta.kind === 'text') turn.text += delta.text;
    else turn.thinking += delta.text;
    this.#emit(conversationId, { event: 'live', data: { runId, turn: turn.turn, kind: delta.kind, text: delta.text } });
  }

  /** The turn's words are in the transcript now; whatever was live is done. */
  settle(conversationId: string, runId: string): void {
    const turn = this.#turns.get(conversationId);
    if (!turn || turn.runId !== runId) return;
    this.#turns.delete(conversationId);
    this.#emit(conversationId, { event: 'live.settle', data: { runId, turn: turn.turn } });
  }

  /** The run is over, however it ended. Nothing may stay half-written. */
  end(conversationId: string, runId: string): void {
    this.settle(conversationId, runId);
    this.#counters.delete(conversationId);
  }

  snapshot(conversationId: string): LiveTurn | null {
    const turn = this.#turns.get(conversationId);
    return turn ? { ...turn } : null;
  }

  subscribe(conversationId: string, listener: Listener): () => void {
    let set = this.#listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.#listeners.set(conversationId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.#listeners.delete(conversationId);
    };
  }

  #emit(conversationId: string, frame: LiveFrame): void {
    const set = this.#listeners.get(conversationId);
    if (!set) return;
    for (const listener of set) {
      try { listener(frame); } catch { /* a dead page is the stream's problem, not the run's */ }
    }
  }
}

/**
 * The run stream.
 *
 * `EventSource` would almost do — it reconnects and it resends
 * `Last-Event-ID` — but it cannot carry the session's headers and it cannot be
 * driven from a test without a real socket. So the loop is written out: fetch,
 * read, parse, dispatch; on any end, wait and reconnect **from the last id we
 * actually handled**, which is the part that makes "never lose events" true
 * rather than hopeful.
 *
 * The id is only advanced once an event has been dispatched. A stream that
 * dies mid-frame therefore replays that frame instead of skipping it, and the
 * consumer is expected to be idempotent — which it is, because every handler
 * either refreshes the transcript or sets state by id.
 */
import type { ChatEvent, ChatEventName } from './types';

const KNOWN: ChatEventName[] = [
  'run.started',
  'tool.called',
  'tool.result',
  'message.appended',
  'awaiting-approval',
  'run.finished',
  'live',
  'live.settle',
  'live.snapshot',
  'attention',
  'ping',
];

export type StreamStatus = 'connecting' | 'open' | 'closed';

export interface StreamOptions {
  url: string;
  onEvent: (event: ChatEvent) => void;
  onStatus?: (status: StreamStatus) => void;
  /** Injectable for tests; defaults to the page's own `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `setTimeout`. */
  wait?: (ms: number) => Promise<void>;
  retryMs?: number;
  lastEventId?: string | null;
}

export interface StreamHandle {
  close: () => void;
  /** The last id dispatched — what a reconnect will resume from. */
  lastEventId: () => string | null;
}

/**
 * Parse whatever has arrived so far. Returns the complete events and the
 * leftover text, which is prepended to the next chunk: an event split across
 * two TCP reads is one event, not two broken ones.
 */
export function parseSse(buffer: string): { events: ChatEvent[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, '\n');
  const frames = normalised.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: ChatEvent[] = [];

  for (const frame of frames) {
    let id: string | null = null;
    let name = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') name = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0 && name === 'message') continue;
    events.push({
      id,
      name: (KNOWN as string[]).includes(name) ? (name as ChatEventName) : 'ping',
      data: safeParse(dataLines.join('\n')),
    });
  }
  return { events, rest };
}

function safeParse(text: string): Record<string, unknown> {
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { value: text };
  }
}

/**
 * Open the stream and keep it open. The returned handle closes it for good —
 * a close is not a drop, and does not reconnect.
 */
export function openChatStream(options: StreamOptions): StreamHandle {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryMs = options.retryMs ?? 1500;

  let lastEventId = options.lastEventId ?? null;
  let stopped = false;
  let controller: AbortController | null = null;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      options.onStatus?.('connecting');
      controller = new AbortController();
      try {
        const response = await fetchImpl(options.url, {
          credentials: 'same-origin',
          signal: controller.signal,
          headers: {
            Accept: 'text/event-stream',
            // The whole point of the retry: pick up where we stopped.
            ...(lastEventId === null ? {} : { 'Last-Event-ID': lastEventId }),
          },
        });
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
        options.onStatus?.('open');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSse(buffer);
          buffer = rest;
          for (const event of events) {
            options.onEvent(event);
            // Advanced *after* the handler, so a crash replays rather than skips.
            if (event.id !== null) lastEventId = event.id;
          }
          if (stopped) break;
        }
      } catch {
        // A drop is ordinary. Say nothing, wait, resume.
      }
      if (stopped) break;
      options.onStatus?.('closed');
      await wait(retryMs);
    }
    options.onStatus?.('closed');
  };

  void loop();

  return {
    close: () => {
      stopped = true;
      controller?.abort();
    },
    lastEventId: () => lastEventId,
  };
}

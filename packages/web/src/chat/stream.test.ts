/**
 * The run stream, and the promise it makes: no event is lost to a dropped
 * connection.
 *
 * The test drops the socket mid-run and asserts the reconnect carries
 * `Last-Event-ID` set to the last event actually *handled* — not the last one
 * received, which is the difference between resuming and skipping.
 */
import { describe, expect, it } from 'vitest';
import { openChatStream, parseSse } from './stream';
import type { ChatEvent } from './types';

/** A response whose body is the given frames, then end-of-stream. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('parsing', () => {
  it('reads id, event and data', () => {
    const { events, rest } = parseSse('id: 4\nevent: tool.called\ndata: {"name":"x"}\n\n');
    expect(rest).toBe('');
    expect(events).toEqual([{ id: '4', name: 'tool.called', data: { name: 'x' } }]);
  });

  it('holds a half-arrived frame back rather than emitting a broken one', () => {
    const first = parseSse('id: 1\nevent: ping\ndata: {}\n\nid: 2\nevent: run.st');
    expect(first.events).toHaveLength(1);
    expect(first.rest).toBe('id: 2\nevent: run.st');

    const second = parseSse(`${first.rest}arted\ndata: {"runId":"r1"}\n\n`);
    expect(second.events).toEqual([{ id: '2', name: 'run.started', data: { runId: 'r1' } }]);
  });

  it('ignores comments and survives data that is not JSON', () => {
    const { events } = parseSse(': keep-alive\nid: 9\nevent: ping\ndata: not json\n\n');
    expect(events[0]).toMatchObject({ id: '9', data: { value: 'not json' } });
  });

  it('joins multi-line data, as the protocol says', () => {
    const { events } = parseSse('event: message.appended\ndata: {"text":\ndata: "hi"}\n\n');
    expect(events[0]?.data).toEqual({ text: 'hi' });
  });
});

describe('resuming', () => {
  it('reconnects from the last event it handled', async () => {
    const seen: ChatEvent[] = [];
    const headers: Array<Record<string, string>> = [];
    let connection = 0;

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      connection += 1;
      if (connection === 1) {
        // Two events, then the socket dies.
        return sseResponse(['id: 1\nevent: run.started\ndata: {}\n\n', 'id: 7\nevent: tool.called\ndata: {"name":"a"}\n\n']);
      }
      return sseResponse(['id: 8\nevent: run.finished\ndata: {}\n\n']);
    }) as unknown as typeof fetch;

    const waits: number[] = [];
    const handle = openChatStream({
      url: '/api/chat/conversations/c1/stream',
      onEvent: (event) => seen.push(event),
      fetchImpl,
      retryMs: 0,
      wait: async (ms) => {
        waits.push(ms);
        // Stop after the second connection has been served, so the loop ends.
        if (waits.length >= 2) handle.close();
      },
    });

    await settle();

    // The first connection asked for nothing; the second resumed from 7.
    expect(headers[0]?.['Last-Event-ID']).toBeUndefined();
    expect(headers[1]?.['Last-Event-ID']).toBe('7');

    // And every event arrived, in order, exactly once.
    expect(seen.map((event) => event.id)).toEqual(['1', '7', '8']);
    expect(handle.lastEventId()).toBe('8');
    handle.close();
  });

  it('starts from an id it was given, for a page that reloaded mid-run', async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return sseResponse(['id: 12\nevent: ping\ndata: {}\n\n']);
    }) as unknown as typeof fetch;

    const handle = openChatStream({
      url: '/stream',
      onEvent: () => {},
      fetchImpl,
      retryMs: 0,
      lastEventId: '11',
      wait: async () => handle.close(),
    });
    await settle();
    expect(headers[0]?.['Last-Event-ID']).toBe('11');
    handle.close();
  });

  it('treats a failed connection as a drop and retries', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection refused');
      return sseResponse(['id: 3\nevent: ping\ndata: {}\n\n']);
    }) as unknown as typeof fetch;

    const statuses: string[] = [];
    let closed = 0;
    const handle = openChatStream({
      url: '/stream',
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
      fetchImpl,
      retryMs: 0,
      wait: async () => {
        closed += 1;
        if (closed >= 2) handle.close();
      },
    });
    await settle();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(statuses).toContain('open');
    handle.close();
  });
});

/** Let every queued microtask and stream read finish. */
async function settle(): Promise<void> {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
}

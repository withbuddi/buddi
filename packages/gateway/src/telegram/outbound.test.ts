/**
 * Outbound tests: what a run's outcome becomes on Telegram. A fake Bot API
 * records every call; no network, no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SEND_BYTES, TelegramApiError, type TelegramApi } from './api.js';
import type { ArtifactRow, ArtifactStore } from './attachments.js';
import {
  CHART_TEXT,
  MAX_FILES_OUT,
  StreamedAnswer,
  canvasAfterCall,
  csvName,
  landAnswer,
  sendRunExtras,
  tableCsv,
  tableMessage,
  tableText,
  type CanvasView,
} from './outbound.js';

interface Call {
  method: string;
  args: any[];
}

/** A Bot API that records calls; `fail` decides per call whether it throws. */
function fakeApi(fail?: (method: string, args: any[]) => Error | undefined) {
  const calls: Call[] = [];
  let nextId = 500;
  const record = (method: string) => async (...args: any[]) => {
    calls.push({ method, args });
    const err = fail?.(method, args);
    if (err) throw err;
    if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') return nextId++;
    return undefined;
  };
  const api = {
    sendMessage: record('sendMessage'),
    editMessageText: record('editMessageText'),
    sendPhoto: record('sendPhoto'),
    sendDocument: record('sendDocument'),
    sendChatAction: record('sendChatAction'),
    deleteMessage: record('deleteMessage'),
  } as unknown as TelegramApi;
  return { api, calls };
}

function row(id: string, over: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id,
    kind: 'document' as ArtifactRow['kind'],
    mime: 'application/pdf',
    filename: `${id}.pdf`,
    sizeBytes: 12,
    sha256: 'x',
    storagePath: `a/${id}`,
    caption: null,
    createdAt: null,
    ...over,
  };
}

function store(rows: ArtifactRow[]): ArtifactStore {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    save: async () => {
      throw new Error('not here');
    },
    describe: async (id) => byId.get(id) ?? null,
    load: async (id) => {
      const r = byId.get(id);
      return r ? { mime: r.mime, data: Buffer.from(`bytes of ${id}`).toString('base64') } : null;
    },
  };
}

const log = (): void => {};

function table(rows: (string | number | null)[][], title = 'Spending'): CanvasView {
  return {
    renderer: 'table',
    title,
    data: { columns: [{ label: 'Item' }, { label: 'Amount', unit: 'currency' }], rows },
  };
}

describe('files out', () => {
  it('sends documents in order, pictures as photos, each under its name', async () => {
    const { api, calls } = fakeApi();
    const artifacts = store([
      row('a1', { filename: 'report.pdf' }),
      row('a2', { filename: 'chart.png', mime: 'image/png' }),
      row('a3', { filename: 'data.csv', mime: 'text/csv' }),
    ]);
    await sendRunExtras({ api, log, artifacts }, 'c1', { artifacts: ['a1', 'a2', 'a3'] });

    expect(calls.map((c) => c.method)).toEqual(['sendDocument', 'sendPhoto', 'sendDocument']);
    expect(calls[0]?.args[2]).toEqual({ filename: 'report.pdf', contentType: 'application/pdf' });
    expect(calls[1]?.args[2]).toMatchObject({ filename: 'chart.png', caption: 'chart.png', contentType: 'image/png' });
    expect(calls[2]?.args[2]).toEqual({ filename: 'data.csv', contentType: 'text/csv' });
    expect(Buffer.isBuffer(calls[0]?.args[1])).toBe(true);
  });

  it('names a file that has no name after its type', async () => {
    const { api, calls } = fakeApi();
    const id = '0123abcd-0000-4000-8000-000000000000';
    await sendRunExtras({ api, log, artifacts: store([row(id, { filename: null })]) }, 'c1', { artifacts: [id] });
    expect(calls[0]?.args[2].filename).toBe('file-0123abcd.pdf');
  });

  it('refuses a file over 50 MB in one sentence naming the Files page', async () => {
    const { api, calls } = fakeApi();
    const artifacts = store([row('big', { filename: 'video.mov', sizeBytes: MAX_SEND_BYTES + 1 })]);
    await sendRunExtras({ api, log, artifacts, publicOrigin: 'https://buddi.example.ts.net' }, 'c1', { artifacts: ['big'] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('sendMessage');
    expect(calls[0]?.args[1]).toMatch(/^video\.mov is .*over Telegram's 50 MB limit; it is on the dashboard, under Files\.$/m);
    expect(calls[0]?.args[1]).toContain('https://buddi.example.ts.net/#/files');
  });

  it('gives no link when the dashboard is on this computer only', async () => {
    const { api, calls } = fakeApi();
    const artifacts = store([row('big', { sizeBytes: MAX_SEND_BYTES + 1 })]);
    await sendRunExtras({ api, log, artifacts }, 'c1', { artifacts: ['big'] });
    expect(calls[0]?.args[1]).not.toContain('http');
  });

  it('keeps going past a file that fails, and says so', async () => {
    const { api, calls } = fakeApi((method, args) =>
      method === 'sendDocument' && args[2].filename === 'a1.pdf' ? new Error('boom') : undefined,
    );
    await sendRunExtras({ api, log, artifacts: store([row('a1'), row('a2')]) }, 'c1', { artifacts: ['a1', 'a2'] });
    expect(calls.map((c) => c.method)).toEqual(['sendDocument', 'sendMessage', 'sendDocument']);
    expect(calls[1]?.args[1]).toContain('I could not send a1.pdf here');
  });

  it(`sends at most ${MAX_FILES_OUT} and counts the rest`, async () => {
    const { api, calls } = fakeApi();
    const rows = Array.from({ length: MAX_FILES_OUT + 2 }, (_, i) => row(`f${i}`));
    await sendRunExtras({ api, log, artifacts: store(rows) }, 'c1', { artifacts: rows.map((r) => r.id) });
    expect(calls.filter((c) => c.method === 'sendDocument')).toHaveLength(MAX_FILES_OUT);
    expect(calls.at(-1)?.args[1]).toBe('And 2 more files on the dashboard, under Files.');
  });
});

describe('tables and charts', () => {
  it('sends a table that fits as monospace HTML, escaped', async () => {
    const { api, calls } = fakeApi();
    await sendRunExtras({ api, log }, 'c1', { canvas: table([['Rent <flat>', 1200], ['Food & drink', 310.5]]) });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('sendMessage');
    expect(calls[0]?.args[2]).toEqual({ parseMode: 'HTML' });
    const html = calls[0]?.args[1] as string;
    expect(html.startsWith('Spending\n<pre>')).toBe(true);
    expect(html).toContain('Rent &lt;flat&gt;');
    expect(html).toContain('Food &amp; drink');
    expect(html.endsWith('</pre>')).toBe(true);
  });

  it('aligns columns, numbers to the right', () => {
    const view = table([['Rent', 1200], ['Food', 31]]) as Extract<CanvasView, { renderer: 'table' }>;
    expect(tableText(view)).toBe(['Item  Amount', '----  ------', 'Rent    1200', 'Food      31'].join('\n'));
  });

  it('sends a table too long for one message as a CSV named after its title', async () => {
    const { api, calls } = fakeApi();
    const rows = Array.from({ length: 200 }, (_, i) => [`A fairly long item name number ${i}`, i * 10]);
    const view = table(rows, 'Q3 / spending');
    expect(tableMessage(view as any)).toBeUndefined();
    await sendRunExtras({ api, log }, 'c1', { canvas: view });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('sendDocument');
    expect(calls[0]?.args[2]).toEqual({ filename: 'Q3 spending.csv', contentType: 'text/csv' });
    const csv = (calls[0]?.args[1] as Buffer).toString('utf8');
    expect(csv.split('\r\n')[0]).toBe('Item,Amount');
    expect(csv.split('\r\n')[1]).toBe('A fairly long item name number 0,0');
  });

  it('quotes CSV cells that need it', () => {
    const view = table([['a, "b"', 1]]) as any;
    expect(tableCsv(view)).toBe('Item,Amount\r\n"a, ""b""",1\r\n');
    expect(csvName(undefined)).toBe('table.csv');
  });

  it('answers a chart with one line, and the dashboard link when there is one', async () => {
    const chart: CanvasView = {
      renderer: 'timeseries',
      data: { x: ['2026-09-01'], series: [{ label: 'Cash', values: [1] }] },
    };
    const bare = fakeApi();
    await sendRunExtras({ api: bare.api, log }, 'c1', { canvas: chart });
    expect(bare.calls[0]?.args[1]).toBe(CHART_TEXT);

    const linked = fakeApi();
    await sendRunExtras({ api: linked.api, log, publicOrigin: 'https://buddi.example.ts.net' }, 'c1', { canvas: chart });
    expect(linked.calls[0]?.args[1]).toBe(`${CHART_TEXT}\nhttps://buddi.example.ts.net/`);
  });

  it('sends the view before the files', async () => {
    const { api, calls } = fakeApi();
    await sendRunExtras({ api, log, artifacts: store([row('a1')]) }, 'c1', { canvas: table([['x', 1]]), artifacts: ['a1'] });
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendDocument']);
  });

  it('keeps the last view a run drew, and none after a clear', () => {
    const first = canvasAfterCall(undefined, 'canvas.show', table([['a', 1]]));
    expect(first?.renderer).toBe('table');
    expect(canvasAfterCall(first, 'finance.read', {})).toBe(first);
    expect(canvasAfterCall(first, 'canvas.show', { renderer: 'bars' })).toBe(first); // invalid: ignored
    expect(canvasAfterCall(first, 'canvas.clear', {})).toBeUndefined();
  });
});

describe('landing the answer', () => {
  it('edits the message with the first 4,096 and sends the rest split at paragraphs', async () => {
    const { api, calls } = fakeApi();
    const para = (c: string) => `${c.repeat(3000)}`;
    const text = [para('a'), para('b'), para('c')].join('\n\n');
    await landAnswer({ api, log }, 'c1', 42, text, { inline_keyboard: [[{ text: 'Go', callback_data: 'x' }]] });

    expect(calls.map((c) => c.method)).toEqual(['editMessageText', 'sendMessage', 'sendMessage']);
    expect(calls[0]?.args[2]).toBe(para('a'));
    expect(calls[0]?.args[3]).toEqual({});
    expect(calls[1]?.args[1]).toBe(para('b'));
    expect(calls[2]?.args[1]).toBe(para('c'));
    // The keyboard sits under the last part.
    expect(calls[2]?.args[2].replyMarkup).toBeDefined();
    expect(calls[1]?.args[2].replyMarkup).toBeUndefined();
  });

  it('sends a fresh message when the edit is refused', async () => {
    const { api, calls } = fakeApi((m) => (m === 'editMessageText' ? new TelegramApiError(m, 400, 'message to edit not found') : undefined));
    await landAnswer({ api, log }, 'c1', 42, 'the answer');
    expect(calls.map((c) => c.method)).toEqual(['editMessageText', 'sendMessage']);
    expect(calls[1]?.args[1]).toBe('the answer');
  });
});

describe('streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const edits = (calls: Call[]) => calls.filter((c) => c.method === 'editMessageText').map((c) => c.args[2]);

  it('types first, sends the first chunk at once, then edits at most every 1.5 s', async () => {
    const { api, calls } = fakeApi();
    const stream = new StreamedAnswer({ api, log }, 'c1', undefined, { typing: true, now: () => Date.now() });
    expect(calls[0]?.method).toBe('sendChatAction');

    stream.push('Hello');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.method === 'sendMessage').map((c) => c.args[1])).toEqual(['Hello']);

    stream.push(' there');
    await vi.advanceTimersByTimeAsync(500);
    stream.push(', friend');
    await vi.advanceTimersByTimeAsync(500);
    expect(edits(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(edits(calls)).toEqual(['Hello there, friend']);

    stream.push('.');
    await vi.advanceTimersByTimeAsync(1499);
    expect(edits(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(edits(calls)).toEqual(['Hello there, friend', 'Hello there, friend.']);

    await stream.finish('Hello there, friend. Done.');
    expect(edits(calls).at(-1)).toBe('Hello there, friend. Done.');
    // Every edit went to the message the first chunk created.
    expect(calls.filter((c) => c.method === 'editMessageText').every((c) => c.args[1] === 500)).toBe(true);
  });

  it('streams into the placeholder after the progress line has settled', async () => {
    const { api, calls } = fakeApi();
    const order: string[] = [];
    const stream = new StreamedAnswer({ api, log }, 'c1', 7, {
      now: () => Date.now(),
      takeOver: async () => {
        order.push('takeOver');
      },
    });
    stream.push('Hi');
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['takeOver']);
    expect(calls.map((c) => [c.method, c.args[1], c.args[2]])).toEqual([['editMessageText', 7, 'Hi']]);
  });

  it('cuts a growing answer at 4,000 characters with an ellipsis', async () => {
    const { api, calls } = fakeApi();
    const stream = new StreamedAnswer({ api, log }, 'c1', 7, { now: () => Date.now() });
    stream.push('x'.repeat(5000));
    await vi.advanceTimersByTimeAsync(0);
    const shown = edits(calls)[0] as string;
    expect(shown).toHaveLength(4000);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('backs off on a 429 by retry_after, skips edits meanwhile, and still lands the final text', async () => {
    let limited = true;
    const { api, calls } = fakeApi((method) => {
      if (method === 'editMessageText' && limited) {
        limited = false;
        return new TelegramApiError(method, 429, 'Too Many Requests: retry after 5', 5);
      }
      return undefined;
    });
    const stream = new StreamedAnswer({ api, log }, 'c1', 7, { now: () => Date.now() });
    stream.push('one');
    await vi.advanceTimersByTimeAsync(0); // refused: 429, back off 5 s
    expect(edits(calls)).toEqual(['one']);

    stream.push(' two');
    await vi.advanceTimersByTimeAsync(1500);
    stream.push(' three');
    await vi.advanceTimersByTimeAsync(2000);
    expect(edits(calls)).toEqual(['one']); // nothing tried during the back-off

    await vi.advanceTimersByTimeAsync(1500); // 5 s since the 429
    expect(edits(calls)).toEqual(['one', 'one two three']);

    await stream.finish('one two three four');
    expect(edits(calls).at(-1)).toBe('one two three four');
  });

  it('waits out a 429 on the final edit rather than losing the text', async () => {
    let refusals = 0;
    const { api, calls } = fakeApi((method) => {
      if (method === 'editMessageText' && refusals < 1) {
        refusals += 1;
        return new TelegramApiError(method, 429, 'Too Many Requests', 2);
      }
      return undefined;
    });
    const stream = new StreamedAnswer({ api, log }, 'c1', 7, { now: () => Date.now() });
    const done = stream.finish('the whole answer');
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(edits(calls)).toEqual(['the whole answer', 'the whole answer']);
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('splits a finished answer past 4,096 into the streamed message and new ones', async () => {
    const { api, calls } = fakeApi();
    const stream = new StreamedAnswer({ api, log }, 'c1', 7, { now: () => Date.now() });
    stream.push('a'.repeat(100));
    await vi.advanceTimersByTimeAsync(0);
    const whole = `${'a'.repeat(4000)}\n\n${'b'.repeat(3000)}`;
    await stream.finish(whole);
    expect(edits(calls).at(-1)).toBe('a'.repeat(4000));
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends.map((c) => c.args[1])).toEqual(['b'.repeat(3000)]);
  });

  it('never writes after finish, even with an edit scheduled', async () => {
    const { api, calls } = fakeApi();
    const stream = new StreamedAnswer({ api, log }, 'c1', 7, { now: () => Date.now() });
    stream.push('a');
    await vi.advanceTimersByTimeAsync(0);
    stream.push('b'); // scheduled for 1.5 s
    await stream.finish('final');
    await vi.advanceTimersByTimeAsync(5000);
    expect(edits(calls)).toEqual(['a', 'final']);
  });
});

describe('the Bot API calls outbound uses', () => {
  it('sendDocument uploads multipart with the name and type', async () => {
    const { TelegramApi } = await import('./api.js');
    let seen: { url: string; headers?: Record<string, string>; body?: string | Buffer } | undefined;
    const api = new TelegramApi({
      token: 't',
      fetch: async (url, init) => {
        seen = { url, headers: init?.headers, body: init?.body };
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 9 } }) };
      },
    });
    const id = await api.sendDocument('c1', Buffer.from('PDF'), { filename: 'a "b".pdf', contentType: 'application/pdf' });
    expect(id).toBe(9);
    expect(seen?.url.endsWith('/sendDocument')).toBe(true);
    expect(seen?.headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = String(seen?.body);
    expect(body).toContain('name="document"; filename="a _b_.pdf"');
    expect(body).toContain('Content-Type: application/pdf');
    expect(body).toContain('PDF');
  });

  it('reads retry_after off a 429', async () => {
    const { TelegramApi } = await import('./api.js');
    const api = new TelegramApi({
      token: 't',
      fetch: async () => ({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ ok: false, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }),
      }),
    });
    const err = await api.editMessageText('c1', 1, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.retryAfter).toBe(7);
  });

  it('sends HTML as one message and refuses what would not fit', async () => {
    const { TelegramApi } = await import('./api.js');
    const bodies: any[] = [];
    const api = new TelegramApi({
      token: 't',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }) };
      },
    });
    await api.sendMessage('c1', '<pre>x</pre>', { parseMode: 'HTML' });
    expect(bodies[0]).toMatchObject({ parse_mode: 'HTML', text: '<pre>x</pre>' });
    await expect(api.sendMessage('c1', 'x'.repeat(5000), { parseMode: 'HTML' })).rejects.toThrow(/over Telegram/);
  });
});

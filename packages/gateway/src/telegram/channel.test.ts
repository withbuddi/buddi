import { describe, expect, it } from 'vitest';
import { createTelegramChannel, unlinkSignatures } from './channel.js';
import { TelegramApi } from './api.js';

describe('agent signatures on Telegram', () => {
  it('stops Telegram linking "@handle:" to a public account, and changes nothing else', () => {
    expect(unlinkSignatures('@buddi: Hello')).toBe('@⁠buddi: Hello');
    expect(unlinkSignatures('While you were away: 2 things.\n\n- @buddi: Hello\n- buddi: Scheduled work did not run.'))
      .toBe('While you were away: 2 things.\n\n- @⁠buddi: Hello\n- buddi: Scheduled work did not run.');
    // A handle the owner typed in the text, or an address, is left alone.
    expect(unlinkSignatures('Ask @ledger about it; mail me at a@b.co')).toBe('Ask @ledger about it; mail me at a@b.co');
  });
});

describe('a report\'s voice note on Telegram (host API 1.27)', () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes('core.surface_identities')) {
        return { rows: [{ id: 'i1', owner_id: 'owner', surface: 'telegram', external_user_id: '7', external_chat_id: '42' }] };
      }
      return { rows: [] };
    },
  };
  const message = (over: Record<string, unknown> = {}) => ({
    id: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', kind: 'recap' as const, urgency: 'now' as const,
    title: 'Morning edition · Sat 3 Oct', text: 'Six stories from 15 outlets.', ...over,
  });

  it('sends the voice note first, then the text', async () => {
    const order: string[] = [];
    const channel = createTelegramChannel({
      pool,
      env: {},
      loadAudio: async (id) => (id === 'a1' ? { bytes: Buffer.from('OggS'), mime: 'audio/ogg' } : null),
      sendVoice: async (chatId, bytes, opts) => { order.push(`voice ${chatId} ${bytes.length} ${opts.contentType} ${opts.filename}`); },
      sendText: async (text) => { order.push(`text ${text.split('\n')[0]}`); return '42'; },
    });
    await channel.deliver(message({ audio: 'a1' }));
    expect(order).toEqual(['voice 42 4 audio/ogg voice.ogg', 'text Morning edition · Sat 3 Oct']);
  });

  it('sends the text alone when the voice note is gone or will not send, and says why in the log', async () => {
    const order: string[] = [];
    const logged: string[] = [];
    const channel = (send: () => Promise<unknown>) => createTelegramChannel({
      pool,
      env: {},
      log: (line) => logged.push(line),
      loadAudio: async (id) => (id === 'there' ? { bytes: Buffer.from('ID3'), mime: 'audio/mpeg' } : null),
      sendVoice: send,
      sendText: async (text) => { order.push(text.split('\n')[0]!); return '42'; },
    });
    await channel(async () => undefined).deliver(message({ audio: 'gone' }));
    await channel(async () => { throw new Error('Bad Request: file too big'); }).deliver(message({ audio: 'there' }));
    expect(order).toEqual(['Morning edition · Sat 3 Oct', 'Morning edition · Sat 3 Oct']);
    expect(logged).toEqual([
      expect.stringMatching(/voice note gone is not in Files; the text goes alone/),
      expect.stringMatching(/could not be sent \(Bad Request: file too big\); the text goes alone/),
    ]);
  });

  it('splits a long report cleanly at its paragraphs, with link previews off', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const api = new TelegramApi({ token: 't', fetch: async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200 });
    } });
    const paragraph = `${'Lomé port traffic rose 9% in the first half, the port authority says. '.repeat(8).trim()}\nTogo First · https://www.togofirst.com/fr/economie/x`;
    const text = Array.from({ length: 8 }, () => paragraph).join('\n\n');
    expect(text.length).toBeGreaterThan(4000);
    expect(text.length).toBeLessThanOrEqual(6000);
    await api.sendMessage('42', text);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.disable_web_page_preview).toBe(true);
      expect(String(call.text).endsWith('/x')).toBe(true);
    }
    expect(calls.map((c) => c.text).join('\n\n')).toBe(text);
  });
});

describe("a parked mission's card on Telegram (docs/browser.md, Missions)", () => {
  const QID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const question = (over: Record<string, unknown> = {}) => ({
    id: QID, agent_id: 'travel', conversation_id: 'c1', question: 'amazon.com needs your sign-in.',
    options: [{ id: 'option-1', label: 'Take over', hint: null, recommended: true }, { id: 'option-2', label: 'Save a login for next time', hint: null, recommended: false }],
    allow_other: true, created_at: new Date(), expires_at: new Date(Date.now() + 60 * 60_000), answered_at: null, answered_via: null, answer: null, ...over,
  });
  const card = { id: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', kind: 'question' as const, urgency: 'now' as const,
    title: 'Trip check: amazon.com needs your sign-in.', text: 'It waits an hour.', action: 'amazon.com needs your sign-in.', dedupeKey: `question:${QID}` };

  it("draws the card's options as its buttons, without the spelled-out action line", async () => {
    const sent: Array<{ text: string; markup: unknown }> = [];
    const channel = createTelegramChannel({
      pool: { query: async (sql: string) => ({ rows: sql.includes('core.questions') ? [question()] : [] }) },
      env: {},
      sendText: async (text, opts) => { sent.push({ text, markup: opts?.replyMarkup }); return '42'; },
    });
    await channel.deliver(card);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).not.toContain('→');
    expect(sent[0]!.markup).toEqual({ inline_keyboard: [
      [{ text: '★ Take over', callback_data: `q:${QID}:0` }],
      [{ text: 'Save a login for next time', callback_data: `q:${QID}:1` }],
    ] });
  });

  it('sends only the text once the card was answered', async () => {
    const sent: Array<{ text: string; markup: unknown }> = [];
    const channel = createTelegramChannel({
      pool: { query: async (sql: string) => ({ rows: sql.includes('core.questions') ? [question({ answered_at: new Date() })] : [] }) },
      env: {},
      sendText: async (text, opts) => { sent.push({ text, markup: opts?.replyMarkup }); return '42'; },
    });
    await channel.deliver(card);
    expect(sent[0]!.markup).toBeUndefined();
    expect(sent[0]!.text).toContain('→ amazon.com needs your sign-in.');
  });
});

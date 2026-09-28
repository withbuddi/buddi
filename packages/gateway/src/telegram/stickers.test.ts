/**
 * The thinking Blob's sticker set: made once, remembered, refused gracefully.
 * No network: a fake `fetch` answers the Bot API; web settings live in a Map.
 */
import { describe, expect, it } from 'vitest';
import type { Queryable } from '@buddi/core';
import { TelegramApi, type FetchLike } from './api.js';
import { MascotStickers, STICKERS_SETTING, readMascotTgs, stickerSetName } from './stickers.js';

function settingsDb(): Queryable & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('select value from core.web_settings')) {
        const key = String(params[0]);
        return { rows: values.has(key) ? [{ value: values.get(key) }] : [], rowCount: values.has(key) ? 1 : 0 } as never;
      }
      if (sql.includes('insert into core.web_settings')) {
        values.set(String(params[0]), JSON.parse(String(params[1])));
        return { rows: [], rowCount: 1 } as never;
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as Queryable & { values: Map<string, unknown> };
}

/** A Bot API that knows at most one set, made by `createNewStickerSet`. */
function stickerApi(opts: { refuseCreate?: boolean } = {}): { api: TelegramApi; calls: Array<{ method: string; body: string }> } {
  const calls: Array<{ method: string; body: string }> = [];
  let set: { name: string; title: string; stickers: Array<{ file_id: string; emoji: string }> } | null = null;
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const fetchLike: FetchLike = async (url, init) => {
    const method = url.split('/').pop() as string;
    const raw = init?.body as unknown;
    const body = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    calls.push({ method, body });
    if (method === 'getStickerSet') {
      return set ? reply(200, { ok: true, result: set }) : reply(400, { ok: false, description: 'Bad Request: STICKERSET_INVALID' });
    }
    if (method === 'createNewStickerSet') {
      if (opts.refuseCreate) return reply(400, { ok: false, description: 'Bad Request: PEER_ID_INVALID' });
      set = { name: 'x', title: 'buddi', stickers: [{ file_id: 'id-working', emoji: '⏳' }, { file_id: 'id-idle', emoji: '🙂' }] };
      return reply(200, { ok: true, result: true });
    }
    return reply(200, { ok: true, result: true });
  };
  return { api: new TelegramApi({ token: 'test-token', fetch: fetchLike }), calls };
}

const owner = async (): Promise<string> => '4242';

describe('the working sticker set', () => {
  it('is named for the bot, with Telegram\'s _by_ suffix', () => {
    expect(stickerSetName('buddi_agent_bot')).toBe('buddi_working_by_buddi_agent_bot');
    expect(stickerSetName('@buddi_agent_bot')).toBe('buddi_working_by_buddi_agent_bot');
  });

  it('ships both loops as .tgs in the gateway package', () => {
    for (const state of ['working', 'idle'] as const) {
      const tgs = readMascotTgs(state);
      expect(tgs.length).toBeGreaterThan(100);
      expect(tgs[0]).toBe(0x1f); // gzip
      expect(tgs[1]).toBe(0x8b);
    }
  });

  it('is created once, from the shipped .tgs, and its file_id reused', async () => {
    const db = settingsDb();
    const { api, calls } = stickerApi();
    const stickers = new MascotStickers({ api, pool: db, botUsername: 'buddi_agent_bot', ownerUserId: owner });

    const [a, b] = await Promise.all([stickers.fileId('working', '4242'), stickers.fileId('working', '4242')]);
    expect(a).toBe('id-working');
    expect(b).toBe('id-working');
    const creates = calls.filter((c) => c.method === 'createNewStickerSet');
    expect(creates).toHaveLength(1);
    const form = creates[0]!.body;
    expect(form).toContain('name="user_id"\r\n\r\n4242');
    expect(form).toContain('name="name"\r\n\r\nbuddi_working_by_buddi_agent_bot');
    expect(form).toContain('name="title"\r\n\r\nbuddi');
    expect(form).toContain('"sticker":"attach://sticker0","format":"animated","emoji_list":["⏳"]');
    expect(form).toContain('filename="sticker.tgs"');
    expect(db.values.get(STICKERS_SETTING)).toEqual({
      set: 'buddi_working_by_buddi_agent_bot',
      fileIds: { working: 'id-working', idle: 'id-idle' },
    });

    // A restart: a new instance reads the ids back and calls Telegram for nothing.
    const before = calls.length;
    const again = new MascotStickers({ api, pool: db, botUsername: 'buddi_agent_bot', ownerUserId: owner });
    expect(await again.fileId('working', '4242')).toBe('id-working');
    expect(calls.length).toBe(before);
  });

  it('remembers a refusal and falls back to text from then on', async () => {
    const db = settingsDb();
    const { api, calls } = stickerApi({ refuseCreate: true });
    const lines: string[] = [];
    const stickers = new MascotStickers({ api, pool: db, botUsername: 'buddi_agent_bot', ownerUserId: owner, log: (l) => lines.push(l) });
    expect(await stickers.fileId('working', '4242')).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/refused/);
    const before = calls.length;
    expect(await stickers.fileId('working', '4242')).toBeUndefined();
    expect(calls.length).toBe(before);
    expect((db.values.get(STICKERS_SETTING) as { refused?: string }).refused).toMatch(/PEER_ID_INVALID/);
  });

  it('asks nothing of Telegram while no owner is paired', async () => {
    const { api, calls } = stickerApi();
    const stickers = new MascotStickers({ api, pool: settingsDb(), botUsername: 'buddi_agent_bot', ownerUserId: async () => undefined });
    expect(await stickers.fileId('working', '1')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

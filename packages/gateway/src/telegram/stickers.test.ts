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

/** A Bot API that knows at most one set, made by `createNewStickerSet` from uploaded file_ids. */
function stickerApi(opts: { refuseCreate?: boolean; existing?: boolean } = {}): {
  api: TelegramApi;
  calls: Array<{ method: string; body: string }>;
  refuse: (on: boolean) => void;
} {
  const calls: Array<{ method: string; body: string }> = [];
  let refuseCreate = opts.refuseCreate ?? false;
  let uploads = 0;
  let set: { name: string; title: string; stickers: Array<{ file_id: string; emoji: string }> } | null = opts.existing
    ? { name: 'x', title: 'buddi', stickers: [{ file_id: 'old-working', emoji: '⏳' }, { file_id: 'old-idle', emoji: '🙂\uFE0F' }] }
    : null;
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const fetchLike: FetchLike = async (url, init) => {
    const method = url.split('/').pop() as string;
    const raw = init?.body as unknown;
    const body = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    calls.push({ method, body });
    if (method === 'getStickerSet') {
      return set ? reply(200, { ok: true, result: set }) : reply(400, { ok: false, description: 'Bad Request: STICKERSET_INVALID' });
    }
    if (method === 'uploadStickerFile') {
      uploads += 1;
      return reply(200, { ok: true, result: { file_id: `up-${uploads}` } });
    }
    if (method === 'createNewStickerSet') {
      if (refuseCreate) return reply(400, { ok: false, description: 'Bad Request: wrong file type' });
      set = { name: 'x', title: 'buddi', stickers: [{ file_id: 'id-working', emoji: '⏳' }, { file_id: 'id-idle', emoji: '🙂' }] };
      return reply(200, { ok: true, result: true });
    }
    return reply(200, { ok: true, result: true });
  };
  return { api: new TelegramApi({ token: 'test-token', fetch: fetchLike }), calls, refuse: (on) => { refuseCreate = on; } };
}

const owner = async (): Promise<string> => '4242';
const v = (version: string) => async (): Promise<string> => version;

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
    const lines: string[] = [];
    const stickers = new MascotStickers({ api, pool: db, botUsername: 'buddi_agent_bot', ownerUserId: owner, version: v('0.1.0'), log: (l) => lines.push(l) });

    const [a, b] = await Promise.all([stickers.fileId('working', '4242'), stickers.fileId('working', '4242')]);
    expect(a).toBe('id-working');
    expect(b).toBe('id-working');
    // Step one: each state's .tgs uploaded on its own, as the owner's file.
    const uploads = calls.filter((c) => c.method === 'uploadStickerFile');
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.body).toContain('name="user_id"\r\n\r\n4242');
      expect(upload.body).toContain('name="sticker_format"\r\n\r\nanimated');
      expect(upload.body).toContain('name="sticker"; filename="sticker.tgs"');
    }
    // Step two: the set names those file_ids; nothing is attached.
    const creates = calls.filter((c) => c.method === 'createNewStickerSet');
    expect(creates).toHaveLength(1);
    const form = creates[0]!.body;
    const order = calls.map((c) => c.method).filter((m) => m !== 'getStickerSet');
    expect(order).toEqual(['uploadStickerFile', 'uploadStickerFile', 'createNewStickerSet']);
    expect(form).toContain('name="user_id"\r\n\r\n4242');
    expect(form).toContain('name="name"\r\n\r\nbuddi_working_by_buddi_agent_bot');
    expect(form).toContain('name="title"\r\n\r\nbuddi');
    expect(form).toContain('"sticker":"up-1","format":"animated","emoji_list":["⏳"]');
    expect(form).toContain('"sticker":"up-2","format":"animated","emoji_list":["🙂"]');
    expect(form).not.toContain('attach://');
    expect(form).not.toContain('filename=');
    expect(lines).toEqual(['telegram: sticker set buddi_working_by_buddi_agent_bot ready']);
    expect(db.values.get(STICKERS_SETTING)).toEqual({
      set: 'buddi_working_by_buddi_agent_bot',
      fileIds: { working: 'id-working', idle: 'id-idle' },
    });

    // A restart: a new instance reads the ids back and calls Telegram for nothing.
    const before = calls.length;
    const again = new MascotStickers({ api, pool: db, botUsername: 'buddi_agent_bot', ownerUserId: owner, version: v('0.1.0') });
    expect(await again.fileId('working', '4242')).toBe('id-working');
    expect(calls.length).toBe(before);
  });

  it('reuses a set that already exists, creating nothing', async () => {
    const db = settingsDb();
    const { api, calls } = stickerApi({ existing: true });
    const stickers = new MascotStickers({ api, pool: db, botUsername: 'buddi_agent_bot', ownerUserId: owner, version: v('0.1.0') });
    expect(await stickers.fileId('working', '4242')).toBe('old-working');
    expect(await stickers.fileId('idle', '4242')).toBe('old-idle');
    expect(calls.map((c) => c.method)).toEqual(['getStickerSet']);
    expect(db.values.get(STICKERS_SETTING)).toEqual({ set: 'buddi_working_by_buddi_agent_bot', fileIds: { working: 'old-working', idle: 'old-idle' } });
  });

  it('honours a refusal for the version that met it, and retries on another', async () => {
    const db = settingsDb();
    const { api, calls, refuse } = stickerApi({ refuseCreate: true });
    const lines: string[] = [];
    const make = (version: string) => new MascotStickers({
      api, pool: db, botUsername: 'buddi_agent_bot', ownerUserId: owner, version: v(version),
      now: () => new Date('2026-09-27T10:00:00Z'), log: (l) => lines.push(l),
    });
    const first = make('0.1.0');
    expect(await first.fileId('working', '4242')).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/refused/);
    expect(db.values.get(STICKERS_SETTING)).toEqual({
      set: 'buddi_working_by_buddi_agent_bot',
      refused: 'Bad Request: wrong file type',
      refusedAt: '2026-09-27T10:00:00.000Z',
      refusedVersion: '0.1.0',
    });

    // Same version, same process or after a restart: text, and no call.
    let before = calls.length;
    expect(await first.fileId('working', '4242')).toBeUndefined();
    expect(await make('0.1.0').fileId('working', '4242')).toBeUndefined();
    expect(calls.length).toBe(before);

    // Another version tries once more; this time Telegram says yes.
    refuse(false);
    expect(await make('0.1.1').fileId('working', '4242')).toBe('id-working');
    expect(db.values.get(STICKERS_SETTING)).toEqual({ set: 'buddi_working_by_buddi_agent_bot', fileIds: { working: 'id-working', idle: 'id-idle' } });
    before = calls.length;
    expect(await make('0.1.1').fileId('idle', '4242')).toBe('id-idle');
    expect(calls.length).toBe(before);
  });

  it('counts each dev build as its own version', async () => {
    const db = settingsDb();
    const { api, calls } = stickerApi({ refuseCreate: true });
    const make = (version: string) => new MascotStickers({ api, pool: db, botUsername: 'buddi_agent_bot', ownerUserId: owner, version: v(version) });
    expect(await make('0.1.0-dev.abc1234').fileId('working', '4242')).toBeUndefined();
    const before = calls.length;
    expect(await make('0.1.0-dev.abc1234').fileId('working', '4242')).toBeUndefined();
    expect(calls.length).toBe(before);
    expect(await make('0.1.0-dev.def5678').fileId('working', '4242')).toBeUndefined();
    expect(calls.filter((c) => c.method === 'createNewStickerSet')).toHaveLength(2);
    expect((db.values.get(STICKERS_SETTING) as { refusedVersion?: string }).refusedVersion).toBe('0.1.0-dev.def5678');
  });

  it('treats a refusal stored before versions were recorded as expired', async () => {
    const db = settingsDb();
    db.values.set(STICKERS_SETTING, { set: 'buddi_working_by_buddi_agent_bot', refused: 'Bad Request: wrong file type' });
    const { api, calls } = stickerApi();
    const stickers = new MascotStickers({ api, pool: db, botUsername: 'buddi_agent_bot', ownerUserId: owner, version: v('0.1.0') });
    expect(await stickers.fileId('working', '4242')).toBe('id-working');
    expect(calls.filter((c) => c.method === 'createNewStickerSet')).toHaveLength(1);
  });

  it('asks nothing of Telegram while no owner is paired', async () => {
    const { api, calls } = stickerApi();
    const stickers = new MascotStickers({ api, pool: settingsDb(), botUsername: 'buddi_agent_bot', ownerUserId: async () => undefined, version: v('0.1.0') });
    expect(await stickers.fileId('working', '1')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

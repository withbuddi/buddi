/** The backup passphrase's one-time card and Telegram message, against an in-memory settings table. */
import type { Queryable } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import {
  acknowledgePassphrase,
  passphraseNotice,
  passphraseTelegramText,
  PASSPHRASE_NOTICE_KEY,
  readNoticeState,
  telegramPassphraseOnce,
  type PassphraseNoticeDeps,
} from './passphrase-notice.js';

const PHRASE = 'able acid actor adult afraid agent';

function settings(): Queryable & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    query: (async (text: string, values?: unknown[]) => {
      if (/^select value from core\.web_settings/.test(text)) {
        const key = values?.[0] as string;
        return { rows: rows.has(key) ? [{ value: rows.get(key) }] : [] };
      }
      if (/insert into core\.web_settings/.test(text)) {
        // The merge the real statement does in one step: stored || patch, or patch || stored when the stored fields win.
        const key = values?.[0] as string;
        const patch = JSON.parse(values?.[1] as string) as Record<string, unknown>;
        const stored = (rows.get(key) ?? {}) as Record<string, unknown>;
        const value = /excluded\.value \|\|/.test(text) ? { ...patch, ...stored } : { ...stored, ...patch };
        rows.set(key, value);
        return { rows: [{ value }] };
      }
      throw new Error(`unexpected query: ${text}`);
    }) as Queryable['query'],
  } as Queryable & { rows: Map<string, unknown> };
}

function deps(over: Partial<PassphraseNoticeDeps> & { archives?: Array<{ name: string; encrypted: boolean }> } = {}): PassphraseNoticeDeps & { sent: string[] } {
  const sent: string[] = [];
  return {
    pool: settings(),
    listBackups: async () => ({ status: 200, body: { archives: over.archives ?? [{ name: 'buddi-backup-20261004-030000.tar.gz.age', encrypted: true }] } }),
    passphrase: async () => ({ status: 200, body: { passphrase: PHRASE } }),
    sendTelegram: async (text) => { sent.push(text); },
    now: () => new Date('2026-10-04T10:00:00Z'),
    sent,
    ...over,
  };
}

describe('Home\'s passphrase card', () => {
  it('shows nothing before the first encrypted backup', async () => {
    expect(await passphraseNotice(deps({ archives: [] }))).toEqual({ show: false });
    expect(await passphraseNotice(deps({ archives: [{ name: 'buddi-backup-20261004-030000.tar.gz', encrypted: false }] }))).toEqual({ show: false });
  });

  it('shows the six words after it, and keeps showing them on every visit until "I saved it"', async () => {
    const d = deps();
    expect(await passphraseNotice(d)).toEqual({ show: true, passphrase: PHRASE });
    expect(await passphraseNotice(d)).toEqual({ show: true, passphrase: PHRASE });
    // Telegram going out is not the owner saving them: the card stays.
    await telegramPassphraseOnce(d);
    expect(await passphraseNotice(d)).toEqual({ show: true, passphrase: PHRASE });
    await acknowledgePassphrase(d);
    expect(await passphraseNotice(d)).toEqual({ show: false });
    expect(await readNoticeState(d.pool)).toMatchObject({ acknowledgedAt: '2026-10-04T10:00:00.000Z' });
  });

  it('keeps the first acknowledgement time, and stays gone after more backups', async () => {
    const d = deps();
    await acknowledgePassphrase(d);
    await acknowledgePassphrase({ ...d, now: () => new Date('2026-10-05T10:00:00Z') });
    expect((await readNoticeState(d.pool)).acknowledgedAt).toBe('2026-10-04T10:00:00.000Z');
    expect(await passphraseNotice(d)).toEqual({ show: false });
  });

  it('with a PIN set, says the card is due without sending the words', async () => {
    expect(await passphraseNotice(deps(), { words: false })).toEqual({ show: true, needsPin: true });
    const d = deps();
    await acknowledgePassphrase(d);
    expect(await passphraseNotice(d, { words: false })).toEqual({ show: false });
  });

  it('"I saved it" pressed while the Telegram message is on its way is not lost', async () => {
    const pool = settings();
    let d: PassphraseNoticeDeps;
    d = deps({
      pool,
      sendTelegram: async () => {
        // The owner acknowledges on Home while the send is in flight.
        await acknowledgePassphrase(d);
      },
    });
    expect(await telegramPassphraseOnce(d)).toBe('sent');
    const state = await readNoticeState(pool);
    expect(state).toMatchObject({ acknowledgedAt: '2026-10-04T10:00:00.000Z', telegram: 'sent' });
    expect(await passphraseNotice(d)).toEqual({ show: false });
  });

  it('never stores the words themselves', async () => {
    const d = deps();
    await telegramPassphraseOnce(d);
    await acknowledgePassphrase(d);
    expect(JSON.stringify((d.pool as unknown as { rows: Map<string, unknown> }).rows.get(PASSPHRASE_NOTICE_KEY))).not.toContain('able');
  });
});

describe('the Telegram message', () => {
  it('goes once, after the first encrypted backup, and says to delete it', async () => {
    const d = deps();
    expect(await telegramPassphraseOnce(deps({ archives: [] }))).toBe('waiting');
    expect(await telegramPassphraseOnce(d)).toBe('sent');
    expect(await telegramPassphraseOnce(d)).toBe('done');
    expect(d.sent).toEqual([passphraseTelegramText(PHRASE)]);
    expect(d.sent[0]).toContain(PHRASE);
    expect(d.sent[0]).toMatch(/delete this message/);
  });

  it('nothing paired: nothing sent, now or later', async () => {
    const d = deps({ sendTelegram: async () => { throw Object.assign(new Error('no chat'), { code: 'owner-not-paired' }); } });
    expect(await telegramPassphraseOnce(d)).toBe('not-paired');
    expect(await telegramPassphraseOnce({ ...d, sendTelegram: async () => { throw new Error('should not send'); } })).toBe('done');
  });

  it('a send that failed is tried again', async () => {
    const d = deps({ sendTelegram: async () => { throw new Error('502'); } });
    expect(await telegramPassphraseOnce(d)).toBe('failed');
    const sent: string[] = [];
    expect(await telegramPassphraseOnce({ ...d, sendTelegram: async (text) => { sent.push(text); } })).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

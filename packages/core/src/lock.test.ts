import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCK_BACKGROUND, PIN_FIRST_WAIT_MS, PIN_MAX_WAIT_MS, hashPin, isValidPin, pinWaitMs, readLockSettings, verifyPin, writeLockSettings } from './lock.js';
import type { Queryable } from './owner.js';

describe('the lock screen PIN', () => {
  it('accepts four to eight digits and nothing else', () => {
    for (const pin of ['1234', '00000000', '2468']) expect(isValidPin(pin)).toBe(true);
    for (const pin of ['123', '123456789', '12a4', ' 1234', '', 1234, null]) expect(isValidPin(pin)).toBe(false);
  });

  it('keeps a salted scrypt hash, never the PIN, and checks it', async () => {
    const a = await hashPin('2468');
    const b = await hashPin('2468');
    expect(a).toMatch(/^scrypt\$15\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toContain('2468');
    expect(a).not.toBe(b);
    expect(await verifyPin('2468', a)).toBe(true);
    expect(await verifyPin('2469', a)).toBe(false);
    expect(await verifyPin('', a)).toBe(false);
    expect(await verifyPin('2468', 'plain')).toBe(false);
    expect(await verifyPin('2468', 'scrypt$30$8$1$c2FsdHNhbHQ$aGFzaA')).toBe(false);
    await expect(hashPin('12')).rejects.toThrow(/four to eight/);
  });

  it('waits nothing for four wrong tries, then 30 seconds doubling up to an hour', () => {
    expect([0, 1, 4].map(pinWaitMs)).toEqual([0, 0, 0]);
    expect(pinWaitMs(5)).toBe(PIN_FIRST_WAIT_MS);
    expect(pinWaitMs(6)).toBe(PIN_FIRST_WAIT_MS * 2);
    expect(pinWaitMs(8)).toBe(PIN_FIRST_WAIT_MS * 8);
    expect(pinWaitMs(40)).toBe(PIN_MAX_WAIT_MS);
  });
});

/** core.web_settings as a map: enough for the lock settings' read and write. */
function settingsTable(start?: unknown): { db: Queryable; stored: () => unknown } {
  let value: unknown = start;
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('select')) return { rows: value === undefined ? [] : [{ value }] };
      value = JSON.parse(params[1] as string);
      return { rows: [] };
    },
  } as unknown as Queryable;
  return { db, stored: () => value };
}

describe('the lock screen background', () => {
  it('is Earth until the owner picks one', async () => {
    expect(DEFAULT_LOCK_BACKGROUND).toBe('earth');
    expect((await readLockSettings(settingsTable().db)).background).toBe('earth');
    expect((await readLockSettings(settingsTable({ delayMinutes: 15 }).db)).background).toBe('earth');
    expect((await readLockSettings(settingsTable({ background: 'nebula' }).db)).background).toBe('earth');
  });

  it('keeps a background picked before Earth existed, but not the old default every write carried', async () => {
    expect((await readLockSettings(settingsTable({ delayMinutes: 5, background: 'dusk' }).db)).background).toBe('dusk');
    expect((await readLockSettings(settingsTable({ delayMinutes: 5, background: 'image' }).db)).background).toBe('image');
    // Before version 2 a delay change wrote `field` too: it says nothing about a pick.
    expect((await readLockSettings(settingsTable({ delayMinutes: 15, background: 'field' }).db)).background).toBe('earth');
  });

  it('keeps Buddi once the owner picks it, through later changes to the delay', async () => {
    const table = settingsTable({ delayMinutes: 5, background: 'field' });
    const before = await readLockSettings(table.db);
    await writeLockSettings(table.db, { ...before, background: 'field' });
    expect(table.stored()).toMatchObject({ background: 'field', v: 2 });
    const picked = await readLockSettings(table.db);
    expect(picked.background).toBe('field');
    await writeLockSettings(table.db, { ...picked, delayMinutes: 60 });
    expect(await readLockSettings(table.db)).toMatchObject({ background: 'field', delayMinutes: 60 });
  });
});

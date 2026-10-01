import { describe, expect, it } from 'vitest';
import { PIN_FIRST_WAIT_MS, PIN_MAX_WAIT_MS, hashPin, isValidPin, pinWaitMs, verifyPin } from './lock.js';

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

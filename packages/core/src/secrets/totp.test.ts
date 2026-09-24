/**
 * The TOTP code (owner-secrets §4): RFC 6238's own vectors, base32 decoding
 * that tolerates how a human pastes a seed, and the step clock.
 */
import { describe, expect, it } from 'vitest';
import { TOTP_STEP_SECONDS, currentTotp, decodeBase32, totpCode, totpCounter, totpValidFor } from './totp.js';

/** RFC 6238 appendix B's seed: ASCII "12345678901234567890". */
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('decodeBase32', () => {
  it('decodes the RFC seed to the bytes it names', () => {
    expect(decodeBase32(RFC_SEED).toString('utf8')).toBe('12345678901234567890');
  });

  it('tolerates the ways a seed is pasted: spaces, dashes, no padding, lower case', () => {
    expect(decodeBase32('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq ====')).toEqual(decodeBase32(RFC_SEED));
  });

  it('refuses a character that is not base32', () => {
    expect(() => decodeBase32('GEZDGNBV1')).toThrow(/not base32/);
    expect(() => decodeBase32('')).toThrow(/empty/);
  });
});

describe('totpCode', () => {
  // The six-digit values the RFC's eight-digit vectors truncate to.
  const cases: Array<{ at: number; code: string }> = [
    { at: 59, code: '287082' },
    { at: 1_111_111_109, code: '081804' },
    { at: 1_234_567_890, code: '005924' },
    { at: 2_000_000_000, code: '279037' },
  ];
  for (const { at, code } of cases) {
    it(`answers ${code} at T=${at}`, () => {
      expect(totpCode(RFC_SEED, Math.floor(at / TOTP_STEP_SECONDS))).toBe(code);
    });
  }

  it('is stable within a step and steps with the clock', () => {
    const a = currentTotp(RFC_SEED, new Date(30_500));
    const b = currentTotp(RFC_SEED, new Date(59_000)); // same 30-second window
    const c = currentTotp(RFC_SEED, new Date(60_500)); // the next one
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe('the step clock', () => {
  it('floors to the step', () => {
    expect(totpCounter(new Date(59_999))).toBe(1);
    expect(totpCounter(new Date(60_000))).toBe(2);
  });

  it('says how long the current code still works', () => {
    expect(totpValidFor(new Date(59_000))).toBe(1);
    expect(totpValidFor(new Date(0))).toBe(TOTP_STEP_SECONDS);
  });
});
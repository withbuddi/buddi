/**
 * A TOTP code from a seed (docs/specs/owner-secrets.md §4, "TOTP seeds").
 *
 * A secret marked TOTP keeps its value as the seed; what is delivered is the
 * current code. The owner turns TOTP on per secret, off by default, because it
 * merges the password and the second factor into one thing buddi holds — and
 * every code generated is logged, which `use.ts` does with the use row.
 *
 * RFC 6238 over HMAC-SHA1, the parameters every authenticator app ships:
 * SHA-1, a 30-second step, six digits, a base32 seed with or without its
 * padding and separators.
 */
import { createHmac } from 'node:crypto';

/** The step, in seconds: 30, as every authenticator app defaults. */
export const TOTP_STEP_SECONDS = 30;

/** Six digits, the default the spec's use (a login form) assumes. */
export const TOTP_DIGITS = 6;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode RFC 4648 base32, tolerating spaces, dashes and missing padding. */
export function decodeBase32(seed: string): Buffer {
  const clean = seed.toUpperCase().replaceAll(' ', '').replaceAll('-', '').replaceAll('=', '');
  if (clean.length === 0) throw new Error('the TOTP seed is empty');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) throw new Error(`the TOTP seed has a character that is not base32: ${JSON.stringify(ch)}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The unix time a code is asked for, floored to the step. */
export function totpCounter(at: Date, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(at.getTime() / 1000 / stepSeconds);
}

/** The dynamic truncation and modulo of RFC 4226 §5.3. */
export function totpCode(seed: string, counter: number, digits = TOTP_DIGITS): string {
  const key = decodeBase32(seed);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** The code now (or at `at`), padded to six digits. */
export function currentTotp(seed: string, at: Date = new Date()): string {
  return totpCode(seed, totpCounter(at));
}

/** Seconds until the current code stops working — for the card, and the tests. */
export function totpValidFor(at: Date = new Date(), stepSeconds = TOTP_STEP_SECONDS): number {
  return stepSeconds - Math.floor((at.getTime() / 1000) % stepSeconds);
}
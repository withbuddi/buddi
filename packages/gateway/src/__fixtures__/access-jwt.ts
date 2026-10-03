/**
 * A fake Cloudflare Access team for tests: an RSA key pair, the JWKS its
 * `/cdn-cgi/access/certs` would answer, and a signer for assertions.
 *
 * Nothing here touches the network: `transport` answers the certs URL from
 * memory and counts how often it was asked.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { HttpTransport, TransportResponse } from '@buddi/runtime';

export const TEAM = 'buddi-test.cloudflareaccess.com';
export const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
export const OWNER_EMAIL = 'owner@example.com';

export interface FakeTeam {
  kid: string;
  privateKey: KeyObject;
  /** How many times the certs URL was fetched. */
  fetches: () => number;
  /** Make the next fetches fail (a network error) or answer an HTTP status. */
  fail: (how: 'network' | number | null) => void;
  /** Rotate: a fresh key under a fresh kid, published from now on. */
  rotate: () => void;
  transport: HttpTransport;
  sign: (claims?: Record<string, unknown>, header?: Record<string, unknown>, key?: KeyObject) => string;
}

function keyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function response(status: number, body: unknown): TransportResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

export function fakeTeam(opts: { now: () => Date; team?: string } = { now: () => new Date() }): FakeTeam {
  const team = opts.team ?? TEAM;
  let current = { kid: 'kid-1', ...keyPair() };
  let count = 0;
  let failing: 'network' | number | null = null;
  const t: FakeTeam = {
    get kid() { return current.kid; },
    get privateKey() { return current.privateKey; },
    fetches: () => count,
    fail: (how) => { failing = how; },
    rotate: () => { current = { kid: `kid-${Number(current.kid.split('-')[1]) + 1}`, ...keyPair() }; },
    transport: async (url) => {
      count += 1;
      if (failing === 'network') throw new Error('connect ECONNREFUSED');
      if (typeof failing === 'number') return response(failing, { error: 'nope' });
      if (url !== `https://${team}/cdn-cgi/access/certs`) return response(404, {});
      const jwk = current.publicKey.export({ format: 'jwk' });
      return response(200, { keys: [{ ...jwk, kid: current.kid, alg: 'RS256', use: 'sig' }], public_cert: { kid: current.kid } });
    },
    sign: (claims = {}, header = {}, key) => {
      const at = Math.floor(opts.now().getTime() / 1000);
      const h = { alg: 'RS256', kid: current.kid, typ: 'JWT', ...header };
      const p = {
        aud: [AUD],
        email: OWNER_EMAIL,
        exp: at + 24 * 3600,
        iat: at,
        nbf: at,
        iss: `https://${team}`,
        type: 'app',
        identity_nonce: 'n0nce',
        sub: '7335d417-61da-459d-899c-0a01c76a2f94',
        country: 'FR',
        ...claims,
      };
      const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
      const data = `${enc(h)}.${enc(p)}`;
      const signature = createSign('RSA-SHA256').update(data).sign(key ?? current.privateKey).toString('base64url');
      return `${data}.${signature}`;
    },
  };
  return t;
}

/**
 * Ollama's device key: how `ollama login` talks to ollama.com with no key
 * anyone sees (buddi-planning specs/ollama-connect.md §2, read in the ollama
 * source: `auth/auth.go`, `api/client.go`, `server/cloud_proxy.go`).
 *
 * - The device holds an ed25519 key pair. The public key travels as the
 *   authorized_keys line `ssh-ed25519 <base64 SSH wire blob>`.
 * - The owner connects it once at
 *   `https://ollama.com/connect?name=<device>&key=<base64url of that line>`.
 * - Every request then carries `?ts=<unix seconds>` and
 *   `Authorization: <base64 wire blob>:<base64 ed25519 signature>`, where the
 *   signature is over `<METHOD>,<path>?<query with ts>`.
 *
 * Pure: no I/O but the one `/api/me` call in `OllamaConnectProtocol`, which
 * takes its transport.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { defaultHttpTransport, type HttpTransport } from './transport.js';

/** The only host a device key is ever sent to. */
export const OLLAMA_CLOUD_ORIGIN = 'https://ollama.com';
export const OLLAMA_CONNECT_URL = 'https://ollama.com/connect';

export interface OllamaDeviceKey {
  /** PKCS8 PEM. Lives in the vault, never leaves the gateway. */
  privateKey: string;
  /** The authorized_keys line, `ssh-ed25519 AAAA…`. What "Show key" on ollama.com shows. */
  publicKey: string;
}

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

/** The SSH wire blob of an ed25519 public key, base64: the part after `ssh-ed25519 `. */
function wireBlob(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { crv?: string; x?: string };
  if (jwk.crv !== 'Ed25519' || !jwk.x) throw new Error('Not an ed25519 key.');
  return Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(Buffer.from(jwk.x, 'base64url'))]).toString('base64');
}

function privateKeyObject(privateKeyPem: string): KeyObject {
  let key: KeyObject;
  try { key = createPrivateKey(privateKeyPem); } catch { throw new Error('Invalid Ollama device key.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid Ollama device key.');
  return key;
}

export function generateOllamaDeviceKey(): OllamaDeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: `ssh-ed25519 ${wireBlob(publicKey)}`,
  };
}

/** The authorized_keys line for a private key. */
export function ollamaPublicKey(privateKeyPem: string): string {
  return `ssh-ed25519 ${wireBlob(createPublicKey(privateKeyObject(privateKeyPem)))}`;
}

/** The page the owner presses Connect on. `name` is what ollama.com lists the device as. */
export function ollamaConnectUrl(publicKey: string, name: string): string {
  const key = Buffer.from(publicKey.trim()).toString('base64url');
  return `${OLLAMA_CONNECT_URL}?name=${encodeURIComponent(name)}&key=${key}`;
}

/** Is this URL on ollama.com? A device key is never sent anywhere else. */
export function isOllamaCloud(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'ollama.com' && (parsed.port === '' || parsed.port === '443');
  } catch {
    return false;
  }
}

/**
 * Sign one request: the URL to send (with `ts` added) and the Authorization
 * header. The challenge is what Go's `url.RequestURI()` gives after
 * `query.Set("ts", …)` and `query.Encode()` (keys sorted).
 */
export function signOllamaRequest(
  method: string,
  url: string,
  privateKeyPem: string,
  nowMs: number = Date.now(),
): { url: string; authorization: string } {
  if (!isOllamaCloud(url)) throw new Error('An Ollama device key is only sent to ollama.com.');
  const key = privateKeyObject(privateKeyPem);
  const target = new URL(url);
  const query = new URLSearchParams(target.search);
  query.set('ts', String(Math.floor(nowMs / 1000)));
  query.sort();
  target.search = query.toString();
  const challenge = `${method.toUpperCase()},${target.pathname}${target.search}`;
  const signature = sign(null, Buffer.from(challenge), key).toString('base64');
  return { url: target.toString(), authorization: `${wireBlob(createPublicKey(key))}:${signature}` };
}

export type OllamaWhoami =
  | { state: 'connected'; username: string }
  | { state: 'waiting' }
  | { state: 'failed'; message: string };

/** The user ID `/api/me` answers for a key nobody connected yet. */
const NO_USER = '00000000-0000-0000-0000-000000000000';

/**
 * One cheap signed request: `POST /api/me`. A connected key answers with a
 * real user ID and the account's name; a key nobody connected yet answers 200
 * with the all-zero ID and empty fields; a bad signature answers 401.
 */
export class OllamaConnectProtocol {
  constructor(readonly transport: HttpTransport = defaultHttpTransport, readonly now = Date.now) {}
  async whoami(privateKeyPem: string): Promise<OllamaWhoami> {
    const signed = signOllamaRequest('POST', `${OLLAMA_CLOUD_ORIGIN}/api/me`, privateKeyPem, this.now());
    let res;
    try {
      res = await this.transport(signed.url, {
        method: 'POST', headers: { authorization: signed.authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000), maxBytes: 65536,
      });
    } catch {
      // Offline for a moment is not an answer; the next poll asks again.
      return { state: 'waiting' };
    }
    if (res.status === 401) return { state: 'failed', message: 'ollama.com refused this device key. Check this computer’s clock, then connect again.' };
    if (!res.ok) return { state: 'waiting' };
    let data: unknown;
    try { data = await res.json(); } catch { return { state: 'waiting' }; }
    const record = (data ?? {}) as Record<string, unknown>;
    const id = typeof record.ID === 'string' ? record.ID : typeof record.id === 'string' ? record.id : '';
    if (!id || id === NO_USER) return { state: 'waiting' };
    const name = typeof record.Name === 'string' ? record.Name : typeof record.name === 'string' ? record.name : '';
    const username = name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100);
    return { state: 'connected', username };
  }

  /**
   * Ask ollama.com to forget this device: signed `DELETE /api/user/keys/<key>`,
   * as `ollama signout` does. Best effort; true only when ollama.com said yes.
   */
  async forget(privateKeyPem: string): Promise<boolean> {
    const key = Buffer.from(ollamaPublicKey(privateKeyPem)).toString('base64url');
    const signed = signOllamaRequest('DELETE', `${OLLAMA_CLOUD_ORIGIN}/api/user/keys/${key}`, privateKeyPem, this.now());
    try {
      const res = await this.transport(signed.url, {
        method: 'DELETE', headers: { authorization: signed.authorization }, signal: AbortSignal.timeout(10_000), maxBytes: 65536,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

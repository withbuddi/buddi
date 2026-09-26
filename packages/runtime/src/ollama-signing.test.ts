import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  OllamaConnectProtocol, generateOllamaDeviceKey, isOllamaCloud, ollamaConnectUrl, ollamaPublicKey, signOllamaRequest,
} from './ollama-signing.js';
import type { HttpTransport } from './transport.js';

/*
 * Captured from ollama's own code path: Go, `ssh.ParsePrivateKey` then
 * `Signer.Sign`, exactly as `auth.Sign` does, with the seed bytes 1..32.
 * ollama.com accepted signatures from this key (specs/ollama-connect.md §2).
 */
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const VECTOR_PEM = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]), format: 'der', type: 'pkcs8' })
  .export({ format: 'pem', type: 'pkcs8' }).toString();
const VECTOR_PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZk';
const VECTOR_KEY_PARAM = 'c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSUhtMVZpNlA1bFQ1UUhpeEV1aXBpNmVRSDRVNjVwVysxK0Rqa1F1dEJKWms';
const VECTOR_ME = 'AAAAC3NzaC1lZDI1NTE5AAAAIHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZk:C3v4yPFoL6KDZMYdbgWneZG92xCNMRnBOd/Z9WA9poFbUcbtVOUGTIplmlOF5bt92H6vcU/PEp0O2ViEZM3PDA==';
const VECTOR_CHAT = 'AAAAC3NzaC1lZDI1NTE5AAAAIHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZk:b9ZnLz5GzNTy3oe9X6EnpaVCDzLLdvqo85VVfQ+0pLfJbh04o2B8gAcT9EZtuLwqav5ES9YG5zjxX3Wnk7qODw==';
const TS = 1_790_000_000_000;

it('matches the vectors captured from the ollama client', () => {
  expect(ollamaPublicKey(VECTOR_PEM)).toBe(VECTOR_PUBLIC);
  expect(signOllamaRequest('POST', 'https://ollama.com/api/me', VECTOR_PEM, TS)).toEqual({
    url: 'https://ollama.com/api/me?ts=1790000000', authorization: VECTOR_ME,
  });
  expect(signOllamaRequest('post', 'https://ollama.com/v1/chat/completions', VECTOR_PEM, TS + 999).authorization).toBe(VECTOR_CHAT);
});

it('builds the connect URL the way ollama does', () => {
  const url = new URL(ollamaConnectUrl(VECTOR_PUBLIC, 'buddi on studio'));
  expect(url.origin + url.pathname).toBe('https://ollama.com/connect');
  expect(url.searchParams.get('name')).toBe('buddi on studio');
  expect(url.searchParams.get('key')).toBe(VECTOR_KEY_PARAM);
});

it('round-trips a fresh key: the signature verifies against the public key it presents', () => {
  const key = generateOllamaDeviceKey();
  expect(key.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=*$/);
  expect(ollamaPublicKey(key.privateKey)).toBe(key.publicKey);
  const signed = signOllamaRequest('GET', 'https://ollama.com/v1/models?after=b&a=1', key.privateKey, TS);
  // Other query keys stay, ts joins them, and the keys are sorted as Go's Encode sorts them.
  expect(signed.url).toBe('https://ollama.com/v1/models?a=1&after=b&ts=1790000000');
  const [blob, signature] = signed.authorization.split(':');
  expect(`ssh-ed25519 ${blob}`).toBe(key.publicKey);
  const ok = verify(null, Buffer.from('GET,/v1/models?a=1&after=b&ts=1790000000'), createPublicKey(key.privateKey), Buffer.from(signature!, 'base64'));
  expect(ok).toBe(true);
});

it('never signs for a host other than ollama.com', () => {
  const key = generateOllamaDeviceKey();
  for (const url of ['https://evil.example/api/me', 'http://ollama.com/api/me', 'https://ollama.com.evil.example/v1', 'https://api.ollama.com/v1', 'https://ollama.com:8443/v1']) {
    expect(isOllamaCloud(url)).toBe(false);
    expect(() => signOllamaRequest('POST', url, key.privateKey)).toThrow('only sent to ollama.com');
  }
  expect(() => signOllamaRequest('POST', 'https://ollama.com/api/me', 'not a key')).toThrow('Invalid Ollama device key');
});

function transport(status: number, data: unknown) {
  return vi.fn<HttpTransport>().mockResolvedValue({ ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => null },
    json: async () => data, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) });
}

it('reads connected, waiting and failed from one signed /api/me', async () => {
  const connected = transport(200, { Name: 'amen', Email: 'x@example.com' });
  expect(await new OllamaConnectProtocol(connected, () => TS).whoami(VECTOR_PEM)).toEqual({ state: 'connected', username: 'amen' });
  const [url, init] = connected.mock.calls[0]!;
  expect(url).toBe('https://ollama.com/api/me?ts=1790000000');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ authorization: VECTOR_ME });
  expect(JSON.stringify(init)).not.toContain('PRIVATE KEY');
  expect(await new OllamaConnectProtocol(transport(200, { Name: '' })).whoami(VECTOR_PEM)).toEqual({ state: 'waiting' });
  expect(await new OllamaConnectProtocol(transport(502, {})).whoami(VECTOR_PEM)).toEqual({ state: 'waiting' });
  expect(await new OllamaConnectProtocol(vi.fn<HttpTransport>().mockRejectedValue(new Error('offline'))).whoami(VECTOR_PEM)).toEqual({ state: 'waiting' });
  expect((await new OllamaConnectProtocol(transport(401, { error: 'invalid credentials' })).whoami(VECTOR_PEM)).state).toBe('failed');
});

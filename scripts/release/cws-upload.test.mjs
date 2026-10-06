import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { explain, main } from './cws-upload.mjs';

const TOKEN = '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKlMnOpQrStUvWxYz';
const ENV = { CLIENT_ID: 'client.apps.googleusercontent.com', CLIENT_SECRET: 'GOCSPX-secret', REFRESH_TOKEN: TOKEN };

function zip() {
  const dir = mkdtempSync(join(tmpdir(), 'cws-'));
  const file = join(dir, 'buddi-extension-0.1.0-pre.47.zip');
  writeFileSync(file, 'zip');
  return file;
}

function respond(...answers) {
  const fetch = vi.fn();
  for (const [status, body] of answers) fetch.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function logged() {
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
  return lines;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('explain', () => {
  test('keeps only the explaining fields, never tokens', () => {
    const body = { access_token: TOKEN, refresh_token: TOKEN, error: { code: 400, message: 'Nope', status: 'FAILED_PRECONDITION' } };
    expect(explain(body)).toBe('code: 400; message: Nope; status: FAILED_PRECONDITION');
  });

  test('a token or literal secret inside an allowed field is redacted', () => {
    expect(explain({ message: `bad ${TOKEN}` })).toBe('message: bad [redacted]');
    expect(explain({ message: 'client GOCSPX-short is wrong' }, ['GOCSPX-short'])).toBe('message: client [redacted] is wrong');
  });
});

describe('main', () => {
  test('a refused refresh token prints the OAuth reason and no secret', async () => {
    respond([400, { error: 'invalid_grant', error_description: 'Bad Request' }]);
    const lines = logged();
    expect(await main(['--source', zip(), '--extension-id', 'abc', '--publish'], ENV)).toBe(1);
    const out = lines.join('\n');
    expect(out).toContain('Sign-in refused (HTTP 400). error: invalid_grant; error_description: Bad Request');
    for (const s of Object.values(ENV)) expect(out).not.toContain(s);
  });

  test('an upload the store refuses names its item error', async () => {
    respond(
      [200, { access_token: 'ya29.short' }],
      [200, { uploadState: 'FAILURE', itemError: [{ error_code: 'PKG_INVALID_VERSION_NUMBER', error_detail: 'Version must increase.' }] }],
    );
    const lines = logged();
    expect(await main(['--source', zip(), '--extension-id', 'abc', '--publish'], ENV)).toBe(1);
    expect(lines).toEqual(['Upload refused. uploadState: FAILURE; error_code: PKG_INVALID_VERSION_NUMBER; error_detail: Version must increase.']);
  });

  test('upload then publish pending review succeeds', async () => {
    const fetch = respond([200, { access_token: 'ya29.short' }], [200, { uploadState: 'SUCCESS' }], [200, { status: ['ITEM_PENDING_REVIEW'] }]);
    const lines = logged();
    expect(await main(['--source', zip(), '--extension-id', 'abc', '--publish'], ENV)).toBe(0);
    expect(lines).toEqual(['Uploaded buddi-extension-0.1.0-pre.47.zip.', 'Submitted for review.']);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('a network failure withholds its details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`boom ${TOKEN}`)));
    const lines = logged();
    expect(await main(['--source', zip(), '--extension-id', 'abc'], ENV)).toBe(1);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});

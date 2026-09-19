import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cleanupCodexSessions, openCodexSession, validateCodexCredential } from './codex-session.js';
import { initializeCodex } from './codex-rpc.js';

it('validates subscription envelopes without exposing their values in errors', () => {
  const value = JSON.stringify({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' }, auth_mode: 'chatgpt' });
  expect(validateCodexCredential(value)).toBe(value);
  for (const invalid of ['not-json-secret', '{}', JSON.stringify({ OPENAI_API_KEY: 'not-a-subscription' }), 'x'.repeat(70_000)]) {
    expect(() => validateCodexCredential(invalid)).toThrow('Invalid Codex subscription credential');
  }
});

it('recovers Keychain hex output and normalizes native credentials to one line', () => {
  const data = { tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id' }, auth_mode: 'chatgpt', last_refresh: '2026-09-19T00:00:00Z' };
  const pretty = JSON.stringify(data, null, 2) + '\n';
  const compact = JSON.stringify(data);
  expect(validateCodexCredential(pretty)).toBe(compact);
  expect(validateCodexCredential(Buffer.from(pretty).toString('hex'))).toBe(compact);
  expect(validateCodexCredential(Buffer.from(pretty).toString('hex').toUpperCase())).toBe(compact);
  expect(validateCodexCredential(compact)).toBe(compact);
});

it('rejects invalid hex envelopes without weakening credential validation or size limits', () => {
  for (const invalid of ['abc', 'ff', 'deadbeef', Buffer.from('{}').toString('hex'),
    Buffer.from(JSON.stringify({ tokens: { access_token: 'access' } })).toString('hex'),
    Buffer.from(JSON.stringify({ tokens: { access_token: 'access', refresh_token: 'refresh' }, OPENAI_API_KEY: 'secret' })).toString('hex'),
    Buffer.from(' '.repeat(65_537)).toString('hex')]) {
    expect(() => validateCodexCredential(invalid)).toThrow('Invalid Codex subscription credential. Reconnect the account.');
  }
});

it('cleans only recognizable private orphan profiles, never live profiles or symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddi-codex-cleanup-test-'));
  const create = async (name: string, parent: number, mode = 0o700) => {
    const dir = join(root, name); await mkdir(dir); await chmod(dir, mode);
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ version: 1, parent, child: null }));
    return dir;
  };
  try {
    const orphan = await create('buddi-codex-session-orphan', 2_000_000_000);
    const active = await create('buddi-codex-session-active', process.pid);
    const broad = await create('buddi-codex-session-public', 2_000_000_000, 0o755);
    const unrelated = await create('unrelated-directory', 2_000_000_000);
    await symlink(unrelated, join(root, 'buddi-codex-session-link'));
    await cleanupCodexSessions(root);
    await expect(lstat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const dir of [active, broad, unrelated]) expect((await lstat(dir)).isDirectory()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.env.BUDDI_TEST_CODEX !== '1')('starts the pinned native client with an empty isolated auth store and removes its profile', async () => {
  const session = await openCodexSession(null);
  const cwd = session.cwd;
  try {
    await initializeCodex(session.rpc);
    expect(await session.rpc.request('account/read', { refreshToken: false })).toMatchObject({ account: null });
    expect(await session.credential()).toBeNull();
    expect((await lstat(cwd)).mode & 0o077).toBe(0);
  } finally { await session.dispose(); }
  await expect(lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15_000);

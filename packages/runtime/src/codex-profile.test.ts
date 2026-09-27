import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cleanupCodexSessions, codexChildEnv, stageCodexProfile } from './codex-profile.js';
import type { CodexTokens } from './codex-oauth.js';

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

it('gives the child only an allowlisted environment with its own CODEX_HOME', () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'ambient';
  try {
    const env = codexChildEnv('/private/profile');
    expect(env.CODEX_HOME).toBe('/private/profile');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  } finally { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; }
});

it.skipIf(process.platform === 'win32')('stages tokens as a private auth.json, reads a refresh back, and removes the profile', async () => {
  const tokens: CodexTokens = { version: 1, state: 'ready', accessToken: 'access-1', refreshToken: 'refresh-1', accountId: 'acct-1', expiresAt: 1 };
  const staged = await stageCodexProfile(tokens);
  try {
    expect(staged.home.includes('buddi-codex-session-')).toBe(true);
    expect((await stat(staged.home)).mode & 0o077).toBe(0);
    const file = JSON.parse(await readFile(join(staged.home, 'auth.json'), 'utf8'));
    expect(file).toMatchObject({ auth_mode: 'chatgpt', tokens: { access_token: 'access-1', refresh_token: 'refresh-1', account_id: 'acct-1' } });
    await writeFile(join(staged.home, 'auth.json'), JSON.stringify({ ...file, tokens: { ...file.tokens, access_token: 'access-2', refresh_token: 'refresh-2' } }));
    expect(await staged.credential()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', accountId: 'acct-1' });
  } finally { await staged.dispose(); }
  await expect(stat(staged.home)).rejects.toThrow();
});

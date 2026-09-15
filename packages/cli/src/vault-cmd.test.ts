import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryVault } from '@buddi/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { plannedImports, runVault } from './vault-cmd.js';

const dirs: string[] = [];
function tmpEnvFile(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-vault-cmd-'));
  dirs.push(dir);
  const file = path.join(dir, '.env');
  writeFileSync(file, text);
  return file;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function capture(): { out: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), lines };
}

describe('buddi vault', () => {
  it('stores a secret read with echo off, and never prints it back', async () => {
    const vault = createMemoryVault();
    const { out, lines } = capture();
    const code = await runVault('set', 'TELEGRAM_BOT_TOKEN', {
      vault,
      promptSecret: async () => 'abc:123',
      out,
    });
    expect(code).toBe(0);
    expect(await vault.get('TELEGRAM_BOT_TOKEN')).toBe('abc:123');
    expect(lines.join('\n')).not.toContain('abc:123');
  });

  it('stores nothing when nothing is typed', async () => {
    const vault = createMemoryVault();
    const { out, lines } = capture();
    expect(await runVault('set', 'A_KEY', { vault, promptSecret: async () => '  ', out })).toBe(1);
    expect(await vault.list()).toEqual([]);
    expect(lines.join('\n')).toContain('Nothing entered');
  });

  it('answers get with set / not set, and only that', async () => {
    const vault = createMemoryVault({ seed: { A_KEY: 'a-real-secret' } });
    const { out, lines } = capture();
    expect(await runVault('get', 'A_KEY', { vault, out })).toBe(0);
    expect(await runVault('get', 'B_KEY', { vault, out })).toBe(1);
    expect(lines).toEqual(['A_KEY: set', 'B_KEY: not set']);
    expect(lines.join('\n')).not.toContain('a-real-secret');
  });

  it('deletes and lists', async () => {
    const vault = createMemoryVault({ seed: { A_KEY: 'x', B_KEY: 'y' } });
    const { out, lines } = capture();
    await runVault('list', undefined, { vault, out });
    expect(lines.join('\n')).toContain('A_KEY');
    expect(await runVault('delete', 'A_KEY', { vault, out })).toBe(0);
    expect(await runVault('delete', 'A_KEY', { vault, out })).toBe(1);
    expect(await vault.list()).toEqual(['B_KEY']);
  });

  it('says so when this machine has no vault at all', async () => {
    const { out, lines } = capture();
    expect(await runVault('list', undefined, { vault: undefined, env: { BUDDI_VAULT: 'none' }, out })).toBe(
      1,
    );
    expect(lines.join('\n')).toContain('No vault on this machine');
  });

  describe('import-env', () => {
    const envText = [
      'DATABASE_URL=postgres://buddi:buddi@localhost:5432/buddi',
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secret',
      'TELEGRAM_BOT_TOKEN=123:abc',
      'ANTHROPIC_API_KEY=',
      'GMAIL_APP_PASSWORD="<vault>"',
      '',
    ].join('\n');

    it('plans only the secrets that are actually there', () => {
      // DATABASE_URL is a known secret now: it *contains* the database
      // password, so `import-env` moves it like any other credential.
      expect(plannedImports(envText)).toEqual([
        'CLAUDE_CODE_OAUTH_TOKEN',
        'TELEGRAM_BOT_TOKEN',
        'DATABASE_URL',
      ]);
    });

    it('changes nothing when the owner says no', async () => {
      const file = tmpEnvFile(envText);
      const vault = createMemoryVault();
      const { out, lines } = capture();
      const code = await runVault('import-env', undefined, {
        vault,
        envFile: file,
        confirm: async () => false,
        out,
      });
      expect(code).toBe(1);
      expect(await vault.list()).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(envText);
      expect(lines.join('\n')).toContain('Nothing was changed');
    });

    it('moves secrets into the vault and leaves a quoted <vault> marker behind', async () => {
      const file = tmpEnvFile(envText);
      const vault = createMemoryVault();
      const confirm = vi.fn(async () => true);
      const { out, lines } = capture();

      expect(
        await runVault('import-env', undefined, { vault, envFile: file, confirm, out }),
      ).toBe(0);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(await vault.get('TELEGRAM_BOT_TOKEN')).toBe('123:abc');
      expect(await vault.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('sk-ant-oat01-secret');

      const rewritten = readFileSync(file, 'utf8');
      // Quoted: bare `<vault>` is a redirection, and `set -a; . ./.env` dies on it.
      expect(rewritten).toContain('TELEGRAM_BOT_TOKEN="<vault>"');
      expect(rewritten).toContain('CLAUDE_CODE_OAUTH_TOKEN="<vault>"');
      expect(rewritten).not.toMatch(/^[A-Z_]+=<vault>$/m);
      expect(rewritten).not.toContain('123:abc');
      expect(rewritten).not.toContain('sk-ant-oat01-secret');
      // The connection string goes too: the password is inside it, and buddi
      // assembles the URL from the vault at runtime.
      expect(await vault.get('DATABASE_URL')).toBe('postgres://buddi:buddi@localhost:5432/buddi');
      expect(rewritten).toContain('DATABASE_URL="<vault>"');
      expect(rewritten).not.toContain('postgres://buddi:buddi@');
      // Untouched: an empty one has nothing to move.
      expect(rewritten).toContain('ANTHROPIC_API_KEY=');
      expect(lines.join('\n')).toContain('Restart buddi');
    });

    it('leaves a .env that `sh` can still source', async () => {
      const file = tmpEnvFile(envText);
      await runVault('import-env', undefined, {
        vault: createMemoryVault(),
        envFile: file,
        confirm: async () => true,
        out: () => {},
      });
      // The whole point of the quotes: unquoted `<vault>` is a here-doc
      // redirection and this dies with a parse error.
      const echoed = execFileSync('sh', ['-c', `set -a; . '${file}'; set +a; echo ok`], {
        encoding: 'utf8',
      });
      expect(echoed.trim()).toBe('ok');
    });

    it('is idempotent: a second run has nothing left to move', async () => {
      const file = tmpEnvFile(envText);
      const vault = createMemoryVault();
      await runVault('import-env', undefined, { vault, envFile: file, confirm: async () => true, out: () => {} });
      const { out, lines } = capture();
      expect(
        await runVault('import-env', undefined, { vault, envFile: file, confirm: async () => true, out }),
      ).toBe(0);
      expect(lines.join('\n')).toContain('No secrets left in .env');
    });
  });
});

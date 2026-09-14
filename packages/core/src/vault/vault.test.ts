import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFileVault } from './file.js';
import { createKeychainVault, INDEX_ACCOUNT, type RunResult } from './keychain.js';
import { createMemoryVault } from './memory.js';
import {
  KNOWN_SECRETS,
  VAULT_PLACEHOLDER,
  VAULT_PLACEHOLDER_LINE,
  envValue,
  isVaultPlaceholder,
  resolveSecret,
  resolveSecrets,
} from './resolve.js';
import { VaultLockedError, VaultUnavailableError, createVault, vaultSelection } from './index.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-vault-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('memory vault', () => {
  it('round-trips, lists and deletes', async () => {
    const vault = createMemoryVault();
    expect(await vault.get('TELEGRAM_BOT_TOKEN')).toBeNull();
    await vault.set('TELEGRAM_BOT_TOKEN', 'abc:123');
    await vault.set('ANTHROPIC_API_KEY', 'sk-ant-x');
    expect(await vault.get('TELEGRAM_BOT_TOKEN')).toBe('abc:123');
    expect(await vault.list()).toEqual(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
    expect(await vault.delete('TELEGRAM_BOT_TOKEN')).toBe(true);
    expect(await vault.delete('TELEGRAM_BOT_TOKEN')).toBe(false);
    expect(await vault.get('TELEGRAM_BOT_TOKEN')).toBeNull();
  });

  it('refuses an empty value and an invalid name', async () => {
    const vault = createMemoryVault();
    await expect(vault.set('A_KEY', '   ')).rejects.toThrow(/empty secret/);
    await expect(vault.set('9BAD', 'x')).rejects.toThrow(/invalid secret name/);
  });
});

describe('file vault', () => {
  const env = (key?: string): NodeJS.ProcessEnv => (key ? { BUDDI_VAULT_KEY: key } : {});

  it('round-trips through a real encrypted file', async () => {
    const file = path.join(tmp(), 'vault.json');
    const vault = createFileVault({ file, env: env('correct horse battery staple') });
    await vault.set('GMAIL_APP_PASSWORD', 'abcd efgh ijkl mnop');
    expect(await vault.get('GMAIL_APP_PASSWORD')).toBe('abcd efgh ijkl mnop');
    expect(await vault.list()).toEqual(['GMAIL_APP_PASSWORD']);
    expect(await vault.delete('GMAIL_APP_PASSWORD')).toBe(true);
    expect(await vault.list()).toEqual([]);
  });

  it('never writes the value in the clear', async () => {
    const file = path.join(tmp(), 'vault.json');
    const vault = createFileVault({ file, env: env('k') });
    await vault.set('TELEGRAM_BOT_TOKEN', 'super-secret-token');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('super-secret-token');
    expect(raw).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('is locked without BUDDI_VAULT_KEY, and lists names anyway', async () => {
    const file = path.join(tmp(), 'vault.json');
    await createFileVault({ file, env: env('k') }).set('A_KEY', 'v');
    const locked = createFileVault({ file, env: env() });
    await expect(locked.get('A_KEY')).rejects.toBeInstanceOf(VaultLockedError);
    // Names are not the secret: listing them needs no key.
    expect(await locked.list()).toEqual(['A_KEY']);
  });

  it('refuses to decrypt with the wrong key', async () => {
    const file = path.join(tmp(), 'vault.json');
    await createFileVault({ file, env: env('right') }).set('A_KEY', 'v');
    const wrong = createFileVault({ file, env: env('wrong') });
    await expect(wrong.get('A_KEY')).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('reports a file that is not a vault as unavailable', async () => {
    const dir = tmp();
    const file = path.join(dir, 'vault.json');
    await createFileVault({ file, env: env('k') }).set('A_KEY', 'v');
    // Corrupt it the way a stray editor would.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'not json at all');
    await expect(createFileVault({ file, env: env('k') }).list()).rejects.toBeInstanceOf(
      VaultUnavailableError,
    );
  });
});

describe('keychain vault (stubbed `security`)', () => {
  /** A fake `security` over an in-memory (service, account) map. */
  function stub(): {
    run: (args: readonly string[]) => Promise<RunResult>;
    calls: string[][];
    store: Map<string, string>;
  } {
    const store = new Map<string, string>();
    const calls: string[][] = [];
    const run = async (args: readonly string[]): Promise<RunResult> => {
      calls.push([...args]);
      const account = args[args.indexOf('-a') + 1] as string;
      const ok = { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'add-generic-password') {
        store.set(account, args[args.indexOf('-w') + 1] as string);
        return ok;
      }
      if (args[0] === 'find-generic-password') {
        const value = store.get(account);
        if (value === undefined) return { code: 44, stdout: '', stderr: 'not found' };
        return { code: 0, stdout: `${value}\n`, stderr: '' };
      }
      if (args[0] === 'delete-generic-password') {
        return store.delete(account) ? ok : { code: 44, stdout: '', stderr: 'not found' };
      }
      return { code: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    };
    return { run, calls, store };
  }

  it('sets, gets, lists and deletes through `security`', async () => {
    const { run, calls, store } = stub();
    const vault = createKeychainVault({ run });

    await vault.set('TELEGRAM_BOT_TOKEN', 'abc:123');
    expect(await vault.get('TELEGRAM_BOT_TOKEN')).toBe('abc:123');
    expect(await vault.list()).toEqual(['TELEGRAM_BOT_TOKEN']);

    // The service is buddi's, and the value is passed as an argv element (no
    // shell), with -U so a second set replaces rather than duplicating.
    const add = calls.find((c) => c[0] === 'add-generic-password') as string[];
    expect(add).toContain('-U');
    expect(add.slice(add.indexOf('-s'), add.indexOf('-s') + 2)).toEqual(['-s', 'buddi']);

    // The name index lives in the keychain, under its reserved account.
    expect(store.has(INDEX_ACCOUNT)).toBe(true);
    expect(await vault.list()).not.toContain(INDEX_ACCOUNT);

    expect(await vault.delete('TELEGRAM_BOT_TOKEN')).toBe(true);
    expect(await vault.get('TELEGRAM_BOT_TOKEN')).toBeNull();
    expect(await vault.list()).toEqual([]);
  });

  it('turns a locked keychain into a typed problem, not a hang', async () => {
    const vault = createKeychainVault({
      run: async () => ({ code: 45, stdout: '', stderr: 'User interaction is not allowed.' }),
    });
    await expect(vault.get('A_KEY')).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('strips exactly one trailing newline from `-w` output', async () => {
    const vault = createKeychainVault({
      run: async () => ({ code: 0, stdout: 'value-with-\n-inside\n', stderr: '' }),
    });
    expect(await vault.get('A_KEY')).toBe('value-with-\n-inside');
  });
});

describe('resolveSecret', () => {
  it('prefers the vault over a stale .env copy', async () => {
    const vault = createMemoryVault({ seed: { TELEGRAM_BOT_TOKEN: 'from-vault' } });
    const res = await resolveSecret('TELEGRAM_BOT_TOKEN', {
      vault,
      env: { TELEGRAM_BOT_TOKEN: 'from-env' },
    });
    expect(res).toMatchObject({ ok: true, value: 'from-vault', source: 'vault' });
  });

  it('falls back to the environment — the documented day-1 path', async () => {
    const res = await resolveSecret('TELEGRAM_BOT_TOKEN', {
      vault: createMemoryVault(),
      env: { TELEGRAM_BOT_TOKEN: 'from-env' },
    });
    expect(res).toMatchObject({ ok: true, value: 'from-env', source: 'env' });
  });

  it('treats the <vault> placeholder as absent', async () => {
    const res = await resolveSecret('TELEGRAM_BOT_TOKEN', {
      vault: createMemoryVault(),
      env: { TELEGRAM_BOT_TOKEN: VAULT_PLACEHOLDER },
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.problem.code).toBe('missing-secret');
  });

  // `import-env` writes the marker quoted so `. ./.env` does not read `<` as a
  // redirection; `dotenv` strips the quotes, a raw read of the file does not.
  it.each([VAULT_PLACEHOLDER, VAULT_PLACEHOLDER_LINE, "'<vault>'", '  "<vault>"  '])(
    'treats %j as the placeholder, not a token',
    async (written) => {
      expect(isVaultPlaceholder(written)).toBe(true);
      expect(envValue({ TELEGRAM_BOT_TOKEN: written }, 'TELEGRAM_BOT_TOKEN')).toBeUndefined();
      const res = await resolveSecret('TELEGRAM_BOT_TOKEN', {
        vault: createMemoryVault(),
        env: { TELEGRAM_BOT_TOKEN: written },
      });
      expect(res).toMatchObject({ ok: false });
    },
  );

  it('writes the marker quoted, and a real value is never mistaken for it', () => {
    expect(VAULT_PLACEHOLDER_LINE).toBe('"<vault>"');
    expect(isVaultPlaceholder('123:abc')).toBe(false);
    expect(isVaultPlaceholder('"<vault>')).toBe(false);
    expect(isVaultPlaceholder('<vault>x')).toBe(false);
  });

  it('fails closed on a locked vault instead of using .env', async () => {
    const vault = createMemoryVault();
    vault.get = async () => {
      throw new VaultLockedError('locked');
    };
    const res = await resolveSecret('TELEGRAM_BOT_TOKEN', {
      vault,
      env: { TELEGRAM_BOT_TOKEN: 'from-env' },
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.problem.code).toBe('vault-locked');
  });

  it('still uses .env when there is no vault on this machine', async () => {
    const vault = createMemoryVault();
    vault.get = async () => {
      throw new VaultUnavailableError('no security binary');
    };
    const res = await resolveSecret('TELEGRAM_BOT_TOKEN', {
      vault,
      env: { TELEGRAM_BOT_TOKEN: 'from-env' },
    });
    expect(res).toMatchObject({ ok: true, source: 'env' });
  });

  it('builds an environment overlay without mutating the original', async () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'from-env' };
    const vault = createMemoryVault({ seed: { TELEGRAM_BOT_TOKEN: 'from-vault' } });
    const out = await resolveSecrets(KNOWN_SECRETS, { vault, env });
    expect(out.env.TELEGRAM_BOT_TOKEN).toBe('from-vault');
    expect(out.env.ANTHROPIC_API_KEY).toBe('from-env');
    expect(out.sources).toMatchObject({ TELEGRAM_BOT_TOKEN: 'vault', ANTHROPIC_API_KEY: 'env' });
    expect(Object.keys(out.problems)).toContain('GMAIL_APP_PASSWORD');
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
});

describe('vault selection', () => {
  it('is the keychain on macOS and a file elsewhere', () => {
    expect(vaultSelection({ env: {}, platform: 'darwin' })).toBe('keychain');
    expect(vaultSelection({ env: {}, platform: 'linux' })).toBe('file');
  });

  it('obeys BUDDI_VAULT, including turning the vault off', () => {
    expect(vaultSelection({ env: { BUDDI_VAULT: 'memory' }, platform: 'darwin' })).toBe('memory');
    expect(vaultSelection({ env: { BUDDI_VAULT: 'none' }, platform: 'darwin' })).toBe('none');
    expect(createVault({ env: { BUDDI_VAULT: 'none' }, platform: 'darwin' })).toBeUndefined();
    expect(createVault({ env: { BUDDI_VAULT: 'memory' } })?.kind).toBe('memory');
  });
});

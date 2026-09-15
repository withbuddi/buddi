/**
 * The database's own password, and the port it is published on.
 *
 * Three things are asserted here, all of them regressions of a real exposure:
 * the compose file's published binding is a *string* in a file and is checked
 * as one; a generated password never lands in `.env`; and `buddi db secure` is
 * idempotent and reversible against a fake `docker`.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DB_PASSWORD_VAR,
  LEGACY_DB_PASSWORD,
  createMemoryVault,
  generateDatabasePassword,
  passwordInDatabaseUrl,
} from '@buddi/core';
import { describe, expect, it, vi } from 'vitest';
import {
  alterRolePassword,
  ensureDatabasePassword,
  hostOfPublished,
  publishedBinding,
  runDbSecure,
  type Exec,
} from './db-secure.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function tmpEnvFile(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-secure-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, text);
  return file;
}

/** A `docker` that records every call and answers from a script. */
function fakeDocker(
  answer: (args: string[]) => { code: number; stdout?: string; stderr?: string } = () => ({
    code: 0,
  }),
): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (_command, args = []) => {
    calls.push(args);
    const res = answer(args);
    return { code: res.code, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };
  return { exec, calls };
}

describe('docker-compose.yml', () => {
  const compose = readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8');

  it('publishes the database on loopback only', () => {
    // The whole incident in one assertion: without the 127.0.0.1 prefix Docker
    // binds 0.0.0.0 and every host on the network can reach the database.
    expect(compose).toContain('- "127.0.0.1:${BUDDI_DB_PORT:-5432}:5432"');
    expect(compose).not.toMatch(/^\s*-\s*"?\$\{BUDDI_DB_PORT/m);
    expect(compose).not.toContain('0.0.0.0:');
  });

  it('reads the password from the environment rather than hard-coding it', () => {
    expect(compose).toContain('POSTGRES_PASSWORD: ${BUDDI_DB_PASSWORD:-buddi}');
    expect(compose).not.toMatch(/POSTGRES_PASSWORD:\s*buddi\s*$/m);
  });

  it('says why the binding is what it is, and names the one legitimate change', () => {
    expect(compose).toMatch(/tailscale|wireguard/i);
    expect(compose).toContain('0.0.0.0');
  });
});

describe('.env.example', () => {
  const example = readFileSync(path.join(REPO, '.env.example'), 'utf8');

  it('ships no database password, commented or otherwise', () => {
    expect(example).not.toContain('postgres://buddi:buddi@');
    for (const line of example.split('\n')) {
      if (line.trim().startsWith('#')) continue;
      expect(line).not.toMatch(/^DATABASE_URL=/);
      expect(line).not.toMatch(/^BUDDI_DB_PASSWORD=/);
    }
  });
});

describe('hostOfPublished', () => {
  it('reads both spellings docker uses', () => {
    expect(hostOfPublished('127.0.0.1:55433')).toBe('127.0.0.1');
    expect(hostOfPublished('0.0.0.0:5432')).toBe('0.0.0.0');
    expect(hostOfPublished('[::]:55433')).toBe('::');
    expect(hostOfPublished('nonsense')).toBeNull();
  });
});

describe('publishedBinding', () => {
  it('reports what compose printed', async () => {
    const { exec, calls } = fakeDocker(() => ({ code: 0, stdout: '127.0.0.1:55433\n' }));
    expect(await publishedBinding(exec, REPO)).toEqual({ published: '127.0.0.1:55433' });
    expect(calls[0]).toEqual(['compose', 'port', 'postgres', '5432']);
  });

  it('reports a stopped daemon as an error, not as a binding', async () => {
    const { exec } = fakeDocker(() => ({
      code: 1,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
    }));
    const binding = await publishedBinding(exec, REPO);
    expect(binding.published).toBeUndefined();
    expect(binding.error).toContain('Cannot connect to the Docker daemon');
  });

  it('reports a container that is not up as an error', async () => {
    const { exec } = fakeDocker(() => ({ code: 0, stdout: '\n' }));
    expect((await publishedBinding(exec, REPO)).error).toContain('not running');
  });
});

describe('ensureDatabasePassword', () => {
  it('generates one, stores it in the vault, and never writes it to .env', async () => {
    const file = tmpEnvFile('BUDDI_DB_PORT=55433\n');
    const vault = createMemoryVault();

    const result = await ensureDatabasePassword({ env: {}, vault, envFile: file });

    expect(result?.created).toBe(true);
    expect(result?.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await vault.get(DB_PASSWORD_VAR)).toBe(result?.password);
    // The point of the whole exercise: the file is untouched.
    expect(readFileSync(file, 'utf8')).toBe('BUDDI_DB_PORT=55433\n');
    expect(readFileSync(file, 'utf8')).not.toContain(result?.password as string);
  });

  it('is a no-op when the vault already holds one', async () => {
    const file = tmpEnvFile('');
    const vault = createMemoryVault();
    const first = await ensureDatabasePassword({ env: {}, vault, envFile: file });
    const second = await ensureDatabasePassword({ env: {}, vault, envFile: file });
    expect(second).toEqual({ password: first?.password, created: false });
  });

  it('declines when the owner set DATABASE_URL themselves', async () => {
    const file = tmpEnvFile('DATABASE_URL=postgres://me:mine@db.internal:5432/buddi\n');
    const vault = createMemoryVault();
    expect(await ensureDatabasePassword({ env: {}, vault, envFile: file })).toBeNull();
    expect(await vault.list()).toEqual([]);
  });
});

describe('alterRolePassword', () => {
  it('refuses a password it cannot safely interpolate', async () => {
    const { exec, calls } = fakeDocker();
    const result = await alterRolePassword({
      exec,
      repoRoot: REPO,
      user: 'buddi',
      database: 'buddi',
      currentPassword: 'buddi',
      newPassword: "x'; drop database buddi; --",
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('passes the OLD password as PGPASSWORD and the new one in the statement', async () => {
    const { exec, calls } = fakeDocker();
    const fresh = generateDatabasePassword();
    await alterRolePassword({
      exec,
      repoRoot: REPO,
      user: 'buddi',
      database: 'buddi',
      currentPassword: 'buddi',
      newPassword: fresh,
    });
    expect(calls[0]).toContain('PGPASSWORD=buddi');
    expect(calls[0]?.join(' ')).toContain(`alter role "buddi" with password '${fresh}'`);
  });
});

describe('buddi db secure', () => {
  const lines = (): { out: (line: string) => void; text: () => string } => {
    const collected: string[] = [];
    return { out: (line) => collected.push(line), text: () => collected.join('\n') };
  };

  it('rotates, stores, rewrites .env — and is a no-op the second time', async () => {
    const file = tmpEnvFile('BUDDI_DB_PORT=55433\nDATABASE_URL=postgres://buddi:buddi@localhost:55433/buddi\n');
    const vault = createMemoryVault();
    const env: NodeJS.ProcessEnv = { BUDDI_DB_PORT: '55433' };
    const fresh = generateDatabasePassword();
    // The fake database accepts whatever the last ALTER ROLE set.
    let accepted: string = LEGACY_DB_PASSWORD;
    const probe = vi.fn(async (url: string) => {
      if (passwordInDatabaseUrl(url) !== accepted) throw new Error('password authentication failed');
    });
    const { exec, calls } = fakeDocker((args) => {
      const match = /with password '([^']+)'/.exec(args[args.length - 1] ?? '');
      if (match) accepted = match[1] as string;
      return { code: 0 };
    });

    const first = lines();
    expect(
      await runDbSecure({
        env,
        vault,
        envFile: file,
        exec,
        generate: () => fresh,
        probe,
        out: first.out,
        repoRoot: REPO,
      }),
    ).toBe(0);

    // The rotation happened in the running server…
    expect(calls.some((a) => a.join(' ').includes(`with password '${fresh}'`))).toBe(true);
    // …the new password is in the vault…
    expect(await vault.get(DB_PASSWORD_VAR)).toBe(fresh);
    // …and `.env` holds a marker, not a credential.
    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('DATABASE_URL="<vault>"');
    expect(rewritten).not.toContain(fresh);
    expect(rewritten).not.toContain('postgres://buddi:buddi@');
    // Nothing printed the password itself.
    expect(first.text()).not.toContain(fresh);
    expect(first.text()).toContain('ALTER ROLE ok');

    // Second run: idempotent. No ALTER, no new password, same file.
    const before = calls.length;
    const again = lines();
    expect(
      await runDbSecure({
        env,
        vault,
        envFile: file,
        exec,
        generate: () => generateDatabasePassword(),
        probe,
        out: again.out,
        repoRoot: REPO,
      }),
    ).toBe(0);
    expect(calls.length).toBe(before);
    expect(await vault.get(DB_PASSWORD_VAR)).toBe(fresh);
    expect(readFileSync(file, 'utf8')).toBe(rewritten);
    expect(again.text()).toContain('Already secured');
  });

  it('puts the old password back when the new one does not connect', async () => {
    const file = tmpEnvFile('DATABASE_URL=postgres://buddi:buddi@localhost:5432/buddi\n');
    const vault = createMemoryVault();
    const fresh = generateDatabasePassword();
    const { exec, calls } = fakeDocker();
    const probe = vi.fn(async (url: string) => {
      // The old one works; the new one never will.
      if (passwordInDatabaseUrl(url) !== LEGACY_DB_PASSWORD) throw new Error('nope');
    });
    const log = lines();

    const code = await runDbSecure({
      env: {},
      vault,
      envFile: file,
      exec,
      generate: () => fresh,
      probe,
      out: log.out,
      repoRoot: REPO,
    });

    expect(code).toBe(1);
    // It rolled back: the last ALTER ROLE restored the old password.
    const statements = calls.map((a) => a[a.length - 1] ?? '');
    expect(statements[statements.length - 1]).toContain(`with password '${LEGACY_DB_PASSWORD}'`);
    // Nothing was half-migrated.
    expect(await vault.get(DB_PASSWORD_VAR)).toBeNull();
    expect(readFileSync(file, 'utf8')).toContain('postgres://buddi:buddi@localhost:5432/buddi');
    expect(log.text()).toContain('OLD password');
  });

  it('refuses to touch a database the owner pointed at themselves', async () => {
    const file = tmpEnvFile('DATABASE_URL=postgres://me:mine@db.internal:5432/buddi\n');
    const vault = createMemoryVault();
    const { exec, calls } = fakeDocker();
    const log = lines();

    expect(
      await runDbSecure({ env: {}, vault, envFile: file, exec, out: log.out, repoRoot: REPO }),
    ).toBe(0);
    expect(calls).toEqual([]);
    expect(await vault.list()).toEqual([]);
    expect(log.text()).toContain('does not rotate a credential');
    // The password is never echoed, even when buddi is declining to manage it.
    expect(log.text()).not.toContain('mine');
  });

  it('refuses when there is nowhere safe to put the password', async () => {
    const file = tmpEnvFile('');
    const log = lines();
    expect(
      await runDbSecure({ env: {}, vault: false, envFile: file, out: log.out, repoRoot: REPO }),
    ).toBe(1);
    expect(log.text()).toContain('no vault on this machine');
  });
});

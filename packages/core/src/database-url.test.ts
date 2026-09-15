/**
 * Where `DATABASE_URL` comes from, and what a generated password looks like.
 *
 * The rule under test is a precedence, and precedence is exactly the kind of
 * thing that is obvious until someone reorders two lines: an explicit
 * `DATABASE_URL` beats the vault, the vault beats the day-1 default, and the
 * day-1 default still works so that an installation which predates this change
 * keeps running until `buddi db secure` is run.
 */
import { describe, expect, it } from 'vitest';
import {
  DB_PASSWORD_VAR,
  LEGACY_DB_PASSWORD,
  assembleDatabaseUrl,
  databaseDefaults,
  generateDatabasePassword,
  isGeneratedPassword,
  passwordInDatabaseUrl,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  hydrateDatabaseUrl,
} from './database-url.js';
import { createMemoryVault } from './vault/memory.js';
import { KNOWN_SECRETS } from './vault/resolve.js';

describe('generateDatabasePassword', () => {
  it('is long, URL-safe, and different every time', () => {
    const a = generateDatabasePassword();
    const b = generateDatabasePassword();
    expect(a).not.toBe(b);
    expect(a).toHaveLength(32);
    // base64url only: no `@`, `:`, `/`, `#`, `%` or quote to escape anywhere —
    // not in a connection string, not in a SQL literal, not in a shell.
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(isGeneratedPassword(a)).toBe(true);
  });

  it('never yields the password this project shipped with', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateDatabasePassword()).not.toBe(LEGACY_DB_PASSWORD);
    }
  });

  it('refuses to call a short or quoted value one of its own', () => {
    expect(isGeneratedPassword('buddi')).toBe(false);
    expect(isGeneratedPassword("a'; drop database buddi; --")).toBe(false);
  });

  it('survives a round trip through a URL', () => {
    const password = generateDatabasePassword();
    const url = assembleDatabaseUrl({ ...databaseDefaults({}), password });
    expect(passwordInDatabaseUrl(url)).toBe(password);
    expect(redactDatabaseUrl(url)).not.toContain(password);
    expect(redactDatabaseUrl(url)).toContain('***');
  });
});

describe('databaseDefaults', () => {
  it('binds to loopback by address, and reads BUDDI_DB_PORT', () => {
    expect(databaseDefaults({})).toEqual({
      user: 'buddi',
      host: '127.0.0.1',
      port: '5432',
      database: 'buddi',
    });
    expect(databaseDefaults({ BUDDI_DB_PORT: '55433' }).port).toBe('55433');
  });
});

describe('resolveDatabaseUrl', () => {
  it('lets an explicit DATABASE_URL win over everything', async () => {
    const vault = createMemoryVault();
    await vault.set(DB_PASSWORD_VAR, generateDatabasePassword());
    const explicit = 'postgres://me:mine@db.internal:6543/buddi';

    const resolved = await resolveDatabaseUrl({ env: { DATABASE_URL: explicit }, vault });

    expect(resolved.url).toBe(explicit);
    expect(resolved.source).toBe('env');
    expect(resolved.legacyPassword).toBe(false);
  });

  it('assembles the URL around the password in the vault', async () => {
    const vault = createMemoryVault();
    const password = generateDatabasePassword();
    await vault.set(DB_PASSWORD_VAR, password);

    const resolved = await resolveDatabaseUrl({ env: { BUDDI_DB_PORT: '55433' }, vault });

    expect(resolved.source).toBe('vault');
    expect(resolved.legacyPassword).toBe(false);
    expect(resolved.url).toBe(`postgres://buddi:${password}@127.0.0.1:55433/buddi`);
  });

  it('prefers a whole DATABASE_URL in the vault over an assembled one', async () => {
    const vault = createMemoryVault();
    await vault.set('DATABASE_URL', 'postgres://buddi:whole@127.0.0.1:5432/buddi');
    await vault.set(DB_PASSWORD_VAR, generateDatabasePassword());

    const resolved = await resolveDatabaseUrl({ env: {}, vault });

    expect(resolved.url).toBe('postgres://buddi:whole@127.0.0.1:5432/buddi');
    expect(resolved.source).toBe('vault');
  });

  it('falls back to the day-1 default so an old installation keeps running', async () => {
    const resolved = await resolveDatabaseUrl({
      env: { BUDDI_DB_PORT: '55433' },
      vault: createMemoryVault(),
    });

    expect(resolved.source).toBe('default');
    expect(resolved.legacyPassword).toBe(true);
    expect(resolved.url).toBe('postgres://buddi:buddi@127.0.0.1:55433/buddi');
  });

  it('treats the `<vault>` marker as absent, not as a URL', async () => {
    const vault = createMemoryVault();
    const password = generateDatabasePassword();
    await vault.set(DB_PASSWORD_VAR, password);

    const resolved = await resolveDatabaseUrl({ env: { DATABASE_URL: '<vault>' }, vault });

    expect(resolved.source).toBe('vault');
    expect(resolved.url).toContain(password);
  });

  it('works with no vault at all: explicit, or the day-1 default', async () => {
    expect((await resolveDatabaseUrl({ env: {}, vault: undefined })).source).toBe('default');
    expect(
      (await resolveDatabaseUrl({ env: { DATABASE_URL: 'postgres://a:b@c:1/d' } })).source,
    ).toBe('env');
  });

  it('writes the answer into the environment when hydrating', async () => {
    const vault = createMemoryVault();
    const password = generateDatabasePassword();
    await vault.set(DB_PASSWORD_VAR, password);
    const env: NodeJS.ProcessEnv = { BUDDI_DB_PORT: '55433' };

    await hydrateDatabaseUrl(env, vault);

    expect(env.DATABASE_URL).toBe(`postgres://buddi:${password}@127.0.0.1:55433/buddi`);
  });
});

describe('the known-secret list', () => {
  it('holds the database credentials, so import-env and the scrubber see them', () => {
    expect(KNOWN_SECRETS).toContain('DATABASE_URL');
    expect(KNOWN_SECRETS).toContain(DB_PASSWORD_VAR);
  });
});

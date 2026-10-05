/**
 * The isolated test database: an explicit URL or none, never the dev
 * database's port, never without the memory vault — and the vault is never
 * asked, so a keychain that knows the dev database cannot answer.
 */
import { describe, expect, it } from 'vitest';
import { isolatedTestDatabase, isolatedTestDatabaseUrl } from './database-url.js';

describe('isolatedTestDatabase', () => {
  it('skips without an explicit DATABASE_URL, and treats the vault marker as absent', () => {
    expect(isolatedTestDatabase({ BUDDI_VAULT: 'memory' })).toMatchObject({ url: null, source: 'none' });
    expect(isolatedTestDatabaseUrl({ BUDDI_VAULT: 'memory', DATABASE_URL: '<vault>' })).toBeUndefined();
  });

  it('uses an explicit throwaway database with the memory vault', () => {
    const url = 'postgres://postgres:test@127.0.0.1:56001/buddi';
    expect(isolatedTestDatabase({ BUDDI_VAULT: 'memory', DATABASE_URL: url })).toEqual({ url, source: 'env' });
  });

  it('refuses the dev database and a run without the memory vault', () => {
    expect(() => isolatedTestDatabase({ BUDDI_VAULT: 'memory', DATABASE_URL: 'postgres://x:y@127.0.0.1:55433/buddi' })).toThrow(/55433/);
    expect(() => isolatedTestDatabase({ DATABASE_URL: 'postgres://x:y@127.0.0.1:56001/buddi' })).toThrow(/BUDDI_VAULT=memory/);
    expect(() => isolatedTestDatabase({ BUDDI_VAULT: 'keychain', DATABASE_URL: 'postgres://x:y@127.0.0.1:56001/buddi' })).toThrow(/BUDDI_VAULT=memory/);
  });
});

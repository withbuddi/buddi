/**
 * Ghost accounts: the one-shot legacy migration and what it is allowed to seed.
 *
 * The database half of this service is covered by `provider-accounts.db.test.ts`.
 * What is asserted here needs no database at all, because it is a decision
 * about the *environment*: an account named after `ANTHROPIC_API_KEY` may exist
 * only on a machine where `ANTHROPIC_API_KEY` is actually set. A packaged
 * install has none of them, and must come up with zero accounts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentCatalog } from '@buddi/core';
import { ProviderAccounts, legacyAccountsToSeed } from './provider-accounts.js';

/** A client that answers every read with no rows and records every write. */
function recordingPool() {
  const sql: Array<{ text: string; params: unknown[] }> = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      sql.push({ text, params });
      return { rows: [] as unknown[] };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: async (text: string, params: unknown[] = []) => {
      sql.push({ text, params });
      return { rows: [] as unknown[] };
    },
  };
  /** The ids handed to `insert into core.provider_accounts`, in order. */
  const seeded = () =>
    sql
      .filter((q) => /insert into core\.provider_accounts/.test(q.text))
      .map((q) => q.params[0] as string);
  return { pool, sql, seeded };
}

const emptyCatalog = { list: () => [], get: () => undefined } as unknown as AgentCatalog;

function service(env: NodeJS.ProcessEnv) {
  const recorder = recordingPool();
  const accounts = new ProviderAccounts({
    pool: recorder.pool as never,
    env,
    catalog: () => emptyCatalog,
    reload: vi.fn(),
  });
  return { accounts, ...recorder };
}

describe('legacy accounts are named after variables, so an unset variable is not an account', () => {
  it('names nothing when the environment holds none of them', () => {
    expect(legacyAccountsToSeed({})).toEqual([]);
    expect(legacyAccountsToSeed({ ANTHROPIC_API_KEY: '   ' })).toEqual([]);
  });

  it('names exactly the ones that are set and non-empty', () => {
    const named = legacyAccountsToSeed({
      ANTHROPIC_API_KEY: 'sk-ant-fixture',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      OPENAI_API_KEY: 'sk-fixture',
    });
    expect(named.map((item) => item.id)).toEqual(['legacy-anthropic-api', 'legacy-openai-api']);
  });

  it('seeds no account at all on a fresh install', async () => {
    const { accounts, seeded, sql } = service({});
    await accounts.initialize();
    expect(seeded()).toEqual([]);
    // The migration still runs and is still recorded once: a later boot must
    // not start hunting for credentials again.
    expect(sql.some((q) => /provider_account_migrations/.test(q.text) && /insert/.test(q.text))).toBe(true);
  });

  it('seeds the checkout’s own accounts unchanged when the variables are there', async () => {
    const { accounts, seeded } = service({
      ANTHROPIC_API_KEY: 'sk-ant-fixture',
      OPENAI_API_KEY: 'sk-fixture',
    });
    await accounts.initialize();
    expect(seeded()).toEqual(['legacy-anthropic-api', 'legacy-openai-api']);
  });
});

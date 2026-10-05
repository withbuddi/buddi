/**
 * A new agent's first-open strip: owed only to an agent `platform.create_agent`
 * marked, naming both directions of delegation as they apply, and gone for
 * good once closed. Own database, dropped after; skipped without one.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, loadAgentCatalog, migrate, readWebSetting, ToolRegistry } from '@buddi/core';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '@buddi/core/testing';
import { AGENT_INTRO_KEY, dismissAgentIntro, markAgentIntro, readAgentIntro } from './agent-intro.js';
import { createDelegationManifest, readDelegatesFile } from './delegation.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_agent_intro_${process.pid}`;

function agentFile(id: string, extra: string[] = []): string {
  return ['---', `id: ${id}`, `handle: ${id}`, `name: ${id}`, `description: ${id} does ${id} things`, ...extra, '---', '', `You are ${id}.`, ''].join('\n');
}

suite('the first-open strip of a new agent', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('is owed only once marked, names who it may ask and who may ask it, and stays closed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-agent-intro-'));
    const put = (id: string, extra: string[] = [], delegates?: string[]): void => {
      mkdirSync(path.join(dir, id), { recursive: true });
      writeFileSync(path.join(dir, id, 'agent.md'), agentFile(id, extra));
      if (delegates) writeFileSync(path.join(dir, id, 'delegates.json'), JSON.stringify(delegates));
    };
    put('concierge', ['roles: [front-desk]', 'tools: [agent.delegate]']);
    put('art', ['tools: [agent.delegate]'], ['*']);
    put('ledger', ['tools: [agent.delegate]'], []);
    put('quiet', ['tools: [agent.delegate]']);
    put('newbie', ['tools: [agent.delegate]'], ['*']);
    const registry = new ToolRegistry();
    registry.register(createDelegationManifest(registry));
    const catalog = loadAgentCatalog({ dirs: [{ dir, source: 'private' }], registry, env: {}, delegatesFor: (id, d) => readDelegatesFile(id, d) });

    // An agent that was already there owes nothing.
    expect(await readAgentIntro(pool, catalog, 'newbie')).toEqual({ show: false });
    expect(await readAgentIntro(pool, catalog, 'ghost')).toBeNull();

    await markAgentIntro(pool, 'newbie');
    expect(await readAgentIntro(pool, catalog, 'newbie')).toEqual({
      show: true,
      id: 'newbie',
      handle: 'newbie',
      asks: 'everyone',
      // The front desk first; ledger's empty list and quiet's missing one reach nobody.
      askedBy: [
        { id: 'concierge', handle: 'concierge', name: 'concierge', frontDesk: true },
        { id: 'art', handle: 'art', name: 'art' },
      ],
    });
    expect(await readAgentIntro(pool, catalog, 'art')).toEqual({ show: false });

    // A narrowed list is named agent by agent.
    writeFileSync(path.join(dir, 'newbie', 'delegates.json'), '["ledger"]');
    const narrowed = await readAgentIntro(pool, catalog, 'newbie');
    expect(narrowed?.show === true && narrowed.asks).toEqual([{ id: 'ledger', handle: 'ledger', name: 'ledger' }]);

    await dismissAgentIntro(pool, 'newbie');
    expect(await readAgentIntro(pool, catalog, 'newbie')).toEqual({ show: false });
    expect(await readWebSetting(pool, AGENT_INTRO_KEY)).toEqual({ pending: [] });
  });

  it('marks nothing without a database, and never throws', async () => {
    await expect(markAgentIntro(null, 'newbie')).resolves.toBeUndefined();
  });
});

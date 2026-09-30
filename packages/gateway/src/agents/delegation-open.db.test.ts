/**
 * The front desk asks anyone, new agents included, with no list edit.
 *
 * A concierge (`roles: [front-desk]`) with no `delegates.json` is loaded; an
 * agent is created afterwards and the catalog reloaded, as creation does. The
 * concierge's delegation to it runs a real nested conversation, and no
 * allowlist file was written anywhere. Another agent with no list is still
 * refused in the old words.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  ensureOwner,
  loadAgentCatalog,
  migrate,
  ToolRegistry,
  type CoreToolContext,
} from '@buddi/core';
import { DELEGATE_TOOL, type CompletionResponse, type RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '@buddi/core/testing';
import { bindDelegation, createDelegationManifest, DELEGATES_FILE, readDelegatesFile } from './delegation.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_delegation_open_${process.pid}`;

function agentFile(id: string, extra: string[] = []): string {
  return ['---', `id: ${id}`, `handle: ${id}`, `name: ${id}`, `description: ${id} does ${id} things`, ...extra, '---', '', `You are ${id}.`, ''].join('\n');
}

const answer: RuntimeProvider = {
  async complete(): Promise<CompletionResponse> {
    return { content: [{ type: 'text', text: 'Newbie here: done.' }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'claude-test' };
  },
};

suite('open delegation for the front desk', () => {
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
    await ensureOwner(pool, 'owner');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('lets the concierge ask an agent created after it, with no allowlist edit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-open-delegation-'));
    const put = (id: string, extra: string[] = []): void => {
      mkdirSync(path.join(dir, id), { recursive: true });
      writeFileSync(path.join(dir, id, 'agent.md'), agentFile(id, extra));
    };
    put('concierge', ['roles: [front-desk]', 'tools: [agent.delegate]']);
    put('ledger', ['tools: [agent.delegate]']);

    const registry = new ToolRegistry();
    registry.register(createDelegationManifest(registry));
    const load = () => loadAgentCatalog({ dirs: [{ dir, source: 'private' }], registry, env: {}, delegatesFor: (id, d) => readDelegatesFile(id, d) });
    bindDelegation(registry, { catalog: load() as never, provider: answer });

    // Created afterwards, the way creation leaves it: a new directory, then a reload.
    put('newbie', ['tools: []']);
    const catalog = load();
    bindDelegation(registry, { catalog: catalog as never, provider: answer });
    expect(catalog.get('concierge')!.systemPromptTemplate).toContain('`newbie` (@newbie)');

    const ctx = (agentId: string): CoreToolContext => ({ db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC', agentId });
    const out = await registry.invoke(DELEGATE_TOOL, { agent: 'newbie', task: 'Say hello.' }, ctx('concierge'));
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out.ok ? out.output : null)).toContain('Newbie here: done.');
    expect(existsSync(path.join(dir, 'concierge', DELEGATES_FILE))).toBe(false);

    const refused = await registry.invoke(DELEGATE_TOOL, { agent: 'newbie', task: 'Say hello.' }, ctx('ledger'));
    expect(refused.ok === false && refused.message).toBe(
      "delegation refused: @ledger may not delegate to anyone; @newbie is not on its list. The owner adds it on @ledger's Team tab.",
    );
  }, 30_000);
});

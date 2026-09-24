/**
 * Learning step 4 against a throwaway database and a real agents directory:
 * a kept change to an agent's own file goes through `updateAgentFromOwner`,
 * so its refusals are the platform's; a widening tool list is named before
 * the keep; the owner's edited version is what lands; the agent is told once.
 * And acceptance 4: a discard holds for 90 days, for every kind.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createPool,
  createProposal,
  discardProposal,
  getProposal,
  loadAgentCatalog,
  runMigrations,
  type ProposalKind,
  type ProposalProvenance,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createToolRegistry, EXAMPLES_AGENTS_DIR, EXAMPLES_SKILLS_DIR, reloadableCatalog } from './catalog.js';
import { learningContext } from './learning.js';
import { bindPlatformTools } from './platform.js';
import { keepProposalFromWeb, readProposals, registryChangeLookup } from '../web/proposals.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_learning_changes_test_${process.pid}`;
const NOW = new Date('2026-09-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const SCOUT = `---
id: scout
handle: scout
name: Scout
description: Watches things and reports.
tools: [memory.note, memory.recall, learning.propose_change]
---

Scout's persona, written by hand.
`;

function installation() {
  const root = mkdtempSync(path.join(tmpdir(), 'buddi-learning-changes-'));
  const agentsDir = path.join(root, 'agents');
  const skillsDir = path.join(root, 'skills');
  mkdirSync(path.join(agentsDir, 'scout'), { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  const file = path.join(agentsDir, 'scout', 'agent.md');
  writeFileSync(file, SCOUT, 'utf8');
  const registry = createToolRegistry({});
  const catalog = reloadableCatalog(() =>
    loadAgentCatalog({
      dirs: [
        { dir: EXAMPLES_AGENTS_DIR, skillsDir: EXAMPLES_SKILLS_DIR, source: 'example' },
        { dir: agentsDir, skillsDir, source: 'private' },
      ],
      registry,
      env: {},
    }),
  );
  bindPlatformTools(registry, { catalog, reload: () => catalog.reload(), agentsDir, skillsDir, examplesDir: EXAMPLES_AGENTS_DIR });
  return { registry, catalog, file };
}

const provenance = (agent: string): ProposalProvenance => ({ agent, conversation: null, runId: 'run-1', turn: 1, sources: [] });

suite('learning: changes to an agent file (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, []);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.proposals, core.events');
  });

  const propose = async (kind: ProposalKind, payload: Record<string, unknown>, agent = 'scout', now = NOW) =>
    createProposal(pool, { kind, agent, payload, provenance: provenance(agent), now });

  const change = async (part: 'instructions' | 'tools', proposed: string) => {
    const made = await propose('change', { part, before: null, proposed, why: 'w' });
    if (!made.ok) throw new Error(made.message);
    return made.proposal;
  };

  it('writes a kept persona change through the platform update, the edited version, and tells the agent once', async () => {
    const { registry, file } = installation();
    const p = await change('instructions', 'Scout watches, and reports in one line.');
    const deps = { pool, registry, ctx: { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC' }, now: () => NOW };

    const kept = await keepProposalFromWeb(deps, p.id, 'Scout watches, and reports in two lines at most.');
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.body.applied).toBe(true);
    expect(kept.body.note).toMatch(/Written to scout's file/);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Scout watches, and reports in two lines at most.');
    expect(text).not.toContain("Scout's persona, written by hand.");
    expect(text).toContain('tools: [memory.note, memory.recall, learning.propose_change]');

    const first = await learningContext(pool, { agentId: 'scout', tools: ['learning.propose_change'] }, NOW);
    expect(first).toMatch(/kept these changes to your own file[\s\S]*Change to its own instructions, in a version the owner corrected/);
    const second = await learningContext(pool, { agentId: 'scout', tools: ['learning.propose_change'] }, NOW);
    expect(second).not.toMatch(/kept these changes/);
  });

  it('refuses an unknown tool and a hand-only tool with the platform\'s sentence, and leaves the card open', async () => {
    const { registry, file } = installation();
    const deps = { pool, registry, ctx: { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC' }, now: () => NOW };

    const unknown = await change('tools', 'memory.note, memory.recall, nothing.here');
    const a = await keepProposalFromWeb(deps, unknown.id, undefined);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.body.error).toMatch(/^Not applied: .*nothing\.here/);
    expect((await getProposal(pool, unknown.id))?.state).toBe('open');

    const handOnly = await change('tools', 'memory.note, platform.create_agent');
    const b = await keepProposalFromWeb(deps, handOnly.id, undefined);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.body.error).toMatch(/cannot grant platform\.create_agent/);
    expect((await getProposal(pool, handOnly.id))?.state).toBe('open');

    expect(readFileSync(file, 'utf8')).toBe(SCOUT);
    // The card said so before the click, too.
    const view = await readProposals(pool, NOW, undefined, registryChangeLookup(registry));
    const card = view.open.find((v) => v.id === handOnly.id);
    expect(card?.change?.refusal).toMatch(/cannot grant platform\.create_agent/);
  });

  it('names what a widening tool list adds, on the card and in Activity', async () => {
    const { registry, file } = installation();
    const deps = { pool, registry, ctx: { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC' }, now: () => NOW };
    const p = await change('tools', 'memory.note, memory.recall, memory.forget, learning.propose_change');

    const view = await readProposals(pool, NOW, undefined, registryChangeLookup(registry));
    expect(view.open[0]?.change).toMatchObject({
      part: 'tools',
      current: 'memory.note, memory.recall, learning.propose_change',
      added: ['memory.forget'],
      refusal: null,
    });

    const kept = await keepProposalFromWeb(deps, p.id, undefined);
    expect(kept.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/tools: \[memory\.note, memory\.recall, memory\.forget, learning\.propose_change\]/);
    const { rows } = await pool.query(`select payload from core.events where kind = 'proposal.kept'`);
    expect(rows[0]?.payload).toMatchObject({ kind: 'change', added: ['memory.forget'], applied: true });
  });

  it('refuses to propose what the file already says, so the inbox never holds a card that can only be refused', async () => {
    const { registry } = installation();
    const ctx = {
      db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC', agentId: 'scout',
      provenance: () => ({ runId: 'run-1', turn: 1, step: 1, sources: [] }),
    };
    const same = await registry.invoke('learning.propose_change', { part: 'tools', proposed: 'learning.propose_change,memory.recall, memory.note', why: 'w' }, ctx);
    expect(same.ok && same.output).toMatchObject({ ok: false, reason: 'no-change' });
    const persona = await registry.invoke('learning.propose_change', { part: 'instructions', proposed: "Scout's persona,\nwritten by hand.", why: 'w' }, ctx);
    expect(persona.ok && persona.output).toMatchObject({ ok: false, reason: 'no-change' });
    const real = await registry.invoke('learning.propose_change', { part: 'tools', proposed: 'memory.note', why: 'w' }, ctx);
    expect(real.ok && real.output).toMatchObject({ ok: true, state: 'open' });
  });

  it('acceptance 4: a discard stops the same proposal coming back for 90 days, for a skill, a rule and a change', async () => {
    const cases: Array<{ kind: ProposalKind; payload: Record<string, unknown>; again: Record<string, unknown>; agent?: string }> = [
      {
        kind: 'skill',
        payload: { name: 'Check a bank balance', when: 'w', body: '1. Open it.', why: 'twice' },
        again: { name: 'check a bank balance.', when: 'other', body: '1. Open it.\n2. Read it.', why: 'reworded' },
      },
      {
        kind: 'policy',
        payload: { plugin: 'mailer', matcher: { from: 'news@x.test' }, action: 'ignore', verdicts: [], why: 'three times' },
        again: { plugin: 'mailer', matcher: { from: 'news@x.test' }, action: 'ignore', verdicts: ['a'], why: 'again' },
        // A rule is the plugin's: another agent's run noticing it is the same card.
        agent: 'triage',
      },
      {
        kind: 'change',
        payload: { part: 'tools', before: null, proposed: 'memory.note, memory.forget', why: 'w' },
        // The same set in another order, spaced differently.
        again: { part: 'tools', before: null, proposed: 'memory.forget,memory.note', why: 'reworded' },
      },
    ];
    for (const c of cases) {
      const made = await propose(c.kind, c.payload);
      expect(made.ok).toBe(true);
      if (!made.ok) continue;
      await discardProposal(pool, { id: made.proposal.id, reason: 'no', now: NOW });

      const soon = await propose(c.kind, c.again, c.agent ?? 'scout', new Date(NOW.getTime() + 89 * DAY));
      expect(soon, c.kind).toMatchObject({ ok: false, reason: 'recently-discarded' });
      if (!soon.ok) expect(soon.message).toMatch(/do not propose it again before 2026-12-22/);

      const later = await propose(c.kind, c.again, c.agent ?? 'scout', new Date(NOW.getTime() + 91 * DAY));
      expect(later.ok, c.kind).toBe(true);
    }
  });
});

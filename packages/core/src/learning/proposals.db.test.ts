/**
 * The proposal store against a real database: the discard memory, the
 * open-once rule, keeping an edited version, the fold and the 30-day expiry.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, describe } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import {
  countOpenProposals,
  createProposal,
  discardProposal,
  expireStaleProposals,
  keepProposal,
  listClosedProposals,
  listOpenProposals,
  policyTrackRecord,
  readLearningWeek,
  revokeKeptProposal,
  takeUntoldDecisions,
} from './store.js';
import type { ProposalProvenance } from './types.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_proposals_test_${process.pid}`;
const NOW = new Date('2026-09-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);

const provenance = (sources: ProposalProvenance['sources'] = []): ProposalProvenance => ({
  agent: 'advisor', conversation: null, runId: 'run-1', turn: 2, sources,
});
const skill = (name = 'Check a bank balance') => ({ name, when: 'monthly', body: '1. open the bank', why: 'did it twice' });

suite('proposals (postgres)', () => {
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

  beforeEach(async () => {
    await pool.query('truncate core.proposals');
  });

  const propose = (now = NOW, name?: string, sources?: ProposalProvenance['sources']) =>
    createProposal(pool, { kind: 'skill', agent: 'advisor', payload: skill(name), provenance: provenance(sources), now });

  it('records a proposal, untrusted exactly when it has sources', async () => {
    const clean = await propose();
    const marked = await propose(NOW, 'Pay a card', [{ kind: 'web', via: 'web.read', ref: 'https://bank.example' }]);
    expect(clean.ok && clean.proposal.untrusted).toBe(false);
    expect(marked.ok && marked.proposal.untrusted).toBe(true);
    expect(marked.ok && marked.proposal.provenance.sources[0]?.ref).toBe('https://bank.example');
    expect(await countOpenProposals(pool)).toBe(2);
  });

  it('keeps one open card per fingerprint', async () => {
    const first = await propose();
    const again = await propose();
    expect(again.ok).toBe(false);
    expect(!again.ok && again.reason).toBe('already-open');
    expect(!again.ok && first.ok && again.existing.id).toBe(first.ok ? first.proposal.id : '');
  });

  it('refuses a discarded proposal for 90 days, in one line, then lets it back', async () => {
    const first = await propose();
    if (!first.ok) throw new Error('not created');
    await discardProposal(pool, { id: first.proposal.id, reason: 'I do this myself', now: NOW });
    const refused = await propose(at(30));
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toBe('recently-discarded');
    expect(!refused.ok && refused.message).toMatch(/^The owner discarded this on 2026-09-23 \("I do this myself"\); do not propose it again before 2026-12-22\.$/);
    expect((await propose(at(91))).ok).toBe(true);
  });

  it('keeps the owner\'s corrected version, once', async () => {
    const first = await propose();
    if (!first.ok) throw new Error('not created');
    const kept = await keepProposal(pool, { id: first.proposal.id, payload: { ...skill(), body: '1. open it carefully' }, now: NOW });
    expect(kept?.state).toBe('kept');
    expect(kept?.payload.body).toBe('1. open it carefully');
    expect(await keepProposal(pool, { id: first.proposal.id, now: NOW })).toBeNull();
    expect(await discardProposal(pool, { id: first.proposal.id, now: NOW })).toBeNull();
  });

  it('expires what nobody decided in 30 days, and folds decisions for a week', async () => {
    const old = await propose(at(-31), 'Old');
    const recent = await propose(at(-5), 'Recent');
    const expired = await expireStaleProposals(pool, NOW);
    expect(expired.map((p) => p.id)).toEqual([old.ok ? old.proposal.id : '']);
    expect(expired[0]?.reason).toBe('not decided in 30 days');
    expect((await listOpenProposals(pool)).map((p) => p.id)).toEqual([recent.ok ? recent.proposal.id : '']);
    expect((await listClosedProposals(pool, { now: NOW })).map((p) => p.state)).toEqual(['expired']);
    expect(await listClosedProposals(pool, { now: at(8) })).toEqual([]);
  });

  it('tells the agent about a discard once', async () => {
    const first = await propose();
    if (!first.ok) throw new Error('not created');
    await discardProposal(pool, { id: first.proposal.id, now: NOW });
    expect((await takeUntoldDecisions(pool, { agent: 'advisor', now: NOW })).map((p) => p.id)).toEqual([first.proposal.id]);
    expect(await takeUntoldDecisions(pool, { agent: 'advisor', now: NOW })).toEqual([]);
    expect(await takeUntoldDecisions(pool, { agent: 'scout', now: NOW })).toEqual([]);
  });

  it('tells the agent once that a change to its file was kept, and not about a kept skill', async () => {
    const kept = await propose();
    const change = await createProposal(pool, {
      kind: 'change', agent: 'advisor', payload: { part: 'instructions', before: null, proposed: 'Be terse.', why: 'w' },
      provenance: provenance(), now: NOW,
    });
    if (!kept.ok || !change.ok) throw new Error('not created');
    await keepProposal(pool, { id: kept.proposal.id, now: NOW });
    await keepProposal(pool, { id: change.proposal.id, now: NOW });
    expect((await takeUntoldDecisions(pool, { agent: 'advisor', now: NOW })).map((p) => p.id)).toEqual([change.proposal.id]);
    expect(await takeUntoldDecisions(pool, { agent: 'advisor', now: NOW })).toEqual([]);
  });

  it('reads the week: kept per kind with up to three names, and the open count', async () => {
    for (const name of ['A', 'B', 'C', 'D']) {
      const made = await propose(at(-2), name);
      if (made.ok) await keepProposal(pool, { id: made.proposal.id, now: at(-1) });
    }
    const old = await propose(at(-20), 'Old');
    if (old.ok) await keepProposal(pool, { id: old.proposal.id, now: at(-10) });
    await propose(NOW, 'Open');
    const week = await readLearningWeek(pool, { since: at(-7) });
    expect(week.kept.skill.count).toBe(4);
    expect(week.kept.skill.names).toHaveLength(3);
    expect(week.kept.policy).toEqual({ count: 0, names: [] });
    expect(week.open).toBe(1);
  });
  describe('the track record', () => {
    const rule = (sender: string, kind = 'quiet-promo-sender') => ({
      plugin: 'mailer', matcher: { sender }, action: 'ignore', verdicts: [], why: 'w', kind,
    });
    const decide = async (sender: string, how: 'owner' | 'auto' | 'discard', when: Date, kind?: string) => {
      const created = await createProposal(pool, { kind: 'policy', agent: 'mailer', payload: rule(sender, kind), provenance: provenance(), now: when });
      if (!created.ok) throw new Error('not created');
      if (how === 'discard') return discardProposal(pool, { id: created.proposal.id, now: when });
      return keepProposal(pool, { id: created.proposal.id, now: when, decidedBy: how });
    };

    it('turns a kind on after five owner keeps, counts no auto keep, and starts over at a discard', async () => {
      const record = () => policyTrackRecord(pool, { plugin: 'mailer', kind: 'quiet-promo-sender' });
      for (let i = 0; i < 4; i += 1) await decide(`o${i}@x.test`, 'owner', at(i / 10));
      for (let i = 0; i < 3; i += 1) await decide(`a${i}@x.test`, 'auto', at(1 + i / 10));
      await decide('other@x.test', 'owner', at(1.5), 'quiet-low-sender');
      expect(await record()).toEqual({ kept: 4, discarded: 0, trusted: false });
      const fifth = await decide('o4@x.test', 'owner', at(2));
      expect(fifth?.decidedBy).toBe('owner');
      expect(await record()).toEqual({ kept: 5, discarded: 0, trusted: true });

      await decide('d@x.test', 'discard', at(3));
      expect(await record()).toEqual({ kept: 0, discarded: 1, trusted: false });
      for (let i = 0; i < 5; i += 1) await decide(`n${i}@x.test`, 'owner', at(4 + i / 10));
      expect(await record()).toMatchObject({ kept: 5, trusted: true });

      // Taking a kept one back is a discard, from then on.
      const auto = await decide('t@x.test', 'auto', at(5));
      const back = await revokeKeptProposal(pool, { id: auto!.id, now: at(6) });
      expect(back).toMatchObject({ state: 'discarded', decidedBy: 'owner' });
      expect(await record()).toMatchObject({ kept: 0, discarded: 2, trusted: false });
    });

    it('does not announce a proposal created with announce off', async () => {
      await pool.query('truncate core.owner_notifications cascade');
      await createProposal(pool, { kind: 'policy', agent: 'mailer', payload: rule('q@x.test'), provenance: provenance(), now: NOW, announce: false });
      await createProposal(pool, { kind: 'policy', agent: 'mailer', payload: rule('r@x.test'), provenance: provenance(), now: NOW });
      const { rows } = await pool.query('select count(*)::int as n from core.owner_notifications');
      expect(rows[0].n).toBe(1);
    });
  });
});

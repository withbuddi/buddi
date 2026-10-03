/**
 * People (docs/memory.md, "People"), against a real database: the tool's two
 * paths (kept at once when the owner said it in this turn, else a proposal
 * card), the card kept, the list, forget and restore, the preamble, and the
 * one-time seed from notes. Skipped unless DATABASE_URL is set; never the
 * developer's data — a throwaway database, dropped at the end.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createPluginHost,
  createPool,
  hostBindingOf,
  listOpenProposals,
  runMigrations,
  testDatabaseUrl,
  type CoreToolContext,
} from '@buddi/core/testing';
import { manifest } from './index.js';
import { buildPreamble } from './preamble.js';
import { forgetPerson, listPeople, patchOfProposal, peoplePolicyHandler, restorePerson, SEED_KEY, upsertPerson } from './people.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_people_test_${process.pid}`;
const CONVERSATION = '22222222-2222-4222-8222-222222222222';

suite('people (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  const registry = new ToolRegistry();
  const clock = new Date('2026-10-03T09:00:00Z');
  const now = (): Date => clock;

  const ctx = (extra: Partial<CoreToolContext> = {}): CoreToolContext => ({
    db: pool, ownerId: 'owner', now, timezone: 'Europe/Paris', conversationId: CONVERSATION, agentId: 'concierge', ...extra,
  });
  const ownerSaid = (text: string): Partial<CoreToolContext> => ({ ownerRequest: { id: 'r1', text, expiresAt: clock.getTime() + 60_000 } });
  const call = async (name: string, args: unknown, extra: Partial<CoreToolContext> = {}): Promise<any> => {
    const result = await registry.invoke(name, args, ctx(extra));
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
    registry.register(manifest);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('keeps a person at once when the owner named them in this very turn', async () => {
    const out = await call('memory.person', { name: 'Marion', relationship: 'wife', birthday: { day: 14, month: 3 } }, ownerSaid('Marion is my wife, her birthday is 14 March'));
    expect(out).toMatchObject({ ok: true, kept: true, created: true, person: { name: 'Marion', relationship: 'wife', birthday: { day: 14, month: 3, year: null } } });
    // The same name again changes that person, whatever the case.
    const again = await call('memory.person', { name: 'marion', anniversary: { day: 21, month: 6, year: 2014 } }, ownerSaid('our anniversary with marion is 21 June 2014'));
    expect(again).toMatchObject({ kept: true, created: false, person: { name: 'Marion', relationship: 'wife', anniversary: { day: 21, month: 6, year: 2014 } } });
    expect(await listPeople(pool)).toHaveLength(1);
  });

  it('proposes instead when the owner did not say it: a mission, untrusted text in view, or another name', async () => {
    // No owner turn at all (a mission).
    const mission = await call('memory.person', { name: 'Ben', relationship: 'brother', why: 'His mail says so.' });
    expect(mission).toMatchObject({ ok: true, kept: false, proposed: true });
    // An owner turn, but mail was in view.
    const tainted = await call('memory.person', { name: 'Claire', relationship: 'accountant' }, {
      ...ownerSaid('who is Claire?'),
      provenance: () => ({ runId: null, turn: 1, step: 1, sources: [{ kind: 'mail', via: 'email.read', ref: 'm1' }] }),
    });
    expect(tainted).toMatchObject({ kept: false, proposed: true });
    // An owner turn that does not name the person.
    const unnamed = await call('memory.person', { name: 'Nkem', relationship: 'mother' }, ownerSaid('remember my mum'));
    expect(unnamed).toMatchObject({ kept: false, proposed: true });
    expect((await listPeople(pool)).map((p) => p.name)).toEqual(['Marion']);

    const open = (await listOpenProposals(pool)).filter((p) => (p.payload as { kind?: string }).kind === 'person');
    expect(open.map((p) => (p.payload as { matcher: { person: string } }).matcher.person).sort()).toEqual(['Ben', 'Claire', 'Nkem']);
    const ben = open.find((p) => (p.payload as { matcher: { person: string } }).matcher.person === 'Ben')!;
    expect(ben.payload).toMatchObject({ plugin: 'memory', action: 'Remember Ben: brother.', kindLabel: 'Remember a person' });
    const claire = open.find((p) => (p.payload as { matcher: { person: string } }).matcher.person === 'Claire')!;
    expect(claire.untrusted).toBe(true);

    // Keeping the card writes the person.
    const applied = await peoplePolicyHandler.apply(ben, { db: pool, now: clock });
    expect(applied).toMatchObject({ ok: true, note: 'Added Ben in People.' });
    expect(patchOfProposal(ben)).toEqual({ name: 'Ben', relationship: 'brother' });
    expect((await listPeople(pool)).map((p) => p.name)).toEqual(['Ben', 'Marion']);
  });

  it('lists with notes, forgets one and brings it back', async () => {
    const { person } = await upsertPerson(pool, { name: 'Ben', notes: 'Into cycling.', birthday: { day: 9, month: 10, year: 1991 } }, { by: 'owner', now: clock });
    const listed = await call('memory.people', { query: 'brother' });
    expect(listed.people).toEqual([expect.objectContaining({ name: 'Ben', notes: 'Into cycling.', next: [{ what: 'birthday', inDays: 6 }] })]);
    expect(await forgetPerson(pool, person.id, clock)).toMatchObject({ name: 'Ben' });
    expect((await listPeople(pool)).map((p) => p.name)).toEqual(['Marion']);
    expect(await restorePerson(pool, person.id)).toMatchObject({ name: 'Ben' });
    const out = await call('memory.forget_person', { id: person.id });
    expect(out).toEqual({ forgotten: true, name: 'Ben' });
  });

  it('refuses an impossible date and a rename onto another person', async () => {
    const bad = await call('memory.person', { name: 'Marion', birthday: { day: 31, month: 2 } }, ownerSaid('Marion was born 31 February'));
    expect(bad).toMatchObject({ ok: false, message: expect.stringContaining('real day and month') });
    const { person: zoe } = await upsertPerson(pool, { name: 'Zoe' }, { by: 'owner', now: clock });
    await expect(upsertPerson(pool, { id: zoe.id, name: 'MARION' }, { by: 'owner', now: clock })).rejects.toThrow('Marion is already in People.');
    await forgetPerson(pool, zoe.id, clock);
  });

  it('gives every agent the people in one line each, the soonest date first', async () => {
    await upsertPerson(pool, { name: 'Ben', relationship: 'brother', birthday: { day: 9, month: 10, year: 1991 } }, { by: 'owner', now: clock });
    const block = await buildPreamble(pool, 'scout', { now, timezone: 'Europe/Paris' });
    expect(block).toContain("People in the owner's life (memory.people has their notes):\n- Ben: brother; birthday 9 October 1991 (in 6 days, turning 35)\n- Marion: wife; birthday 14 March; anniversary 21 June 2014");
    expect(block).not.toContain('Into cycling');
  });

  it('proposes the people existing notes name, once, and never applies them', async () => {
    await pool.query(
      `insert into memory.notes (content, kind, scope, created_by_agent, created_at) values
         ('Lena is the owner''s sister; her birthday is 4 May.', 'fact', 'shared', 'concierge', $1),
         ('The owner''s accountant is Paul Martin.', 'fact', 'finance', 'finance', $1),
         ('Ben, the owner''s brother, lives in Brooklyn.', 'fact', 'shared', 'concierge', $1),
         ('The owner prefers short answers.', 'fact', 'shared', 'concierge', $1)`,
      [clock],
    );
    const buddi = createPluginHost(hostBindingOf(manifest), { db: pool, now, timezone: 'Europe/Paris', log: () => {} });
    const first = await peoplePolicyHandler.adopt!({ db: pool, now: clock, buddi });
    // Ben is in People already; Lena and Paul Martin are proposed.
    expect(first).toBe(2);
    const seeded = (await listOpenProposals(pool)).filter((p) => /^Remember (Lena|Paul Martin)/.test(String(p.payload.action)));
    expect(seeded.map((p) => p.payload.action).sort()).toEqual(['Remember Lena: sister, birthday 4 May.', 'Remember Paul Martin: accountant.']);
    expect(String(seeded[0]!.payload.why)).toMatch(/^Your notes name /);
    expect((await listPeople(pool)).map((p) => p.name)).not.toContain('Lena');
    // Once in an installation's life.
    expect(await peoplePolicyHandler.adopt!({ db: pool, now: clock, buddi })).toBe(0);
    expect((await pool.query(`select value from memory.meta where key = $1`, [SEED_KEY])).rows[0].value).toBe('2');
  });
});

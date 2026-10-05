/**
 * `owner.set_profile` and `owner.profile_gaps` against real Postgres: every
 * profile field reaches core's row (and so the next turn's context), a place
 * is looked up on a stubbed geocoder and saved with its zone, and the gaps
 * read the "knowing you" record from memory's preferences.
 *
 * The database is created by this suite, named after this process, and
 * dropped again: the owner's installation is never touched.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, getOwnerProfile, listOwnerPlaces, runMigrations, ToolRegistry, type CoreToolContext, type HttpArea } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import { bindOwnerTools, createOwnerManifest } from './agents/owner-tools.js';
import { systemContext } from './system-context.js';
import type { AgentCatalog } from './telegram/types.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_owner_profile_${process.pid}`;
const NOW = new Date('2026-09-14T14:00:00.000Z');

function urlFor(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const geocoder: HttpArea = {
  async request(req) {
    const name = new URL(req.url).searchParams.get('name') ?? '';
    const results = name === 'Lyon'
      ? [{ name: 'Lyon', latitude: 45.75, longitude: 4.85, timezone: 'Europe/Paris', admin1: 'Auvergne-Rhône-Alpes', country: 'France' }]
      : [];
    return { ok: true, status: 200, headers: {}, json: async () => ({ results }), text: async () => '' } as never;
  },
};

suite('the owner tools on a real profile', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;
  const registry = new ToolRegistry();
  const manifest = createOwnerManifest(registry);
  bindOwnerTools(registry, { catalog: { get: () => undefined } as unknown as AgentCatalog, placesHttp: geocoder });
  const tool = (name: string) => manifest.tools.find((t) => t.name === name)! as { execute(input: unknown, ctx: CoreToolContext): Promise<any> };

  beforeAll(async () => {
    admin = createPool(urlFor(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlFor(databaseUrl as string, DB));
    await runMigrations(pool, [memoryManifest]);
    ctx = { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC', agentId: 'concierge' } as CoreToolContext;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists "${DB}"`);
    await admin?.end();
  });

  it('writes every field, and the next turn is told', async () => {
    const result = await tool('owner.set_profile').execute({
      preferredName: 'Ada',
      fullName: 'Ada Lovelace',
      pronouns: 'she/her',
      timezone: 'Europe/London',
      language: 'English',
      about: 'Short answers.',
      birthday: { day: 10, month: 12, year: 1990 },
      timeFormat: '24h',
      dateFormat: 'long',
      places: [{ label: 'Work', address: 'Lyon' }],
    }, ctx);
    expect(result.ok).toBe(true);
    expect(await getOwnerProfile(pool)).toMatchObject({
      preferredName: 'Ada', fullName: 'Ada Lovelace', pronouns: 'she/her', timezone: 'Europe/London', language: 'English',
      about: 'Short answers.', birthday: { day: 10, month: 12, year: 1990 }, timeFormat: '24h', dateFormat: 'long',
    });
    expect(await listOwnerPlaces(pool)).toEqual([
      expect.objectContaining({ id: 'work', label: 'Work', address: 'Lyon', name: 'Lyon, Auvergne-Rhône-Alpes, France', timezone: 'Europe/Paris' }),
    ]);
    const next = await systemContext(ctx, { agentId: 'concierge', tools: [] }, { isFrontDesk: () => true });
    expect(next.prompt).toContain('Ada Lovelace');
    expect(next.prompt).toContain('she/her');
    expect(next.prompt).toContain('24-hour time');
    expect(next.prompt).toContain('Lyon, Auvergne-Rhône-Alpes, France');
  });

  it('clears a field back to empty', async () => {
    const result = await tool('owner.set_profile').execute({ clear: ['pronouns', 'dateFormat'] }, ctx);
    expect(result).toMatchObject({ ok: true, pronouns: null, dateFormat: null });
  });

  it('asks the owner before a clear, through the registry, and writes nothing until he says yes', async () => {
    const gated = new ToolRegistry();
    const owned = createOwnerManifest(gated);
    gated.register(owned);
    bindOwnerTools(gated, { catalog: { get: () => undefined } as unknown as AgentCatalog, placesHttp: geocoder });
    await tool('owner.set_profile').execute({ pronouns: 'they/them' }, ctx);

    const asked = await gated.invoke('owner.set_profile', { clear: ['pronouns'] }, ctx);
    expect(asked).toMatchObject({ ok: false, reason: 'approval-required' });
    expect((asked as { preview: string }).preview).toContain('Pronouns: cleared');
    expect((await getOwnerProfile(pool)).pronouns).toBe('they/them');

    // A plain set is still the owner's words recorded at once.
    expect(await gated.invoke('owner.set_profile', { about: 'Short answers, please.' }, ctx)).toMatchObject({ ok: true });
    expect((await getOwnerProfile(pool)).about).toBe('Short answers, please.');
  });

  it('reads the gaps and the "knowing you" record from memory', async () => {
    let gaps = await tool('owner.profile_gaps').execute({}, ctx);
    expect(gaps.gaps.map((g: any) => g.field)).toEqual(['places.home', 'dateFormat']);
    expect(gaps.nudge).toEqual({ field: 'places.home', why: expect.stringContaining('home') });

    await pool.query(
      `insert into memory.preferences (key, value, revision, agent_scope, created_at) values ('knowing_you_asked', 'places.home', 1, null, $1)`,
      [new Date('2026-09-12T10:00:00Z')],
    );
    gaps = await tool('owner.profile_gaps').execute({}, ctx);
    expect(gaps.gaps.find((g: any) => g.field === 'places.home').asked).toBe(true);
    expect(gaps.nudge).toBeNull();
    expect(gaps.lastAskedAt).toBe('2026-09-12T10:00:00.000Z');
  });
});

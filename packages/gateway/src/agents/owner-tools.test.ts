/**
 * The `owner.*` tools, against a temporary agent file and a stub database.
 *
 * The interesting one is `rename_me`: it is the only tool in the installation
 * that rewrites the configuration it is itself running under, so what it
 * *refuses* matters more than what it does.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type Queryable, type CoreToolContext, type HttpArea } from '@buddi/core';
import { EXAMPLES_AGENTS_DIR } from './catalog.js';
import {
  EXAMPLES_TREE_REFUSAL,
  bindOwnerTools,
  createOwnerManifest,
  handleShapeProblem,
  insideExamples,
} from './owner-tools.js';
import type { AgentCatalog, CatalogAgent } from '../telegram/types.js';

/* ---------------- a database that remembers almost nothing ---------------- */

class StubDb implements Queryable {
  profile: Record<string, unknown> = {
    preferred_name: null,
    timezone: null,
    language: null,
    display_name: null,
  };
  steps: string[] = [];
  rezonedFrom: string[] = [];
  state = 'in-progress';
  places: Array<Record<string, unknown>> = [];
  preferences: Array<{ key: string; value: string; created_at: Date }> = [];

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('select preferred_name')) return { rows: [this.profile] };
    if (text.startsWith('update core.owner_places')) {
      const place = this.places.find((p) => p.id === params[0]);
      if (!place) return { rows: [] };
      Object.assign(place, { label: params[1], address: params[2], place_name: params[3], latitude: params[4], longitude: params[5], timezone: params[6] });
      return { rows: [place] };
    }
    if (text.startsWith('update core.owner')) {
      const columns = ['preferred_name', 'timezone', 'language', 'about', 'time_format', 'date_format', 'full_name', 'pronouns'];
      columns.forEach((column, i) => {
        if (params[1 + i * 2]) this.profile[column] = params[2 + i * 2];
      });
      if (params[17]) Object.assign(this.profile, { birthday_day: params[18], birthday_month: params[19], birthday_year: params[20] });
      return { rows: [this.profile] };
    }
    if (text.startsWith('select id, label, address, place_name')) return { rows: [...this.places] };
    if (text.startsWith('insert into core.owner_places')) {
      const [id, label, address, place_name, latitude, longitude, timezone, position] = params;
      const place = { id, label, address, place_name, latitude, longitude, timezone, position };
      this.places.push(place);
      return { rows: [place] };
    }
    if (text.startsWith('delete from core.owner_places')) {
      const at = this.places.findIndex((p) => p.id === params[0]);
      return { rows: at < 0 ? [] : this.places.splice(at, 1) };
    }
    if (text.includes('from memory.preferences')) {
      const keys = params[0] as string[];
      return { rows: this.preferences.filter((p) => keys.includes(p.key)).sort((a, b) => b.created_at.getTime() - a.created_at.getTime()) };
    }
    if (text.startsWith('insert into core.owner')) return { rows: [{ id: 'owner' }] };
    if (text.startsWith('select owner_id, state')) {
      return {
        rows: [
          {
            owner_id: 'owner',
            state: this.state,
            started_at: null,
            completed_at: null,
            surface: null,
            steps_done: this.steps,
            nudges_sent: 0,
            last_nudge_at: null,
            unanswered: 0,
            quiet_until: null,
            updated_at: null,
          },
        ],
      };
    }
    if (text.startsWith('insert into core.onboarding')) {
      // markStepDone and completeOnboarding both land here.
      if (text.includes("'done'")) this.state = 'done';
      const step = params[1];
      if (typeof step === 'string' && !this.steps.includes(step)) this.steps.push(step);
      return {
        rows: [
          {
            owner_id: 'owner',
            state: this.state,
            started_at: null,
            completed_at: null,
            surface: null,
            steps_done: this.steps,
            nudges_sent: 0,
            last_nudge_at: null,
            unanswered: 0,
            quiet_until: null,
            updated_at: null,
          },
        ],
      };
    }
    // A new zone moves the schedules kept in the old one: none here.
    if (text.includes('from core.schedule_specs where active and timezone')) {
      this.rezonedFrom.push(params[0] as string);
      return { rows: [] };
    }
    throw new Error(`StubDb: unexpected sql: ${text}`);
  }
}

/* ---------------- an agent file on disk ---------------- */

const BODY = `You are the scribe.

## A heading with a --- inside it
- a bullet that must survive byte for byte
`;

function agentFile(dir: string, id: string, handle: string, name: string): string {
  const agentDir = path.join(dir, id);
  mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, 'agent.md');
  writeFileSync(
    file,
    `---\nid: ${id}\nhandle: ${handle}\nname: ${name}\ndescription: a test agent\ntools: []\n---\n\n${BODY}`,
  );
  return file;
}

function stubAgent(id: string, handle: string, name: string, file: string): CatalogAgent {
  return { id, handle, name, file } as unknown as CatalogAgent;
}

function catalogOf(agents: CatalogAgent[]): AgentCatalog {
  // Annotated, not cast: a catalog that grows a method has to grow it here too,
  // and the compiler is what says so.
  const catalog: AgentCatalog = {
    get: (id: string) => agents.find((a) => a.id === id),
    byHandle: (handle: string) =>
      agents.find((a) => a.handle.toLowerCase() === handle.replace(/^@/, '').toLowerCase()),
    list: () => agents as never,
    defaultAgent: () => agents[0] as CatalogAgent,
    agentsWithRole: () => [],
    agentForRole: () => ({ ok: false, problem: { code: 'no-agent-for-role', role: '', message: '' } }),
    resolve: (id?: string) => agents.find((a) => a.id === id) as CatalogAgent,
  };
  return catalog;
}

/** Open-Meteo, as far as these tests go: Lyon and Portland (twice), nothing else. */
const geocoded: string[] = [];
const geocoder: HttpArea = {
  async request(req) {
    const name = new URL(req.url).searchParams.get('name') ?? '';
    geocoded.push(name);
    const results =
      name === 'Lyon'
        ? [{ name: 'Lyon', latitude: 45.75, longitude: 4.85, timezone: 'Europe/Paris', admin1: 'Auvergne-Rhône-Alpes', country: 'France' }]
        : name === 'Portland'
          ? [
              { name: 'Portland', latitude: 45.52, longitude: -122.68, timezone: 'America/Los_Angeles', admin1: 'Oregon', country: 'United States' },
              { name: 'Portland', latitude: 43.66, longitude: -70.26, timezone: 'America/New_York', admin1: 'Maine', country: 'United States' },
            ]
          : [];
    return { ok: true, status: 200, headers: {}, json: async () => ({ results }), text: async () => '' } as never;
  },
};

interface Harness {
  tool(name: string): { execute(input: any, ctx: CoreToolContext): Promise<any> };
  ctx: CoreToolContext;
  db: StubDb;
  file: string;
}

function harness(opts: { file?: string; others?: CatalogAgent[]; agentId?: string } = {}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-owner-'));
  const file = opts.file ?? agentFile(dir, 'scribe', 'scribe', 'Scribe');
  const self = stubAgent('scribe', 'scribe', 'Scribe', file);
  const registry = new ToolRegistry();
  const manifest = createOwnerManifest(registry);
  bindOwnerTools(registry, { catalog: catalogOf([self, ...(opts.others ?? [])]), surface: 'cli', placesHttp: geocoder });
  const db = new StubDb();
  const ctx = {
    db: db as unknown as CoreToolContext['db'],
    ownerId: 'owner',
    now: () => new Date('2026-09-14T12:00:00Z'),
    timezone: 'America/New_York',
    agentId: opts.agentId ?? 'scribe',
  } as CoreToolContext;
  return {
    tool: (name) => manifest.tools.find((t) => t.name === name) as never,
    ctx,
    db,
    file,
  };
}

/* ---------------- the pure bits ---------------- */

describe('handleShapeProblem', () => {
  it('accepts what the catalog accepts', () => {
    for (const handle of ['ledger', 'night-desk', '@ada', 'a1', 'Ada']) {
      expect(handleShapeProblem(handle), handle).toBeUndefined();
    }
  });

  it('refuses a shape the loader would refuse', () => {
    for (const handle of ['a', '1st', 'with space', 'ends-', '@', 'x'.repeat(21)]) {
      expect(handleShapeProblem(handle), handle).toBeTypeOf('string');
    }
  });
});

describe('insideExamples', () => {
  it('catches a file in the shipped tree and nothing that merely looks like it', () => {
    expect(insideExamples(path.join(EXAMPLES_AGENTS_DIR, 'concierge', 'agent.md'))).toBe(true);
    expect(insideExamples('/home/me/examples-of-mine/agents/x/agent.md')).toBe(false);
    expect(insideExamples('/home/me/private/agents/scribe/agent.md')).toBe(false);
  });
});

/* ---------------- the profile ---------------- */

describe('owner.set_profile', () => {
  it('records what the owner said, and marks the steps it covers', async () => {
    const h = harness();
    const result = await h
      .tool('owner.set_profile')
      .execute({ preferredName: 'Amen', timezone: 'Europe/Paris' }, h.ctx);
    expect(result.ok).toBe(true);
    expect(result.preferredName).toBe('Amen');
    expect(h.db.steps).toEqual(['name', 'timezone']);
    // The zone changed from the fallback, so the schedules kept in it were looked for.
    expect(h.db.rezonedFrom).toHaveLength(1);
  });

  it('refuses a zone Intl does not know, and writes nothing', async () => {
    const h = harness();
    const result = await h.tool('owner.set_profile').execute({ timezone: 'Mars/Olympus' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-timezone');
    expect(result.message).toContain('not a timezone I know');
    // No alternatives are offered: guessing a zone is how an installation ends
    // up a day off.
    expect(result.message).not.toContain('America/');
    expect(h.db.profile.timezone).toBeNull();
    expect(h.db.steps).toEqual([]);
  });

  it('reports the detected zone so the agent can confirm rather than ask', async () => {
    const h = harness();
    const profile = await h.tool('owner.get_profile').execute({}, h.ctx);
    expect(profile.detectedTimezone).toBe('America/New_York');
    expect(profile.preferredName).toBeNull();
  });

  it.each([
    ['preferredName', 'Amen', 'preferred_name', 'Amen'],
    ['fullName', 'Amenophis Ouzou', 'full_name', 'Amenophis Ouzou'],
    ['pronouns', 'he/him', 'pronouns', 'he/him'],
    ['language', 'French', 'language', 'French'],
    ['about', 'Short answers, please.', 'about', 'Short answers, please.'],
    ['timeFormat', '24h', 'time_format', '24h'],
    ['dateFormat', 'long', 'date_format', 'long'],
  ] as const)('records %s as said', async (field, value, column, stored) => {
    const h = harness();
    const result = await h.tool('owner.set_profile').execute({ [field]: value }, h.ctx);
    expect(result.ok).toBe(true);
    expect(result[field]).toBe(value);
    expect(h.db.profile[column]).toBe(stored);
  });

  it('records the birthday, the year only when given, and refuses a day that does not exist', async () => {
    const h = harness();
    expect((await h.tool('owner.set_profile').execute({ birthday: { day: 29, month: 2 } }, h.ctx)).birthday).toEqual({ day: 29, month: 2, year: null });
    const bad = await h.tool('owner.set_profile').execute({ birthday: { day: 31, month: 4 } }, h.ctx);
    expect(bad).toMatchObject({ ok: false, reason: 'unknown-day' });
    expect(bad.message).toContain('nothing was recorded');
    expect(h.db.profile.birthday_month).toBe(2);
  });

  it('refuses what Settings → Profile refuses, in its words', async () => {
    const h = harness();
    const long = await h.tool('owner.set_profile').execute({ about: 'x'.repeat(1001) }, h.ctx);
    // Over the tool's own schema too, but the execute path says the page's sentence.
    expect(long.ok).toBe(false);
    expect(long.message).toContain('Keep the line about you under 1,000 characters.');
    expect(h.db.profile.about).toBeUndefined();
  });

  it('clears a field the owner asked to forget, and a cleared format is Auto', async () => {
    const h = harness();
    await h.tool('owner.set_profile').execute({ pronouns: 'she/her', timeFormat: '12h' }, h.ctx);
    const result = await h.tool('owner.set_profile').execute({ clear: ['pronouns', 'timeFormat'] }, h.ctx);
    expect(result).toMatchObject({ ok: true, pronouns: null, timeFormat: null });
    const both = await h.tool('owner.set_profile').execute({ pronouns: 'they/them', clear: ['pronouns'] }, h.ctx);
    expect(both).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('refuses an empty change rather than claiming to have recorded it', async () => {
    const h = harness();
    expect(await h.tool('owner.set_profile').execute({}, h.ctx)).toMatchObject({ ok: false, reason: 'nothing-to-do' });
  });

  it('saves a place through the geocoder, with the town and its zone, and says what it matched', async () => {
    const h = harness();
    const result = await h.tool('owner.set_profile').execute({ places: [{ label: 'Work', address: '12 rue Neuve, Lyon' }] }, h.ctx);
    expect(result.ok).toBe(true);
    expect(result.placesSaved).toEqual([
      { label: 'Work', address: '12 rue Neuve, Lyon', matched: 'Lyon, Auvergne-Rhône-Alpes, France', timezone: 'Europe/Paris', otherMatches: [] },
    ]);
    expect(h.db.places).toHaveLength(1);
    expect(h.db.places[0]).toMatchObject({ id: 'work', label: 'Work', address: '12 rue Neuve, Lyon', timezone: 'Europe/Paris', position: 1 });
    // The street stays here: only the town's parts were asked for.
    expect(geocoded).not.toContain('12 rue Neuve');
  });

  it('changes a place already called that instead of adding a second, and reports the other towns', async () => {
    const h = harness();
    await h.tool('owner.set_profile').execute({ places: [{ label: 'Home', address: 'Lyon' }] }, h.ctx);
    const result = await h.tool('owner.set_profile').execute({ places: [{ label: 'home', address: 'Portland' }] }, h.ctx);
    expect(h.db.places).toHaveLength(1);
    expect(h.db.places[0]).toMatchObject({ id: 'home', label: 'Home', timezone: 'America/Los_Angeles' });
    expect(result.placesSaved[0].otherMatches).toEqual(['Portland, Maine, United States']);
  });

  it('says which place it could not find, saves the rest, and removes by label', async () => {
    const h = harness();
    await h.tool('owner.set_profile').execute({ places: [{ label: 'Home', address: 'Lyon' }] }, h.ctx);
    const result = await h.tool('owner.set_profile').execute(
      { places: [{ label: 'Gym', address: 'Nowhereville' }], removePlaces: ['Home', 'Cabin'] },
      h.ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.placesNotSaved).toEqual([{ label: 'Gym', reason: expect.stringContaining('Nothing matched "Nowhereville"') }]);
    expect(result.placesRemoved).toEqual(['Home']);
    expect(result.placesNotFound).toEqual(['Cabin']);
    expect(h.db.places).toEqual([]);
  });

  it('goes gated with a card when it clears a field or removes a place', async () => {
    const h = harness();
    const tool = h.tool('owner.set_profile') as unknown as {
      tierFor(input: unknown, ctx: unknown): Promise<{ tier: string; reason?: string }>;
      describe(input: unknown, ctx: unknown): Promise<{ envelope: unknown; preview: string }>;
    };
    expect(await tool.tierFor({ clear: ['pronouns'] }, h.ctx)).toMatchObject({ tier: 'gated' });
    expect(await tool.tierFor({ removePlaces: ['Home'] }, h.ctx)).toMatchObject({ tier: 'gated' });
    const card = await tool.describe({ fullName: 'Ada Lovelace', clear: ['pronouns'], removePlaces: ['Work'] }, h.ctx);
    expect(card.preview).toBe('Change your profile:\nFull name: Ada Lovelace\nPronouns: cleared\nRemove the place Work');
    expect(card.envelope).toMatchObject({ kind: 'profile_update', change: { profile: { pronouns: null }, removePlaces: ['Work'] } });
  });

  it('stays auto for a plain set, and for a call it will refuse anyway', async () => {
    const h = harness();
    const tool = h.tool('owner.set_profile') as unknown as {
      tierFor(input: unknown, ctx: unknown): Promise<{ tier: string; reason?: string }>;
      describe(input: unknown, ctx: unknown): Promise<{ envelope: unknown; preview: string }>;
    };
    expect(await tool.tierFor({ preferredName: 'Amen', places: [{ label: 'Home', address: 'Lyon' }] }, h.ctx)).toEqual({ tier: 'auto' });
    expect(await tool.tierFor({ pronouns: 'she/her', clear: ['pronouns'] }, h.ctx)).toEqual({ tier: 'auto' });
  });

  it('looks up one place per call, and refuses a batch before asking the finder', async () => {
    const h = harness();
    const before = geocoded.length;
    const result = await h.tool('owner.set_profile').execute(
      { places: [{ label: 'Home', address: 'Lyon' }, { label: 'Work', address: 'Portland' }] },
      h.ctx,
    );
    expect(result).toMatchObject({ ok: false, reason: 'one-place' });
    expect(geocoded.length).toBe(before);
  });

  it('refuses a place with no address before looking anything up', async () => {
    const h = harness();
    const before = geocoded.length;
    const result = await h.tool('owner.set_profile').execute({ places: [{ label: 'Work', address: ' x ' }] }, h.ctx);
    expect(result).toMatchObject({ ok: false, reason: 'invalid-place' });
    expect(geocoded.length).toBe(before);
  });

  it('get_profile carries every field and the places', async () => {
    const h = harness();
    await h.tool('owner.set_profile').execute({ fullName: 'Ada Lovelace', places: [{ label: 'Home', address: 'Lyon' }] }, h.ctx);
    const profile = await h.tool('owner.get_profile').execute({}, h.ctx);
    expect(profile).toMatchObject({ fullName: 'Ada Lovelace', pronouns: null, timeFormat: null, dateFormat: null, birthday: null });
    expect(profile.places).toEqual([{ label: 'Home', address: 'Lyon', matched: 'Lyon, Auvergne-Rhône-Alpes, France', timezone: 'Europe/Paris' }]);
  });
});

describe('owner.profile_gaps', () => {
  it('lists the empty useful fields, each with why it matters, the language among them, and never pronouns', async () => {
    const h = harness();
    const result = await h.tool('owner.profile_gaps').execute({}, h.ctx);
    const fields = result.gaps.map((g: any) => g.field);
    expect(fields).toEqual(['preferredName', 'timezone', 'language', 'fullName', 'places.home', 'places.work', 'birthday', 'timeFormat', 'dateFormat', 'about']);
    expect(fields).not.toContain('pronouns');
    expect(result.gaps.find((g: any) => g.field === 'language').why).toContain('too short to tell');
    expect(result.gaps.find((g: any) => g.field === 'fullName').why).toBe('letters, forms and bookings');
    expect(result.gaps.find((g: any) => g.field === 'places.work').why).toContain('"how long to work?"');
    expect(result.nudge).toEqual({ field: 'preferredName', why: 'what every agent calls you' });
    expect(result).toMatchObject({ filled: 0, of: 10, lastAskedAt: null });
  });

  it('drops a field once it is filled', async () => {
    const h = harness();
    await h.tool('owner.set_profile').execute({ fullName: 'Ada Lovelace', language: 'French', places: [{ label: 'Work', address: 'Lyon' }] }, h.ctx);
    const fields = (await h.tool('owner.profile_gaps').execute({}, h.ctx)).gaps.map((g: any) => g.field);
    expect(fields).not.toContain('fullName');
    expect(fields).not.toContain('places.work');
    expect(fields).not.toContain('language');
    expect(fields).toContain('places.home');
  });

  it('never nudges twice for one field, nor about a declined one, and at most once a week', async () => {
    const h = harness();
    h.db.preferences.push(
      { key: 'knowing_you_asked', value: 'preferredName, timezone, language', created_at: new Date('2026-09-10T09:00:00Z') },
      { key: 'knowing_you_dont_ask', value: 'fullName', created_at: new Date('2026-09-01T09:00:00Z') },
    );
    const result = await h.tool('owner.profile_gaps').execute({}, h.ctx);
    expect(result.gaps.find((g: any) => g.field === 'timezone')).toMatchObject({ asked: true, declined: false });
    expect(result.gaps.find((g: any) => g.field === 'fullName')).toMatchObject({ asked: false, declined: true });
    // Four days since the last one: no nudge yet.
    expect(result.nudge).toBeNull();
    expect(result.lastAskedAt).toBe('2026-09-10T09:00:00.000Z');

    h.db.preferences[0]!.created_at = new Date('2026-09-06T09:00:00Z');
    const later = await h.tool('owner.profile_gaps').execute({}, h.ctx);
    expect(later.nudge?.field).toBe('places.home');
  });

  it('stops nudging altogether when the owner said not to ask at all', async () => {
    const h = harness();
    h.db.preferences.push({ key: 'knowing_you_dont_ask', value: 'all of it', created_at: new Date('2026-09-01T09:00:00Z') });
    const result = await h.tool('owner.profile_gaps').execute({}, h.ctx);
    expect(result.nudge).toBeNull();
    expect(result.gaps.every((g: any) => g.declined)).toBe(true);
  });
});

/* ---------------- renaming the caller ---------------- */

describe('owner.rename_me', () => {
  it('rewrites its own frontmatter and leaves the body byte for byte', async () => {
    const h = harness();
    const before = readFileSync(h.file, 'utf8');

    const result = await h.tool('owner.rename_me').execute({ name: 'Ada', handle: 'ada' }, h.ctx);
    expect(result.ok).toBe(true);
    expect(result.handle).toBe('ada');
    expect(result.message).toContain('restart');

    const after = readFileSync(h.file, 'utf8');
    expect(after).toContain('handle: ada');
    expect(after).toContain('name: Ada');
    expect(after.slice(after.indexOf('You are the scribe.'))).toBe(
      before.slice(before.indexOf('You are the scribe.')),
    );
    expect(h.db.steps).toEqual(['agent-name']);
  });

  it('normalizes the handle the model wrote', async () => {
    const h = harness();
    const result = await h.tool('owner.rename_me').execute({ handle: '@Ada' }, h.ctx);
    expect(result.ok).toBe(true);
    expect(readFileSync(h.file, 'utf8')).toContain('handle: ada');
  });

  it('refuses a handle another installed agent already answers to', async () => {
    const other = stubAgent('ledger', 'ada', 'Finance Advisor', '/nowhere/agent.md');
    const h = harness({ others: [other] });
    const before = readFileSync(h.file, 'utf8');

    const result = await h.tool('owner.rename_me').execute({ handle: 'ada' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('handle-taken');
    expect(result.message).toContain('Finance Advisor');
    expect(readFileSync(h.file, 'utf8')).toBe(before);
  });

  it('refuses a handle the loader would refuse, and writes nothing', async () => {
    const h = harness();
    const before = readFileSync(h.file, 'utf8');
    const result = await h.tool('owner.rename_me').execute({ handle: 'Big Ada!' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-handle');
    expect(readFileSync(h.file, 'utf8')).toBe(before);
  });

  it('refuses entirely when its own file is one of the shipped examples', async () => {
    const h = harness({ file: path.join(EXAMPLES_AGENTS_DIR, 'concierge', 'agent.md') });
    const before = readFileSync(h.file, 'utf8');

    const result = await h.tool('owner.rename_me').execute({ name: 'Ada' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('examples-tree');
    expect(result.message).toBe(EXAMPLES_TREE_REFUSAL);
    expect(result.message).toContain('buddi init');
    expect(readFileSync(h.file, 'utf8')).toBe(before);
  });

  it('refuses when it cannot tell which file is its own', async () => {
    const h = harness({ agentId: 'someone-else' });
    const result = await h.tool('owner.rename_me').execute({ name: 'Ada' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-self');
  });
});

describe('owner.finish_onboarding', () => {
  it('marks it done and says what was configured', async () => {
    const h = harness();
    await h.tool('owner.set_profile').execute({ preferredName: 'Amen' }, h.ctx);
    const result = await h.tool('owner.finish_onboarding').execute({}, h.ctx);
    expect(result.ok).toBe(true);
    expect(result.configured.preferredName).toBe('Amen');
    expect(h.db.state).toBe('done');
  });
});

describe('the descriptions the model reads', () => {
  it('tell it to ask one thing at a time and invent nothing', () => {
    const manifest = createOwnerManifest(new ToolRegistry());
    // owner.notify is not part of the interview; its own rules are in its description.
    for (const tool of manifest.tools.filter((t) => t.name !== 'owner.notify')) {
      expect(tool.tier, tool.name).toBe('auto');
      expect(tool.description, tool.name).toContain('one thing at a time');
      expect(tool.description, tool.name).toContain('never');
    }
  });
});

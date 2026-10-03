/**
 * People: the owner's people as a structured kind of memory (docs/memory.md,
 * "People").
 *
 * A person is a name, who they are to the owner, how to address them, a
 * birthday and an anniversary (day and month, the year optional) and a few
 * notes. Every agent reads the list as compact context, one line each
 * (`peopleLines`); the notes are read only when an agent looks a person up.
 *
 * Writes come from three places, under one rule — the owner decides who is in
 * it:
 *  - the owner, in Settings → Memory → People (`upsertPerson` with `by: 'owner'`);
 *  - an agent, with `memory.person`: straight away only when the owner named
 *    the person in the very turn the agent is answering and nothing untrusted
 *    is in view; otherwise as a proposal card the owner keeps or discards;
 *  - once, the existing notes that name a person (`seedFromNotes`), each as a
 *    proposal, never applied.
 *
 * Like every memory: context, never permission.
 */
import type {
  DayMonth,
  PolicyApplyResult,
  PolicyHandler,
  PolicyHandlerContext,
  Proposal,
  ToolContext,
  ToolDefinition,
} from '@buddi/core/plugin';
import { dayMonthText, daysUntil, turning, validDayMonth } from '@buddi/core/plugin';
import { z } from 'zod';
import { toIso } from './tools/shared.js';

type Db = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

export const MEMORY_PLUGIN = 'memory';
/** The proposal kind a person card carries (`payload.kind`): the inbox groups and counts by it. */
export const PERSON_KIND = 'person';
export const PERSON_KIND_LABEL = 'Remember a person';
export const NAME_MAX = 80;
export const RELATIONSHIP_MAX = 60;
export const NOTES_MAX = 1000;
/** At most this many people are read into a prompt; the rest are a lookup away. */
export const PEOPLE_CONTEXT_MAX = 40;

export interface PersonView {
  id: string;
  name: string;
  relationship: string | null;
  /** How agents address them ("Mum"); null is their name. */
  addressAs: string | null;
  birthday: DayMonth | null;
  anniversary: DayMonth | null;
  notes: string | null;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** What a write may change. Absent leaves a field alone; null clears it. */
export interface PersonPatch {
  name?: string;
  relationship?: string | null;
  addressAs?: string | null;
  birthday?: DayMonth | null;
  anniversary?: DayMonth | null;
  notes?: string | null;
}

const COLUMNS = `id, name, relationship, address_as, birthday_day, birthday_month, birthday_year,
  anniversary_day, anniversary_month, anniversary_year, notes, created_by, created_at, updated_at`;

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

function dateOf(day: unknown, month: unknown, year: unknown): DayMonth | null {
  if (day === null || day === undefined || month === null || month === undefined) return null;
  return validDayMonth({ day, month, year });
}

export function toPerson(row: any): PersonView {
  return {
    id: String(row.id),
    name: String(row.name),
    relationship: text(row.relationship),
    addressAs: text(row.address_as),
    birthday: dateOf(row.birthday_day, row.birthday_month, row.birthday_year),
    anniversary: dateOf(row.anniversary_day, row.anniversary_month, row.anniversary_year),
    notes: text(row.notes),
    createdBy: String(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Every live person, by name. */
export async function listPeople(db: Db, opts: { query?: string } = {}): Promise<PersonView[]> {
  const q = opts.query?.trim() ?? '';
  const { rows } = await db.query(
    `select ${COLUMNS} from memory.people
      where deleted_at is null
        and ($1::text = '' or name ilike $2 or coalesce(relationship, '') ilike $2 or coalesce(address_as, '') ilike $2)
      order by lower(name) asc
      limit 500`,
    [q, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`],
  );
  return rows.map(toPerson);
}

export async function getPerson(db: Db, id: string): Promise<PersonView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query(`select ${COLUMNS} from memory.people where id = $1 and deleted_at is null`, [id]);
  return rows[0] ? toPerson(rows[0]) : null;
}

/** The live person with this name, whatever the case. */
export async function findPersonByName(db: Db, name: string): Promise<PersonView | null> {
  const { rows } = await db.query(
    `select ${COLUMNS} from memory.people where deleted_at is null and lower(name) = lower($1)`,
    [name.trim()],
  );
  return rows[0] ? toPerson(rows[0]) : null;
}

export class PersonRefusal extends Error {}

/** Clean a patch: lengths, real dates. Throws `PersonRefusal` with a sentence the owner can read. */
export function checkPatch(patch: PersonPatch, creating: boolean): PersonPatch {
  const out: PersonPatch = {};
  if (patch.name !== undefined || creating) {
    const name = text(patch.name);
    if (!name) throw new PersonRefusal('A person needs a name.');
    if (name.length > NAME_MAX) throw new PersonRefusal(`A name is ${NAME_MAX} characters at most.`);
    out.name = name;
  }
  for (const key of ['relationship', 'addressAs'] as const) {
    if (patch[key] === undefined) continue;
    const value = text(patch[key]);
    if (value && value.length > (key === 'relationship' ? RELATIONSHIP_MAX : NAME_MAX)) {
      throw new PersonRefusal(key === 'relationship' ? `Who they are to you is ${RELATIONSHIP_MAX} characters at most.` : `How to address them is ${NAME_MAX} characters at most.`);
    }
    out[key] = value;
  }
  if (patch.notes !== undefined) {
    const notes = text(patch.notes);
    if (notes && notes.length > NOTES_MAX) throw new PersonRefusal(`Notes are ${NOTES_MAX} characters at most.`);
    out.notes = notes;
  }
  for (const key of ['birthday', 'anniversary'] as const) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null) { out[key] = null; continue; }
    const date = validDayMonth(patch[key]);
    if (!date) throw new PersonRefusal(`The ${key} needs a real day and month; the year is optional.`);
    out[key] = date;
  }
  return out;
}

/**
 * Add a person, or change one (by id, else by name). Absent fields are left
 * alone. Returns the person as stored and whether it was new.
 */
export async function upsertPerson(
  db: Db,
  input: PersonPatch & { id?: string },
  opts: { by: string; conversationId?: string | null; now: Date },
): Promise<{ person: PersonView; created: boolean }> {
  const existing = input.id
    ? await getPerson(db, input.id)
    : input.name ? await findPersonByName(db, input.name) : null;
  if (input.id && !existing) throw new PersonRefusal('That person is not in People any more.');
  const patch = checkPatch(input, !existing);
  // Found by name, the name stays as it was written first: "marion" changes Marion, it does not rename her.
  if (existing && !input.id) delete patch.name;
  if (existing) {
    // A rename onto another live person's name would make two of them.
    if (patch.name && patch.name.toLowerCase() !== existing.name.toLowerCase()) {
      const clash = await findPersonByName(db, patch.name);
      if (clash) throw new PersonRefusal(`${clash.name} is already in People.`);
    }
    const has = (key: keyof PersonPatch): boolean => patch[key] !== undefined;
    const { rows } = await db.query(
      `update memory.people set
          name = coalesce($2, name),
          relationship = case when $3::boolean then $4 else relationship end,
          address_as = case when $5::boolean then $6 else address_as end,
          birthday_day = case when $7::boolean then $8::smallint else birthday_day end,
          birthday_month = case when $7::boolean then $9::smallint else birthday_month end,
          birthday_year = case when $7::boolean then $10::smallint else birthday_year end,
          anniversary_day = case when $11::boolean then $12::smallint else anniversary_day end,
          anniversary_month = case when $11::boolean then $13::smallint else anniversary_month end,
          anniversary_year = case when $11::boolean then $14::smallint else anniversary_year end,
          notes = case when $15::boolean then $16 else notes end,
          updated_at = $17
        where id = $1 and deleted_at is null
        returning ${COLUMNS}`,
      [
        existing.id, patch.name ?? null,
        has('relationship'), patch.relationship ?? null,
        has('addressAs'), patch.addressAs ?? null,
        has('birthday'), patch.birthday?.day ?? null, patch.birthday?.month ?? null, patch.birthday?.year ?? null,
        has('anniversary'), patch.anniversary?.day ?? null, patch.anniversary?.month ?? null, patch.anniversary?.year ?? null,
        has('notes'), patch.notes ?? null,
        opts.now,
      ],
    );
    return { person: toPerson(rows[0]), created: false };
  }
  const { rows } = await db.query(
    `insert into memory.people (name, relationship, address_as, birthday_day, birthday_month, birthday_year,
        anniversary_day, anniversary_month, anniversary_year, notes, created_by, source_conversation_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
     returning ${COLUMNS}`,
    [
      patch.name, patch.relationship ?? null, patch.addressAs ?? null,
      patch.birthday?.day ?? null, patch.birthday?.month ?? null, patch.birthday?.year ?? null,
      patch.anniversary?.day ?? null, patch.anniversary?.month ?? null, patch.anniversary?.year ?? null,
      patch.notes ?? null, opts.by, opts.conversationId ?? null, opts.now,
    ],
  );
  return { person: toPerson(rows[0]), created: true };
}

/** Forget one person: a soft delete, like a note. False when there was none. */
export async function forgetPerson(db: Db, id: string, now: Date): Promise<PersonView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query(
    `update memory.people set deleted_at = $2 where id = $1 and deleted_at is null returning ${COLUMNS}`,
    [id, now],
  );
  return rows[0] ? toPerson(rows[0]) : null;
}

/** Bring a forgotten person back (Undo on the page). */
export async function restorePerson(db: Db, id: string): Promise<PersonView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query(
    `update memory.people p set deleted_at = null
      where p.id = $1 and p.deleted_at is not null
        and not exists (select 1 from memory.people o where o.deleted_at is null and lower(o.name) = lower(p.name))
      returning ${COLUMNS}`,
    [id],
  );
  return rows[0] ? toPerson(rows[0]) : null;
}

/* ------------------------------------------------------------------ *
 * The compact context
 * ------------------------------------------------------------------ */

/** One date as a prompt reads it: "birthday 14 March (in 5 days, turning 35)". */
function dateWords(label: string, date: DayMonth, today: string | null): string {
  let words = `${label} ${dayMonthText(date)}`;
  if (today) {
    const until = daysUntil(date, today);
    const age = turning(date, today);
    const years = age !== null && label === 'anniversary' ? `${age} years` : age !== null ? `turning ${age}` : null;
    if (until === 0) words += ` (today${years ? `, ${years}` : ''})`;
    else if (until <= 14) words += ` (in ${until} ${until === 1 ? 'day' : 'days'}${years ? `, ${years}` : ''})`;
  }
  return words;
}

/** One line per person, the notes left out. `today` (owner-local `YYYY-MM-DD`) adds "in 5 days". */
export function personLine(p: PersonView, today: string | null): string {
  const parts: string[] = [];
  if (p.relationship) parts.push(p.relationship);
  if (p.addressAs && p.addressAs.toLowerCase() !== p.name.toLowerCase()) parts.push(`addressed as "${p.addressAs}"`);
  if (p.birthday) parts.push(dateWords('birthday', p.birthday, today));
  if (p.anniversary) parts.push(dateWords('anniversary', p.anniversary, today));
  const clip = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return `- ${clip(p.name)}${parts.length > 0 ? `: ${clip(parts.join('; '))}` : ''}`;
}

/**
 * The people block every agent reads: the soonest dates first, then by name;
 * at most `PEOPLE_CONTEXT_MAX`, with a count of the rest.
 */
export function peopleLines(people: readonly PersonView[], today: string | null): string[] {
  const soon = (p: PersonView): number => {
    if (!today) return 999;
    const days = [p.birthday, p.anniversary].filter((d): d is DayMonth => d !== null).map((d) => daysUntil(d, today));
    return days.length > 0 ? Math.min(...days) : 999;
  };
  const sorted = [...people].sort((a, b) => soon(a) - soon(b) || a.name.localeCompare(b.name));
  const lines = sorted.slice(0, PEOPLE_CONTEXT_MAX).map((p) => personLine(p, today));
  if (sorted.length > PEOPLE_CONTEXT_MAX) lines.push(`- …and ${sorted.length - PEOPLE_CONTEXT_MAX} more (memory.people finds them).`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * The tools
 * ------------------------------------------------------------------ */

const dayMonthInput = z
  .object({
    day: z.number().int().min(1).max(31),
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(1900).max(2100).optional().describe('Only when it was said.'),
  })
  .nullable()
  .optional();

const personInput = z.object({
  name: z.string().min(1).max(NAME_MAX).describe('Their name as the owner says it: "Marion", "Ben Okafor". The same name again changes that person.'),
  relationship: z.string().max(RELATIONSHIP_MAX).nullable().optional().describe('Who they are to the owner, in a word or two: "wife", "brother", "accountant".'),
  addressAs: z.string().max(NAME_MAX).nullable().optional().describe('How to address them, when it differs from their name: "Mum", "Dr Lee".'),
  birthday: dayMonthInput.describe('Their birthday: day and month, the year only when it was said. null clears it.'),
  anniversary: dayMonthInput.describe('An anniversary the owner keeps with them (a wedding): day and month, the year only when it was said.'),
  notes: z.string().max(NOTES_MAX).nullable().optional().describe('A few lines worth keeping: gift ideas, allergies, what they are into. Replaces what was there; read the person first to add to it.'),
  why: z.string().min(1).max(300).optional().describe('One sentence on where you learned this, for the owner\'s card when it needs their OK.'),
});

/** Untrusted inputs in view, from the run's own record (never the model's). */
function untrustedInView(ctx: ToolContext): readonly { kind: string; via: string; ref?: string }[] {
  try { return ctx.provenance?.().sources ?? []; } catch { return []; }
}

/**
 * The owner said it himself: an authenticated owner turn (not a mission, a
 * watcher or a delegate), nothing untrusted in view, and the person's name in
 * the owner's own words of this turn.
 */
export function ownerStatedIt(ctx: ToolContext, name: string, now: Date): boolean {
  const request = ctx.ownerRequest;
  if (!request || request.expiresAt <= now.getTime()) return false;
  if ((ctx.delegationDepth ?? 0) > 0) return false;
  if (untrustedInView(ctx).length > 0) return false;
  const said = request.text.toLowerCase();
  const first = name.trim().split(/\s+/)[0]!.toLowerCase();
  return first.length >= 2 && said.includes(first);
}

/** The card's one sentence: "Remember Marion: wife, birthday 14 March." */
export function proposalSentence(name: string, patch: PersonPatch, existing: PersonView | null): string {
  const bits: string[] = [];
  if (patch.relationship) bits.push(patch.relationship);
  if (patch.addressAs) bits.push(`addressed as "${patch.addressAs}"`);
  if (patch.birthday) bits.push(`birthday ${dayMonthText(patch.birthday)}`);
  if (patch.anniversary) bits.push(`anniversary ${dayMonthText(patch.anniversary)}`);
  if (patch.notes) bits.push(`notes: ${patch.notes.length > 80 ? `${patch.notes.slice(0, 79)}…` : patch.notes}`);
  const verb = existing ? `Update ${existing.name}` : `Remember ${name}`;
  return bits.length > 0 ? `${verb}: ${bits.join(', ')}.` : `${verb}.`;
}

/** The patch as a proposal carries it: only what was said, nothing undefined. */
function payloadOf(patch: PersonPatch & { name?: string }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

export const person: ToolDefinition<z.infer<typeof personInput>, unknown> = {
  name: 'memory.person',
  description:
    'Remember someone in the owner\'s life, or change what you know about them: name, who they are to the owner, how to address them, ' +
    'their birthday and an anniversary, a few notes. Every agent then knows them. When the owner just told you about them in this turn it is ' +
    'kept at once; otherwise (you inferred it, read it in mail or on a page, a mission noticed it) the owner gets a card to keep or discard, ' +
    'and it is not known until they keep it. Prefer this to memory.note for anything about a person. Never permission to contact them.',
  tier: 'auto',
  input: personInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const now = buddi.clock.now();
    const { why, ...fields } = input;
    const scrub = (value: string | null | undefined): string | null | undefined =>
      typeof value === 'string' ? buddi.scrub(value) : value;
    const patch: PersonPatch = {
      name: fields.name,
      ...(fields.relationship !== undefined ? { relationship: scrub(fields.relationship) ?? null } : {}),
      ...(fields.addressAs !== undefined ? { addressAs: scrub(fields.addressAs) ?? null } : {}),
      ...(fields.birthday !== undefined ? { birthday: fields.birthday === null ? null : { ...fields.birthday, year: fields.birthday.year ?? null } } : {}),
      ...(fields.anniversary !== undefined ? { anniversary: fields.anniversary === null ? null : { ...fields.anniversary, year: fields.anniversary.year ?? null } } : {}),
      ...(fields.notes !== undefined ? { notes: scrub(fields.notes) ?? null } : {}),
    };
    let checked: PersonPatch;
    try { checked = checkPatch(patch, true); }
    catch (err) { if (err instanceof PersonRefusal) return { ok: false, message: err.message }; throw err; }
    const existing = await findPersonByName(buddi.db, checked.name!);

    if (ownerStatedIt(ctx, checked.name!, now)) {
      const { person: saved, created } = await upsertPerson(buddi.db, checked, { by: ctx.agentId ?? 'unknown', conversationId: ctx.conversationId ?? null, now });
      return { ok: true, kept: true, created, person: saved, message: `${created ? 'Added' : 'Updated'} ${saved.name} in People.` };
    }

    const proposals = buddi.proposals;
    if (!proposals) return { ok: false, message: 'People cannot take a proposal in this process; tell the owner what you would add.' };
    const sentence = proposalSentence(checked.name!, checked, existing);
    const result = await proposals.proposePolicy(ctx, {
      matcher: { person: existing?.name ?? checked.name!, ...(existing ? { personId: existing.id } : {}) },
      action: sentence,
      params: { person: payloadOf(checked) },
      verdicts: [],
      why: why ?? (existing ? `Noticed something new about ${existing.name}.` : `${checked.name} came up and is not in People yet.`),
      sources: untrustedInView(ctx).map((s) => ({ kind: s.kind as never, via: s.via, ...(s.ref ? { ref: s.ref } : {}) })),
      kind: PERSON_KIND,
      kindLabel: PERSON_KIND_LABEL,
    });
    if (!result.ok && result.reason === 'recently-discarded') {
      return { ok: false, kept: false, message: result.message };
    }
    return { ok: true, kept: false, proposed: true, message: `Asked the owner: "${sentence}" waits for their OK in Needs you. Say so in one line; do not treat it as known yet.` };
  },
};

const peopleInput = z.object({
  query: z.string().max(80).optional().describe('A name or a relationship ("brother"). Leave it out for everyone.'),
});

export const people: ToolDefinition<z.infer<typeof peopleInput>, unknown> = {
  name: 'memory.people',
  description:
    'Look up the owner\'s people with everything kept about them, notes included: who someone is, when a birthday is, what to give them. ' +
    'The one-line list you already see leaves the notes out.',
  tier: 'auto',
  input: peopleInput,
  async execute(input, ctx) {
    const found = await listPeople(ctx.buddi!.db, input.query ? { query: input.query } : {});
    const today = ctx.buddi!.clock.today();
    return {
      people: found.map((p) => ({
        id: p.id, name: p.name, relationship: p.relationship, addressAs: p.addressAs,
        birthday: p.birthday, anniversary: p.anniversary, notes: p.notes,
        next: [p.birthday && { what: 'birthday', inDays: daysUntil(p.birthday, today) }, p.anniversary && { what: 'anniversary', inDays: daysUntil(p.anniversary, today) }].filter(Boolean),
      })),
      count: found.length,
    };
  },
};

const forgetPersonInput = z.object({
  id: z.string().uuid().describe('The person\'s id, from memory.people.'),
});

export const forgetPersonTool: ToolDefinition<z.infer<typeof forgetPersonInput>, unknown> = {
  name: 'memory.forget_person',
  description: 'Forget one person, by id, when the owner asks you to. Every agent stops knowing them; notes that mention them stay.',
  tier: 'auto',
  input: forgetPersonInput,
  async execute(input, ctx) {
    const gone = await forgetPerson(ctx.buddi!.db, input.id, ctx.buddi!.clock.now());
    return gone ? { forgotten: true, name: gone.name } : { forgotten: false };
  },
};

/* ------------------------------------------------------------------ *
 * The proposal: keep → the person is written
 * ------------------------------------------------------------------ */

/** The patch a card carries, checked again: a card is data an agent wrote. */
export function patchOfProposal(proposal: Pick<Proposal, 'payload'>): (PersonPatch & { id?: string }) | null {
  const payload = proposal.payload as { matcher?: Record<string, unknown>; params?: { person?: Record<string, unknown> } };
  const raw = payload.params?.person;
  if (!raw || typeof raw !== 'object') return null;
  const patch: PersonPatch & { id?: string } = {};
  if (typeof raw.name === 'string') patch.name = raw.name;
  for (const key of ['relationship', 'addressAs', 'notes'] as const) {
    if (raw[key] === null || typeof raw[key] === 'string') patch[key] = raw[key] as string | null;
  }
  for (const key of ['birthday', 'anniversary'] as const) {
    if (raw[key] === null) patch[key] = null;
    else if (raw[key] && typeof raw[key] === 'object') patch[key] = raw[key] as DayMonth;
  }
  return patch;
}

export const peoplePolicyHandler: PolicyHandler = {
  async apply(proposal: Proposal, ctx: PolicyHandlerContext): Promise<PolicyApplyResult> {
    const patch = patchOfProposal(proposal);
    if (!patch || !patch.name) return { ok: false, note: 'This card does not say who to remember.' };
    try {
      const { person: saved, created } = await upsertPerson(ctx.db, patch, { by: 'owner', conversationId: proposal.provenance.conversation, now: ctx.now });
      return { ok: true, note: `${created ? 'Added' : 'Updated'} ${saved.name} in People.`, ref: saved.id };
    } catch (err) {
      if (err instanceof PersonRefusal) return { ok: false, note: err.message };
      throw err;
    }
  },
  async revoke(): Promise<{ note: string }> {
    // A discarded card wrote nothing. A person the owner kept and no longer
    // wants is forgotten in People, where Undo lives.
    return { note: 'Nothing was added to People.' };
  },
  async adopt(ctx: PolicyHandlerContext): Promise<number> {
    return seedFromNotes(ctx);
  },
};

/* ------------------------------------------------------------------ *
 * The one-time seed from notes that name a person
 * ------------------------------------------------------------------ */

const RELATIONSHIPS = [
  'wife', 'husband', 'partner', 'girlfriend', 'boyfriend', 'fiancée', 'fiancee', 'fiancé', 'fiance', 'spouse',
  'son', 'daughter', 'child', 'kid', 'mother', 'mom', 'mum', 'father', 'dad', 'brother', 'sister', 'sibling',
  'grandmother', 'grandfather', 'grandma', 'grandpa', 'aunt', 'uncle', 'cousin', 'niece', 'nephew',
  'mother-in-law', 'father-in-law', 'sister-in-law', 'brother-in-law', 'stepmother', 'stepfather', 'stepson', 'stepdaughter',
  'best friend', 'friend', 'boss', 'manager', 'colleague', 'coworker', 'co-worker', 'accountant', 'lawyer', 'doctor',
  'dentist', 'assistant', 'neighbour', 'neighbor', 'landlord', 'nanny', 'babysitter', 'cleaner', 'mentor', 'business partner',
];
const REL = RELATIONSHIPS.slice().sort((a, b) => b.length - a.length).join('|');
const NAME = "([A-Z][\\p{L}'’-]+(?: [A-Z][\\p{L}'’-]+)?)";
// Case-insensitive by hand: the name's capital letter is the one thing that tells a name from a word.
const WHOSE = "(?:[Yy]our|[Mm]y|[Tt]he owner's|[Tt]he owner’s|[Oo]wner's|[Oo]wner’s|[Tt]heir|[Hh]is|[Hh]er)";
const NOT_NAMES = new Set(['The', 'Owner', 'Your', 'My', 'They', 'She', 'He', 'It', 'This', 'That', 'Their', 'His', 'Her', 'Buddi', 'Today', 'Tomorrow']);

const PATTERNS: Array<{ re: RegExp; name: number; rel: number }> = [
  // "Marion is your wife", "Ben is the owner's brother"
  { re: new RegExp(`\\b${NAME} is ${WHOSE} (${REL})\\b`, 'u'), name: 1, rel: 2 },
  // "The owner's wife is Marion", "My brother is called Ben"
  { re: new RegExp(`\\b${WHOSE} (${REL}) is (?:called |named )?${NAME}`, 'u'), name: 2, rel: 1 },
  // "Ben, the owner's brother, lives in Brooklyn"
  { re: new RegExp(`\\b${NAME}, ${WHOSE} (${REL})\\b`, 'u'), name: 1, rel: 2 },
  // "the owner's wife Marion", "my sister Claire"
  { re: new RegExp(`\\b${WHOSE} (${REL}),? ${NAME}`, 'u'), name: 2, rel: 1 },
];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** "14 March", "March 14", "14th of March" after "birthday" in the same sentence. */
function birthdayIn(textValue: string, name: string): DayMonth | null {
  const first = name.split(' ')[0]!;
  const sentence = textValue.split(/(?<=[.!?])\s+/).find((s) => s.includes(first) && /birthday/i.test(s));
  if (!sentence) return null;
  const month = '(january|february|march|april|may|june|july|august|september|october|november|december)';
  const a = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${month}(?:,? (\\d{4}))?`, 'i').exec(sentence);
  const b = new RegExp(`${month} (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?`, 'i').exec(sentence);
  if (a) return validDayMonth({ day: Number(a[1]), month: MONTHS.indexOf(a[2]!.toLowerCase()) + 1, year: a[3] ? Number(a[3]) : null });
  if (b) return validDayMonth({ day: Number(b[2]), month: MONTHS.indexOf(b[1]!.toLowerCase()) + 1, year: b[3] ? Number(b[3]) : null });
  return null;
}

export interface FoundPerson {
  name: string;
  relationship: string;
  birthday: DayMonth | null;
  /** The note it came from, as the owner will read it on the card. */
  from: { content: string; createdBy: string; createdAt: string | null };
}

/** People the notes name, one per name, first note wins (newest first). Pure. */
export function peopleInNotes(notes: ReadonlyArray<{ content: string; createdBy: string; createdAt: string | null }>): FoundPerson[] {
  const found = new Map<string, FoundPerson>();
  for (const note of notes) {
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(note.content);
      if (!match) continue;
      const name = match[pattern.name]!.trim();
      if (NOT_NAMES.has(name.split(' ')[0]!)) continue;
      const key = name.toLowerCase();
      if (found.has(key)) continue;
      found.set(key, { name, relationship: match[pattern.rel]!.toLowerCase(), birthday: null, from: note });
      break;
    }
  }
  // A birthday any note gives for a found person rides along.
  for (const person of found.values()) {
    for (const note of notes) {
      const birthday = birthdayIn(note.content, person.name);
      if (birthday) { person.birthday = birthday; break; }
    }
  }
  return [...found.values()];
}

export const SEED_KEY = 'people_seeded_from_notes';

/**
 * Once in an installation's life: every person the live notes name, who is
 * not in People yet, becomes a proposal card ("Keep all" folds them). Never
 * applied here; the meta row stops it running twice.
 */
export async function seedFromNotes(ctx: PolicyHandlerContext): Promise<number> {
  const done = await ctx.db.query(`select 1 from memory.meta where key = $1`, [SEED_KEY]);
  if (done.rows.length > 0) return 0;
  const proposals = ctx.buddi?.proposals;
  if (!proposals) return 0;
  const { rows } = await ctx.db.query(
    `select content, created_by_agent, created_at from memory.notes
      where deleted_at is null and (expires_at is null or expires_at > $1)
      order by created_at desc, seq desc limit 1000`,
    [ctx.now],
  );
  const found = peopleInNotes(rows.map((r) => ({ content: String(r.content), createdBy: String(r.created_by_agent), createdAt: toIso(r.created_at) })));
  let proposed = 0;
  for (const f of found) {
    if (await findPersonByName(ctx.db, f.name)) continue;
    const patch: PersonPatch & { name: string } = { name: f.name, relationship: f.relationship, ...(f.birthday ? { birthday: f.birthday } : {}) };
    const day = f.from.createdAt ? f.from.createdAt.slice(0, 10) : 'earlier';
    await proposals.proposePolicy(null, {
      matcher: { person: f.name },
      action: proposalSentence(f.name, patch, null),
      params: { person: payloadOf(patch) },
      verdicts: [],
      why: `Your notes name ${f.name}: "${f.from.content.length > 160 ? `${f.from.content.slice(0, 159)}…` : f.from.content}" (${f.from.createdBy}, ${day}).`,
      sources: [],
      kind: PERSON_KIND,
      kindLabel: PERSON_KIND_LABEL,
    });
    proposed += 1;
  }
  await ctx.db.query(`insert into memory.meta (key, value, at) values ($1, $2, $3) on conflict (key) do nothing`, [SEED_KEY, String(proposed), ctx.now]);
  return proposed;
}

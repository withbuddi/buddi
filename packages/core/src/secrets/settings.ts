/**
 * The Keys and secrets page's reads and writes (docs/specs/owner-secrets.md §6).
 *
 * Reads are page queries on core's own `secrets` plugin; every write is an
 * `ownerOnly` tool — no model ever sees one, the same way email's add-account
 * has always worked. The vault is reached through `pluginHostVault()` and never
 * leaves this module: a query answers names, bindings, uses and counts; a tool
 * takes the value the owner typed and holds it only for the vault write and
 * the history look.
 *
 * The save-time look (§6, "On save, buddi looks for the value where it may
 * already be"): events, memory notes and preferences, and the transcript rows —
 * the places that render on a surface or land in a backup. Two places the
 * search does not need to cover: learned skills, whose content was scrubbed
 * when the proposal that became them was recorded, and a workspace's files,
 * which are the developer plugin's to scan and which its `developer.write` and
 * `developer.edit` refuse to hold from then on.
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ToolDefinition, CoreToolContext } from '../tools.js';
import { OWNER_AGENT_ID, type PageQuery } from '../pages.js';
import { pluginHostVault } from '../host/build.js';
import { KNOWN_SECRETS } from '../vault/resolve.js';
import { ownerSecretVaultName, type Vault } from '../vault/types.js';
import { isSecretRule, secretDestinations } from './destinations.js';
import { assertBindings, deleteOwnerSecret, findSecret, listOwnerSecrets, putOwnerSecret, rebindOwnerSecret, renameOwnerSecret } from './store.js';
import type { SecretBinding } from '../host/types.js';
import { scanTextsForValue, scrubValueFrom } from './scrub.js';

/** How much history one look or one scrub reads: bounded, and enough. */
const EVENT_SCAN_LIMIT = 20_000;
const MAX_PAYLOAD_CHARS = 1_000_000;

/** The one place a value may be, as the report names it. */
interface FoundPlace {
  place: 'events' | 'messages' | 'memory notes' | 'memory preferences';
  count: number;
}

/** The value, read once from the vault; null when the secret has none. */
async function storedValue(vault: Vault, pool: Pick<Pool, 'query'>, name: string): Promise<string | null> {
  const secret = await findSecret(pool, name);
  if (secret === null) return null;
  return vault.get(ownerSecretVaultName(secret.id)).catch(() => null);
}

/** The texts one place holds, bounded. A place that is not installed (the memory plugin absent) holds nothing. */
async function textsOfPlace(place: FoundPlace['place'], db: { query: Pool['query'] }): Promise<Array<{ id: string; text: string }>> {
  const tableFor: Record<FoundPlace['place'], string> = {
    events: 'core.events',
    messages: 'core.messages',
    'memory notes': 'memory.notes',
    'memory preferences': 'memory.preferences',
  };
  const present = (await db.query(`select to_regclass($1) is not null as present`, [tableFor[place]])).rows[0] as { present: boolean };
  if (present.present !== true) return [];
  if (place === 'events') {
    const { rows } = await db.query(
      `select id, payload::text as text from core.events order by id desc limit $1`, [EVENT_SCAN_LIMIT],
    );
    return rows
      .map((row: Record<string, unknown>) => ({ id: String(row.id), text: String(row.text ?? '') }))
      .filter((row: { text: string }) => row.text.length <= MAX_PAYLOAD_CHARS);
  }
  if (place === 'messages') {
    const { rows } = await db.query(
      `select id, content::text as text from core.messages order by id desc limit $1`, [EVENT_SCAN_LIMIT],
    );
    return rows
      .map((row: Record<string, unknown>) => ({ id: String(row.id), text: String(row.text ?? '') }))
      .filter((row: { text: string }) => row.text.length <= MAX_PAYLOAD_CHARS);
  }
  if (place === 'memory preferences') {
    const { rows } = await db.query(`select id, value as text from memory.preferences`);
    return rows.map((row: Record<string, unknown>) => ({ id: String(row.id), text: String(row.text ?? '') }));
  }
  const { rows } = await db.query(`select id, content as text from memory.notes`);
  return rows.map((row: Record<string, unknown>) => ({ id: String(row.id), text: String(row.text ?? '') }));
}

/** Where a value may already be, and how often (§6). Never the value. */
async function lookForValue(value: string, db: { query: Pool['query'] }): Promise<FoundPlace[]> {
  const found: FoundPlace[] = [];
  for (const place of ['events', 'messages', 'memory notes', 'memory preferences'] as const) {
    const rows = await textsOfPlace(place, db);
    const count = scanTextsForValue(value, rows.map((row) => row.text));
    if (count > 0) found.push({ place, count });
  }
  return found;
}

/** Replace every form of the value in one place, row by row, counting. */
async function scrubPlace(place: FoundPlace['place'], value: string, name: string, db: { query: Pool['query'] }): Promise<number> {
  let scrubbed = 0;
  for (const row of await textsOfPlace(place, db)) {
    const { text, count } = scrubValueFrom(value, name, row.text);
    if (count === 0) continue;
    scrubbed += count;
    if (place === 'events') {
      await db.query(`update core.events set payload = $2::jsonb where id = $1`, [row.id, text]);
    } else if (place === 'messages') {
      await db.query(`update core.messages set content = $2::jsonb where id = $1`, [row.id, text]);
    } else if (place === 'memory preferences') {
      await db.query(`update memory.preferences set value = $2 where id = $1`, [row.id, text]);
    } else {
      await db.query(`update memory.notes set content = $2 where id = $1`, [row.id, text]);
    }
  }
  return scrubbed;
}

/* ------------------------------------------------------------------ *
 * The reads
 * ------------------------------------------------------------------ */

const noParams = z.object({}).strict();

/** One row of the page, display-ready; never a value. */
const listResult = z.object({
  secrets: z.array(z.unknown()),
  destinations: z.array(z.object({
    kind: z.string(), plugin: z.string(),
    maxRule: z.enum(['every-time', 'first-time', 'pre-approved']),
  })),
  ownKeys: z.array(z.string()),
}).strict();

const list: PageQuery = {
  name: 'list',
  params: noParams,
  result: listResult,
  async produce(_params: unknown, ctx: CoreToolContext) {
    const secrets = await listOwnerSecrets(ctx.db, {});
    const destinations = secretDestinations().map((d) => ({ kind: d.kind, plugin: d.plugin, maxRule: d.maxRule }));
    const vault = pluginHostVault();
    const names = vault !== undefined ? await vault.list().catch(() => []) : [];
    const ownKeys = names.filter((name) => !name.startsWith('owner-secret:'));
    return listResult.parse({ secrets, destinations, ownKeys: [...new Set([...ownKeys, ...KNOWN_SECRETS])].sort() });
  },
};

const usesParams = z.object({
  name: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

const uses: PageQuery = {
  name: 'uses',
  params: usesParams,
  async produce(params: unknown, ctx: CoreToolContext) {
    const parsed = usesParams.parse(params);
    const { rows } = await ctx.db.query(
      `select at, secret_name as secret, kind, target, plugin, agent_id as agent, outcome, detail
         from core.secret_uses
        where ($1::text is null or secret_name = $1)
        order by at desc, id desc
        limit $2`,
      [parsed.name ?? null, parsed.limit],
    );
    return { uses: rows };
  },
};



/* ------------------------------------------------------------------ *
 * The writes: ownerOnly tools, no model ever sees one
 * ------------------------------------------------------------------ */

const asOwner = (ctx: CoreToolContext): void => {
  if (ctx.agentId !== OWNER_AGENT_ID) throw new Error('Only the owner changes the keys and secrets page.');
};

const vaultOf = (): Vault => {
  const vault = pluginHostVault();
  if (vault === undefined) throw new Error('This installation has nowhere safe to keep secrets.');
  return vault;
};

const bindingInput = z.object({
  kind: z.string().min(3).max(100),
  target: z.unknown(),
  rule: z.enum(['every-time', 'first-time', 'pre-approved']),
}).strict();

const putInput = z.object({
  name: z.string().min(1).max(200),
  value: z.string().min(1).max(16_384),
  totp: z.boolean().optional(),
  bindings: z.array(bindingInput).max(20).optional(),
}).strict();

/**
 * Store what the owner typed, then look for it where it may already be. The
 * answer names the places and the counts; the owner decides about the one-tap
 * scrub (`secrets.scrub_history`) — the spec's §10 decision, history scrubbed
 * on save only with the owner's tap.
 */
const put = {
  name: 'secrets.put',
  description: "Store one of the owner's secrets with its bindings. Owner only; no model sees this tool.",
  tier: 'auto',
  ownerOnly: true,
  input: putInput,
  async execute(input, ctx: CoreToolContext) {
    asOwner(ctx);
    await putOwnerSecret(ctx.db, vaultOf(), {
      name: input.name,
      value: input.value,
      totp: input.totp === true,
      bindings: assertBindings((input.bindings ?? []) as SecretBinding[]),
    });
    const found = await lookForValue(input.value, ctx.db);
    return { name: input.name, found };
  },
} satisfies ToolDefinition<z.infer<typeof putInput>, unknown>;

const renameInput = z.object({ name: z.string().min(1).max(200), to: z.string().min(1).max(200) }).strict();

const rename = {
  name: 'secrets.rename',
  description: "Rename one of the owner's secrets. Owner only.",
  tier: 'auto',
  ownerOnly: true,
  input: renameInput,
  async execute(input, ctx: CoreToolContext) {
    asOwner(ctx);
    const done = await renameOwnerSecret(ctx.db, input.name, input.to);
    if (!done) throw new Error(`There is no secret named "${input.name}".`);
    return { renamed: true };
  },
} satisfies ToolDefinition<z.infer<typeof renameInput>, unknown>;

const rebindInput = z.object({ name: z.string().min(1).max(200), bindings: z.array(bindingInput).max(20) }).strict();

const rebind = {
  name: 'secrets.rebind',
  description: "Replace where one of the owner's secrets may go. Rebinding to a looser rule or a new target is the owner's own action, never a tool of an agent's. Owner only.",
  tier: 'auto',
  ownerOnly: true,
  input: rebindInput,
  async execute(input, ctx: CoreToolContext) {
    asOwner(ctx);
    const bindings = assertBindings(input.bindings as SecretBinding[]);
    for (const binding of bindings) {
      if (!isSecretRule(binding.rule)) throw new Error(`"${binding.rule}" is not a rule.`);
    }
    const done = await rebindOwnerSecret(ctx.db, input.name, bindings);
    if (!done) throw new Error(`There is no secret named "${input.name}".`);
    return { rebound: true };
  },
} satisfies ToolDefinition<z.infer<typeof rebindInput>, unknown>;

const deleteInput = z.object({ name: z.string().min(1).max(200) }).strict();

const remove = {
  name: 'secrets.delete',
  description: "Delete one of the owner's secrets, value and all. Owner only.",
  tier: 'auto',
  ownerOnly: true,
  input: deleteInput,
  async execute(input, ctx: CoreToolContext) {
    asOwner(ctx);
    const done = await deleteOwnerSecret(ctx.db, vaultOf(), input.name);
    if (!done) throw new Error(`There is no secret named "${input.name}".`);
    return { deleted: true };
  },
} satisfies ToolDefinition<z.infer<typeof deleteInput>, unknown>;

const scrubInput = z.object({ name: z.string().min(1).max(200) }).strict();

const scrubHistory = {
  name: 'secrets.scrub_history',
  description:
    'Replace every place a stored secret\'s value may already sit — events, the transcript, memory — with its ‹secret:NAME› marker. The one-tap scrub the Keys and secrets page offers after a save. Owner only.',
  tier: 'auto',
  ownerOnly: true,
  input: scrubInput,
  async execute(input, ctx: CoreToolContext) {
    asOwner(ctx);
    const vault = vaultOf();
    const secret = await findSecret(ctx.db, input.name);
    if (secret === null) throw new Error(`There is no secret named "${input.name}".`);
    const value = await vault.get(ownerSecretVaultName(secret.id)).catch(() => null);
    if (value === null) throw new Error(`"${input.name}" has no value stored; there is nothing to scrub.`);
    const scrubbed: FoundPlace[] = [];
    for (const place of ['events', 'messages', 'memory notes', 'memory preferences'] as const) {
      const count = await scrubPlace(place, value, input.name, ctx.db);
      if (count > 0) scrubbed.push({ place, count });
    }
    return { name: input.name, scrubbed };
  },
} satisfies ToolDefinition<z.infer<typeof scrubInput>, unknown>;

export const secretsSettingsTools = [put, rename, rebind, remove, scrubHistory];
/** The manifest's page queries, as the registry's contributions machinery takes them. */
export const SECRETS_QUERIES: PageQuery[] = [list, uses];

/** The ownerOnly writes, as the registry takes them beside the use tool. */
export const SECRETS_SETTINGS_TOOLS = [put, rename, rebind, remove, scrubHistory];
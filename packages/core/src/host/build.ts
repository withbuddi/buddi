/**
 * Building `ctx.buddi` for one plugin (docs/specs/plugin-host-api.md §3, §4).
 *
 * `register()` binds a plugin — its name, version, schema, tools, declared
 * hosts and declared areas — once (`hostBindingOf`). Every time core hands
 * that plugin a context (a tool call, a page query, a metric, a source's poll,
 * a sentinel's run) the context gets a `buddi` built from that binding and
 * from the fields the context already carries today: the pool, the clock, the
 * owner, the accounts. Nothing new is wired into the calls; the host is a view
 * over them, and the old fields stay beside it until every plugin has moved.
 *
 * The few things no context carries — how the HTTP transport is made, which
 * lives in `@buddi/runtime` and which core may not import, and the roster and queue a
 * tool never sees — are handed in once per process by the composition root
 * through `configurePluginHost`. A process that never does (a unit test) gets
 * areas that say so when called, not areas that are missing.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { assertApprovedEffect } from '../actions/effect.js';
import { findToolPermission } from '../actions/permissions.js';
import {
  readArtifactBytes,
  resolveDataDir,
  saveArtifact,
  type ArtifactKind,
  type EnvLike,
} from '../artifacts/store.js';
import { proposePolicy } from '../learning/policies.js';
import { OWNER_ID } from '../owner.js';
import { OWNER_AGENT_ID } from '../pages.js';
import { HOST_API_VERSION } from '../plugin/version.js';
import { parsePluginUses, type PluginUse } from '../plugin/uses.js';
import { localDateString } from '../time.js';
import { createHttpArea, registerHttpHeaderDestination, type HttpTransportFactory } from './http.js';
import { registerSecretDestination } from '../secrets/destinations.js';
import { primeSecretScrubber, scrubText, setSecretScrubSource, loadScrubEntries } from '../secrets/scrub.js';
import {
  assertBindings,
  deleteOwnerSecret,
  findSecret,
  listOwnerSecrets,
  putOwnerSecret,
  rebindOwnerSecret,
  renameOwnerSecret,
  secretBindings,
} from '../secrets/store.js';
import { useOwnerSecret } from '../secrets/use.js';
import type { Vault } from '../vault/types.js';
import type { CoreSourceContext, CoreToolContext, PluginManifest, ToolContext } from '../tools.js';
import type {
  AccountsArea,
  BuddiHost,
  DbArea,
  DirArea,
  EnqueueRunInput,
  FileRow,
  FilesArea,
  ProposalsArea,
  ScheduleArea,
  SecretsArea,
} from './types.js';

/** What `register()` fixes about a plugin, once. */
export interface HostBinding {
  plugin: string;
  version: string;
  schema: string;
  uses: readonly PluginUse[];
  /** This plugin's tool names: `approvals` answers for these and no others. */
  tools: ReadonlySet<string>;
  /** The hosts its manifest declares under `network`. */
  network: readonly string[];
}

/**
 * Bind a manifest. Throws, naming the plugin, when `uses` names an area this
 * build does not have — at `register()`, where a startup error can still say
 * which plugin it was.
 */
export function hostBindingOf(manifest: PluginManifest): HostBinding {
  const parsed = parsePluginUses(manifest.uses, `plugin ${manifest.name}'s manifest uses`);
  if (!parsed.ok) throw new Error(parsed.message);
  return {
    plugin: manifest.name,
    version: manifest.version,
    schema: manifest.schema,
    uses: parsed.uses,
    tools: new Set(manifest.tools.map((tool) => tool.name)),
    network: (manifest.network ?? []).map((use) => use.host),
  };
}

/** What the composition root hands the host once per process. */
export interface PluginHostServices {
  /**
   * How the shared transport is made (`createHttpTransport`): the `http` area
   * makes one with the address guard as its resolver (`host/http.ts`).
   */
  httpTransport?: HttpTransportFactory;
  /** The live roster's answer for a role, for contexts that carry none. */
  agentForRole?: (role: string) => string | undefined;
  /** Whether the live roster holds an agent with this id. */
  hasAgent?: (id: string) => boolean;
  /** How a run is started, for contexts that carry none (a tool's). */
  enqueueRun?: (input: EnqueueRunInput) => Promise<void>;
  /** Where operational lines go when the context has no `log`. */
  log?: (line: string) => void;
  /** The environment the data directory is read from. `process.env` when absent. */
  env?: EnvLike;
  /**
   * The vault owner secrets are kept in (`owner-secret:<id>`), opened once by
   * the composition root. The `secrets` area reads it; no plugin is handed it.
   */
  vault?: Vault;
}

let services: PluginHostServices = {};

/** Hand the host its process-wide services. Merges: each caller sets what it owns. */
export function configurePluginHost(more: PluginHostServices): void {
  services = { ...services, ...more };
  // Core's own destination (owner-secrets §3): `http.header`, under core's
  // `http` area. Re-registering from the same name replaces, so every process
  // that configures the host carries it; a plugin cannot name it — `use`
  // refuses another plugin's kind — and the Settings page lists it as one of
  // the kinds a binding may take.
  registerHttpHeaderDestination();
}

/** Forget them. Tests only. */
export function resetPluginHost(): void {
  services = {};
}

/**
 * The vault owner secrets are kept in, for core's own settings tools (the Keys
 * and secrets page, owner-secrets §6). `undefined` in a process that was never
 * given one; never handed to a plugin.
 */
export function pluginHostVault(): Vault | undefined {
  return services.vault;
}

/**
 * Hand the output scrubber (owner-secrets §5) its source — every owner secret
 * by name, buddi's own keys under theirs — and build the first automaton. The
 * composition root calls this once per process, at boot, before the first tool
 * result, event or log line goes anywhere. A later save, rename or delete
 * invalidates; the next async choke point rebuilds.
 */
export async function configureSecretScrubbing(
  pool: Pool,
  vault: Vault | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  setSecretScrubSource(() => loadScrubEntries(pool, vault, env));
  await primeSecretScrubber();
}

/**
 * The fields of whichever context a plugin is being handed: a `ToolContext`,
 * a `SourceContext`, a `SentinelContext`. The host reads what is there.
 */
export type HostFacts = Pick<CoreToolContext, 'db' | 'now' | 'timezone'> &
  Partial<Omit<CoreToolContext, 'db' | 'now' | 'timezone' | 'buddi'>> &
  Partial<Pick<CoreSourceContext, 'log' | 'enqueueRun'>> & {
    agentForRole?: (role: string) => string | undefined;
    hasAgent?: (id: string) => boolean;
  };

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const FILE_COLUMNS = `a.id, a.kind, a.mime, a.filename, a.size_bytes, a.sha256, a.caption, a.created_at, a.conversation_id`;

function toFileRow(row: Record<string, any>): FileRow {
  return {
    id: String(row.id),
    kind: row.kind as ArtifactKind,
    mime: row.mime,
    filename: row.filename ?? null,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    caption: row.caption ?? null,
    conversationId: row.conversation_id === null || row.conversation_id === undefined ? null : String(row.conversation_id),
    createdAt:
      row.created_at === null || row.created_at === undefined
        ? null
        : row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
  };
}

/** Build one plugin's host over one context's facts. */
export function createPluginHost(binding: HostBinding, facts: HostFacts): BuddiHost {
  const { plugin, schema } = binding;
  const declared = new Set<PluginUse>(binding.uses);
  // Read at each call, not once: the context is the caller's, and what it
  // carries when the call is made is what the call runs on.
  const pool = (): Pool => facts.db;
  const env = (): EnvLike => services.env ?? process.env;
  const log = (line: string): void => {
    const sink = facts.log ?? services.log ?? ((text: string) => console.error(text));
    // Choke point 4 of the scrub (owner-secrets §5): a log line is text
    // leaving core. Synchronous by necessity — it uses whatever automaton is
    // loaded, and the composition root primes it at boot.
    sink(`[${plugin}] ${scrubText(line)}`);
  };
  const ownTool = (tool: string): void => {
    if (!binding.tools.has(tool)) {
      throw new Error(`${plugin} asked about ${tool}, which is not one of its own tools`);
    }
  };

  const db: DbArea = {
    async query(sql, params) {
      const result = await pool().query(sql, params as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rowCount ?? null };
    },
    async transaction(fn) {
      const client: PoolClient = await pool().connect();
      let failure: Error | undefined;
      try {
        await client.query('begin');
        await client.query(`set local search_path to ${quoteIdent(schema)}, public`);
        const result = await fn({
          async query(sql, params) {
            const answer = await client.query(sql, params as unknown[] | undefined);
            return { rows: answer.rows, rowCount: answer.rowCount ?? null };
          },
        });
        await client.query('commit');
        return result;
      } catch (err) {
        try {
          await client.query('rollback');
        } catch (rollback) {
          failure = rollback instanceof Error ? rollback : new Error(String(rollback));
        }
        throw err;
      } finally {
        client.release(failure);
      }
    },
  };

  const host: BuddiHost = {
    version: HOST_API_VERSION,
    plugin,
    log,
    scrub: (text: string): string => scrubText(text),
    owner: {
      id: facts.ownerId ?? OWNER_ID,
      timezone: facts.timezone,
      agentForRole: (role) => (facts.agentForRole ?? services.agentForRole)?.(role),
      hasAgent: (id) => (facts.hasAgent ?? services.hasAgent)?.(id) ?? true,
      protectedPaths: facts.protectedPaths ?? [],
    },
    clock: {
      now: () => facts.now(),
      today: () => localDateString(facts.now(), facts.timezone),
    },
    db,
    dir: pluginDir(plugin),
    approvals: {
      assert: (ctx, envelope) => assertApprovedEffect(ctx, envelope),
      async standing(tool) {
        ownTool(tool);
        const ctx = { ...facts, ownerId: facts.ownerId ?? OWNER_ID } as CoreToolContext;
        return (await findToolPermission(pool(), ctx, tool, binding.version)) ?? null;
      },
      async approvedInConversation(tool, conversationId) {
        ownTool(tool);
        // A delegate's run lives in its own conversation, opened from the
        // owner's: the family is the root conversation and every conversation
        // delegated from it. Moved from the image plugin, unchanged but for
        // the tool, which was always its own.
        const { rows } = await pool().query(
          `with root as (
             select coalesce(
               (select e.conversation_id from core.events e
                 where e.kind = 'delegation.started' and e.payload->>'conversationId' = $1::text
                 order by e.created_at limit 1),
               $1::uuid) as id
           ), family as (
             select id from root
             union
             select (e.payload->>'conversationId')::uuid from core.events e, root
              where e.kind = 'delegation.started' and e.conversation_id = root.id
           )
           select exists (
             select 1 from core.actions a join core.approvals p on p.action_id = a.id
              where a.tool = $2 and a.conversation_id in (select id from family)
                and p.state in ('approved', 'executing', 'succeeded', 'failed', 'unknown')
           ) as approved`,
          [conversationId, tool],
        );
        return (rows[0] as { approved?: boolean } | undefined)?.approved === true;
      },
    },
    pages: {
      previewPort: () => facts.previewPort,
      previewUrl: (name) =>
        facts.previewPort === undefined
          ? undefined
          : `http://127.0.0.1:${facts.previewPort}/preview/${encodeURIComponent(plugin)}/${encodeURIComponent(name)}/`,
    },
  };

  if (declared.has('http')) {
    host.http = createHttpArea({
      plugin,
      network: binding.network,
      log,
      transport: services.httpTransport,
      // A secret reaches one header of one request (owner-secrets §3,
      // `http.header`): the area asks for the value itself, through
      // `useOwnerSecret`'s core-internal delivery, and inserts the header
      // after the address checks. Recorded as an ordinary use; the value
      // crosses only this boundary, in this closure, and is gone with the
      // request.
      secrets:
        services.vault === undefined
          ? undefined
          : {
              async deliverFor(name, requestHost, header) {
                let value: string | undefined;
                const result = await useOwnerSecret(
                  {
                    pool: facts.db,
                    vault: services.vault,
                    plugin: 'http',
                    buddi: host,
                    agentId: facts.agentId,
                    conversationId: facts.conversationId,
                    now: () => facts.now(),
                    deliverInto: (delivered) => {
                      value = delivered;
                    },
                  },
                  { name, kind: 'http.header', target: { host: requestHost, header } },
                );
                if ('done' in result) {
                  if (value === undefined) {
                    return { refused: `The destination did not take "${name}".` };
                  }
                  return { ok: true, value };
                }
                if ('pending' in result) return { pending: result.pending };
                return { refused: result.refused };
              },
            },
    });
  }
  if (declared.has('accounts')) host.accounts = accountsArea(binding, facts);
  if (declared.has('files') || declared.has('files:library')) {
    host.files = filesArea(binding, facts, declared.has('files:library'), env);
  }
  if (declared.has('proposals')) host.proposals = proposalsArea(binding, facts);
  if (declared.has('schedule')) host.schedule = scheduleArea(facts);
  if (declared.has('secrets')) host.secrets = secretsArea(binding, facts, host);
  // `memory` is a type only in 1.0 (§11): a plugin that declares it gets
  // nothing yet, and a call is `undefined`.
  return host;
}

/**
 * A plugin's `dir` area, the same one its `ctx.buddi.dir` is: what `register()`
 * hands the manifest's `register` hook, and what the composition root hands a
 * built-in's factory, before any context exists. Created on first read of
 * `path`; the data directory is read then, from `env` or the host's.
 */
export function pluginDir(plugin: string, env?: EnvLike): DirArea {
  const dataDir = (): string => resolveDataDir(env ?? services.env ?? process.env);
  let made: string | undefined;
  return {
    get path(): string {
      if (made === undefined) {
        const dir = path.join(dataDir(), 'plugins-data', plugin);
        mkdirSync(dir, { recursive: true });
        made = dir;
      }
      return made;
    },
    get legacyPath(): string | undefined {
      return LEGACY_DIRS.has(plugin) ? path.join(dataDir(), plugin) : undefined;
    },
  };
}

/**
 * The built-ins whose owner data was under `<data>/<plugin>` before
 * `plugins-data` existed: the host plugin's workspaces and the browser's
 * profile. Moving them would move the owner's work, so `dir.legacyPath` names
 * the old place for these and for no other plugin — a plugin named after one
 * of the data directory's own folders must not be handed it.
 */
const LEGACY_DIRS: ReadonlySet<string> = new Set(['browser', 'host']);

function secretsArea(binding: HostBinding, facts: HostFacts, host: BuddiHost): SecretsArea {
  const { plugin } = binding;
  const own = (kind: string): boolean => kind.startsWith(`${plugin}.`);
  const vault = (): Vault => {
    if (services.vault === undefined) throw new Error('This installation has nowhere safe to keep secrets.');
    return services.vault;
  };
  const asOwner = (what: string): void => {
    // The owner's own call: the act route invokes an `ownerOnly` tool as the
    // owner, and nothing else is the owner.
    if (facts.agentId !== OWNER_AGENT_ID) throw new Error(`Only the owner ${what}, from ${plugin}'s own page.`);
  };
  const ownKinds = (bindings: readonly { kind: string }[]): void => {
    const foreign = bindings.find((b) => !own(b.kind));
    if (foreign !== undefined) throw new Error(`${plugin} may bind a secret only to its own destinations, not ${foreign.kind}.`);
  };
  /*
   * A secret this plugin may change: one bound to its kinds and nothing else.
   * One the owner also bound elsewhere, or bound nowhere, is theirs to change
   * in Settings, not a plugin's.
   */
  const ownedSecret = async (name: string): Promise<boolean> => {
    const secret = await findSecret(facts.db, name);
    if (secret === null) return false;
    const bindings = await secretBindings(facts.db, secret.id);
    if (bindings.length === 0 || bindings.some((b) => !own(b.kind))) {
      throw new Error(`"${name}" is not ${plugin}'s alone to change; the owner changes it in Settings.`);
    }
    return true;
  };
  return {
    registerDestination: (destination) => registerSecretDestination(plugin, destination),
    use: (name, kind, target) =>
      useOwnerSecret(
        {
          pool: facts.db,
          vault: services.vault,
          plugin,
          buddi: host,
          agentId: facts.agentId,
          conversationId: facts.conversationId,
          now: () => facts.now(),
        },
        { name, kind, target },
      ),
    list: () => listOwnerSecrets(facts.db, { kindPrefix: `${plugin}.` }),
    async put(name, value, bindings) {
      asOwner('stores a secret');
      ownKinds(assertBindings(bindings));
      await ownedSecret(name);
      await putOwnerSecret(facts.db, vault(), { name, value, bindings });
    },
    async rename(name, to) {
      asOwner('renames a secret');
      if (!(await ownedSecret(name))) return false;
      return renameOwnerSecret(facts.db, name, to);
    },
    async rebind(name, bindings) {
      asOwner('rebinds a secret');
      ownKinds(assertBindings(bindings));
      if (!(await ownedSecret(name))) return false;
      return rebindOwnerSecret(facts.db, name, bindings);
    },
    async delete(name) {
      asOwner('deletes a secret');
      if (!(await ownedSecret(name))) return false;
      return deleteOwnerSecret(facts.db, vault(), name);
    },
  };
}

function accountsArea(binding: HostBinding, facts: HostFacts): AccountsArea {
  const access = (): NonNullable<CoreToolContext['providerAccounts']> => {
    if (facts.providerAccounts === undefined) {
      throw new Error('Model accounts are not available in this process.');
    }
    return facts.providerAccounts;
  };
  const assertBound = async (accountId: string): Promise<void> => {
    const { rows } = await facts.db.query(
      `select 1 from core.plugin_account_bindings where plugin = $1 and account_id = $2`,
      [binding.plugin, accountId],
    );
    if (rows.length === 0) {
      throw new Error(
        `The owner has not given ${binding.plugin} that model account; pick one on its settings page.`,
      );
    }
  };
  return {
    list: () => access().list(),
    async resolve(accountId, model, signal) {
      await assertBound(accountId);
      return access().resolve(accountId, model, signal);
    },
    async withCodexProfile(accountId, use, signal) {
      await assertBound(accountId);
      return access().withCodexProfile(accountId, use, signal);
    },
    async bind(accountId) {
      // The binding is the owner's choice, made on the plugin's own page: the
      // act route invokes an `ownerOnly` tool as the owner, and nothing else
      // is the owner.
      if (facts.agentId !== OWNER_AGENT_ID) {
        throw new Error('Only the owner binds a model account to a plugin, from its settings page.');
      }
      if (!access().list().some((account) => account.id === accountId)) {
        throw new Error(`There is no model account "${accountId}".`);
      }
      await facts.db.query(
        `insert into core.plugin_account_bindings (plugin, account_id) values ($1, $2)
         on conflict do nothing`,
        [binding.plugin, accountId],
      );
    },
  };
}

function filesArea(
  binding: HostBinding,
  facts: HostFacts,
  library: boolean,
  env: () => EnvLike,
): FilesArea {
  const pool = (): Pool => facts.db;
  /*
   * In scope: every file with `files:library`; otherwise the files this plugin
   * saved, and the files used in the conversation its tool is running in.
   */
  const scope = (first: number): { sql: string; params: unknown[] } => {
    if (library) return { sql: 'true', params: [] };
    return {
      sql: `(exists (select 1 from core.plugin_files f where f.plugin = $${first} and f.artifact_id = a.id)
             or ($${first + 1}::uuid is not null and (a.conversation_id = $${first + 1}::uuid
               or exists (select 1 from core.artifact_uses u
                           where u.artifact_id = a.id and u.conversation_id = $${first + 1}::uuid))))`,
      params: [binding.plugin, facts.conversationId ?? null],
    };
  };
  const get = async (id: string): Promise<(FileRow & { storagePath: string }) | null> => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const where = scope(2);
    const { rows } = await pool().query(
      `select ${FILE_COLUMNS}, a.storage_path from core.artifacts a
        where a.id = $1 and a.deleted_at is null and ${where.sql}`,
      [id, ...where.params],
    );
    const row = rows[0];
    return row === undefined ? null : { ...toFileRow(row), storagePath: row.storage_path };
  };
  return {
    async save(input) {
      // The file belongs to the conversation the call runs in only when that
      // conversation exists: a mission's or a test's id is not a row, and the
      // library's reference to it would not hold.
      let conversationId: string | null = null;
      if (facts.conversationId !== undefined && /^[0-9a-f-]{36}$/i.test(facts.conversationId)) {
        const { rows } = await pool().query(`select 1 from core.conversations where id = $1`, [facts.conversationId]);
        if (rows.length > 0) conversationId = facts.conversationId;
      }
      const saved = await saveArtifact(
        pool(),
        {
          bytes: input.bytes,
          mime: input.mime,
          ...(input.filename === undefined ? {} : { filename: input.filename }),
          ...(input.source === undefined ? {} : { source: input.source }),
          ...(input.caption === undefined ? {} : { caption: input.caption }),
          createdBy: facts.agentId ?? binding.plugin,
          conversationId,
        },
        env(),
      );
      await pool().query(
        `insert into core.plugin_files (plugin, artifact_id) values ($1, $2) on conflict do nothing`,
        [binding.plugin, saved.id],
      );
      const { storagePath: _hidden, ...row } = saved;
      return { ...row, conversationId };
    },
    async get(id) {
      const row = await get(id);
      if (row === null) return null;
      const { storagePath: _hidden, ...visible } = row;
      return visible;
    },
    async read(id) {
      const row = await get(id);
      if (row === null) throw new Error(`There is no file ${id} that ${binding.plugin} can read.`);
      return readArtifactBytes(env(), row);
    },
    async list(opts = {}) {
      const params: unknown[] = [];
      const where = ['a.deleted_at is null'];
      if (opts.since !== undefined) {
        params.push(opts.since.toISOString());
        where.push(`a.created_at >= $${params.length}`);
      }
      if (opts.before !== undefined) {
        params.push(opts.before.toISOString());
        where.push(`a.created_at < $${params.length}`);
      }
      if (opts.kind !== undefined) {
        params.push(opts.kind);
        where.push(`a.kind = $${params.length}`);
      }
      if (opts.sha256 !== undefined) {
        params.push(opts.sha256);
        where.push(`a.sha256 = $${params.length}`);
      }
      if (opts.surface !== undefined) {
        params.push(opts.surface);
        where.push(`a.source_surface = $${params.length}`);
      }
      const scoped = scope(params.length + 1);
      params.push(...scoped.params);
      where.push(scoped.sql);
      params.push(Math.min(Math.max(1, Math.trunc(opts.limit ?? 20)), 100));
      const { rows } = await pool().query(
        `select ${FILE_COLUMNS} from core.artifacts a
          where ${where.join(' and ')}
          order by a.created_at desc, a.id desc
          limit $${params.length}`,
        params,
      );
      return rows.map(toFileRow);
    },
  };
}

function proposalsArea(binding: HostBinding, facts: HostFacts): ProposalsArea {
  return {
    proposePolicy: (ctx, input, within) =>
      proposePolicy(within ?? facts.db, ctx, { ...input, plugin: binding.plugin }, facts.now()),
    async countOpen() {
      const { rows } = await facts.db.query(
        `select count(*)::int as n from core.proposals
          where kind = 'policy' and state = 'open' and payload->>'plugin' = $1`,
        [binding.plugin],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

function scheduleArea(facts: HostFacts): ScheduleArea {
  return {
    enqueueRun(input) {
      const enqueue = facts.enqueueRun ?? services.enqueueRun;
      if (enqueue === undefined) return Promise.reject(new Error('This process starts no agent runs.'));
      return enqueue(input);
    },
    async remindersFor(key, days) {
      if (key.values.length === 0 || days.length === 0) return [];
      const { rows } = await facts.db.query(
        `select r.context->>$1 as value,
                to_char((r.due_at at time zone $4)::date, 'YYYY-MM-DD') as day
           from core.reminders r
          where r.state = 'pending'
            and r.context->>$1 = any($2::text[])
            and (r.due_at at time zone $4)::date = any($3::date[])`,
        [key.contextKey, key.values, days, facts.timezone],
      );
      return rows.map((row: Record<string, unknown>) => ({ value: String(row.value), day: String(row.day) }));
    },
  };
}

/* ------------------------------------------------------------------ *
 * Handing a context over
 * ------------------------------------------------------------------ */

/** One host per plugin per context object, so a run's calls share it. */
const built = new WeakMap<object, Map<string, BuddiHost>>();

/**
 * The context, with this plugin's `buddi` on it.
 *
 * A copy: one run's context is handed to many plugins' tools, and each must
 * see its own host. A `buddi` already there — another plugin's, or this one's
 * from an outer call — is replaced, never trusted.
 */
export function withPluginHost<C extends HostFacts & { buddi?: BuddiHost }>(binding: HostBinding, ctx: C): C {
  let perPlugin = built.get(ctx);
  if (perPlugin === undefined) {
    perPlugin = new Map();
    built.set(ctx, perPlugin);
  }
  let host = perPlugin.get(binding.plugin);
  if (host === undefined) {
    host = createPluginHost(binding, ctx);
    perPlugin.set(binding.plugin, host);
  }
  return { ...ctx, buddi: host };
}

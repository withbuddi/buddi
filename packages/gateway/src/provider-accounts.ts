import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  accountBaseUrl, accountModelProblem, accountProtocol, createVault, providerFromEnv,
  putOwnerSecret, registerSecretDestination, resolveProviderAccount, useOwnerSecret, vaultState,
  type AgentCatalog, type AgentFrontmatter, type BuddiHost,
  type LoadAgentCatalogOptions, type ProviderAccount, type ProviderAccountsAccess, type ProviderRef, type ResolvedProvider, type Vault,
} from '@buddi/core';
import { contextWindowTokens, createProvider, providerCapabilities, listProviderModels, readAnthropicTokens, type AccountModels, type RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { z } from 'zod';
import { providerDiagnostic, type ProviderDiagnostic } from './provider-diagnostics.js';
import { CodexAccounts, type CodexAccountAccess } from './codex-accounts.js';
import { AnthropicAccounts } from './anthropic-accounts.js';
import { ACCOUNTS_PROVIDER_KIND, accountsProviderDestination, deleteAccountSecret, ownerSecretVault } from './owner-secrets.js';

type Row = ProviderAccount & { secretRef: string | null; legacyEnv: string | null; deleting: boolean };
type Binding = { agentId: string; accountId: string; model: string };
type TestResult = ProviderDiagnostic & { checkedAt: string };
const columns = `id, label, kind, auth, base_url as "baseUrl", default_model as "defaultModel",
  context_window_tokens as "contextWindowTokens",
  enabled, deleting, revision, secret_ref as "secretRef", legacy_env as "legacyEnv"`;
const saveSchema = z.object({
  id: z.string().min(1).max(100).optional(), revision: z.number().int().positive().optional(),
  label: z.string().trim().min(1).max(100), kind: z.enum(['anthropic', 'openai', 'openai-compatible', 'codex']),
  auth: z.enum(['api-key', 'none', 'legacy-subscription-token', 'chatgpt', 'anthropic-oauth']),
  baseUrl: z.string().trim().max(2048).optional(), defaultModel: z.string().trim().min(1).max(150),
  enabled: z.boolean(), secret: z.string().trim().min(1).max(16384).optional(),
  /**
   * What this endpoint's models actually hold, when the owner knows better
   * than the runtime's table — a local host serves whatever `num_ctx` it was
   * started with, under the same model name either way. Null or absent leaves
   * the table in charge, which is the answer for almost everyone.
   */
  contextWindowTokens: z.number().int().min(8_000).max(2_000_000).nullable().optional(),
}).strict();
const probeSchema = z.object({
  kind: z.enum(['anthropic', 'openai', 'openai-compatible']),
  auth: z.enum(['api-key', 'none']),
  baseUrl: z.string().trim().max(2048).optional(),
  secret: z.string().trim().min(1).max(16384).optional(),
}).strict();
const legacy = [
  { id: 'legacy-anthropic-api', name: 'ANTHROPIC_API_KEY', label: 'Anthropic — existing API key', kind: 'anthropic', auth: 'api-key' },
  { id: 'legacy-anthropic-subscription', name: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude — existing subscription token', kind: 'anthropic', auth: 'legacy-subscription-token' },
  { id: 'legacy-openai-api', name: 'OPENAI_API_KEY', label: 'OpenAI — existing API key', kind: 'openai', auth: 'api-key' },
] as const;

export type LegacyAccount = (typeof legacy)[number];

/**
 * The legacy accounts this environment actually has a credential for.
 *
 * A packaged install has none of these variables, and an account named after a
 * variable nobody set is a ghost: it shows up in Settings and in the wizard,
 * it can never be made to work, and the first thing a new owner sees is a
 * model account that is a lie. So the one-shot migration seeds an account only
 * where the variable is set and non-empty — a checkout that exports them is
 * migrated exactly as before, and a fresh install starts with zero accounts
 * until the owner adds one.
 */
export function legacyAccountsToSeed(env: NodeJS.ProcessEnv): readonly LegacyAccount[] {
  return legacy.filter((item) => (env[item.name] ?? '').trim() !== '');
}

export class ProviderAccountError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Owner-only service. No account credentials are exposed as tools or put in env. */
export class ProviderAccounts {
  readonly vault: Vault | undefined;
  readonly codex: CodexAccounts | undefined;
  readonly anthropic: AnthropicAccounts | undefined;
  #tokenInfo = new Map<string, { tokenExpiresAt: string; reconnectRequired: boolean }>();
  #rows = new Map<string, Row>();
  #bindings = new Map<string, Binding>();
  #configured = new Map<string, boolean>();
  #tests = new Map<string, TestResult>();
  #testing = new Set<string>();
  #codexReleased = new Map<string, Promise<void>>();
  #tail: Promise<unknown> = Promise.resolve();
  #modelLists = new Map<string, { revision: number; until: number; value: AccountModels }>();
  #modelRequests = new Map<string, Promise<AccountModels>>();
  /** The vault the OAuth adapters see, with account names translated onto owner secrets. */
  readonly accountVault: Vault | undefined;
  constructor(readonly deps: {
    pool: Pick<Pool, 'query' | 'connect'>; env: NodeJS.ProcessEnv;
    catalog: () => AgentCatalog; reload: () => void; vault?: Vault;
    test?: (resolved: ResolvedProvider) => Promise<void>;
    listModels?: typeof listProviderModels;
  }) {
    this.vault = deps.vault ?? createVault({ env: deps.env });
    // The account credentials are owner secrets bound to `accounts.provider`
    // (docs/specs/owner-secrets.md §3, §7): the destination is registered here,
    // where the accounts live, and the adapters read and write through names
    // translated onto the owner secrets the adoption saved. buddi's own keys
    // (the legacy accounts' environment variables) pass through untouched.
    if (this.vault) {
      this.accountVault = ownerSecretVault(this.vault, this.deps.pool);
      registerSecretDestination('accounts', accountsProviderDestination(
        async (id) => {
          const { rows } = await this.deps.pool.query(`select 1 from core.provider_accounts where id = $1`, [id]);
          return rows.length > 0;
        },
        (id) => {
          const row = this.#rows.get(id);
          return row === undefined ? 'a provider account' : `the model account “${row.label}”`;
        },
      ));
    }
    if (deps.env.BUDDI_CODEX_EXPERIMENT === '1' && this.accountVault) this.codex = new CodexAccounts({ vault: this.accountVault });
    if (this.accountVault) this.anthropic = new AnthropicAccounts(this.accountVault);
  }

  get anthropicOAuthEnabled() { return this.deps.env.BUDDI_ANTHROPIC_OAUTH_EXPERIMENT === '1' && !!this.anthropic; }

  async initialize(): Promise<void> {
    // One atomic, restart-safe migration. Never rewrites private agent files or
    // copies a secret into SQL. Missing credentials still get a stable account.
    const client = await this.deps.pool.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('buddi-provider-accounts-migration'))");
      const done = await client.query("select name from core.provider_account_migrations where name='legacy-v1'");
      if (!done.rows.length) {
        const removed = await client.query('select name from core.provider_credential_state where removed=true');
        const seeding = legacyAccountsToSeed(this.deps.env);
        for (const item of seeding) {
          const ref = providerFromEnv(this.deps.env, undefined, item.kind);
          await client.query(`insert into core.provider_accounts
            (id,label,kind,auth,base_url,default_model,secret_ref,legacy_env,enabled)
            values ($1,$2,$3,$4,$5,$6,$7,$7,$8) on conflict (id) do nothing`,
          [item.id, item.label, item.kind, item.auth, accountBaseUrl(item.kind), ref.model, item.name,
            !removed.rows.some(r => r.name === item.name)]);
        }
        for (const summary of this.deps.catalog().list()) {
          const agent = this.deps.catalog().get(summary.id)!;
          const account = seeding.find(l => l.name === agent.provider.credential.env);
          if (account) await client.query(`insert into core.agent_provider_accounts (agent_id,account_id,model)
            values ($1,$2,$3) on conflict (agent_id) do nothing`, [agent.id, account.id, agent.model]);
        }
        await client.query("insert into core.provider_account_migrations (name) values ('legacy-v1')");
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
    await this.load();
  }

  /**
   * Whether the credential is there, not a recorded use: `load()` runs this for
   * every account on every reload, and a delivered use row per account per
   * reload would be noise. The real deliveries go through `#usableSecret`,
   * which records them (owner-secrets §7).
   */
  async #secret(row: Row): Promise<string | null> {
    if (row.auth === 'none') return null;
    try {
      const value = row.secretRef ? await this.accountVault?.get(row.secretRef) : null;
      // Only a migrated account may use its original, explicitly named env.
      // Rotation clears legacyEnv; disable/delete never rediscovers another key.
      return value ?? (row.legacyEnv ? this.deps.env[row.legacyEnv]?.trim() || null : null);
    } catch { throw new ProviderAccountError(409, 'The credential vault is unavailable or locked. Unlock it on the host and retry.'); }
  }

  async load(): Promise<void> {
    const result = await this.deps.pool.query(`select ${columns} from core.provider_accounts order by created_at,id`);
    const bindings = await this.deps.pool.query('select agent_id as "agentId", account_id as "accountId", model from core.agent_provider_accounts');
    const configured = new Map<string, boolean>();
    this.#tokenInfo.clear();
    for (const row of result.rows as Row[]) {
      try {
        const raw = await this.#secret(row);
        configured.set(row.id, row.auth === 'none' || !!raw);
        if (row.auth === 'anthropic-oauth' && raw) {
          const tokens = readAnthropicTokens(raw);
          this.#tokenInfo.set(row.id, { tokenExpiresAt: new Date(tokens.expiresAt).toISOString(), reconnectRequired: tokens.state !== 'ready' });
        }
      }
      catch { configured.set(row.id, false); }
    }
    this.#rows = new Map(result.rows.map((r: Row) => [r.id, r]));
    this.#bindings = new Map(bindings.rows.map((b: Binding) => [b.agentId, b]));
    this.#configured = configured;
    this.deps.reload();
  }

  refresh(): Promise<void> { return this.#serial(() => this.load()); }

  selection: NonNullable<LoadAgentCatalogOptions['providerSelection']> = (agent: AgentFrontmatter) => {
    const binding = this.#bindings.get(agent.id);
    const row = binding && this.#rows.get(binding.accountId);
    const provider: ProviderRef = row ? {
      kind: accountProtocol(row.kind), model: binding!.model, accountId: row.id,
      credential: { kind: row.auth === 'legacy-subscription-token' || row.auth === 'anthropic-oauth' ? 'subscription-token' : 'api-key', env: row.secretRef ?? 'NO_CREDENTIAL' },
    } as ProviderRef : { ...providerFromEnv(this.deps.env, agent.model, agent.provider), accountId: binding?.accountId ?? '' };
    const issue = !row ? 'Choose a provider account for this agent in Settings → Agents.'
      : row.kind === 'codex' && !this.codex ? 'Codex experiment is not enabled in this process.'
      : row.auth === 'anthropic-oauth' && !this.anthropicOAuthEnabled ? 'Claude OAuth experiment is not enabled in this process.'
      : !row.enabled ? `Provider account “${row.label}” is disabled.`
      : !this.#configured.get(row.id) ? `Provider account “${row.label}” needs a credential or vault access.`
      : accountModelProblem(row.kind, binding!.model);
    return { provider, availability: issue ? { ok: false, problem: { code: 'missing-credential', message: issue } } : { ok: true } };
  };

  view(ownerSession?: string) {
    return {
      vault: { kind: this.vault?.kind ?? 'none', ...vaultState({ env: this.deps.env }) },
      codexEnabled: !!this.codex,
      anthropicOAuthEnabled: this.anthropicOAuthEnabled,
      accounts: [...this.#rows.values()].map(({ secretRef: _secret, legacyEnv: _env, deleting, ...row }) => ({
        ...row, configured: this.#configured.get(row.id) ?? false,
        // What the runtime would assume for this account's default model, so
        // the field can show it as a placeholder instead of a blank the owner
        // has to guess at.
        detectedContextWindowTokens: contextWindowTokens(row.defaultModel, row.kind === 'codex' ? 'openai' : row.kind),
        removalPending: deleting,
        refreshable: row.kind === 'codex' || row.auth === 'anthropic-oauth', tokenExpiresAt: null, subscriptionRenewsAt: null,
        ...(row.auth === 'anthropic-oauth' ? { ...this.#tokenInfo.get(row.id), login: this.anthropic?.view(row.id, row.revision, ownerSession) ?? null } : {}),
        ...(row.kind === 'codex' ? { login: this.codex?.view(row.id) ?? null } : {}),
        assignedAgents: [...this.#bindings.values()].filter(b => b.accountId === row.id).map(b => b.agentId),
        test: this.#tests.get(row.id) ?? null,
      })),
      bindings: [...this.#bindings.values()],
    };
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(fn, fn); this.#tail = pending.catch(() => {}); return pending;
  }
  async #row(id: string): Promise<Row> {
    const result = await this.deps.pool.query(`select ${columns} from core.provider_accounts where id=$1`, [id]);
    if (!result.rows[0]) throw new ProviderAccountError(404, 'Provider account not found.');
    return result.rows[0];
  }

  async models(id: string, refresh = false): Promise<AccountModels> {
    const row = await this.#row(id);
    if (!row.enabled || row.deleting) throw new ProviderAccountError(409, 'Enable this account before loading models.');
    const cached = this.#modelLists.get(id);
    if (!refresh && cached?.revision === row.revision && cached.until > Date.now()) return cached.value;
    const key = `${id}:${row.revision}`;
    const existing = this.#modelRequests.get(key);
    if (existing) return existing;
    const pending = (async () => {
      try {
        let value: AccountModels;
        if (row.kind === 'codex') {
          if (!this.codex) throw new ProviderAccountError(409, 'Codex experiment is unavailable.');
          const lease = await this.#codexAccess(row);
          try { value = await this.codex.models(lease.access); } finally { await lease.release(); }
        } else {
          const secret = await this.#usableSecret(row);
          if (row.auth !== 'none' && !secret) throw new ProviderAccountError(409, 'Save or connect this account’s credential before loading models.');
          value = await (this.deps.listModels ?? listProviderModels)(resolveProviderAccount(row, row.defaultModel, secret));
        }
        const current = await this.#row(id);
        if (current.revision !== row.revision || !current.enabled || current.deleting) throw new ProviderAccountError(409, 'Account changed. Refresh models again.');
        this.#modelLists.set(id, { revision: row.revision, until: Date.now() + 60_000, value });
        return value;
      } catch (error) {
        if (error instanceof ProviderAccountError) throw error;
        const diagnostic = providerDiagnostic(error);
        throw new ProviderAccountError(502, `Could not load models. ${diagnostic.message} You can still enter a custom model.`);
      } finally { this.#modelRequests.delete(key); }
    })();
    this.#modelRequests.set(key, pending);
    return pending;
  }

  /**
   * List the models a credential can reach, before anything is saved.
   *
   * Nothing is written: the secret is used for one request and dropped. This is
   * what lets the add-account form offer a real list to pick from rather than
   * asking the owner to type a model id from memory. Subscription accounts
   * cannot be probed; they connect first.
   */
  async probeModels(body: unknown): Promise<AccountModels> {
    const parsed = probeSchema.safeParse(body);
    if (!parsed.success) throw new ProviderAccountError(400, 'Invalid probe.');
    const input = parsed.data;
    if (input.auth === 'none' && input.kind !== 'openai-compatible') throw new ProviderAccountError(400, 'This provider requires an API key.');
    if (input.auth === 'api-key' && !input.secret) throw new ProviderAccountError(400, 'Enter the API key first.');
    const placeholder = input.kind === 'anthropic' ? 'claude-sonnet-5' : input.kind === 'openai' ? 'gpt-5' : 'probe';
    const row: ProviderAccount = { id: 'probe', label: 'probe', kind: input.kind, auth: input.auth, baseUrl: input.baseUrl ?? '', defaultModel: placeholder, enabled: true, revision: 0 };
    try {
      return await (this.deps.listModels ?? listProviderModels)(resolveProviderAccount(row, placeholder, input.secret ?? null));
    } catch (error) {
      const diagnostic = providerDiagnostic(error);
      throw new ProviderAccountError(502, `Could not load models. ${diagnostic.message} You can still enter a custom model.`);
    }
  }

  save(body: unknown) { return this.#serial(async () => {
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) throw new ProviderAccountError(400, 'Invalid account settings.');
    const input = parsed.data;
    if ((input.kind === 'codex') !== (input.auth === 'chatgpt')) throw new ProviderAccountError(400, 'Codex accounts require ChatGPT subscription sign-in.');
    if (input.kind === 'codex' && (!this.codex || input.secret)) throw new ProviderAccountError(400, 'Enable the Codex experiment on the host and use device sign-in, not a pasted token.');
    if (input.auth === 'anthropic-oauth' && (input.kind !== 'anthropic' || input.secret)) throw new ProviderAccountError(400, 'Claude OAuth requires an Anthropic account and browser sign-in, not a pasted token.');
    const old = input.id ? await this.#row(input.id) : undefined;
    if (input.auth === 'anthropic-oauth' && !old && !this.anthropicOAuthEnabled) throw new ProviderAccountError(400, 'Enable the Claude OAuth experiment on the host first.');
    if (old?.deleting) throw new ProviderAccountError(409, 'Removal is pending. Unlock the vault and finish removing this account.');
    if (old && input.revision !== old.revision) throw new ProviderAccountError(409, 'This account changed. Reload before saving.');
    if (old && (old.kind !== input.kind || old.auth !== input.auth)) throw new ProviderAccountError(400, 'Create a separate account to change provider or authentication type.');
    if (input.auth === 'legacy-subscription-token' && (!old || input.secret)) throw new ProviderAccountError(400, 'Legacy subscription tokens are preserved for compatibility; new subscription sign-in is not supported here.');
    if (input.auth === 'none' && (input.kind !== 'openai-compatible' || input.secret)) throw new ProviderAccountError(400, 'No-key authentication is only available for compatible endpoints.');
    if (input.secret && /[\r\n\x00-\x1f]/.test(input.secret)) throw new ProviderAccountError(400, 'Credential cannot contain control characters.');
    let baseUrl: string;
    try { baseUrl = accountBaseUrl(input.kind, input.baseUrl); }
    catch (e) { throw new ProviderAccountError(400, (e as Error).message); }
    // Never send an existing key to a newly edited destination without the
    // owner explicitly supplying a credential for that destination.
    if (old && old.baseUrl !== baseUrl && input.auth !== 'none' && !input.secret) throw new ProviderAccountError(400, 'Enter the credential again when changing the endpoint.');
    const modelError = accountModelProblem(input.kind, input.defaultModel);
    if (modelError) throw new ProviderAccountError(400, modelError);
    const id = old?.id ?? randomUUID();
    if (old?.kind === 'codex') await this.#cancelCodex(id);
    const lease = old?.kind === 'codex' ? await this.#codexAccess(old, false) : undefined;
    const oauthLease = old?.auth === 'anthropic-oauth' ? await this.#anthropicAccess(old, false) : undefined;
    try {
    if (old?.auth === 'anthropic-oauth') this.anthropic?.forget(id);
    let secretRef = old?.secretRef ?? (input.auth === 'anthropic-oauth' ? `ANTHROPIC_ACCOUNT_${randomUUID().replaceAll('-', '_')}` : input.kind === 'codex' ? `CODEX_ACCOUNT_${randomUUID().replaceAll('-', '_')}` : null);
    if (input.secret) {
      if (!this.vault) throw new ProviderAccountError(409, 'Configure a credential vault on the host first.');
      // The credential is an owner secret bound to this account row
      // (owner-secrets §7), pre-approved because the owner typed it here.
      secretRef = `PROVIDER_ACCOUNT_${randomUUID().replaceAll('-', '_')}`;
      try {
        await putOwnerSecret(this.deps.pool as Pool, this.vault, {
          name: secretRef, value: input.secret,
          bindings: [{ kind: ACCOUNTS_PROVIDER_KIND, target: id, rule: 'pre-approved' }],
        });
      } catch { throw new ProviderAccountError(409, 'Could not save the credential to the vault.'); }
    }
    try {
      if (old) {
        const result = await this.deps.pool.query(`update core.provider_accounts set label=$2,base_url=$3,default_model=$4,
          enabled=$5,secret_ref=$6,legacy_env=$7,context_window_tokens=$9,revision=revision+1,updated_at=now() where id=$1 and revision=$8 returning id`,
        [id,input.label,baseUrl,input.defaultModel,input.enabled,secretRef,input.secret ? null : old.legacyEnv,old.revision,
          input.contextWindowTokens ?? null]);
        if (!result.rows.length) throw new ProviderAccountError(409, 'This account changed. Reload before saving.');
      } else await this.deps.pool.query(`insert into core.provider_accounts (id,label,kind,auth,base_url,default_model,enabled,secret_ref,context_window_tokens)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id,input.label,input.kind,input.auth,baseUrl,input.defaultModel,input.enabled,secretRef,
          input.contextWindowTokens ?? null]);
    } catch (error) {
      // Only delete the new, unreferenced secret; never alter the previous one.
      if (input.secret && secretRef) await deleteAccountSecret(this.deps.pool as Pool, this.vault, secretRef);
      throw error;
    }
    let warning: string | undefined;
    if (input.secret && old?.secretRef && !old.legacyEnv) {
      try { await deleteAccountSecret(this.deps.pool as Pool, this.vault, old.secretRef); }
      catch { warning = 'Account saved. Its retired credential could not be removed from the vault.'; }
    }
    this.#tests.delete(id);
    this.#modelLists.delete(id);
    await this.load();
    return { id, warning };
    } finally { await lease?.release(); await oauthLease?.release(); }
  }); }

  assign(agentId: string, body: unknown) { return this.#serial(async () => {
    const agent = this.deps.catalog().get(agentId);
    if (!agent) throw new ProviderAccountError(404, 'Agent not found.');
    const parsed = z.object({ accountId: z.string().min(1), model: z.string().trim().min(1).max(150) }).strict().safeParse(body);
    if (!parsed.success) throw new ProviderAccountError(400, 'Choose an account and model.');
    const row = await this.#row(parsed.data.accountId);
    const issue = accountModelProblem(row.kind, parsed.data.model);
    if (issue) throw new ProviderAccountError(400, issue);
    if (!row.enabled) throw new ProviderAccountError(409, 'Enable this account before assigning it.');
    const result = await this.deps.pool.query(`with selected as (
      select id from core.provider_accounts where id=$2 and enabled=true and deleting=false for update
    ) insert into core.agent_provider_accounts (agent_id,account_id,model) select $1,id,$3 from selected
      on conflict (agent_id) do update set account_id=$2, model=$3,updated_at=now() returning agent_id`, [agentId,row.id,parsed.data.model]);
    if (!result.rows.length) throw new ProviderAccountError(409, 'Account was disabled or removed. Reload before assigning it.');
    await this.load();
    return { changed: ['account', 'model'], note: 'Applies to new runs on every surface; active runs keep their selected account' };
  }); }

  remove(id: string, revision: number) { return this.#serial(async () => {
    const row = await this.#row(id);
    if (row.revision !== revision) throw new ProviderAccountError(409, 'This account changed. Reload before removing it.');
    const assigned = await this.deps.pool.query('select agent_id from core.agent_provider_accounts where account_id=$1', [id]);
    if (assigned.rows.length) throw new ProviderAccountError(409, 'Reassign the agents using this account before removing it. You can disable it instead.');
    if (row.kind === 'codex') await this.#cancelCodex(id);
    const lease = row.kind === 'codex' ? await this.#codexAccess(row, false) : undefined;
    const oauthLease = row.auth === 'anthropic-oauth' ? await this.#anthropicAccess(row, false) : undefined;
    try {
    this.anthropic?.forget(id);
    // A tombstone prevents reactivation even if vault deletion is denied.
    const disabled = await this.deps.pool.query(`update core.provider_accounts set enabled=false,deleting=true,revision=revision+1
      where id=$1 and revision=$2 returning id`, [id,revision]);
    if (!disabled.rows.length) throw new ProviderAccountError(409, 'This account changed. Reload before removing it.');
    await this.load();
    try { await deleteAccountSecret(this.deps.pool as Pool, this.vault, row.secretRef ?? undefined); }
    catch { throw new ProviderAccountError(409, 'Account disabled, but its credential could not be removed. Unlock the vault and retry removal.'); }
    await this.deps.pool.query('delete from core.provider_accounts where id=$1 and deleting=true and revision=$2', [id,revision+1]);
    this.#tests.delete(id); await this.load();
    this.codex?.forget(id);
    return { removed: true };
    } finally { await lease?.release(); await oauthLease?.release(); }
  }); }

  /** Pins account identity/model for a run; disabling stops its next model call. */
  provider(ref: ProviderRef): RuntimeProvider {
    const id = ref.accountId;
    if (!id) throw new ProviderAccountError(409, 'Choose a provider account for this agent in Settings → Agents.');
    const snapshot = this.#rows.get(id);
    if (!snapshot) throw new ProviderAccountError(409, 'Provider account is no longer available.');
    return {
      capabilities: { ...providerCapabilities(accountProtocol(snapshot.kind)), ...(snapshot.kind === 'codex' ? { usageReporting: false, parallelToolCalls: false } : {}) },
      complete: async request => {
        const row = await this.#row(id);
        if (row.revision !== snapshot.revision) throw new ProviderAccountError(409, 'Provider account settings changed during this run. Send a new message to continue with the updated account.');
        if (row.kind === 'codex') {
          if (!this.codex) throw new ProviderAccountError(409, 'Codex experiment is disabled on this process.');
          const lease = await this.#codexCompletionAccess(row, request.signal);
          try { return await this.codex.complete(lease.access, ref.model, request); }
          finally { await lease.release(); }
        }
        const resolved = resolveProviderAccount(row, ref.model, await this.#usableSecret(row, request.signal));
        return createProvider(resolved).complete(request);
      },
    };
  }

  async test(id: string): Promise<TestResult> {
    if (this.#testing.has(id)) throw new ProviderAccountError(409, 'A connection test is already running for this account.');
    this.#testing.add(id);
    try {
      const row = await this.#row(id);
      if (row.kind === 'codex') throw new ProviderAccountError(400, 'Codex connection testing has no verified output-token cap. Connect and send a test chat instead.');
      let diagnostic: ProviderDiagnostic = { state: 'connected', message: 'Connection succeeded.', httpStatus: null, retryAt: null };
      try {
        const resolved = resolveProviderAccount(row, row.defaultModel, await this.#usableSecret(row));
        if (this.deps.test) await this.deps.test(resolved);
        else await createProvider(resolved, { maxTokens: 32, maxStatusRetries: 0 }).complete({
          system: 'Reply with OK.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Connection test. Reply OK.' }] }],
          tools: [], signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        diagnostic = providerDiagnostic(error);
      }
      if ((await this.#row(id)).revision !== row.revision) throw new ProviderAccountError(409, 'Account changed during the test. Test it again.');
      const result = { ...diagnostic, checkedAt: new Date().toISOString() };
      this.#tests.set(id, result); return result;
    } finally { this.#testing.delete(id); }
  }

  /**
   * What a plugin sees (`CoreToolContext.providerAccounts`): the listing, an HTTP
   * account resolved as a run resolves it, and a Codex account's profile
   * staged under its lock. Never the vault reference.
   */
  pluginAccess(): ProviderAccountsAccess {
    return {
      list: () => this.view().accounts.map((a) => ({
        id: a.id, label: a.label, kind: a.kind, enabled: a.enabled, configured: a.configured, defaultModel: a.defaultModel,
      })),
      resolve: async (id, model, signal) => {
        const row = await this.#row(id);
        if (row.deleting) throw new ProviderAccountError(409, 'This account is being removed.');
        return resolveProviderAccount(row, model, await this.#usableSecret(row, signal));
      },
      withCodexProfile: async (id, use, signal) => {
        const row = await this.#row(id);
        if (row.kind !== 'codex') throw new ProviderAccountError(400, 'This is not a Codex account.');
        if (!this.codex) throw new ProviderAccountError(409, 'Codex experiment is not enabled in this process.');
        if (!row.enabled || row.deleting) throw new ProviderAccountError(409, `Provider account “${row.label}” is disabled.`);
        const lease = await this.#codexCompletionAccess(row, signal);
        try { return await this.codex.withProfile(lease.access, use); }
        finally { await lease.release(); }
      },
    };
  }

  async #cancelCodex(id: string) {
    await this.codex?.cancel(id);
    await this.#codexReleased.get(id);
  }

  async #usableSecret(row: Row, signal?: AbortSignal): Promise<string | null> {
    if (row.auth !== 'anthropic-oauth') {
      if (row.auth === 'none' || row.secretRef === null) return this.#secret(row);
      /*
       * The run path reads the credential through the owner secrets area
       * (owner-secrets §7): the binding found and the rule applied, the use
       * recorded — `pre-approved` delivers, so no card stands between an
       * agent and its model call. A legacy account's named environment
       * variable is buddi's own key and answers from the raw vault as before.
       */
      let value: string | null | undefined;
      const result = await useOwnerSecret(
        {
          pool: this.deps.pool as Pool,
          vault: this.vault,
          plugin: 'accounts',
          buddi: { version: '0.0', plugin: 'accounts' } as unknown as BuddiHost,
          now: () => new Date(),
          deliverInto: (delivered) => {
            value = delivered;
          },
        },
        { name: row.secretRef, kind: ACCOUNTS_PROVIDER_KIND, target: row.id },
      );
      if ('done' in result) return value ?? null;
      if ('pending' in result) throw new ProviderAccountError(409, `The owner has not approved this account's credential yet (action ${result.pending}).`);
      if (/not bound|no secret named|no vault/.test(result.refused)) {
        // Not an owner secret (a legacy entry the adoption has not reached, or
        // a fresh row): the raw vault answers as it always has.
        return this.#secret(row);
      }
      throw new ProviderAccountError(409, result.refused);
    }
    if (!this.anthropicOAuthEnabled) throw new ProviderAccountError(409, 'Claude OAuth experiment is disabled.');
    const lease = await this.#anthropicAccess(row, true, signal);
    try { return await this.anthropic!.credential(row.secretRef!); }
    catch (error) {
      // Never propagate vault or transport errors, which may contain secrets.
      throw new ProviderAccountError(409, error instanceof Error && /^(Connect this Claude|Claude token refresh|Invalid Claude credential|Claude credentials rotated|Claude authorization)/.test(error.message)
        ? error.message : 'Could not access Claude credentials securely. Check the vault and reconnect this account.');
    } finally { await lease.release(); }
  }

  async #anthropicAccess(row: Row, requireEnabled = true, signal?: AbortSignal) {
    if (row.auth !== 'anthropic-oauth' || !row.secretRef || !this.anthropic) throw new ProviderAccountError(409, 'Claude OAuth account is unavailable.');
    const deadline = Date.now() + 25_000;
    while (true) {
      signal?.throwIfAborted();
      const client = await this.deps.pool.connect();
      let acquired = false;
      try {
        acquired = (await client.query("select pg_try_advisory_lock(hashtext('buddi-anthropic-oauth'),hashtext($1)) as acquired", [row.id])).rows[0]?.acquired === true;
        if (acquired) {
          const current = (await client.query(`select ${columns} from core.provider_accounts where id=$1`, [row.id])).rows[0] as Row | undefined;
          if (!current || current.revision !== row.revision || (requireEnabled && (!current.enabled || current.deleting))) throw new ProviderAccountError(409, 'Claude account changed or is disabled. Refresh and try again.');
          return { release: async () => {
            try { await client.query("select pg_advisory_unlock(hashtext('buddi-anthropic-oauth'),hashtext($1))", [row.id]); }
            finally { client.release(); }
          } };
        }
      } catch (error) {
        if (acquired) await client.query("select pg_advisory_unlock(hashtext('buddi-anthropic-oauth'),hashtext($1))", [row.id]).catch(() => {});
        client.release(); throw error;
      }
      client.release();
      if (Date.now() >= deadline) throw new ProviderAccountError(423, 'Claude account is busy. Try again shortly.');
      await delay(100, undefined, { signal });
    }
  }

  anthropicAction(id: string, action: 'login' | 'complete-login' | 'cancel-login' | 'logout', body: { revision?: unknown; attemptId?: unknown; code?: unknown }, owner: string) {
    return this.#serial(async () => {
      const row = await this.#row(id);
      if (!owner || row.auth !== 'anthropic-oauth' || row.revision !== body.revision) throw new ProviderAccountError(409, 'Account changed. Refresh before continuing.');
      if ((action === 'login' || action === 'complete-login') && !this.anthropicOAuthEnabled) throw new ProviderAccountError(409, 'Claude OAuth experiment is disabled.');
      const lease = await this.#anthropicAccess(row, action === 'login' || action === 'complete-login');
      try {
        if (action === 'complete-login') {
          if (typeof body.attemptId !== 'string' || typeof body.code !== 'string' || body.code.length > 8192) throw new ProviderAccountError(400, 'Paste the full authorization code.');
          try { await this.anthropic!.finish(id, row.revision, owner, body.attemptId, body.code, row.secretRef!); }
          catch (error) { throw new ProviderAccountError(409, (error as Error).message); }
        } else {
          this.anthropic!.forget(id);
          if (action === 'logout') {
            try { await deleteAccountSecret(this.deps.pool as Pool, this.vault!, row.secretRef!); }
            catch { throw new ProviderAccountError(409, 'Could not remove Claude credentials. Unlock the vault and retry.'); }
          }
        }
        // Invalidates pending attempts in other processes, and old run snapshots.
        await this.deps.pool.query('update core.provider_accounts set revision=revision+1,updated_at=now() where id=$1', [id]);
        this.#modelLists.delete(id); this.#tests.delete(id);
        await this.load();
        return action === 'login' ? this.anthropic!.start(id, row.revision + 1, owner) : { completed: true };
      } finally { await lease.release(); }
    });
  }

  async #codexCompletionAccess(row: Row, signal?: AbortSignal) {
    const deadline = Date.now() + 120_000;
    while (true) {
      signal?.throwIfAborted();
      try { return await this.#codexAccess(row); }
      catch (error) {
        if (!(error instanceof ProviderAccountError) || error.status !== 423 || Date.now() >= deadline) throw error;
        // Release the DB client between attempts: queued agents cannot exhaust
        // the pool and starve the run that needs to finish refreshing its token.
        await delay(250, undefined, { signal });
      }
    }
  }

  async #codexAccess(row: Row, requireEnabled = true) {
    if (!this.codex || !row.secretRef || row.kind !== 'codex') throw new ProviderAccountError(409, 'Codex account is unavailable.');
    const client = await this.deps.pool.connect();
    let acquired = false;
    let released = () => {};
    try {
      const result = await client.query("select pg_try_advisory_lock(hashtext('buddi-codex'),hashtext($1)) as acquired", [row.id]);
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) throw new ProviderAccountError(423, 'This Codex account is busy in another run. Try again when it finishes.');
      this.#codexReleased.set(row.id, new Promise<void>((resolve) => { released = resolve; }));
      const access: CodexAccountAccess = { id: row.id, secretRef: row.secretRef, check: async () => {
        const current = (await client.query(`select ${columns} from core.provider_accounts where id=$1`, [row.id])).rows[0] as Row | undefined;
        if (!current) throw new ProviderAccountError(409, 'Codex account was removed.');
        if ((requireEnabled && (!current.enabled || current.deleting)) || current.revision !== row.revision) throw new ProviderAccountError(409, 'Codex account was disabled or changed. Start a new run.');
      } };
      await access.check();
      return { access, release: async () => {
        try { await client.query("select pg_advisory_unlock(hashtext('buddi-codex'),hashtext($1))", [row.id]); }
        finally { client.release(); this.#codexReleased.delete(row.id); released(); }
      } };
    } catch (error) {
      if (acquired) await client.query("select pg_advisory_unlock(hashtext('buddi-codex'),hashtext($1))", [row.id]);
      client.release(); if (acquired) { this.#codexReleased.delete(row.id); released(); } throw error;
    }
  }

  codexAction(id: string, action: 'login' | 'cancel-login' | 'logout', revision: unknown) { return this.#serial(async () => {
    const row = await this.#row(id);
    if (!this.codex || row.kind !== 'codex' || !row.secretRef) throw new ProviderAccountError(409, 'Codex experiment is unavailable.');
    if (revision !== row.revision) throw new ProviderAccountError(409, 'Account changed. Refresh before continuing.');
    if (action === 'cancel-login') { await this.#cancelCodex(id); return { cancelled: true }; }
    if (action === 'logout') {
      await this.#cancelCodex(id);
      const lease = await this.#codexAccess(row, false);
      try { await deleteAccountSecret(this.deps.pool as Pool, this.vault!, row.secretRef); }
      finally { await lease.release(); }
      await this.load();
      this.codex.forget(id);
      this.#modelLists.delete(id);
      return { removed: true };
    }
    const lease = await this.#codexAccess(row);
    try {
      const started = await this.codex.login(lease.access);
      void started.finished.then(() => lease.release()).catch(() => {});
      return started.view;
    } catch {
      await lease.release();
      throw new ProviderAccountError(409, 'Could not start Codex sign-in. Check CLI version 0.155.0 and host vault access.');
    }
  }); }
}

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  accountBaseUrl, accountModelProblem, accountProtocol, createVault, providerFromEnv,
  resolveProviderAccount, vaultState, type AgentCatalog, type AgentFrontmatter,
  type LoadAgentCatalogOptions, type ProviderAccount, type ProviderRef, type ResolvedProvider, type Vault,
} from '@buddi/core';
import { createProvider, providerCapabilities, type RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { z } from 'zod';
import { providerDiagnostic, type ProviderDiagnostic } from './provider-diagnostics.js';
import { CodexAccounts, type CodexAccountAccess } from './codex-accounts.js';

type Row = ProviderAccount & { secretRef: string | null; legacyEnv: string | null; deleting: boolean };
type Binding = { agentId: string; accountId: string; model: string };
type TestResult = ProviderDiagnostic & { checkedAt: string };
const columns = `id, label, kind, auth, base_url as "baseUrl", default_model as "defaultModel",
  enabled, deleting, revision, secret_ref as "secretRef", legacy_env as "legacyEnv"`;
const saveSchema = z.object({
  id: z.string().min(1).max(100).optional(), revision: z.number().int().positive().optional(),
  label: z.string().trim().min(1).max(100), kind: z.enum(['anthropic', 'openai', 'openai-compatible', 'codex']),
  auth: z.enum(['api-key', 'none', 'legacy-subscription-token', 'chatgpt']),
  baseUrl: z.string().trim().max(2048).optional(), defaultModel: z.string().trim().min(1).max(150),
  enabled: z.boolean(), secret: z.string().trim().min(1).max(16384).optional(),
}).strict();
const legacy = [
  { id: 'legacy-anthropic-api', name: 'ANTHROPIC_API_KEY', label: 'Anthropic — existing API key', kind: 'anthropic', auth: 'api-key' },
  { id: 'legacy-anthropic-subscription', name: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude — existing subscription token', kind: 'anthropic', auth: 'legacy-subscription-token' },
  { id: 'legacy-openai-api', name: 'OPENAI_API_KEY', label: 'OpenAI — existing API key', kind: 'openai', auth: 'api-key' },
] as const;

export class ProviderAccountError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Owner-only service. No account credentials are exposed as tools or put in env. */
export class ProviderAccounts {
  readonly vault: Vault | undefined;
  readonly codex: CodexAccounts | undefined;
  #rows = new Map<string, Row>();
  #bindings = new Map<string, Binding>();
  #configured = new Map<string, boolean>();
  #tests = new Map<string, TestResult>();
  #testing = new Set<string>();
  #codexReleased = new Map<string, Promise<void>>();
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly deps: {
    pool: Pick<Pool, 'query' | 'connect'>; env: NodeJS.ProcessEnv;
    catalog: () => AgentCatalog; reload: () => void; vault?: Vault;
    test?: (resolved: ResolvedProvider) => Promise<void>;
  }) {
    this.vault = deps.vault ?? createVault({ env: deps.env });
    if (deps.env.BUDDI_CODEX_EXPERIMENT === '1' && this.vault) this.codex = new CodexAccounts({ vault: this.vault });
  }

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
        for (const item of legacy) {
          const ref = providerFromEnv(this.deps.env, undefined, item.kind);
          await client.query(`insert into core.provider_accounts
            (id,label,kind,auth,base_url,default_model,secret_ref,legacy_env,enabled)
            values ($1,$2,$3,$4,$5,$6,$7,$7,$8) on conflict (id) do nothing`,
          [item.id, item.label, item.kind, item.auth, accountBaseUrl(item.kind), ref.model, item.name,
            !removed.rows.some(r => r.name === item.name)]);
        }
        for (const summary of this.deps.catalog().list()) {
          const agent = this.deps.catalog().get(summary.id)!;
          const account = legacy.find(l => l.name === agent.provider.credential.env);
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

  async #secret(row: Row): Promise<string | null> {
    if (row.auth === 'none') return null;
    try {
      const value = row.secretRef ? await this.vault?.get(row.secretRef) : null;
      // Only a migrated account may use its original, explicitly named env.
      // Rotation clears legacyEnv; disable/delete never rediscovers another key.
      return value ?? (row.legacyEnv ? this.deps.env[row.legacyEnv]?.trim() || null : null);
    } catch { throw new ProviderAccountError(409, 'The credential vault is unavailable or locked. Unlock it on the host and retry.'); }
  }

  async load(): Promise<void> {
    const result = await this.deps.pool.query(`select ${columns} from core.provider_accounts order by created_at,id`);
    const bindings = await this.deps.pool.query('select agent_id as "agentId", account_id as "accountId", model from core.agent_provider_accounts');
    const configured = new Map<string, boolean>();
    for (const row of result.rows as Row[]) {
      try { configured.set(row.id, row.auth === 'none' || !!await this.#secret(row)); }
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
      credential: { kind: row.auth === 'legacy-subscription-token' ? 'subscription-token' : 'api-key', env: row.secretRef ?? 'NO_CREDENTIAL' },
    } as ProviderRef : { ...providerFromEnv(this.deps.env, agent.model, agent.provider), accountId: binding?.accountId ?? '' };
    const issue = !row ? 'Choose a provider account for this agent in Settings → Agents.'
      : row.kind === 'codex' && !this.codex ? 'Codex experiment is not enabled in this process.'
      : !row.enabled ? `Provider account “${row.label}” is disabled.`
      : !this.#configured.get(row.id) ? `Provider account “${row.label}” needs a credential or vault access.`
      : accountModelProblem(row.kind, binding!.model);
    return { provider, availability: issue ? { ok: false, problem: { code: 'missing-credential', message: issue } } : { ok: true } };
  };

  view() {
    return {
      vault: { kind: this.vault?.kind ?? 'none', ...vaultState({ env: this.deps.env }) },
      codexEnabled: !!this.codex,
      accounts: [...this.#rows.values()].map(({ secretRef: _secret, legacyEnv: _env, deleting, ...row }) => ({
        ...row, configured: this.#configured.get(row.id) ?? false,
        removalPending: deleting,
        refreshable: row.kind === 'codex', tokenExpiresAt: null, subscriptionRenewsAt: null,
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

  save(body: unknown) { return this.#serial(async () => {
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) throw new ProviderAccountError(400, 'Invalid account settings.');
    const input = parsed.data;
    if ((input.kind === 'codex') !== (input.auth === 'chatgpt')) throw new ProviderAccountError(400, 'Codex accounts require ChatGPT subscription sign-in.');
    if (input.kind === 'codex' && (!this.codex || input.secret)) throw new ProviderAccountError(400, 'Enable the Codex experiment on the host and use device sign-in, not a pasted token.');
    const old = input.id ? await this.#row(input.id) : undefined;
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
    try {
    let secretRef = old?.secretRef ?? (input.kind === 'codex' ? `CODEX_ACCOUNT_${randomUUID().replaceAll('-', '_')}` : null);
    if (input.secret) {
      if (!this.vault) throw new ProviderAccountError(409, 'Configure a credential vault on the host first.');
      secretRef = `PROVIDER_ACCOUNT_${randomUUID().replaceAll('-', '_')}`;
      try { await this.vault.set(secretRef, input.secret); }
      catch { throw new ProviderAccountError(409, 'Could not save the credential to the vault.'); }
    }
    try {
      if (old) {
        const result = await this.deps.pool.query(`update core.provider_accounts set label=$2,base_url=$3,default_model=$4,
          enabled=$5,secret_ref=$6,legacy_env=$7,revision=revision+1,updated_at=now() where id=$1 and revision=$8 returning id`,
        [id,input.label,baseUrl,input.defaultModel,input.enabled,secretRef,input.secret ? null : old.legacyEnv,old.revision]);
        if (!result.rows.length) throw new ProviderAccountError(409, 'This account changed. Reload before saving.');
      } else await this.deps.pool.query(`insert into core.provider_accounts (id,label,kind,auth,base_url,default_model,enabled,secret_ref)
        values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id,input.label,input.kind,input.auth,baseUrl,input.defaultModel,input.enabled,secretRef]);
    } catch (error) {
      // Only delete the new, unreferenced secret; never alter the previous one.
      if (input.secret && secretRef) await this.vault?.delete(secretRef).catch(() => {});
      throw error;
    }
    let warning: string | undefined;
    if (input.secret && old?.secretRef && !old.legacyEnv) {
      try { await this.vault?.delete(old.secretRef); }
      catch { warning = 'Account saved. Its retired credential could not be removed from the vault.'; }
    }
    this.#tests.delete(id);
    await this.load();
    return { id, warning };
    } finally { await lease?.release(); }
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
    try {
    // A tombstone prevents reactivation even if vault deletion is denied.
    const disabled = await this.deps.pool.query(`update core.provider_accounts set enabled=false,deleting=true,revision=revision+1
      where id=$1 and revision=$2 returning id`, [id,revision]);
    if (!disabled.rows.length) throw new ProviderAccountError(409, 'This account changed. Reload before removing it.');
    await this.load();
    try { if (row.secretRef) await this.vault?.delete(row.secretRef); }
    catch { throw new ProviderAccountError(409, 'Account disabled, but its credential could not be removed. Unlock the vault and retry removal.'); }
    await this.deps.pool.query('delete from core.provider_accounts where id=$1 and deleting=true and revision=$2', [id,revision+1]);
    this.#tests.delete(id); await this.load();
    this.codex?.forget(id);
    return { removed: true };
    } finally { await lease?.release(); }
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
        const resolved = resolveProviderAccount(row, ref.model, await this.#secret(row));
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
        const resolved = resolveProviderAccount(row, row.defaultModel, await this.#secret(row));
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

  async #cancelCodex(id: string) {
    await this.codex?.cancel(id);
    await this.#codexReleased.get(id);
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
      try { await this.vault!.delete(row.secretRef); }
      finally { await lease.release(); }
      await this.load();
      this.codex.forget(id);
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

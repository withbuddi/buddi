import { createVault, modelCatalogue, modelProblem, providerFromEnv, resolveProvider, vaultState,
  type Vault, type ProviderKind, type ResolvedProvider } from '@buddi/core';
import { createProvider } from '@buddi/runtime';
import { z } from 'zod';

const names = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'] as const;
const providerSchema = z.enum(['anthropic', 'openai']);
const configSchema = z.object({ credentialKind: z.enum(['auto', 'api-key', 'subscription-token']), defaultModel: z.string().trim().min(1).max(150) }).strict();
const credentialSchema = z.object({ value: z.string().trim().min(1).max(16384) }).strict();
type Queryable = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };
export type ProviderTest = { state: 'connected' | 'authentication-error' | 'rate-limited' | 'unavailable'; message: string; checkedAt: string };
export class ProviderSettingsError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Owner-only configuration service, never registered as an agent tool. */
export class ProviderSettings {
  readonly vault: Vault | undefined;
  #tests = new Map<string, ProviderTest>();
  #sources = new Map<string, string>();
  #tail: Promise<unknown> = Promise.resolve();
  #testing = new Set<string>();
  #revision = 0;
  constructor(readonly deps: { pool: Queryable; env: NodeJS.ProcessEnv; reload: () => void; vault?: Vault;
    test?: (provider: ResolvedProvider) => Promise<void> }) {
    this.vault = deps.vault ?? createVault({ env: deps.env });
  }
  async load(): Promise<void> {
    const env = { ...this.deps.env };
    const sources = new Map(this.#sources);
    const { rows: configs } = await this.deps.pool.query('select provider, credential_kind, default_model from core.provider_settings');
    const { rows: credentials } = await this.deps.pool.query('select name, removed from core.provider_credential_state');
    for (const name of names) {
      if (credentials.some(row => row.name === name && row.removed)) {
        delete env[name]; sources.set(name, 'removed'); continue;
      }
      try {
        const value = await this.vault?.get(name);
        if (value) { env[name] = value; sources.set(name, 'vault'); }
        else sources.set(name, env[name] ? 'environment' : 'missing');
      } catch {
        delete env[name]; sources.set(name, 'locked or unavailable');
      }
    }
    for (const row of configs) {
      if (row.provider === 'anthropic') {
        env.BUDDI_ANTHROPIC_CREDENTIAL_KIND = row.credential_kind;
        env.BUDDI_MODEL = row.default_model;
      } else if (row.provider === 'openai') env.BUDDI_OPENAI_MODEL = row.default_model;
    }
    for (const name of [...names, 'BUDDI_ANTHROPIC_CREDENTIAL_KIND', 'BUDDI_MODEL', 'BUDDI_OPENAI_MODEL']) {
      if (env[name] === undefined) delete this.deps.env[name]; else this.deps.env[name] = env[name];
    }
    this.#sources = sources;
    this.#revision++;
    this.deps.reload();
  }
  view() {
    return { vault: { kind: this.vault?.kind ?? 'none', ...vaultState({ env: this.deps.env }) },
      providers: modelCatalogue(this.deps.env).map(p => ({ ...p,
        credentialKind: p.kind === 'anthropic' ? this.deps.env.BUDDI_ANTHROPIC_CREDENTIAL_KIND ?? 'auto' : 'api-key',
        activeCredential: providerFromEnv(this.deps.env, undefined, p.kind).credential.env,
        credentials: names.filter(name => p.kind === 'openai' ? name === 'OPENAI_API_KEY' : name !== 'OPENAI_API_KEY').map(name => ({
          name, configured: !!this.deps.env[name], source: this.#sources.get(name) ?? 'missing',
        })), test: this.#tests.get(p.kind) ?? null,
      })) };
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.#tail.then(fn, fn); this.#tail = work.catch(() => {}); return work;
  }
  configure(provider: string, body: unknown) {
    const kind = providerSchema.safeParse(provider); const config = configSchema.safeParse(body);
    if (!kind.success || !config.success || (provider === 'openai' && config.data.credentialKind !== 'api-key')) throw new ProviderSettingsError(400, 'Invalid provider settings.');
    if (modelProblem(kind.data, config.data.defaultModel)) throw new ProviderSettingsError(400, 'Model does not belong to this provider.');
    return this.#serial(async () => {
      await this.deps.pool.query('insert into core.provider_settings (provider, credential_kind, default_model) values ($1,$2,$3) on conflict (provider) do update set credential_kind=$2, default_model=$3, updated_at=now()', [provider, config.data.credentialKind, config.data.defaultModel]);
      this.#tests.delete(provider); await this.load(); return this.view();
    });
  }
  credential(name: string, action: 'save' | 'remove', body: unknown) {
    if (!(names as readonly string[]).includes(name)) throw new ProviderSettingsError(400, 'Unknown provider credential.');
    const parsed = action === 'save' ? credentialSchema.safeParse(body) : null;
    if (parsed && (!parsed.success || parsed.data.value === '<vault>')) throw new ProviderSettingsError(400, 'Enter a non-empty credential.');
    if (!this.vault) throw new ProviderSettingsError(409, 'No vault configured. Run buddi init on the host to enable secure credential storage.');
    return this.#serial(async () => {
      if (action === 'remove') {
        // Disable durably first: a failed physical deletion must not revive a key.
        await this.deps.pool.query('insert into core.provider_credential_state (name, removed) values ($1,true) on conflict (name) do update set removed=true, updated_at=now()', [name]);
        delete this.deps.env[name]; this.#sources.set(name, 'removed'); this.#tests.clear(); this.#revision++; this.deps.reload();
        try { await this.vault!.delete(name); }
        catch { throw new ProviderSettingsError(409, 'Credential disabled, but the vault could not delete it. Unlock the vault and retry removal.'); }
      } else {
        try { await this.vault!.set(name, parsed!.success ? parsed!.data.value : ''); }
        catch { throw new ProviderSettingsError(409, 'Could not save to the vault. Unlock the host keychain, or run buddi init to configure the encrypted-file vault.'); }
        await this.deps.pool.query('insert into core.provider_credential_state (name, removed) values ($1,false) on conflict (name) do update set removed=false, updated_at=now()', [name]);
      }
      this.#tests.clear(); await this.load(); return this.view();
    });
  }
  async test(provider: string): Promise<ProviderTest> {
    const kind = providerSchema.safeParse(provider);
    if (!kind.success) throw new ProviderSettingsError(400, 'Unknown provider.');
    if (this.#testing.has(provider)) throw new ProviderSettingsError(409, 'A connection test is already running.');
    this.#testing.add(provider);
    const revision = this.#revision;
    const ref = providerFromEnv(this.deps.env, undefined, kind.data);
    const resolved = resolveProvider(ref, this.deps.env);
    let result: ProviderTest;
    try {
      if (!resolved.ok) throw new Error('unavailable');
      if (this.deps.test) await this.deps.test(resolved.provider);
      else await createProvider(resolved.provider, { maxTokens: 32, maxStatusRetries: 0 }).complete({
        system: 'This is a connection test. Reply only OK.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }],
        tools: [], signal: AbortSignal.timeout(15000),
      });
      result = { state: 'connected', message: 'Connection and default model verified.', checkedAt: new Date().toISOString() };
    } catch (error) {
      const status = (error as { status?: number }).status;
      result = { state: status === 429 ? 'rate-limited' : status === 401 || status === 403 ? 'authentication-error' : 'unavailable',
        message: status === 429 ? 'Provider rate limit reached. Try again later.' : status === 401 || status === 403 ? 'Provider rejected the credential or access.' : 'Could not verify the default model. Check credentials, model access, network or provider availability.', checkedAt: new Date().toISOString() };
    } finally { this.#testing.delete(provider); }
    if (revision !== this.#revision) throw new ProviderSettingsError(409, 'Provider settings changed during this test. Test the current settings again.');
    this.#tests.set(provider, result); return result;
  }
}

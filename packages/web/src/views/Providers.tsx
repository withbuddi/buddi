/**
 * Model accounts: every credential the agents may run on, as a list on the
 * left and one account's detail on the right.
 *
 * The list says what an owner scans for: which provider, whether it works,
 * who uses it. The detail says everything else, and the technical caveats
 * that used to be three paragraphs per card sit under "Details" where they
 * can be read once.
 */
import { useEffect, useState } from 'react';
import { api, type ProviderAccount, type SaveProviderAccount } from '../api';
import {
  Button,
  Section,
  Details,
  Empty,
  ErrorBanner,
  Field,
  KV,
  Notice,
  PageFrame,
  Pill,
  Sheet,
  Stack,
  Toolbar,
  useAsync,
} from '../ui';
import { ModelPicker } from '../ModelPicker';
import { AGENTS_ROUTE, agentRoute } from '../routes';

type Run = (work: () => Promise<unknown>, message: string) => Promise<boolean>;

export function Providers({ embedded }: { embedded?: boolean } = {}): JSX.Element {
  const { data, error, reload, loading } = useAsync(() => api.providerAccounts(), []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [refreshRequested, setRefreshRequested] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pendingLogin = data?.accounts.some(a => a.login?.state === 'pending' &&
    a.login.expiresAt && Date.parse(a.login.expiresAt) > Date.now());
  useEffect(() => {
    if (!pendingLogin) return;
    const timer = setInterval(reload, 2_000);
    return () => clearInterval(timer);
  }, [pendingLogin, reload]);
  const run: Run = async (work, message) => {
    setBusy(true); setFailure(null); setNotice(''); setRefreshRequested(false);
    try {
      const result = await work() as { warning?: string } | undefined;
      setNotice(result?.warning ?? message); reload(); return true;
    } catch (e) { setFailure(e instanceof Error ? e.message : 'Could not apply change.'); reload(); return false; }
    finally { setBusy(false); }
  };
  const accounts = data?.accounts ?? [];
  const selected = accounts.find((a) => a.id === selectedId) ?? accounts[0];
  return (
    <PageFrame
      embedded={embedded}
      title="Model accounts"
      lede="Give each API key or subscription a name, then pick one per agent. An account never falls back to another credential on its own."
    >
      <ErrorBanner message={error ?? failure} />
      {notice && <Notice tone="good" role="status">{notice}</Notice>}
      {refreshRequested && (
        <Notice role="status">
          {loading ? 'Refreshing account status…' : error ? 'Could not refresh account status. Try again.' : 'Account status refreshed. This checks saved credentials; it does not renew subscription tokens or test connections.'}
        </Notice>
      )}
      {!data && !error && <Empty>Loading accounts…</Empty>}
      {error && <Toolbar><Button onClick={reload}>Retry</Button></Toolbar>}
      {data && <>
        {(data.vault.locked || data.vault.kind === 'none') && (
          <Notice tone="warning">{data.vault.advice || 'Run buddi init on the host to configure secure credential storage.'}</Notice>
        )}
        {adding && (
          <Sheet title="Add an account" onClose={() => setAdding(false)}>
            <div id="new-provider-account">
              <AccountWizard
                accounts={accounts}
                codexEnabled={data.codexEnabled}
                anthropicOAuthEnabled={data.anthropicOAuthEnabled}
                busy={busy}
                run={run}
                onDone={(id) => { setAdding(false); if (id) setSelectedId(id); }}
              />
            </div>
          </Sheet>
        )}
        <Section
          title="Accounts"
          aside={`Secrets live in the ${vaultName(data.vault.kind)}; Postgres holds names and assignments only.`}
          actions={
            <>
              <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => { setFailure(null); setNotice(''); setRefreshRequested(true); reload(); }}>
                {loading ? 'Refreshing…' : 'Refresh status'}
              </Button>
              <Button variant="accent" size="sm" disabled={busy} aria-expanded={adding} aria-controls="new-provider-account" onClick={() => setAdding(!adding)}>
                Add account
              </Button>
            </>
          }
          panel
          flush
        >
        {accounts.length === 0 ? (
          <Empty>No accounts yet. Add one to give your agents a model to run on.</Empty>
        ) : (
          <div className="accounts">
            <nav className="accounts-list" aria-label="Accounts">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="accounts-row"
                  aria-pressed={selected?.id === a.id}
                  onClick={() => setSelectedId(a.id)}
                >
                  <ProviderMark kind={a.kind} auth={a.auth} />
                  <span className="accounts-row-text">
                    <span className="accounts-row-name">{a.label}</span>
                    <span className="accounts-row-sub">{providerName(a)} · {a.assignedAgents.length === 0 ? 'no agents' : `${a.assignedAgents.length} agent${a.assignedAgents.length === 1 ? '' : 's'}`}</span>
                  </span>
                  <StatusDot account={a} />
                </button>
              ))}
            </nav>
            {selected ? (
              <AccountDetail key={`${selected.id}:${selected.revision}`} account={selected} anthropicOAuthEnabled={data.anthropicOAuthEnabled} busy={busy} run={run} />
            ) : null}
          </div>
        )}
        </Section>
      </>}
    </PageFrame>
  );
}

function vaultName(kind: string): string {
  return kind === 'keychain' ? 'macOS Keychain' : kind === 'file' ? 'encrypted file vault' : kind === 'none' ? 'vault (none configured)' : kind;
}

export function providerName(a: Pick<ProviderAccount, 'kind' | 'auth'>): string {
  if (a.kind === 'codex') return 'ChatGPT subscription';
  if (a.kind === 'anthropic') return a.auth === 'anthropic-oauth' ? 'Claude subscription' : a.auth === 'legacy-subscription-token' ? 'Claude setup token' : 'Anthropic API';
  if (a.kind === 'openai') return 'OpenAI API';
  return 'OpenAI-compatible';
}

/** A provider's mark: one letter in the provider's own tint, never a logo we do not own. */
function ProviderMark({ kind, auth }: { kind: ProviderAccount['kind']; auth: ProviderAccount['auth'] }): JSX.Element {
  const letter = kind === 'anthropic' ? 'A' : kind === 'codex' ? 'G' : kind === 'openai' ? 'O' : '∞';
  const tint = kind === 'anthropic' ? '3' : kind === 'codex' ? '2' : kind === 'openai' ? '5' : '4';
  return <span className="ui-avatar" data-tint={tint} aria-hidden="true" title={`${kind} · ${auth}`}>{letter}</span>;
}

function StatusDot({ account: a }: { account: ProviderAccount }): JSX.Element {
  const tone = !a.enabled ? undefined : a.configured ? 'good' : 'warning';
  const text = !a.enabled ? 'Disabled' : a.configured ? 'Configured' : 'Needs credential';
  return <Pill tone={tone}>{text}</Pill>;
}

function accountSettings(a: ProviderAccount): SaveProviderAccount {
  return { id: a.id, revision: a.revision, label: a.label, kind: a.kind, auth: a.auth, baseUrl: a.baseUrl, defaultModel: a.defaultModel, enabled: a.enabled,
    contextWindowTokens: a.contextWindowTokens ?? null };
}

function AccountDetail({ account: a, busy, run, anthropicOAuthEnabled }: { account: ProviderAccount; busy: boolean; run: Run; anthropicOAuthEnabled?: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <section className="accounts-detail" aria-label={a.label}>
      <div className="ui-card-head">
        <h3 className="ui-card-title">{a.label}</h3>
        <StatusDot account={a} />
      </div>
      <KV
        items={[
          { label: 'Provider', value: providerName(a) },
          { label: 'Default model', value: <span className="mono">{a.defaultModel || '—'}</span> },
          { label: 'Context window', value: <span className="mono">{`${(a.contextWindowTokens ?? a.detectedContextWindowTokens ?? 0).toLocaleString()} tokens${a.contextWindowTokens ? '' : ' (detected)'}`}</span> },
          ...(a.baseUrl ? [{ label: 'Endpoint', value: <span className="mono">{a.baseUrl}</span> }] : []),
          {
            label: 'Used by',
            value: a.assignedAgents.length ? (
              <span className="ui-row">
                {a.assignedAgents.map((id) => <a key={id} href={agentRoute(id, 'setup')}>{id}</a>)}
              </span>
            ) : (
              <span className="ui-row">
                <span className="muted">No agents</span>
                <a href={AGENTS_ROUTE}>Assign to an agent</a>
              </span>
            ),
          },
          ...(a.tokenExpiresAt ? [{ label: 'Access token', value: `expires ${new Date(a.tokenExpiresAt).toLocaleString()} (not your subscription renewal date)` }] : []),
        ]}
      />
      {a.removalPending && <Notice tone="warning">Removal is pending. Unlock the vault, then retry Remove account.</Notice>}
      {a.reconnectRequired && <Notice tone="warning">Token refresh did not finish. Reconnect this Claude account.</Notice>}
      {a.auth === 'anthropic-oauth' && <ClaudeLogin account={a} enabled={!!anthropicOAuthEnabled} busy={busy} run={run} />}
      {a.kind === 'codex' && <CodexLogin account={a} busy={busy} run={run} />}
      <Toolbar>
        <Button disabled={busy || a.removalPending} onClick={() => setEditing(true)}>Edit account</Button>
        <Button disabled={busy || a.removalPending} onClick={() => void run(() => api.saveProviderAccount({ ...accountSettings(a), enabled: !a.enabled }), a.enabled ? 'Account disabled. Subsequent model calls will stop; already-sent requests cannot be recalled.' : 'Account enabled.')}>{a.enabled ? 'Disable' : 'Enable'}</Button>
        {a.kind !== 'codex' && <Button disabled={busy || !a.enabled || !a.configured} onClick={() => void run(() => api.testProviderAccount(a.id), 'Connection test finished.')}>Test connection</Button>}
        <Button variant="danger" disabled={busy || a.assignedAgents.length > 0} title={a.assignedAgents.length ? 'Reassign its agents before removing this account' : undefined} onClick={() => setRemoving(true)}>Remove account</Button>
      </Toolbar>
      {a.test && <Notice role="status" tone={a.test.state === 'ok' ? 'good' : 'warning'}>
        <p>{a.test.state}{a.test.httpStatus ? ` · HTTP ${a.test.httpStatus}` : ''}: {a.test.message}</p>
        <p className="muted">Tested at: {new Date(a.test.checkedAt).toLocaleString()} (your browser’s local time). This is not a quota reset or subscription renewal date.</p>
        {a.test.retryAt ? <p>Provider suggested retry time: {new Date(a.test.retryAt).toLocaleString()}. This is retry advice, not a guaranteed quota reset.</p>
          : ['rate-limited', 'quota-exhausted'].includes(a.test.state) && <p className="muted">The provider did not supply a usable Retry-After time. Reset time is unknown.</p>}
      </Notice>}
      {editing && (
        <Sheet title={`Edit ${a.label}`} onClose={() => setEditing(false)}>
          <AccountForm account={a} busy={busy} run={run} onDone={() => setEditing(false)} />
        </Sheet>
      )}
      {removing && <Notice tone="critical">
        <p>Remove “{a.label}” and its stored credential from Buddi? This does not revoke it at the provider or remove it from backups.</p>
        <Toolbar>
          <Button variant="danger" disabled={busy} onClick={() => void run(() => api.removeProviderAccount(a.id, a.revision), 'Account removed from Buddi.')}>Confirm removal</Button>
          <Button disabled={busy} onClick={() => setRemoving(false)}>Cancel</Button>
        </Toolbar>
      </Notice>}
      <Details summary="Details">
        <div className="ui-prose muted">
          {a.auth === 'legacy-subscription-token' && <p>Legacy subscription token: not refreshable, token expiry and subscription renewal date unknown.</p>}
          {a.kind === 'codex' ? (
            <>
              <p>Experimental Codex App Server. Credentials stay in Buddi’s vault and are staged in a private temporary file during native sessions. Codex manages refresh. Subscription renewal date is unknown.</p>
              <p>Native tool-step usage reporting is incomplete. Do not use Buddi’s token or API-cost estimates as subscription billing or remaining quota.</p>
              <p>After connecting, assign this account to an agent and send a test message. Model turns use your subscription allowance.</p>
            </>
          ) : (
            <p>Testing sends a small fixed prompt and may incur a charge. No conversation or files are sent. Configured does not mean verified.</p>
          )}
          {a.auth === 'anthropic-oauth' && <p>Experimental Claude subscription sign-in. Tokens remain in Buddi’s vault and refresh before use. Subscription renewal and remaining quota are unknown.</p>}
          <p>Subscription login is separate from API-key access. Existing Claude setup tokens remain legacy accounts, without automatic refresh or a known expiry.</p>
        </div>
      </Details>
    </section>
  );
}

function CodexLogin({ account: a, busy, run }: { account: ProviderAccount; busy: boolean; run: Run }): JSX.Element {
  return <>
    <Toolbar>
      <Button disabled={busy || !a.enabled || a.removalPending || a.login?.state === 'pending'} onClick={() => void run(() => api.codexAccountAction(a.id, 'login', a.revision), 'Complete device sign-in below.')}>{a.configured ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}</Button>
      {a.login?.state === 'pending' && <Button disabled={busy} onClick={() => void run(() => api.codexAccountAction(a.id, 'cancel-login', a.revision), 'Sign-in cancelled.')}>Cancel sign-in</Button>}
      <Button disabled={busy || !a.configured} onClick={() => void run(() => api.codexAccountAction(a.id, 'logout', a.revision), 'Subscription disconnected from Buddi. Your regular Codex login is unchanged.')}>Disconnect</Button>
    </Toolbar>
    {a.login?.state === 'pending' && <Notice tone="accent" role="status">
      <p>Open <a href={a.login.verificationUrl} target="_blank" rel="noreferrer">{a.login.verificationUrl}</a> and enter <code>{a.login.userCode}</code>.</p>
      <p className="muted">Buddi stops waiting at {a.login.expiresAt && new Date(a.login.expiresAt).toLocaleTimeString()}. This is the sign-in timeout, not your subscription expiry.</p>
    </Notice>}
    {a.login && a.login.state !== 'pending' && <p role="status" className="muted">{a.login.message ?? `Sign-in ${a.login.state}.`}</p>}
  </>;
}

function AccountForm({ account: a, busy, run, onDone, codexEnabled, anthropicOAuthEnabled }: { account?: ProviderAccount; busy: boolean; run: Run; onDone: () => void; codexEnabled?: boolean; anthropicOAuthEnabled?: boolean }): JSX.Element {
  const [label, setLabel] = useState(a?.label ?? '');
  const [kind, setKind] = useState<ProviderAccount['kind']>(a?.kind ?? 'anthropic');
  const [auth, setAuth] = useState<ProviderAccount['auth']>(a?.auth ?? 'api-key');
  const [baseUrl, setBaseUrl] = useState(a?.baseUrl ?? '');
  const [model, setModel] = useState(a?.defaultModel ?? 'claude-sonnet-5');
  const [secret, setSecret] = useState('');
  // Blank means "whatever the model is known to hold". Only somebody serving
  // a model themselves, at a window of their own choosing, needs this.
  const [contextWindow, setContextWindow] = useState(a?.contextWindowTokens ? String(a.contextWindowTokens) : '');
  const changeKind = (value: ProviderAccount['kind']) => {
    setKind(value); setAuth(value === 'codex' ? 'chatgpt' : 'api-key'); setSecret('');
    setBaseUrl(value === 'openai-compatible' ? 'http://localhost:11434/v1' : '');
    setModel(value === 'anthropic' ? 'claude-sonnet-5' : value === 'openai' ? 'gpt-5' : '');
  };
  const incomplete = !label.trim() || !model.trim();
  return (
    <form className="ui-stack" onSubmit={e => {
      e.preventDefault();
      const value = secret; setSecret('');
      void run(() => api.saveProviderAccount({ ...(a ? { id: a.id, revision: a.revision } : {}), label, kind, auth, baseUrl,
        defaultModel: model, enabled: a?.enabled ?? true, contextWindowTokens: contextWindow.trim() ? Number(contextWindow) : null,
        ...(value.trim() ? { secret: value } : {}) }), 'Account saved. Agent model selections are unchanged.').then(ok => { if (ok) onDone(); });
    }}>
      <fieldset disabled={busy} className="ui-fields" data-stack="true">
        <Field label="Account name">
          <input autoFocus required maxLength={100} value={label} onChange={e => setLabel(e.target.value)} placeholder="Anthropic — Personal" />
        </Field>
        <Field label="Provider">
          <select disabled={!!a} value={auth === 'anthropic-oauth' ? 'anthropic-oauth' : kind} onChange={e => {
            if (e.target.value === 'anthropic-oauth') { changeKind('anthropic'); setAuth('anthropic-oauth'); }
            else changeKind(e.target.value as ProviderAccount['kind']);
          }}>
            <option value="anthropic">Anthropic API</option><option value="openai">OpenAI API</option><option value="openai-compatible">OpenAI-compatible endpoint</option>
            {(anthropicOAuthEnabled || a?.auth === 'anthropic-oauth') && <option value="anthropic-oauth">Claude subscription (experimental)</option>}
            {(codexEnabled || a?.kind === 'codex') && <option value="codex">ChatGPT subscription via Codex (experimental)</option>}
          </select>
        </Field>
        {kind === 'openai-compatible' && <>
          <Field label="API base URL" hint="Include the API path, such as /v1 or /api/v1. Conversation data will be sent to this endpoint. The model must support tool calling to use agent tools.">
            <input required type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
          </Field>
          <Field label="Authentication">
            <select disabled={!!a} value={auth} onChange={e => { setAuth(e.target.value as ProviderAccount['auth']); setSecret(''); }}>
              <option value="api-key">API key</option><option value="none">No key (local/self-hosted)</option>
            </select>
          </Field>
        </>}
        <Toolbar valign="end">
          <ModelPicker key={`${a?.id}:${a?.revision}`} accountId={a?.configured && a.enabled ? a.id : undefined} label="Default model" value={model} onChange={setModel} disabled={busy} />
        </Toolbar>
        <Field label="Context window" hint="Tokens this endpoint actually serves. Leave blank unless you run the model yourself and set a window of your own — a conversation is ended once its history would fill half of this.">
          <input type="number" inputMode="numeric" min={8000} max={2000000} step={1000} value={contextWindow}
            placeholder={a?.detectedContextWindowTokens ? String(a.detectedContextWindowTokens) : 'detected from the model'}
            onChange={e => setContextWindow(e.target.value)} />
        </Field>
        {kind === 'codex' && <p className="muted">Enter a model available to your Codex subscription. API model availability is different; there is no automatic model fallback.</p>}
        {auth === 'anthropic-oauth' && <p className="muted">Save this account, then choose Connect Claude. You will approve in your browser and paste the authorization code here, not in chat. No existing agent assignment changes.</p>}
        {auth === 'api-key' && (
          <Field label={a ? 'Replacement API key (leave blank to keep)' : 'API key'}>
            <input type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={e => setSecret(e.target.value)} />
          </Field>
        )}
        {a && <p className="muted">Saving changes stops an active run at its next model call. Start a new turn afterward. Changing the default model does not change existing agent assignments.</p>}
        <Toolbar align="end">
          <Button onClick={onDone}>Cancel</Button>
          <Button type="submit" variant="accent" disabled={incomplete}>Save account</Button>
        </Toolbar>
      </fieldset>
      {incomplete && <p className="muted">Enter an account name and default model to enable Save account. The example name is a placeholder.</p>}
    </form>
  );
}

function ClaudeLogin({ account: a, enabled, busy, run }: { account: ProviderAccount; enabled: boolean; busy: boolean; run: Run }) {
  const [code, setCode] = useState('');
  useEffect(() => { setCode(''); }, [a.login?.attemptId, a.login?.state]);
  return <>
    {!enabled && <Notice tone="warning">Claude OAuth is disabled on this host.</Notice>}
    <Toolbar>
      <Button disabled={busy || !enabled || !a.enabled || a.removalPending || a.login?.state === 'pending'} onClick={() => void run(() => api.anthropicAccountAction(a.id, 'login', a.revision), 'Open the Claude consent link below. Existing credentials remain until sign-in succeeds.')}>{a.configured ? 'Reconnect Claude' : 'Connect Claude'}</Button>
      {a.login?.state === 'pending' && <Button disabled={busy} onClick={() => { setCode(''); void run(() => api.anthropicAccountAction(a.id, 'cancel-login', a.revision), 'Claude sign-in cancelled.'); }}>Cancel sign-in</Button>}
      <Button disabled={busy || !a.configured || a.removalPending} onClick={() => { setCode(''); void run(() => api.anthropicAccountAction(a.id, 'logout', a.revision), 'Claude disconnected from Buddi. This does not revoke access at Anthropic.'); }}>Disconnect Claude</Button>
    </Toolbar>
    {a.login?.state === 'pending' && <form className="ui-notice" data-tone="accent" onSubmit={e => {
      e.preventDefault(); const pasted = code; setCode('');
      void run(() => api.anthropicAccountAction(a.id, 'complete-login', a.revision, { attemptId: a.login!.attemptId!, code: pasted }), 'Claude connected. Edit account to load its model list, then assign it to an agent.');
    }}>
      <p><a href={a.login.verificationUrl} target="_blank" rel="noreferrer">Open Claude consent page</a></p>
      <p className="muted">Use the Claude account you want to connect. Paste the entire code including #state. This attempt expires at {a.login.expiresAt && new Date(a.login.expiresAt).toLocaleTimeString()}; restarting Buddi also ends it.</p>
      <Field label="Claude authorization code">
        <input type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={code} onChange={e => setCode(e.target.value)} disabled={busy} />
      </Field>
      <Toolbar align="end"><Button type="submit" variant="accent" disabled={busy || !code.trim()}>Complete Claude sign-in</Button></Toolbar>
    </form>}
  </>;
}


/**
 * Adding an account, in the order the facts become available.
 *
 * Step one asks only what the owner already knows: a name, the provider, and
 * the key or endpoint. Step two happens once the account exists, because that
 * is when the provider can be asked what models it serves, or when a
 * subscription can be connected. The default model is chosen from a real
 * list, not typed from memory before there is anything to check it against.
 */
const STARTING_MODEL: Record<string, string> = { anthropic: 'claude-sonnet-5', openai: 'gpt-5', codex: 'gpt-5' };

/** The name the form proposes for a provider, before the owner touches it. */
export function suggestedLabel(kind: ProviderAccount['kind'], auth: ProviderAccount['auth'], taken: string[]): string {
  const base = kind === 'codex' ? 'ChatGPT subscription'
    : kind === 'anthropic' ? (auth === 'anthropic-oauth' ? 'Claude subscription' : 'Anthropic API')
    : kind === 'openai' ? 'OpenAI API'
    : 'Local endpoint';
  const names = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n += 1) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  return base;
}

type Probe = { models: Array<{ id: string; name: string; isDefault: boolean; thinks?: boolean }>; truncated: boolean };

function AccountWizard({ accounts, busy, run, onDone, codexEnabled, anthropicOAuthEnabled }: {
  accounts: ProviderAccount[]; busy: boolean; run: Run; onDone: (id?: string) => void; codexEnabled?: boolean; anthropicOAuthEnabled?: boolean;
}): JSX.Element {
  const taken = accounts.map((a) => a.label);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [kind, setKind] = useState<ProviderAccount['kind']>('anthropic');
  const [auth, setAuth] = useState<ProviderAccount['auth']>('api-key');
  const [label, setLabel] = useState(() => suggestedLabel('anthropic', 'api-key', taken));
  const [labelTouched, setLabelTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState(false);

  const choose = (nextKind: ProviderAccount['kind'], nextAuth: ProviderAccount['auth']) => {
    setKind(nextKind); setAuth(nextAuth); setSecret(''); setProbe(null); setProbeError(''); setModel(''); setCustomModel(false);
    setBaseUrl(nextKind === 'openai-compatible' ? 'http://localhost:11434/v1' : '');
    if (!labelTouched) setLabel(suggestedLabel(nextKind, nextAuth, taken));
  };
  const saved = savedId ? accounts.find((a) => a.id === savedId) : undefined;
  if (savedId) {
    if (!saved) return <Empty>Saving…</Empty>;
    return <ModelStep account={saved} busy={busy} run={run} anthropicOAuthEnabled={anthropicOAuthEnabled} onDone={() => onDone(saved.id)} />;
  }

  const endpoint = kind === 'openai-compatible';
  const subscription = kind === 'codex' || auth === 'anthropic-oauth';
  const canProbe = !subscription && (auth === 'none' || secret.trim() !== '') && (!endpoint || baseUrl.trim() !== '');
  const loadModels = async (): Promise<void> => {
    setProbing(true); setProbeError('');
    try {
      const result = await api.probeModels({ kind: kind as 'anthropic' | 'openai' | 'openai-compatible', auth: auth as 'api-key' | 'none', ...(endpoint ? { baseUrl } : {}), ...(secret.trim() ? { secret } : {}) });
      setProbe(result);
      if (!model) setModel(result.models.find((m) => m.isDefault)?.id ?? result.models[0]?.id ?? '');
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : 'Could not load models. You can still enter a custom model.');
    } finally { setProbing(false); }
  };
  const chosen = model.trim();
  const incomplete = !label.trim() || (endpoint && !baseUrl.trim()) || (endpoint && !chosen);
  return (
    <form className="ui-stack" onSubmit={e => {
      e.preventDefault();
      const value = secret; setSecret('');
      const defaultModel = chosen || STARTING_MODEL[kind] || 'claude-sonnet-5';
      void (async () => {
        let created: { id: string } | undefined;
        const ok = await run(async () => {
          created = await api.saveProviderAccount({ label, kind, auth, baseUrl, defaultModel, enabled: true, ...(value.trim() ? { secret: value } : {}) });
          return created;
        }, 'Account saved.');
        if (!ok || !created) return;
        // A model picked here is the whole job; only a subscription has a next step.
        if (chosen || !subscription) onDone(created.id);
        else setSavedId(created.id);
      })();
    }}>
      <fieldset disabled={busy} className="ui-fields" data-stack="true">
        <Field label="Provider">
          <select value={auth === 'anthropic-oauth' ? 'anthropic-oauth' : kind} onChange={e => {
            if (e.target.value === 'anthropic-oauth') choose('anthropic', 'anthropic-oauth');
            else { const k = e.target.value as ProviderAccount['kind']; choose(k, k === 'codex' ? 'chatgpt' : 'api-key'); }
          }}>
            <option value="anthropic">Anthropic API</option><option value="openai">OpenAI API</option><option value="openai-compatible">OpenAI-compatible endpoint (Ollama, OpenRouter, vLLM…)</option>
            {anthropicOAuthEnabled && <option value="anthropic-oauth">Claude subscription (experimental)</option>}
            {codexEnabled && <option value="codex">ChatGPT subscription via Codex (experimental)</option>}
          </select>
        </Field>
        <Field label="Account name" hint="Proposed from the provider. Change it to anything you will recognise.">
          <input autoFocus required maxLength={100} value={label} onChange={e => { setLabel(e.target.value); setLabelTouched(true); }} placeholder="Anthropic — Personal" />
        </Field>
        {endpoint && <>
          <Field label="API base URL" hint="Include the API path, such as /v1 or /api/v1. Conversation data will be sent to this endpoint. The model must support tool calling to use agent tools.">
            <input required type="url" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setProbe(null); }} />
          </Field>
          <Field label="Authentication">
            <select value={auth} onChange={e => { setAuth(e.target.value as ProviderAccount['auth']); setSecret(''); setProbe(null); }}>
              <option value="api-key">API key</option><option value="none">No key (local/self-hosted)</option>
            </select>
          </Field>
        </>}
        {auth === 'api-key' && (
          <Field label="API key" hint="Stored in the vault, never shown again.">
            <input type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={e => { setSecret(e.target.value); setProbe(null); }} />
          </Field>
        )}
        {subscription ? (
          <p className="muted">{kind === 'codex' ? 'You will connect your ChatGPT subscription on the next step, with a device code, and pick a model then.' : 'You will connect your Claude subscription on the next step, in your browser, and pick a model then.'}</p>
        ) : (
          <div className="ui-field">
            <span className="ui-field-label">Model</span>
            {probe ? (
              <div className="ui-row">
                <select aria-label="Model" value={customModel ? '__custom__' : model} onChange={e => {
                  if (e.target.value === '__custom__') { setCustomModel(true); setModel(''); } else { setCustomModel(false); setModel(e.target.value); }
                }}>
                  {probe.models.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} — ${m.id}`}{m.isDefault ? ' (provider default)' : ''}{m.thinks ? ' · thinks' : ''}</option>)}
                  <option value="__custom__">Custom model…</option>
                </select>
                <Button size="sm" disabled={probing || !canProbe} onClick={() => void loadModels()}>{probing ? 'Loading…' : 'Reload'}</Button>
              </div>
            ) : (
              <div className="ui-row">
                <Button disabled={probing || !canProbe} onClick={() => void loadModels()}>{probing ? 'Loading models…' : 'Load models'}</Button>
                {!endpoint ? <span className="muted">Optional now: {STARTING_MODEL[kind]} is used until you pick one.</span> : <span className="muted">Ask the endpoint what it serves.</span>}
              </div>
            )}
            {customModel || (endpoint && !probe) ? (
              <input aria-label="Custom model" required={endpoint} maxLength={150} value={model} onChange={e => setModel(e.target.value)} placeholder={endpoint ? 'qwen3:8b' : STARTING_MODEL[kind]} />
            ) : null}
            {probeError ? <span className="ui-field-hint critical" role="alert">{probeError}</span> : null}
            {probe?.truncated ? <span className="ui-field-hint">Showing the first part of the provider’s list.</span> : null}
          </div>
        )}
        <Toolbar align="end">
          <Button onClick={() => onDone()}>Cancel</Button>
          <Button type="submit" variant="accent" disabled={incomplete}>Save account</Button>
        </Toolbar>
      </fieldset>
      {incomplete && <p className="muted">Enter an account name{endpoint ? ', an endpoint and a model' : ''} to enable Save account.</p>}
    </form>
  );
}

function ModelStep({ account: a, busy, run, anthropicOAuthEnabled, onDone }: { account: ProviderAccount; busy: boolean; run: Run; anthropicOAuthEnabled?: boolean; onDone: () => void }): JSX.Element {
  const [model, setModel] = useState(a.defaultModel);
  const connected = a.configured;
  return (
    <Stack gap="lg">
      <Notice tone="good">Saved “{a.label}”.</Notice>
      {a.auth === 'anthropic-oauth' && !connected ? <ClaudeLogin account={a} enabled={!!anthropicOAuthEnabled} busy={busy} run={run} /> : null}
      {a.kind === 'codex' && !connected ? <CodexLogin account={a} busy={busy} run={run} /> : null}
      {connected ? (
        <>
          <p className="ui-page-lede">Pick the model this account offers by default. An agent can still choose another when you assign it.</p>
          <Toolbar valign="end">
            <ModelPicker key={`${a.id}:${a.revision}`} accountId={a.enabled ? a.id : undefined} label="Default model" value={model} onChange={setModel} disabled={busy} />
          </Toolbar>
          <Toolbar align="end">
            <Button onClick={onDone}>Skip for now</Button>
            <Button variant="accent" disabled={busy || !model.trim()} onClick={() => {
              if (model === a.defaultModel) { onDone(); return; }
              void run(() => api.saveProviderAccount({ ...accountSettings(a), defaultModel: model }), 'Default model saved.').then((ok) => { if (ok) onDone(); });
            }}>Done</Button>
          </Toolbar>
        </>
      ) : (
        <Toolbar><Button onClick={onDone}>Finish later</Button></Toolbar>
      )}
    </Stack>
  );
}

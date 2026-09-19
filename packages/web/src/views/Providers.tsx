import { useEffect, useState } from 'react';
import { api, type ProviderAccount, type SaveProviderAccount } from '../api';
import { ErrorBanner, useAsync } from '../ui';
import { ModelPicker } from '../ModelPicker';

type Run = (work: () => Promise<unknown>, message: string) => Promise<boolean>;
export function Providers(): JSX.Element {
  const { data, error, reload, loading } = useAsync(() => api.providerAccounts(), []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [refreshRequested, setRefreshRequested] = useState(false);
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
  return <>
    <h2>Provider accounts</h2>
    <p className="lede">Give each API key or connection a name, then assign an account and model to each agent. Accounts never fall back to another credential automatically.</p>
    <p><a href="#/agents">Assign accounts to agents →</a></p>
    <ErrorBanner message={error ?? failure} />
    {notice && <p role="status">{notice}</p>}
    {refreshRequested && <p role="status">{loading ? 'Refreshing account status…' : error ? 'Could not refresh account status. Try again.' : 'Account status refreshed. This checks saved credentials; it does not renew subscription tokens or test connections.'}</p>}
    {!data && !error && <p>Loading accounts…</p>}
    {error && <button onClick={reload}>Retry</button>}
    {data && <>
      <p className="muted">Credential storage: {data.vault.kind === 'keychain' ? 'macOS Keychain' : data.vault.kind === 'file' ? 'Encrypted file vault' : data.vault.kind}. Postgres stores account settings and assignments, never secret values.</p>
      {(data.vault.locked || data.vault.kind === 'none') && <p className="attention">{data.vault.advice || 'Run buddi init on the host to configure secure credential storage.'}</p>}
      <button disabled={busy} aria-expanded={adding} aria-controls="new-provider-account" onClick={() => setAdding(!adding)}>{adding ? 'Cancel adding account' : 'Add account'}</button>
      <button disabled={busy || loading} onClick={() => { setFailure(null); setNotice(''); setRefreshRequested(true); reload(); }}>{loading ? 'Refreshing…' : 'Refresh status'}</button>
      {adding && <div id="new-provider-account"><AccountForm codexEnabled={data.codexEnabled} anthropicOAuthEnabled={data.anthropicOAuthEnabled} busy={busy} run={run} onDone={() => setAdding(false)} /></div>}
      {data.accounts.length === 0 && <p>No accounts yet. Add one to connect your agents.</p>}
      {data.accounts.map(account => <AccountCard key={`${account.id}:${account.revision}`} account={account} anthropicOAuthEnabled={data.anthropicOAuthEnabled} busy={busy} run={run} />)}
      <p className="muted">Subscription login is separate from API-key access. Existing Claude setup tokens remain legacy accounts, without automatic refresh or a known expiry. {data.codexEnabled ? 'Codex ChatGPT device sign-in is experimental; existing account assignments are unchanged.' : 'Codex subscription sign-in is not enabled on this host.'}</p>
    </>}
  </>;
}

function accountSettings(a: ProviderAccount): SaveProviderAccount {
  return { id: a.id, revision: a.revision, label: a.label, kind: a.kind, auth: a.auth, baseUrl: a.baseUrl, defaultModel: a.defaultModel, enabled: a.enabled };
}
function AccountCard({ account: a, busy, run, anthropicOAuthEnabled }: { account: ProviderAccount; busy: boolean; run: Run; anthropicOAuthEnabled?: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  return <section className="attention">
    <h3>{a.label} <span className="pill">{!a.enabled ? 'Disabled' : a.configured ? 'Configured' : 'Needs credential'}</span></h3>
    <p>{a.kind} · {a.auth} · {a.defaultModel}</p>
    <p className="mono muted">{a.baseUrl}</p>
    <p>Used by: {a.assignedAgents.length ? a.assignedAgents.join(', ') : 'No agents'}</p>
    {a.removalPending && <p className="attention">Removal is pending. Unlock the vault, then retry Remove account.</p>}
    {a.auth === 'legacy-subscription-token' && <p className="muted">Legacy subscription token · Not refreshable · Token expiry and subscription renewal date unknown</p>}
    {a.auth === 'anthropic-oauth' && <ClaudeLogin account={a} enabled={!!anthropicOAuthEnabled} busy={busy} run={run} />}
    {a.kind === 'codex' && <>
      <p className="muted">Experimental Codex App Server · Credentials stay in Buddi’s vault and are staged in a private temporary file during native sessions. Codex manages refresh. Subscription renewal date is unknown.</p>
      <p className="muted">Native tool-step usage reporting is incomplete. Do not use Buddi’s token or API-cost estimates as subscription billing or remaining quota.</p>
      <div className="bar">
        <button disabled={busy || !a.enabled || a.removalPending || a.login?.state === 'pending'} onClick={() => void run(() => api.codexAccountAction(a.id, 'login', a.revision), 'Complete device sign-in below.')}>{a.configured ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}</button>
        {a.login?.state === 'pending' && <button disabled={busy} onClick={() => void run(() => api.codexAccountAction(a.id, 'cancel-login', a.revision), 'Sign-in cancelled.')}>Cancel sign-in</button>}
        <button disabled={busy || !a.configured} onClick={() => void run(() => api.codexAccountAction(a.id, 'logout', a.revision), 'Subscription disconnected from Buddi. Your regular Codex login is unchanged.')}>Disconnect</button>
      </div>
      {a.login?.state === 'pending' && <div role="status">
        <p>Open <a href={a.login.verificationUrl} target="_blank" rel="noreferrer">{a.login.verificationUrl}</a> and enter <code>{a.login.userCode}</code>.</p>
        <p className="muted">Buddi stops waiting at {a.login.expiresAt && new Date(a.login.expiresAt).toLocaleTimeString()}. This is the sign-in timeout, not your subscription expiry.</p>
      </div>}
      {a.login && a.login.state !== 'pending' && <p role="status">{a.login.message ?? `Sign-in ${a.login.state}.`}</p>}
    </>}
    <div className="bar">
      <button disabled={busy || a.removalPending} onClick={() => setEditing(!editing)}>{editing ? 'Cancel edit' : 'Edit account'}</button>
      <button disabled={busy || a.removalPending} onClick={() => void run(() => api.saveProviderAccount({ ...accountSettings(a), enabled: !a.enabled }), a.enabled ? 'Account disabled. Subsequent model calls will stop; already-sent requests cannot be recalled.' : 'Account enabled.')}>{a.enabled ? 'Disable' : 'Enable'}</button>
      {a.kind !== 'codex' && <button disabled={busy || !a.enabled || !a.configured} onClick={() => void run(() => api.testProviderAccount(a.id), 'Connection test finished.')}>Test connection</button>}
      <button disabled={busy || a.assignedAgents.length > 0} title={a.assignedAgents.length ? 'Reassign its agents before removing this account' : undefined} onClick={() => setRemoving(true)}>Remove account</button>
    </div>
    <p className="muted">{a.kind === 'codex' ? 'After connecting, assign this account to an agent and send a test message. Model turns use your subscription allowance.' : 'Testing sends a small fixed prompt and may incur a charge. No conversation or files are sent. Configured does not mean verified.'}</p>
    {a.test && <div role="status">
      <p>{a.test.state}{a.test.httpStatus ? ` · HTTP ${a.test.httpStatus}` : ''}: {a.test.message}</p>
      <p className="muted">Tested at: {new Date(a.test.checkedAt).toLocaleString()} (your browser’s local time). This is not a quota reset or subscription renewal date.</p>
      {a.test.retryAt ? <p>Provider suggested retry time: {new Date(a.test.retryAt).toLocaleString()}. This is retry advice, not a guaranteed quota reset.</p>
        : ['rate-limited', 'quota-exhausted'].includes(a.test.state) && <p className="muted">The provider did not supply a usable Retry-After time. Reset time is unknown.</p>}
    </div>}
    {editing && <AccountForm account={a} busy={busy} run={run} onDone={() => setEditing(false)} />}
    {removing && <div className="attention">
      <p>Remove “{a.label}” and its stored credential from Buddi? This does not revoke it at the provider or remove it from backups.</p>
      <button disabled={busy} onClick={() => void run(() => api.removeProviderAccount(a.id, a.revision), 'Account removed from Buddi.')}>Confirm removal</button>
      <button disabled={busy} onClick={() => setRemoving(false)}>Cancel</button>
    </div>}
  </section>;
}

function AccountForm({ account: a, busy, run, onDone, codexEnabled, anthropicOAuthEnabled }: { account?: ProviderAccount; busy: boolean; run: Run; onDone: () => void; codexEnabled?: boolean; anthropicOAuthEnabled?: boolean }): JSX.Element {
  const [label, setLabel] = useState(a?.label ?? '');
  const [kind, setKind] = useState<ProviderAccount['kind']>(a?.kind ?? 'anthropic');
  const [auth, setAuth] = useState<ProviderAccount['auth']>(a?.auth ?? 'api-key');
  const [baseUrl, setBaseUrl] = useState(a?.baseUrl ?? '');
  const [model, setModel] = useState(a?.defaultModel ?? 'claude-sonnet-5');
  const [secret, setSecret] = useState('');
  const changeKind = (value: ProviderAccount['kind']) => {
    setKind(value); setAuth(value === 'codex' ? 'chatgpt' : 'api-key'); setSecret('');
    setBaseUrl(value === 'openai-compatible' ? 'http://localhost:11434/v1' : '');
    setModel(value === 'anthropic' ? 'claude-sonnet-5' : value === 'openai' ? 'gpt-5' : '');
  };
  return <form className="attention" onSubmit={e => {
    e.preventDefault();
    const value = secret; setSecret('');
    void run(() => api.saveProviderAccount({ ...(a ? { id: a.id, revision: a.revision } : {}), label, kind, auth, baseUrl,
      defaultModel: model, enabled: a?.enabled ?? true, ...(value.trim() ? { secret: value } : {}) }), 'Account saved. Agent model selections are unchanged.').then(ok => { if (ok) onDone(); });
  }}>
    <h3>{a ? 'Edit account' : 'New account'}</h3>
    <fieldset disabled={busy} className="provider-fields">
      <label>Account name <input autoFocus required maxLength={100} value={label} onChange={e => setLabel(e.target.value)} placeholder="Anthropic — Personal" /></label>
      <label>Provider <select disabled={!!a} value={auth === 'anthropic-oauth' ? 'anthropic-oauth' : kind} onChange={e => {
        if (e.target.value === 'anthropic-oauth') { changeKind('anthropic'); setAuth('anthropic-oauth'); }
        else changeKind(e.target.value as ProviderAccount['kind']);
      }}>
        <option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="openai-compatible">OpenAI-compatible</option>
        {(anthropicOAuthEnabled || a?.auth === 'anthropic-oauth') && <option value="anthropic-oauth">Anthropic — Claude subscription (experimental)</option>}
        {(codexEnabled || a?.kind === 'codex') && <option value="codex">Codex — ChatGPT subscription (experimental)</option>}
      </select></label>
      {kind === 'openai-compatible' && <>
        <label>API base URL <input required type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></label>
        <label>Authentication <select disabled={!!a} value={auth} onChange={e => { setAuth(e.target.value as ProviderAccount['auth']); setSecret(''); }}>
          <option value="api-key">API key</option><option value="none">No key (local/self-hosted)</option>
        </select></label>
        <p className="muted">Include the API path, such as /v1 or /api/v1. Conversation data will be sent to this endpoint. The model must support tool calling to use agent tools.</p>
      </>}
      <ModelPicker key={`${a?.id}:${a?.revision}`} accountId={a?.configured && a.enabled ? a.id : undefined} label="Default model" value={model} onChange={setModel} disabled={busy} />
      {kind === 'codex' && <p className="muted">Enter a model available to your Codex subscription. API model availability is different; there is no automatic model fallback.</p>}
      {auth === 'anthropic-oauth' && <p className="muted">Save this account, then choose Connect Claude. You will approve in your browser and paste the authorization code here, not in chat. No existing agent assignment changes.</p>}
      {auth === 'api-key' && <label>{a ? 'Replacement API key (leave blank to keep)' : 'API key'}
        <input type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={e => setSecret(e.target.value)} />
      </label>}
      {a && <p className="muted">Saving changes stops an active run at its next model call. Start a new turn afterward. Changing the default model does not change existing agent assignments.</p>}
      <div className="bar"><button type="submit" disabled={!label.trim() || !model.trim()}>Save account</button><button type="button" onClick={onDone}>Cancel</button></div>
    </fieldset>
    {(!label.trim() || !model.trim()) && <p className="muted">Enter an account name and default model to enable Save account. The example name is a placeholder.</p>}
  </form>;
}

function ClaudeLogin({ account: a, enabled, busy, run }: { account: ProviderAccount; enabled: boolean; busy: boolean; run: Run }) {
  const [code, setCode] = useState('');
  useEffect(() => { setCode(''); }, [a.login?.attemptId, a.login?.state]);
  return <>
    <p className="muted">Experimental Claude subscription sign-in · Tokens remain in Buddi’s vault and refresh before use. Subscription renewal and remaining quota are unknown.</p>
    {!enabled && <p className="attention">Claude OAuth is disabled on this host.</p>}
    {a.tokenExpiresAt && <p className="muted">Access token expires: {new Date(a.tokenExpiresAt).toLocaleString()}. This is not your subscription renewal date.</p>}
    {a.reconnectRequired && <p className="attention">Token refresh did not finish. Reconnect this Claude account.</p>}
    <div className="bar">
      <button disabled={busy || !enabled || !a.enabled || a.removalPending || a.login?.state === 'pending'} onClick={() => void run(() => api.anthropicAccountAction(a.id, 'login', a.revision), 'Open the Claude consent link below. Existing credentials remain until sign-in succeeds.')}>{a.configured ? 'Reconnect Claude' : 'Connect Claude'}</button>
      {a.login?.state === 'pending' && <button disabled={busy} onClick={() => { setCode(''); void run(() => api.anthropicAccountAction(a.id, 'cancel-login', a.revision), 'Claude sign-in cancelled.'); }}>Cancel sign-in</button>}
      <button disabled={busy || !a.configured || a.removalPending} onClick={() => { setCode(''); void run(() => api.anthropicAccountAction(a.id, 'logout', a.revision), 'Claude disconnected from Buddi. This does not revoke access at Anthropic.'); }}>Disconnect Claude</button>
    </div>
    {a.login?.state === 'pending' && <form onSubmit={e => {
      e.preventDefault(); const pasted = code; setCode('');
      void run(() => api.anthropicAccountAction(a.id, 'complete-login', a.revision, { attemptId: a.login!.attemptId!, code: pasted }), 'Claude connected. Edit account to load its model list, then assign it to an agent.');
    }}>
      <p><a href={a.login.verificationUrl} target="_blank" rel="noreferrer">Open Claude consent page ↗</a></p>
      <p className="muted">Use the Claude account you want to connect. Paste the entire code including #state. This attempt expires at {a.login.expiresAt && new Date(a.login.expiresAt).toLocaleTimeString()}; restarting Buddi also ends it.</p>
      <label>Claude authorization code <input type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={code} onChange={e => setCode(e.target.value)} disabled={busy} /></label>
      <button disabled={busy || !code.trim()}>Complete Claude sign-in</button>
    </form>}
  </>;
}

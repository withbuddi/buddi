import { useState } from 'react';
import { api, type ProvidersView } from '../api';
import { ErrorBanner, useAsync } from '../ui';

export function Providers(): JSX.Element {
  const { data, error, reload } = useAsync(() => api.providers(), []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const run = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true); setFailure(null); setNotice('');
    try { await work(); setNotice(message); reload(); }
    catch (e) { setFailure(e instanceof Error ? e.message : 'Could not apply change.'); }
    finally { setBusy(false); }
  };
  return <>
    <h2>Providers</h2>
    <p className="lede">Manage credentials and default models. Changes apply to new runs in dashboard and Telegram; active runs keep their current connection.</p>
    <p><a href="#/agents">Choose the provider and model for each agent →</a></p>
    <ErrorBanner message={error ?? failure} />
    {notice && <p role="status">{notice}</p>}
    {!data && !error && <p>Loading providers…</p>}
    {error && <button onClick={reload}>Retry</button>}
    {data && <>
      <p className="muted">Credential storage: {data.vault.kind === 'keychain' ? 'macOS Keychain' : data.vault.kind === 'file' ? 'Encrypted file vault' : data.vault.kind}. Secret values are never stored in Postgres, chat, or browser storage.</p>
      {(data.vault.locked || data.vault.kind === 'none') && <p className="attention">{data.vault.advice || 'Run buddi init on the host to configure secure credential storage.'}</p>}
      {data.providers.map(provider => <ProviderCard key={`${provider.kind}:${provider.defaultModel}:${provider.credentialKind}`} provider={provider} busy={busy} run={run} />)}
    </>}
  </>;
}

function ProviderCard({ provider: p, busy, run }: { provider: ProvidersView['providers'][number]; busy: boolean;
  run: (work: () => Promise<unknown>, message: string) => Promise<void> }): JSX.Element {
  const [model, setModel] = useState(p.defaultModel);
  const [kind, setKind] = useState(p.credentialKind);
  return <section className="attention">
    <h3>{p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI'} <span className="pill">{p.usable ? 'Credential configured' : 'Not available'}</span></h3>
    <p className="muted">Configured does not mean verified. Active credential: {p.activeCredential}.</p>
    <fieldset disabled={busy} className="provider-fields">
      {p.kind === 'anthropic' && <label>Authentication <select value={kind} onChange={e => setKind(e.target.value)}>
        <option value="auto">Automatic (subscription token first)</option><option value="api-key">API key</option><option value="subscription-token">Subscription token</option>
      </select></label>}
      <label>Default model <input value={model} onChange={e => setModel(e.target.value)} list={`provider-models-${p.kind}`} /></label>
      <datalist id={`provider-models-${p.kind}`}>{p.models.map(m => <option key={m.id} value={m.id} />)}</datalist>
      <button disabled={!model.trim()} onClick={() => void run(() => api.configureProvider(p.kind, { credentialKind: kind, defaultModel: model }), 'Provider defaults saved. Explicit per-agent model choices are unchanged.')}>Save defaults</button>
    </fieldset>
    {p.credentials.map(c => <Credential key={c.name} credential={c} busy={busy} run={run} />)}
    <p className="muted">Test connection sends a small fixed prompt to the saved default model. It may incur a small provider charge. No conversation or files are sent.</p>
    <button disabled={busy || !p.usable} onClick={() => void run(() => api.testProvider(p.kind), 'Connection test finished.')}>Test {p.kind} connection</button>
    {p.test && <p role="status">{p.test.state}: {p.test.message} <span className="muted">{new Date(p.test.checkedAt).toLocaleString()}</span></p>}
  </section>;
}

function Credential({ credential: c, busy, run }: { credential: ProvidersView['providers'][number]['credentials'][number]; busy: boolean;
  run: (work: () => Promise<unknown>, message: string) => Promise<void> }): JSX.Element {
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState(false);
  return <div className="provider-credential">
    <label>{c.name} <span className="muted">— {c.configured ? `Configured (${c.source})` : c.source}</span>
      <input type="password" autoComplete="new-password" spellCheck={false} value={value} disabled={busy}
        placeholder={c.configured ? 'Enter a replacement credential' : 'Enter credential'} onChange={e => setValue(e.target.value)} />
    </label>
    <div className="bar">
      <button disabled={busy || !value.trim()} onClick={() => {
        const secret = value; setValue('');
        void run(() => api.saveCredential(c.name, secret), 'Credential saved to the vault. New runs use the updated credential when selected.');
      }}>Save {c.name}</button>
      <button disabled={busy} onClick={() => setConfirm(true)}>Remove {c.name}</button>
    </div>
    {confirm && <div className="attention">
      <p>Remove this credential from Buddi? New runs using it may stop working. Any environment fallback will be disabled. This does not revoke the key at the provider or remove it from backups.</p>
      <button disabled={busy} onClick={() => { setConfirm(false); void run(() => api.removeCredential(c.name), 'Credential removed from Buddi; environment fallback disabled.'); }}>Confirm removal</button>
      <button disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
    </div>}
  </div>;
}

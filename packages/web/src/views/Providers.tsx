/**
 * Model accounts: every credential the agents may run on, as a list on the
 * left and one account's detail on the right.
 *
 * The list says what an owner scans for: which provider, whether it works,
 * who uses it. The detail says everything else, and the technical caveats
 * that used to be three paragraphs per card sit under "Details" where they
 * can be read once.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { OLLAMA_CLOUD_MODEL, api, keyRefused, type AccountRateLimit, type AccountTest, type MlxhProbe, type ProviderAccount, type SaveProviderAccount } from '../api';
import { Button, ButtonLink, Section, Details, Empty, ErrorBanner, Field, KV, Notice, PageFrame, Pill, Sheet, Stack, Toolbar, useAsync, EmptyState } from '../ui';
import { ModelPicker } from '../ModelPicker';
import { CODEX_STARTING_MODEL, codexSuggestion } from '../codex-models';
import { GEMINI_FALLBACK_MODEL, isGeminiAccount, isGeminiPro, limited, pickGeminiFlash, pickGeminiModel } from '../gemini';
import { MLXH_IMAGE_MODEL, firstMlxhModel, isMlxhAccount, mlxhNotAnswering, mlxhWindowNote } from '../mlxh';
import { SignInCode } from './parts/SignInCode';
import { AGENTS_ROUTE, agentRoute } from '../routes';
import { fmtClock, fmtMoment, fmtTime } from '../format';

type Run = (work: () => Promise<unknown>, message: string) => Promise<boolean>;

/**
 * `account` is the id a link asked for (`#/settings/accounts?account=<id>`):
 * that account opens, and a new link opens its account again.
 */
export function Providers({ embedded, account }: { embedded?: boolean; account?: string | null } = {}): JSX.Element {
  const { data, error, reload, loading } = useAsync(() => api.providerAccounts(), []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [refreshRequested, setRefreshRequested] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(account ?? null);
  useEffect(() => { if (account) setSelectedId(account); }, [account]);
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
  // Google's compatible address is named for what it is; the address itself comes from the gateway.
  const nameOf = (a: ProviderAccount): string => (isGeminiAccount(a, data?.gemini?.baseUrl) ? 'Gemini' : providerName(a));
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
                gemini={data.gemini}
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
          <EmptyState icon="chip" title="No accounts yet">Add one to give your agents a model to run on.</EmptyState>
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
                    {standingLimit(a) ? (
                      <span className="accounts-row-sub" data-tone="warning">{nameOf(a)} · back at {untilText(standingLimit(a)!.until)}</span>
                    ) : (
                      <span className="accounts-row-sub">{nameOf(a)} · {a.assignedAgents.length === 0 ? 'no agents' : `${a.assignedAgents.length} agent${a.assignedAgents.length === 1 ? '' : 's'}`}</span>
                    )}
                  </span>
                  <StatusDot account={a} />
                </button>
              ))}
            </nav>
            {selected ? (
              <AccountDetail key={`${selected.id}:${selected.revision}`} account={selected} provider={nameOf(selected)} anthropicOAuthEnabled={data.anthropicOAuthEnabled} busy={busy} run={run} />
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

export function providerName(a: Pick<ProviderAccount, 'kind' | 'auth'> & Partial<Pick<ProviderAccount, 'detectedContextWindowSource'>>): string {
  if (a.kind === 'codex') return 'ChatGPT subscription';
  if (a.kind === 'anthropic') return a.auth === 'anthropic-oauth' ? 'Claude subscription' : 'Anthropic API';
  if (a.kind === 'openai') return 'OpenAI API';
  if (a.auth === 'device-key') return 'Ollama Cloud';
  if (isMlxhAccount(a)) return 'mlxh';
  return 'OpenAI-compatible';
}

/** Whose the detected context window is, for the label beside it. */
export function detectedWindowSource(a: Pick<ProviderAccount, 'kind' | 'detectedContextWindowSource'> & Partial<Pick<ProviderAccount, 'detectedContextWindowTokens'>>): string {
  if (a.detectedContextWindowSource === 'mlxh') return mlxhWindowNote(a.detectedContextWindowTokens);
  if (a.detectedContextWindowSource !== 'provider') return 'assumed';
  return a.kind === 'codex' ? 'from ChatGPT' : 'from the provider';
}

/** A provider's mark: one letter in the provider's own tint, never a logo we do not own. */
function ProviderMark({ kind, auth }: { kind: ProviderAccount['kind']; auth: ProviderAccount['auth'] }): JSX.Element {
  const letter = kind === 'anthropic' ? 'A' : kind === 'codex' ? 'G' : kind === 'openai' ? 'O' : '∞';
  const tint = kind === 'anthropic' ? '3' : kind === 'codex' ? '2' : kind === 'openai' ? '5' : '4';
  return <span className="ui-avatar" data-tint={tint} aria-hidden="true" title={`${kind} · ${auth}`}>{letter}</span>;
}

/** Success reads good; limits and outages read warning; a rejected credential or missing model reads critical. */
function testTone(state: string): 'good' | 'warning' | 'critical' {
  if (state === 'connected') return 'good';
  if (['rate-limited', 'quota-exhausted', 'provider-unavailable'].includes(state)) return 'warning';
  return 'critical';
}

/** The limit its provider set, while it still stands; null once it has lapsed, even on a page left open. */
export function standingLimit(a: Pick<ProviderAccount, 'enabled' | 'configured' | 'rateLimit'>, now: number = Date.now()): AccountRateLimit | null {
  const limit = a.rateLimit;
  return a.enabled && a.configured && limit && Date.parse(limit.until) > now ? limit : null;
}

const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** When a limit lifts, the owner's way: "14:20" today, "tomorrow at 09:00", else the day and the time. */
export function untilText(iso: string, now: Date = new Date(), zone: string = browserZone()): string {
  const at = new Date(iso);
  const day = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: zone });
  if (day(at) === day(now)) return fmtClock(at, zone);
  if (day(at) === day(new Date(now.getTime() + 86_400_000))) return `tomorrow at ${fmtClock(at, zone)}`;
  return fmtMoment(at, zone);
}

function StatusDot({ account: a, long }: { account: ProviderAccount; long?: boolean }): JSX.Element {
  const limit = standingLimit(a);
  if (limit) {
    const said = `Rate-limited until ${untilText(limit.until)}`;
    return <span title={said}><Pill tone="warning">{long ? said : 'Rate-limited'}</Pill></span>;
  }
  const tone = !a.enabled ? undefined : a.configured ? 'good' : 'warning';
  const text = !a.enabled ? 'Disabled' : a.configured ? 'Configured' : 'Needs credential';
  return <Pill tone={tone}>{text}</Pill>;
}

/** The account's id, small and mono, with Copy: `buddi agents set <handle> --account <id>` takes it. */
function CopyId({ id }: { id: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(id).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return (
    <span className="accounts-id">
      <code className="accounts-id-text">{id}</code>
      <Button variant="ghost" size="sm" onClick={copy} aria-label={`Copy the id of this account`}>{copied ? 'Copied' : 'Copy'}</Button>
    </span>
  );
}

/**
 * What a provider's limit means, in plain words, with the one fix as the
 * action: a daily quota says its size and when it resets; a short burst says
 * what buddi does about it and offers nothing.
 */
function LimitNotice({ account: a, provider, children }: { account: ProviderAccount; provider: string; children?: ReactNode }): JSX.Element | null {
  const limit = standingLimit(a);
  if (!limit) return null;
  const who = limit.provider ?? provider;
  const when = untilText(limit.until);
  if (limit.scope === 'day') {
    const agents = a.assignedAgents;
    const them = agents.length === 1 ? agents[0]! : 'its agents';
    // ChatGPT's plan windows are hours or a week, not a calendar day.
    const plan = limit.provider === 'ChatGPT';
    const allowance = plan
      ? 'This ChatGPT plan has reached its usage limit'
      : limit.limit !== null
        ? `${limit.freeTier ? `${who}'s free tier allows` : `${who} allows this account`} ${limit.limit.toLocaleString()} ${limit.unit ?? 'requests'} a day`
        : `${who} says this account has used today's allowance`;
    const billing = limit.freeTier && limit.provider === 'Gemini' ? ', or turn on billing for the key at aistudio.google.com' : '';
    return (
      <Notice
        tone="warning"
        title={allowance}
        action={agents.length > 0 ? <ButtonLink size="sm" href={agents.length === 1 ? agentRoute(agents[0]!, 'setup', 'brain') : AGENTS_ROUTE}>{agents.length === 1 ? `Change ${agents[0]}'s account` : 'Change their accounts'}</ButtonLink> : undefined}
      >
        <p>It resets {/^tomorrow/.test(when) ? when : `at ${when}`}. Until then buddi doesn't send this account's requests to {who}, so {agents.length ? `${them}'s runs stop with this note` : 'a run on it stops with this note'} instead of failing again and again. To keep going {plan ? 'before then' : 'today'}, {agents.length ? `give ${them} another account` : 'use another account'}{billing}.</p>
        {children}
      </Notice>
    );
  }
  return (
    <Notice tone="warning" title={`${who} asked buddi to slow down`}>
      <p>It said to wait until {when}. A run that meets this waits and tries again — up to a minute during a conversation, longer for work in the background.</p>
      {children}
    </Notice>
  );
}

/** The engineer's half of a failed test: HTTP code, retry time, the provider's words. Never the sentence. */
function TestDetails({ test: t }: { test: AccountTest }): JSX.Element | null {
  if (t.state === 'connected') return null;
  return (
    <Details summary="Details">
      <KV items={[
        ...(t.httpStatus ? [{ label: 'HTTP', value: <span className="mono">{t.httpStatus}</span> }] : []),
        { label: 'Retry after', value: t.retryAt ? new Date(t.retryAt).toLocaleString() : 'not given' },
        ...(t.detail ? [{ label: 'Provider said', value: <span className="mono">{t.detail}</span> }] : []),
        { label: 'Tested', value: new Date(t.checkedAt).toLocaleString() },
      ]} />
    </Details>
  );
}

/**
 * One notice per account. A standing limit and a test that met it are the
 * same news, said once; any other test result replaces the limit, because a
 * refused key matters before a limit does.
 */
function AccountNotice({ account: a, provider }: { account: ProviderAccount; provider: string }): JSX.Element | null {
  const t = a.test;
  const limit = standingLimit(a);
  if (limit && (!t || ['rate-limited', 'quota-exhausted', 'connected'].includes(t.state))) {
    return <LimitNotice account={a} provider={provider}>{t && <TestDetails test={t} />}</LimitNotice>;
  }
  if (!t) return null;
  return (
    <Notice role="status" tone={testTone(t.state)}>
      <p>{t.message}</p>
      <TestDetails test={t} />
    </Notice>
  );
}

function accountSettings(a: ProviderAccount): SaveProviderAccount {
  return { id: a.id, revision: a.revision, label: a.label, kind: a.kind, auth: a.auth, baseUrl: a.baseUrl, defaultModel: a.defaultModel, enabled: a.enabled,
    contextWindowTokens: a.contextWindowTokens ?? null };
}

function AccountDetail({ account: a, provider, busy, run, anthropicOAuthEnabled }: { account: ProviderAccount; provider: string; busy: boolean; run: Run; anthropicOAuthEnabled?: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <section className="accounts-detail" aria-label={a.label}>
      <div className="ui-card-head">
        <h3 className="ui-card-title">{a.label}</h3>
        <StatusDot account={a} long />
      </div>
      <KV
        items={[
          { label: 'Provider', value: provider },
          { label: 'Default model', value: <span className="mono">{a.defaultModel || '—'}</span> },
          { label: 'Context window', value: <span className="mono">{`${(a.contextWindowTokens ?? a.detectedContextWindowTokens ?? 0).toLocaleString()} tokens${a.contextWindowTokens ? '' : ` (${detectedWindowSource(a)})`}`}</span> },
          ...(a.baseUrl ? [{ label: 'Endpoint', value: <span className="mono">{a.baseUrl}</span> }] : []),
          {
            label: 'Used by',
            value: a.assignedAgents.length ? (
              <span className="ui-row">
                {a.assignedAgents.map((id) => <a key={id} href={agentRoute(id, 'setup', 'brain')}>{id}</a>)}
              </span>
            ) : (
              <span className="ui-row">
                <span className="muted">No agents</span>
                <a href={AGENTS_ROUTE}>Assign to an agent</a>
              </span>
            ),
          },
          ...(a.tokenExpiresAt ? [{ label: 'Access token', value: `expires ${fmtTime(a.tokenExpiresAt, Intl.DateTimeFormat().resolvedOptions().timeZone)} (not your subscription renewal date)` }] : []),
          { label: 'ID', value: <CopyId id={a.id} /> },
        ]}
      />
      {a.removalPending && <Notice tone="warning">Removal is pending. Unlock the vault, then retry Remove account.</Notice>}
      {a.reconnectRequired && <Notice tone="warning">Token refresh did not finish. Reconnect this {a.kind === 'codex' ? 'ChatGPT' : 'Claude'} account.</Notice>}
      {a.auth === 'anthropic-oauth' && <ClaudeLogin account={a} enabled={!!anthropicOAuthEnabled} busy={busy} run={run} />}
      {a.kind === 'codex' && <CodexLogin account={a} busy={busy} run={run} />}
      {a.auth === 'device-key' && <OllamaLogin account={a} busy={busy} run={run} />}
      <Toolbar>
        <Button disabled={busy || a.removalPending} onClick={() => setEditing(true)}>Edit account</Button>
        <Button disabled={busy || a.removalPending} onClick={() => void run(() => api.saveProviderAccount({ ...accountSettings(a), enabled: !a.enabled }), a.enabled ? 'Account disabled. Subsequent model calls will stop; already-sent requests cannot be recalled.' : 'Account enabled.')}>{a.enabled ? 'Disable' : 'Enable'}</Button>
        {a.kind !== 'codex' && <Button disabled={busy || !a.enabled || !a.configured} onClick={() => void run(async () => { await api.testProviderAccount(a.id); return { warning: '' }; }, '')}>Test connection</Button>}
        <Button variant="danger" disabled={busy || a.assignedAgents.length > 0} title={a.assignedAgents.length ? 'Reassign its agents before removing this account' : undefined} onClick={() => setRemoving(true)}>Remove account</Button>
      </Toolbar>
      <AccountNotice account={a} provider={provider} />
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
          {a.kind === 'codex' ? (
            <>
              <p>Talks to OpenAI’s Codex backend directly with your ChatGPT sign-in. The credential stays in buddi’s vault; buddi refreshes it and never reads your own Codex login.</p>
              <p>Native tool-step usage reporting is incomplete. Do not use Buddi’s token or API-cost estimates as subscription billing or remaining quota.</p>
              <p>After connecting, assign this account to an agent and send a test message. Model turns use your subscription allowance.</p>
            </>
          ) : (
            <p>Test connection asks the default model to reply with the single word “ready” (at most five tokens, no tools) and may incur a small charge. No conversation or files are sent. Configured does not mean verified.</p>
          )}
          {a.auth === 'device-key' && <p>Ollama Cloud with a device key: buddi made a key pair and keeps it in the vault; ollama.com only ever saw the public half and this computer’s name. Each request to ollama.com is signed with the key, and nothing else is sent with it. Disconnect asks ollama.com to forget the device and removes the key from buddi either way.</p>}
          {a.auth === 'anthropic-oauth' && <p>Claude subscription sign-in. Tokens remain in Buddi’s vault and refresh before use. Uses your plan’s monthly Agent SDK credits; after them, an API key. Remaining credits are unknown here.</p>}
          <p>Subscription login is separate from API-key access.</p>
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
      <p>Open openai.com, type this code there and approve buddi.</p>
      {a.login.userCode && <SignInCode code={a.login.userCode} large />}
      {a.login.verificationUrl && <Toolbar><ButtonLink variant="accent" href={a.login.verificationUrl} target="_blank" rel="noreferrer">Open openai.com</ButtonLink></Toolbar>}
      {a.login.expiresAt && <p className="muted">The code works until {fmtClock(new Date(a.login.expiresAt), Intl.DateTimeFormat().resolvedOptions().timeZone)}. Start again after that; this is the sign-in timeout, not your subscription expiry.</p>}
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
          <select disabled={!!a} value={auth === 'anthropic-oauth' ? 'anthropic-oauth' : auth === 'device-key' ? 'ollama-cloud' : kind} onChange={e => {
            if (e.target.value === 'anthropic-oauth') { changeKind('anthropic'); setAuth('anthropic-oauth'); }
            else changeKind(e.target.value as ProviderAccount['kind']);
          }}>
            <option value="anthropic">Anthropic API</option><option value="openai">OpenAI API</option><option value="openai-compatible">OpenAI-compatible endpoint</option>
            {a?.auth === 'device-key' && <option value="ollama-cloud">Ollama Cloud</option>}
            {(anthropicOAuthEnabled || a?.auth === 'anthropic-oauth') && <option value="anthropic-oauth">Claude subscription</option>}
            {(codexEnabled || a?.kind === 'codex') && <option value="codex">ChatGPT subscription</option>}
          </select>
        </Field>
        {kind === 'openai-compatible' && auth !== 'device-key' && <>
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
          <ModelPicker key={`${a?.id}:${a?.revision}`} accountId={a?.configured && a.enabled ? a.id : undefined} label="Default model" value={model} onChange={setModel} disabled={busy} {...(a?.kind === 'codex' ? { origin: 'from ChatGPT', suggest: codexSuggestion } : {})} />
        </Toolbar>
        <Field label="Context window" hint={isMlxhAccount(a)
          ? 'mlxh refuses a prompt over its max_prompt_tokens, and its model manager does not report the number, so buddi assumes 8,192. After `mlxh config max_prompt_tokens 40960`, enter the same number here.'
          : 'Tokens this endpoint actually serves. Leave blank unless you run the model yourself and set a window of your own — a conversation is ended once its history would fill half of this.'}>
          <input type="number" inputMode="numeric" min={8000} max={2000000} step={1000} value={contextWindow}
            placeholder={a?.detectedContextWindowTokens ? `${a.detectedContextWindowTokens} (${detectedWindowSource(a)})` : 'assumed from the model'}
            onChange={e => setContextWindow(e.target.value)} />
        </Field>
        {kind === 'codex' && <p className="muted">Pick a model from the list once the account is connected.</p>}
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

/**
 * Ollama Cloud with a device key: Connect opens ollama.com in a window made
 * inside the click, and this card asks every two seconds whether the owner
 * pressed Connect there.
 */
function OllamaLogin({ account: a, busy, run }: { account: ProviderAccount; busy: boolean; run: Run }): JSX.Element {
  const pending = a.login?.state === 'pending' && a.login.attemptId ? a.login : null;
  // The page re-renders on every reload; the poll must not restart with it.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!pending?.attemptId) return undefined;
    let stopped = false;
    let asking = false;
    const timer = setInterval(() => {
      if (stopped || asking) return;
      asking = true;
      api.ollamaPoll(a.id, pending.attemptId!)
        .then((answer) => {
          if (stopped || answer.state === 'waiting') return;
          stopped = true;
          if (answer.state === 'connected') void runRef.current(async () => undefined, `Connected as ${answer.username}, device ${answer.deviceName}.`);
          else void runRef.current(async () => { throw new Error(answer.message); }, '');
        })
        .catch(() => { /* not answering for a moment; the next tick asks again */ })
        .finally(() => { asking = false; });
    }, 2_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [a.id, pending?.attemptId]);
  const connect = (): void => {
    // Opened here, inside the click, so no popup blocker stops it.
    const opened = typeof window.open === 'function' ? window.open('', '_blank') : null;
    void run(async () => {
      try {
        const started = await api.ollamaConnect(a.id, a.revision);
        if (opened) opened.location.href = started.verificationUrl;
        return started;
      } catch (error) { opened?.close(); throw error; }
    }, 'Press Connect on the ollama.com page. This card notices on its own.');
  };
  const device = a.device;
  return <>
    {device && <p className="muted" role="status">{device.connectedAt ? `Connected as ${device.username || 'an ollama.com account'}, device ${device.deviceName}.` : `Not connected yet. Device ${device.deviceName}.`}</p>}
    <Toolbar>
      <Button disabled={busy || !a.enabled || a.removalPending || !!pending} onClick={connect}>{a.configured ? 'Reconnect Ollama' : 'Connect Ollama'}</Button>
      <Button disabled={busy || !device || a.removalPending} onClick={() => void run(async () => ({ warning: (await api.ollamaDisconnect(a.id, a.revision)).note }), 'Disconnected.')}>Disconnect</Button>
    </Toolbar>
    {pending && <Notice tone="accent" role="status">
      <p><a href={pending.verificationUrl} target="_blank" rel="noreferrer">Open the ollama.com page</a> and press Connect. Sign in there first if it asks.</p>
      <p className="muted">buddi stops waiting at {pending.expiresAt && fmtClock(new Date(pending.expiresAt), Intl.DateTimeFormat().resolvedOptions().timeZone)}.</p>
    </Notice>}
  </>;
}

function ClaudeLogin({ account: a, enabled, busy, run }: { account: ProviderAccount; enabled: boolean; busy: boolean; run: Run }) {
  const [code, setCode] = useState('');
  useEffect(() => { setCode(''); }, [a.login?.attemptId, a.login?.state]);
  return <>
    {!enabled && <Notice tone="warning">Claude subscription sign-in is turned off on this host.</Notice>}
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
      <p className="muted">Use the Claude account you want to connect. Paste the entire code including #state. This attempt expires at {a.login.expiresAt && fmtClock(new Date(a.login.expiresAt), Intl.DateTimeFormat().resolvedOptions().timeZone)}; restarting Buddi also ends it.</p>
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
const STARTING_MODEL: Record<string, string> = { anthropic: 'claude-sonnet-5', openai: 'gpt-5', codex: CODEX_STARTING_MODEL };

/** The name the form proposes for a provider, before the owner touches it. */
export function suggestedLabel(kind: ProviderAccount['kind'], auth: ProviderAccount['auth'], taken: string[]): string {
  const base = kind === 'codex' ? 'ChatGPT subscription'
    : kind === 'anthropic' ? (auth === 'anthropic-oauth' ? 'Claude subscription' : 'Anthropic API')
    : kind === 'openai' ? 'OpenAI API'
    : auth === 'device-key' ? 'Ollama Cloud'
    : 'Local endpoint';
  return uniqueLabel(base, taken);
}

/** `base`, or `base 2`, `base 3`… when an account already has the name. */
function uniqueLabel(base: string, taken: string[]): string {
  const names = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n += 1) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  return base;
}

/** Said where the key was typed when the provider refused it (401/403). */
const KEY_REFUSED = 'That key was refused. Check it and paste it again.';

type Probe = { models: Array<{ id: string; name: string; isDefault: boolean; thinks?: boolean }>; truncated: boolean };

function AccountWizard({ accounts, busy, run, onDone, codexEnabled, anthropicOAuthEnabled, gemini }: {
  accounts: ProviderAccount[]; busy: boolean; run: Run; onDone: (id?: string) => void; codexEnabled?: boolean; anthropicOAuthEnabled?: boolean;
  /** The Gemini preset's address and key page, from the gateway. */
  gemini?: { baseUrl: string; keyUrl: string };
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

  const [cloud, setCloud] = useState(false);
  /** The Gemini preset: an OpenAI-compatible account on Google's address, a key, and the model list after the save. */
  const [google, setGoogle] = useState(false);
  /**
   * The mlxh preset: an OpenAI-compatible account on the address the gateway
   * found mlxh on, no key (mlxh takes any), and the model list after the save.
   * `undefined` while not chosen, null while the gateway is asked.
   */
  const [mlxh, setMlxh] = useState<MlxhProbe | null | undefined>(undefined);
  const choose = (nextKind: ProviderAccount['kind'], nextAuth: ProviderAccount['auth'], nextCloud = false) => {
    setKind(nextKind); setAuth(nextAuth); setSecret(''); setProbe(null); setProbeError(''); setModel(''); setCustomModel(false);
    setCloud(nextCloud); setGoogle(false); setMlxh(undefined);
    setBaseUrl(nextCloud ? '' : nextKind === 'openai-compatible' ? 'http://localhost:11434/v1' : '');
    if (!labelTouched) setLabel(nextCloud ? suggestedLabel(nextKind, 'device-key', taken) : suggestedLabel(nextKind, nextAuth, taken));
  };
  /** Ollama Cloud with a key rather than a device: the address comes from the gateway, which names it. */
  const useKey = (on: boolean) => {
    choose('openai-compatible', on ? 'api-key' : 'device-key', true);
    if (on) void api.ollama().then((probed) => setBaseUrl(probed.cloudBaseUrl)).catch(() => {});
  };
  const chooseGemini = () => {
    if (!gemini) return;
    choose('openai-compatible', 'api-key');
    setGoogle(true);
    setBaseUrl(gemini.baseUrl);
    if (!labelTouched) setLabel(uniqueLabel('Gemini', taken));
  };
  const chooseMlxh = () => {
    choose('openai-compatible', 'none');
    setMlxh(null);
    if (!labelTouched) setLabel(uniqueLabel('mlxh', taken));
    void api.mlxh().then((probed) => { setMlxh(probed); setBaseUrl(probed.baseUrl); }).catch(() => setMlxh(undefined));
  };
  const local = mlxh !== undefined;
  const saved = savedId ? accounts.find((a) => a.id === savedId) : undefined;
  if (savedId) {
    if (!saved) return <Empty>Saving…</Empty>;
    return <ModelStep account={saved} busy={busy} run={run} anthropicOAuthEnabled={anthropicOAuthEnabled} onDone={() => onDone(saved.id)} />;
  }

  const endpoint = kind === 'openai-compatible' && auth !== 'device-key';
  const subscription = kind === 'codex' || auth === 'anthropic-oauth' || auth === 'device-key';
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
  const incomplete = !label.trim() || (endpoint && !baseUrl.trim()) || (endpoint && !google && !local && !chosen) || (google && !secret.trim()) || (local && !mlxh?.running);
  return (
    <form className="ui-stack" onSubmit={e => {
      e.preventDefault();
      const value = secret; setSecret('');
      let defaultModel = chosen || (local ? firstMlxhModel(mlxh) ?? mlxh?.models[0]?.id : undefined) || (auth === 'device-key' ? OLLAMA_CLOUD_MODEL : STARTING_MODEL[kind]) || 'claude-sonnet-5';
      let flash: string | undefined;
      void (async () => {
        if (google) {
          // Google flags no default: start on the newest Pro the key can reach,
          // and let the next step offer the rest.
          defaultModel = GEMINI_FALLBACK_MODEL;
          try {
            const listed = await api.probeModels({ kind: 'openai-compatible', auth: 'api-key', baseUrl, secret: value });
            const ids = listed.models.map((m) => m.id);
            defaultModel = pickGeminiModel(ids) ?? defaultModel;
            flash = isGeminiPro(defaultModel) ? pickGeminiFlash(ids) : undefined;
          } catch { /* the save's own test says what is wrong with the key */ }
        }
        let created: { id: string } | undefined;
        /** The key answered, but not on this model: the model step comes next, with the reason. */
        let failed = false;
        const ok = await run(async () => {
          created = await api.saveProviderAccount({ label, kind, auth, baseUrl, defaultModel, enabled: true, ...(value.trim() ? { secret: value } : {}) });
          if (auth !== 'api-key') return created;
          // One small call before anything else: a service may list its
          // models without a key (Ollama Cloud does), so a list proves nothing.
          const verdict = await api.testProviderAccount(created.id);
          if (verdict.state === 'connected') return { ...created, warning: `Account saved. ${verdict.message}` };
          if (keyRefused(verdict)) {
            // Nothing left behind, or every retry adds one more copy.
            const id = created.id;
            created = undefined;
            try {
              const row = (await api.providerAccounts()).accounts.find((a) => a.id === id);
              if (row) await api.removeProviderAccount(id, row.revision);
            } catch { /* the sentence below matters more; the list can still remove it */ }
            throw new Error(KEY_REFUSED);
          }
          if (google && flash && limited(verdict)) {
            // A free Google AI key has no Pro allowance: a Pro refused for a
            // limit is tried once more on the newest Flash.
            const row = (await api.providerAccounts()).accounts.find((a) => a.id === created!.id);
            if (row) {
              await api.saveProviderAccount({ ...accountSettings(row), defaultModel: flash });
              const again = await api.testProviderAccount(created.id);
              if (again.state === 'connected') {
                return { ...created, warning: `Account saved on ${flash}. Your Google AI plan covers the Gemini app, not this key. The key’s Google Cloud project has no billing, so Pro models aren’t included; enable billing on that project at aistudio.google.com to use Pro.` };
              }
            }
          }
          // A limit or a model this key cannot use: the key may be fine.
          failed = true;
          return { ...created, warning: `Account saved. ${verdict.message}` };
        }, 'Account saved.');
        if (!ok || !created) return;
        // A model picked here is the whole job; only a subscription has a next step.
        // Gemini and mlxh serve several models: the next step lists them.
        if (google || local || failed) setSavedId(created.id);
        else if (chosen || !subscription) onDone(created.id);
        else setSavedId(created.id);
      })();
    }}>
      <fieldset disabled={busy} className="ui-fields" data-stack="true">
        <Field label="Provider">
          <select value={auth === 'anthropic-oauth' ? 'anthropic-oauth' : cloud ? 'ollama-cloud' : google ? 'gemini' : local ? 'mlxh' : kind} onChange={e => {
            if (e.target.value === 'anthropic-oauth') choose('anthropic', 'anthropic-oauth');
            else if (e.target.value === 'gemini') chooseGemini();
            else if (e.target.value === 'mlxh') chooseMlxh();
            else if (e.target.value === 'ollama-cloud') choose('openai-compatible', 'device-key', true);
            else { const k = e.target.value as ProviderAccount['kind']; choose(k, k === 'codex' ? 'chatgpt' : 'api-key'); }
          }}>
            <option value="anthropic">Anthropic API</option><option value="openai">OpenAI API</option>
            {gemini && <option value="gemini">Gemini (Google AI key)</option>}
            <option value="ollama-cloud">Ollama Cloud</option>
            <option value="mlxh">mlxh, local MLX models on this Mac</option>
            <option value="openai-compatible">OpenAI-compatible endpoint (Ollama, OpenRouter, vLLM…)</option>
            {anthropicOAuthEnabled && <option value="anthropic-oauth">Claude subscription</option>}
            {codexEnabled && <option value="codex">ChatGPT subscription</option>}
          </select>
        </Field>
        <Field label="Account name" hint="Proposed from the provider. Change it to anything you will recognise.">
          <input autoFocus required maxLength={100} value={label} onChange={e => { setLabel(e.target.value); setLabelTouched(true); }} placeholder="Anthropic — Personal" />
        </Field>
        {cloud && (
          <label className="ui-row">
            <input type="checkbox" checked={auth === 'api-key'} onChange={e => useKey(e.target.checked)} />
            <span>Use a key instead</span>
          </label>
        )}
        {endpoint && <>
          <Field label="API base URL" hint="Include the API path, such as /v1 or /api/v1. Conversation data will be sent to this endpoint. The model must support tool calling to use agent tools.">
            <input required type="url" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setProbe(null); }} />
          </Field>
          {!google && !local && <Field label="Authentication">
            <select value={auth} onChange={e => { setAuth(e.target.value as ProviderAccount['auth']); setSecret(''); setProbe(null); }}>
              <option value="api-key">API key</option><option value="none">No key (local/self-hosted)</option>
            </select>
          </Field>}
        </>}
        {auth === 'api-key' && (
          <Field label="API key" hint="Stored in the vault, never shown again.">
            <input type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={e => { setSecret(e.target.value); setProbe(null); }} />
          </Field>
        )}
        {local ? (
          mlxh === null ? <p className="muted">Looking for mlxh on this computer…</p>
          : mlxh?.running ? (
            <Stack gap="sm">
              <p className="muted">
                mlxh answers with {mlxh.models.length === 1 ? 'one model' : `${mlxh.models.length} models`}. No key: mlxh takes any. buddi starts on {firstMlxhModel(mlxh) ?? 'the first'}; the next step lists the rest. A model that is not loaded takes up to a minute on its first answer.
              </p>
              {mlxh.models.some((m) => m.kind === 'image') ? (
                <p className="muted">{mlxh.models.filter((m) => m.kind === 'image').map((m) => m.id).join(', ')}: {MLXH_IMAGE_MODEL}.</p>
              ) : null}
            </Stack>
          ) : <Notice tone="warning">{mlxhNotAnswering(mlxh?.baseUrl ?? baseUrl)}</Notice>
        ) : google && gemini ? (
          <p className="muted">
            <a href={gemini.keyUrl} target="_blank" rel="noreferrer">Get a key at aistudio.google.com</a>. buddi picks the newest Gemini Pro your key can reach; the next step lists the rest.
          </p>
        ) : subscription ? (
          <p className="muted">{kind === 'codex' ? 'You will connect your ChatGPT subscription on the next step, with a code you enter on openai.com, and pick a model then.'
            : auth === 'device-key' ? 'You will connect on the next step: ollama.com opens, you press Connect, and no key is typed. Free to start.'
            : 'You will connect your Claude subscription on the next step, in your browser, and pick a model then.'}</p>
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
      {incomplete && !local && <p className="muted">Enter an account name{google ? ' and a key' : endpoint ? ', an endpoint and a model' : ''} to enable Save account.</p>}
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
      {a.auth === 'device-key' && !connected ? <OllamaLogin account={a} busy={busy} run={run} /> : null}
      {connected ? (
        <>
          <p className="ui-page-lede">Pick the model this account offers by default. An agent can still choose another when you assign it.</p>
          <Toolbar valign="end">
            <ModelPicker key={`${a.id}:${a.revision}`} accountId={a.enabled ? a.id : undefined} label="Default model" value={model} onChange={setModel} disabled={busy}
              {...(a.kind === 'codex' ? {
                origin: 'from ChatGPT',
                suggest: codexSuggestion,
                // Still on the starting model: the suggestion is picked here,
                // and saved only by Done.
                onSuggest: (suggested: string) => setModel((current) => (current === CODEX_STARTING_MODEL && a.defaultModel === CODEX_STARTING_MODEL ? suggested : current)),
              } : {})} />
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

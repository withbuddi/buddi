/**
 * Settings → Connections (docs/connections.md).
 *
 * A service that speaks MCP — GitHub, Notion, Linear, any remote server — is
 * connected once: its address, its own consent page, a review of every tool it
 * brings with the tier buddi gives it, and which agents get them. The list
 * says where each connection stands, how many tools it brings and who holds
 * them; Disconnect names the agents it takes them from before it does.
 *
 * The four screens are one sheet, in the first-run wizard's voice: one
 * question per screen, the primary answer on the right. Signing in is the
 * service's own page, a code you type on its site (the device way, with
 * buddi's own app), a token you paste, or a client id; "I have a config"
 * reads the block another MCP client takes into the same screens.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type ConnectionCard,
  type ConnectionReview,
  type ConnectionState,
  type ConnectionToolView,
  type ConnectionView,
  type ConnectionsView,
} from '../api';
import { fmtRelative, fmtTime } from '../format';
import { Button, Card, Empty, EmptyState, ErrorBanner, Field, FormGrid, Notice, PageFrame, Pill, Section, Segment, Sheet, Stack, Tag, Toolbar, useAsync, type Tone } from '../ui';
import { parseConnectionConfig, type PastedConfig, type PastedHeader } from '@buddi/core/connection-config';
import { SignInCode } from './parts/SignInCode';

export const STATE_LABELS: Record<ConnectionState, { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'good' },
  'needs-reconnect': { label: 'Needs reconnect', tone: 'warning' },
  unreachable: { label: 'Unreachable', tone: 'critical' },
  'pending-review': { label: 'Not finished', tone: 'muted' },
  'needs-review': { label: 'Changed its tools', tone: 'warning' },
};

/** Why a tool's approval is never remembered: the server said it destroys something. */
export const NEVER_REMEMBERED = 'It can delete or destroy something, so it asks you every time and is never remembered.';

/** What a tier means to the owner, in the words of an approval. */
export function tierLabel(tool: { tier: 'auto' | 'gated'; destructive: boolean }): { label: string; tone: Tone } {
  if (tool.tier === 'auto') return { label: 'Runs on its own', tone: 'good' };
  if (tool.destructive) return { label: 'Asks you every time', tone: 'critical' };
  return { label: 'Asks you first', tone: 'warning' };
}

type Step = 'paste' | 'address' | 'consent' | 'review' | 'grant';

/** The tab the consent page comes back to tells the one that sent it (`ConnectionCallback`). */
export const CONNECTIONS_CHANNEL = 'buddi-connections';
export const CALLBACK_PATH = '/connections/callback';
const MANUAL_SENTENCE =
  'This service does not let buddi register itself. Create an app in its developer settings with the redirect address below, and paste its client id here. A token is usually simpler.';

interface FlowStart {
  step: Step;
  card?: ConnectionCard;
  connection?: ConnectionView;
  /** Reconnect and "review again" end at review: the agents already hold the tools. */
  keepGrants?: boolean;
}

export function Connections({ embedded, timezone }: { embedded?: boolean; timezone?: string } = {}): JSX.Element {
  const view = useAsync(() => api.connections(), [], 30_000);
  const [flow, setFlow] = useState<FlowStart | null>(null);
  const data = view.data;
  const agentName = (id: string): string => data?.agents.find((a) => a.id === id)?.name ?? id;
  return (
    <PageFrame
      embedded={embedded}
      title="Connections"
      lede="Services that speak MCP, connected once. Their tools become buddi tools: read at review, given to the agents you choose, approved like everything else."
    >
      <Stack gap="lg">
        {!data && !view.error ? <Empty>Reading your connections…</Empty> : null}
        <ErrorBanner message={view.error} />
        {data && !data.vault ? (
          <Notice tone="warning">This installation has no vault, so a service that asks for a sign-in cannot be connected. Turn the vault on first.</Notice>
        ) : null}
        {data ? (
          <Section title="Your connections" aside="Each one's tools are named mcp.<connection>.<tool>." panel>
            <Stack divided>
              {data.connections.length === 0 ? (
                <EmptyState icon="globe" title="Nothing connected yet">
                  Pick a service below, or give the address of any remote MCP server.
                </EmptyState>
              ) : (
                data.connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    agentName={agentName}
                    timezone={timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
                    onFlow={setFlow}
                    onChanged={view.reload}
                  />
                ))
              )}
            </Stack>
          </Section>
        ) : null}
        {data ? (
          <Section title="Connect a service" aside="Each has an official remote server. You sign in on the service's own page, or with a token.">
            <div className="connections-cards">
              {data.catalog.map((card) => (
                <Card
                  key={card.id}
                  title={card.name}
                  foot={<Toolbar align="end"><Button size="sm" onClick={() => setFlow({ step: 'address', card })}>Connect</Button></Toolbar>}
                >
                  <p className="ui-card-meta">{card.blurb}</p>
                </Card>
              ))}
              <Card
                title="Another server"
                foot={<Toolbar align="end"><Button size="sm" onClick={() => setFlow({ step: 'address' })}>Connect</Button></Toolbar>}
              >
                <p className="ui-card-meta">Any remote MCP server, by its https address.</p>
              </Card>
              <Card
                title="I have a config"
                foot={<Toolbar align="end"><Button size="sm" onClick={() => setFlow({ step: 'paste' })}>Paste it</Button></Toolbar>}
              >
                <p className="ui-card-meta">The mcpServers block another app uses, with its url and headers.</p>
              </Card>
            </div>
          </Section>
        ) : null}
      </Stack>
      {flow && data ? (
        <ConnectFlow
          start={flow}
          agents={data.agents}
          catalog={data.catalog}
          tokens={data.tokens ?? data.vault}
          onClose={() => { setFlow(null); view.reload(); }}
        />
      ) : null}
    </PageFrame>
  );
}

function ConnectionRow({
  connection,
  agentName,
  timezone,
  onFlow,
  onChanged,
}: {
  connection: ConnectionView;
  agentName: (id: string) => string;
  timezone: string;
  onFlow: (flow: FlowStart) => void;
  onChanged: () => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const state = STATE_LABELS[connection.state];
  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await api.disconnect(connection.id);
      setConfirming(false);
      onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const pending = connection.state === 'pending-review';
  return (
    <Stack gap="sm">
      <div className="ui-card-head">
        <h3 className="ui-card-title">{connection.name}</h3>
        <Pill tone={state.tone} dot>{state.label}</Pill>
        {connection.grant ? <Tag>{connection.grant}</Tag> : null}
      </div>
      <p className="ui-card-meta">
        <span className="mono">{connection.host}</span>
        {pending ? ' · its tools are not reviewed yet' : ` · ${connection.toolCount} ${connection.toolCount === 1 ? 'tool' : 'tools'}`}
        {connection.reviewedAt ? ` · reviewed ${fmtRelative(connection.reviewedAt)}` : ''}
      </p>
      {!pending ? (
        <p className="ui-card-meta">
          {connection.agents.length === 0
            ? 'No agent holds these tools yet.'
            : `Held by ${connection.agents.map(agentName).join(', ')}.`}
        </p>
      ) : null}
      {connection.state === 'needs-reconnect' ? (
        <p className="ui-card-meta">Its sign-in ran out or was refused. Until you reconnect, each of its tools answers with one sentence instead of running.</p>
      ) : null}
      {connection.state === 'needs-review' ? (
        <p className="ui-card-meta">
          It changed its tools since you reviewed them. The new and changed ones wait until you review it again
          {connection.heldTools ? ` (${connection.heldTools} of the ones you kept ${connection.heldTools === 1 ? 'waits' : 'wait'})` : ''}; the others keep working.
        </p>
      ) : null}
      {connection.state === 'unreachable' && connection.unreachableSince ? (
        <p className="ui-card-meta">Unreachable since {fmtTime(connection.unreachableSince, timezone)}, retrying.</p>
      ) : null}
      <ErrorBanner message={failure} />
      {confirming ? (
        <Notice tone="critical" role="alert" title={`Disconnect ${connection.name}?`}>
          <Stack gap="sm">
            <p>
              buddi forgets its sign-in and its tools.
              {connection.agents.length > 0
                ? ` ${connection.grant} comes out of ${connection.agents.map(agentName).join(', ')}.`
                : ' No agent holds its tools.'}
            </p>
            <Toolbar align="end">
              <Button size="sm" onClick={() => setConfirming(false)} disabled={busy}>Keep it</Button>
              <Button size="sm" variant="danger" onClick={() => void disconnect()} disabled={busy}>Disconnect</Button>
            </Toolbar>
          </Stack>
        </Notice>
      ) : (
        <Toolbar align="end">
          {pending ? (
            <Button size="sm" variant="accent" onClick={() => onFlow({ step: connection.signedIn ? 'review' : 'consent', connection })}>Finish</Button>
          ) : null}
          {!pending ? (
            <Button size="sm" variant={connection.state === 'needs-review' ? 'accent' : undefined} onClick={() => onFlow({ step: 'review', connection, keepGrants: true })}>
              Review again
            </Button>
          ) : null}
          {connection.authKind !== 'none' && !pending ? (
            <Button size="sm" variant={connection.state === 'needs-reconnect' ? 'accent' : undefined} onClick={() => onFlow({ step: 'consent', connection, keepGrants: true })}>
              Reconnect
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>Disconnect</Button>
        </Toolbar>
      )}
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * The four screens
 * ------------------------------------------------------------------ */

export function ConnectFlow({
  start,
  agents,
  catalog = [],
  tokens = true,
  onClose,
  pollMs = 2000,
}: {
  start: FlowStart;
  agents: ConnectionsView['agents'];
  /** The cards, so a pasted address that is one of them gets its hints. */
  catalog?: ConnectionCard[];
  /** Whether a pasted token can be kept. */
  tokens?: boolean;
  onClose: () => void;
  pollMs?: number;
}): JSX.Element {
  const [step, setStep] = useState<Step>(start.step);
  const [connection, setConnection] = useState<ConnectionView | undefined>(start.connection);
  const [signIn, setSignIn] = useState<KnownSignIn>('unknown');
  const [pasted, setPasted] = useState<PastedConfig | null>(null);
  const address = pasted?.url ?? connection?.url;
  const card = start.card ?? catalog.find((c) => address !== undefined && sameAddress(c.url, address));
  const name = connection?.name ?? card?.name ?? pasted?.name ?? 'the service';
  const title = step === 'paste' ? 'Paste a config'
    : step === 'address' ? 'Connect a service'
    : step === 'consent' ? `Sign in to ${name}`
    : step === 'review' ? `What ${name} brings`
    : 'Who gets these tools';
  return (
    <Sheet title={title} onClose={onClose} size="wide">
      {step === 'paste' ? (
        <PasteStep onRead={(config) => { setPasted(config); setStep('address'); }} />
      ) : null}
      {step === 'address' ? (
        <AddressStep
          card={card}
          pasted={pasted}
          onDone={(added, kind) => {
            setConnection(added);
            if (kind === 'none') setStep('review');
            else { setSignIn(kind); setStep('consent'); }
          }}
        />
      ) : null}
      {step === 'consent' && connection ? (
        <ConsentStep
          connection={connection}
          signIn={signIn}
          card={card}
          pasted={pasted?.header}
          placeholder={pasted?.placeholder ?? false}
          tokens={tokens}
          pollMs={pollMs}
          onSignedIn={(fresh) => {
            setPasted(null);
            setConnection(fresh);
            if (start.keepGrants) onClose();
            else setStep('review');
          }}
        />
      ) : null}
      {step === 'review' && connection ? (
        <ReviewStep
          connection={connection}
          onKept={(kept) => {
            setConnection(kept);
            if (start.keepGrants) onClose();
            else setStep('grant');
          }}
        />
      ) : null}
      {step === 'grant' && connection ? <GrantStep connection={connection} agents={agents} onDone={onClose} /> : null}
    </Sheet>
  );
}

function sameAddress(a: string, b: string): boolean {
  const norm = (text: string): string => text.trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * "I have a config": the block another MCP client takes. Read here, never
 * sent as it is: the address and name go to the next screen, a header's
 * value to the token screen, and the box is cleared.
 */
function PasteStep({ onRead }: { onRead: (config: PastedConfig) => void }): JSX.Element {
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const read = (): void => {
    try {
      const config = parseConnectionConfig(text);
      setText('');
      setFailure(null);
      onRead(config);
    } catch (error) {
      setFailure(failureOf(error));
    }
  };
  return (
    <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); read(); }}>
      <p>Paste the block another app uses for this server, the one with <span className="mono">mcpServers</span>, or just its url and headers. buddi takes the address, the name and one header from it.</p>
      <Field label="Config" hint="Remote servers only: a url, not a command.">
        <textarea
          className="mono"
          rows={8}
          required
          autoFocus
          spellCheck={false}
          autoComplete="off"
          value={text}
          placeholder={'{ "mcpServers": { "github": { "url": "…", "headers": { "Authorization": "Bearer …" } } } }'}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <ErrorBanner message={failure} />
      <Toolbar align="end">
        <Button type="submit" variant="accent" disabled={text.trim() === ''}>Read it</Button>
      </Toolbar>
    </form>
  );
}

function AddressStep({
  card,
  pasted,
  onDone,
}: {
  card?: ConnectionCard;
  pasted?: PastedConfig | null;
  onDone: (connection: ConnectionView, signIn: 'none' | 'dynamic' | 'manual') => void;
}): JSX.Element {
  const [url, setUrl] = useState(pasted?.url ?? card?.url ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const open = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const added = await api.addConnection(url.trim(), card?.name ?? pasted?.name);
      onDone(added.connection, added.signIn);
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };
  const tokenFirst = card?.auth?.recommended === 'token';
  const deviceFirst = card?.auth?.recommended === 'device' && card.auth.device !== undefined;
  return (
    <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); void open(); }}>
      {card ? (
        <p>buddi opens {card.name}’s server, reads its name and what it offers, and asks whether it wants you to sign in. Nothing else is sent.</p>
      ) : (
        <p>Where is the server? buddi opens it, reads its name and what it offers, and nothing else until you have read its tools.</p>
      )}
      <Field label="Address" hint="An https:// address. Servers that run as a program on this computer are not supported yet.">
        <input required autoFocus={!card && !pasted} spellCheck={false} value={url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} />
      </Field>
      {card && !card.verified ? <p className="ui-card-meta">This address is the one {card.name} published; buddi has not checked it since.</p> : null}
      {deviceFirst ? (
        <p className="ui-card-meta">{card!.name} signs in with a code you type on its site. The next screen shows it.</p>
      ) : tokenFirst ? (
        <p className="ui-card-meta">{card!.name} signs in with a token you make on its site. The next screen links to the page.</p>
      ) : card?.clientIdRequired ? (
        <p className="ui-card-meta">{card.name} does not let buddi register itself: signing in needs a token, or a client id from its developer settings.</p>
      ) : null}
      {pasted?.header ? (
        <p className="ui-card-meta">
          {pasted.placeholder
            ? `Your config has a placeholder where the ${pasted.header.name} header's token goes. You paste the token itself on the next screen.`
            : `The ${pasted.header.name} header from your config waits for the sign-in screen. buddi tries it before it keeps it.`}
        </p>
      ) : null}
      {pasted && pasted.dropped.length > 0 ? (
        <p className="ui-card-meta">buddi sends one header, so {pasted.dropped.join(', ')} {pasted.dropped.length === 1 ? 'was' : 'were'} left out.</p>
      ) : null}
      <ErrorBanner message={failure} />
      <Toolbar align="end">
        <Button type="submit" variant="accent" disabled={busy || url.trim() === ''}>{busy ? 'Opening…' : 'Continue'}</Button>
      </Toolbar>
    </form>
  );
}

type KnownSignIn = 'dynamic' | 'manual' | 'unknown';
type SignInMode = 'device' | 'oauth' | 'token' | 'client';

const MODE_LABELS: Record<SignInMode, string> = { device: 'Device', oauth: 'Sign in', token: 'Token', client: 'Client id' };

/**
 * The ways this service can be signed in to, from what its server said
 * (`signIn`) and whether a token can be kept: its own sign-in page when it
 * lets buddi register, a client id when it does not, a token either way.
 * Unknown (a reconnect) is taken as the sign-in page until the server says
 * otherwise. A card with buddi's own app on the service adds a code typed on
 * its site: first when the card recommends it, otherwise before Client id.
 */
export function signInModes(signIn: KnownSignIn, tokens: boolean, device: 'first' | 'offered' | 'none' = 'none'): SignInMode[] {
  const base: SignInMode[] = signIn === 'manual' ? ['token', 'client'] : ['oauth', 'token'];
  const modes = tokens ? base : base.filter((m) => m !== 'token');
  if (device === 'first') return ['device', ...modes];
  if (device === 'offered') return [...modes.filter((m) => m !== 'client'), 'device', ...modes.filter((m) => m === 'client')];
  return modes;
}

function ConsentStep({
  connection,
  signIn,
  card,
  pasted,
  placeholder,
  tokens,
  pollMs,
  onSignedIn,
}: {
  connection: ConnectionView;
  signIn: KnownSignIn;
  card?: ConnectionCard;
  pasted?: PastedHeader;
  placeholder: boolean;
  tokens: boolean;
  pollMs: number;
  onSignedIn: (connection: ConnectionView) => void;
}): JSX.Element {
  const [known, setKnown] = useState<KnownSignIn>(signIn);
  const device = card?.auth?.device ? (card.auth.recommended === 'device' ? 'first' : 'offered') : 'none';
  const modes = signInModes(known, tokens, device);
  const preferToken = pasted !== undefined || (device !== 'first' && (connection.authKind === 'token' || card?.auth?.recommended === 'token'));
  const [chosen, setChosen] = useState<SignInMode>(() => (preferToken && modes.includes('token') ? 'token' : modes[0]!));
  const mode = modes.includes(chosen) ? chosen : modes[0]!;
  const [manualSentence, setManualSentence] = useState(MANUAL_SENTENCE);
  const [clientId, setClientId] = useState('');
  /** The consent page's address, once buddi has it: a tab opens only onto it. */
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const redirect = `${location.origin}${CALLBACK_PATH}`;
  const landed = useRef(onSignedIn);
  landed.current = onSignedIn;

  /*
   * While the consent page is open: the callback tab says so on a channel
   * the two tabs share, and a first sign-in is also seen by asking.
   */
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const finish = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try { landed.current(await api.connection(connection.id)); } catch (error) { setFailure(failureOf(error)); }
    };
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CONNECTIONS_CHANNEL) : null;
    if (channel) {
      channel.onmessage = (event: MessageEvent<{ id?: string }>) => { if (event.data?.id === connection.id) void finish(); };
    }
    let timer: number | undefined;
    const started = Date.now();
    const ask = async (): Promise<void> => {
      if (stopped) return;
      try {
        const fresh = await api.connection(connection.id);
        if ((!connection.signedIn || connection.authKind === 'token') && fresh.signedIn && fresh.authKind === 'oauth') { void finish(); return; }
      } catch {
        // Keep asking.
      }
      if (Date.now() - started > 10 * 60_000) { setWaiting(false); setFailure('The sign-in did not come back within ten minutes. Start it again.'); return; }
      timer = window.setTimeout(() => void ask(), pollMs);
    };
    timer = window.setTimeout(() => void ask(), pollMs);
    return () => { stopped = true; channel?.close(); window.clearTimeout(timer); };
  }, [waiting, connection, pollMs]);

  /** Ask buddi for the consent page's address. No tab is opened here. */
  const fetchConsent = async (withClientId?: string): Promise<void> => {
    setAsking(true);
    setFailure(null);
    try {
      const { authorizeUrl } = await api.connectionConsent(connection.id, withClientId);
      setConsentUrl(authorizeUrl);
    } catch (error) {
      if (error instanceof ApiError && (error.detail as { code?: string } | undefined)?.code === 'client-id') {
        setManualSentence(error.message);
        setKnown('manual');
        setChosen('client');
      } else {
        setFailure(failureOf(error));
      }
    } finally {
      setAsking(false);
    }
  };

  // The service's own sign-in page: its address is fetched as the mode opens, so the click only opens it.
  useEffect(() => {
    if (mode !== 'oauth' || consentUrl !== null) return;
    void fetchConsent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /** Opened inside the click, onto the page itself: never an empty tab. */
  const openConsent = (url: string): void => {
    const tab = window.open(url, '_blank');
    if (tab) {
      tab.opener = null;
      setLink(null);
    } else {
      setLink(url);
    }
    setWaiting(true);
  };

  const switchMode = (next: SignInMode): void => {
    setChosen(next);
    setConsentUrl(null);
    setFailure(null);
    setWaiting(false);
    setLink(null);
  };

  return (
    <div className="ui-stack">
      {modes.length > 1 ? (
        <Segment label="How to sign in" options={modes.map((m) => ({ value: m, label: MODE_LABELS[m] }))} value={mode} onChange={switchMode} />
      ) : null}
      {mode === 'oauth' ? (
        <>
          <p>
            buddi opens {connection.name}’s own sign-in page in a new tab. You say yes there, the tab comes back here, and buddi keeps
            the sign-in in its vault. No agent ever sees it.
          </p>
          {asking ? <Empty>Getting {connection.name}’s sign-in page…</Empty> : null}
        </>
      ) : null}
      {mode === 'client' ? (
        <>
          <Notice tone="warning">{manualSentence}</Notice>
          <Field label="Client id">
            <input
              required
              spellCheck={false}
              value={clientId}
              onChange={(event) => { setClientId(event.target.value); setConsentUrl(null); setWaiting(false); }}
            />
          </Field>
          <p className="ui-card-meta">Its redirect address: <span className="mono">{redirect}</span></p>
        </>
      ) : null}
      {mode === 'token' ? (
        <TokenForm connection={connection} card={card} pasted={pasted} placeholder={placeholder} onSignedIn={onSignedIn} />
      ) : null}
      {mode === 'device' ? (
        <DeviceSignIn connection={connection} service={card?.name ?? connection.name} pollMs={pollMs} onSignedIn={onSignedIn} />
      ) : null}
      {(mode === 'oauth' || mode === 'client') && waiting ? <Notice tone="accent" role="status">Waiting for you to say yes on {connection.name}’s page…</Notice> : null}
      {(mode === 'oauth' || mode === 'client') && link ? <p><a href={link} target="_blank" rel="noopener noreferrer">Open {connection.name}’s sign-in page</a></p> : null}
      {mode === 'oauth' || mode === 'client' ? <ErrorBanner message={failure} /> : null}
      {mode === 'oauth' ? (
        <Toolbar align="end">
          <Button variant="accent" onClick={() => { if (consentUrl) openConsent(consentUrl); }} disabled={consentUrl === null}>
            {waiting ? 'Open it again' : `Sign in to ${connection.name}`}
          </Button>
        </Toolbar>
      ) : null}
      {mode === 'client' ? (
        <Toolbar align="end">
          {consentUrl === null ? (
            <Button variant="accent" onClick={() => void fetchConsent(clientId.trim())} disabled={asking || clientId.trim() === ''}>
              {asking ? 'Checking…' : 'Continue'}
            </Button>
          ) : (
            <Button variant="accent" onClick={() => openConsent(consentUrl)}>
              {waiting ? 'Open it again' : `Open ${connection.name}’s sign-in page`}
            </Button>
          )}
        </Toolbar>
      ) : null}
    </div>
  );
}

/** `https://github.com/login/device` as the words on its button: `github.com/login/device`. */
function shortAddress(uri: string): string {
  try {
    const url = new URL(uri);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`;
  } catch {
    return uri;
  }
}

/**
 * A code typed on the service's site (the OAuth device flow, with buddi's own
 * app): asked for as the mode opens, shown large with Copy, the site opened
 * inside the click. The gateway waits for the approval; this screen asks the
 * connection every two seconds and moves on by itself once it is kept.
 */
function DeviceSignIn({
  connection,
  service,
  pollMs,
  onSignedIn,
}: {
  connection: ConnectionView;
  /** Whose site the code is typed on: the card's name. */
  service: string;
  pollMs: number;
  onSignedIn: (connection: ConnectionView) => void;
}): JSX.Element {
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [link, setLink] = useState<string | null>(null);
  const landed = useRef(onSignedIn);
  landed.current = onSignedIn;

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    setCode(null);
    setFailure(null);
    setLink(null);
    const ask = async (): Promise<void> => {
      if (stopped) return;
      try {
        const fresh = await api.connection(connection.id);
        if (stopped) return;
        if (fresh.device?.state === 'done') { landed.current(fresh); return; }
        if (fresh.device?.state === 'failed') { setFailure(fresh.device.reason ?? 'The sign-in did not finish. Start again.'); return; }
      } catch {
        // Keep asking.
      }
      timer = window.setTimeout(() => void ask(), pollMs);
    };
    void (async () => {
      try {
        const started = await api.connectionDevice(connection.id);
        if (stopped) return;
        setCode({ userCode: started.userCode, verificationUri: started.verificationUri });
        timer = window.setTimeout(() => void ask(), pollMs);
      } catch (error) {
        if (!stopped) setFailure(failureOf(error));
      }
    })();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [connection.id, pollMs, attempt]);

  /** Opened inside the click, onto the page itself: never an empty tab. */
  const openSite = (url: string): void => {
    const tab = window.open(url, '_blank');
    if (tab) {
      tab.opener = null;
      setLink(null);
    } else {
      setLink(url);
    }
  };

  const address = code ? shortAddress(code.verificationUri) : '';
  return (
    <>
      <p>
        Type this code on {service}’s site and say yes there. buddi keeps the sign-in in its vault and sends it only to{' '}
        <span className="mono">{connection.host}</span>. No agent ever sees it.
      </p>
      {code === null && failure === null ? <Empty>Asking {service} for a code…</Empty> : null}
      {code && failure === null ? (
        <>
          <SignInCode code={code.userCode} label={`Your code for ${service}`} large />
          <Notice tone="accent" role="status">Waiting for you to approve on {service}…</Notice>
          {link ? <p><a href={link} target="_blank" rel="noopener noreferrer">Open {address}</a></p> : null}
          <Toolbar align="end">
            <Button variant="accent" onClick={() => openSite(code.verificationUri)}>Open {address}</Button>
          </Toolbar>
        </>
      ) : null}
      {failure !== null ? (
        <>
          <ErrorBanner message={failure} />
          <Toolbar align="end">
            <Button variant="accent" onClick={() => setAttempt((n) => n + 1)}>Start again</Button>
          </Toolbar>
        </>
      ) : null}
    </>
  );
}

/**
 * A token the owner pasted: tried on the server before buddi keeps it, then
 * kept in the vault and sent only to this connection's host, in one header.
 * The field is a password field and is emptied once the token is kept.
 */
function TokenForm({
  connection,
  card,
  pasted,
  placeholder,
  onSignedIn,
}: {
  connection: ConnectionView;
  card?: ConnectionCard;
  pasted?: PastedHeader;
  placeholder: boolean;
  onSignedIn: (connection: ConnectionView) => void;
}): JSX.Element {
  const [token, setToken] = useState(pasted?.value ?? '');
  const [header, setHeader] = useState(pasted?.name ?? 'Authorization');
  const [prefix, setPrefix] = useState(pasted?.prefix ?? (pasted ? '' : 'Bearer '));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const keep = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const done = await api.connectionToken(connection.id, { token: token.trim(), header: header.trim(), prefix });
      setToken('');
      onSignedIn(done.connection);
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };
  const page = card?.auth?.tokenPage;
  return (
    <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); void keep(); }}>
      <p>
        {page ? `Make a token on ${connection.name}’s site and paste it here.` : `Paste a token ${connection.name} gave you.`} buddi tries it on{' '}
        <span className="mono">{connection.host}</span> first, keeps it in its vault, and sends it only there. No agent ever sees it.
      </p>
      {page ? (
        <p><a href={page} target="_blank" rel="noopener noreferrer">Make a token on {connection.name}</a></p>
      ) : null}
      {placeholder ? <Notice tone="accent">Your config had a placeholder where the token goes. Paste the token itself.</Notice> : null}
      <Field label="Token" hint={card?.auth?.tokenHint}>
        <input
          type="password"
          required
          autoFocus={!pasted?.value}
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
      <FormGrid columns={2} dense>
        <Field label="Header" hint="Most services want Authorization.">
          <input required spellCheck={false} value={header} onChange={(event) => setHeader(event.target.value)} />
        </Field>
        <Field label="Before the token" hint="Usually “Bearer ”, with its space. Empty for none.">
          <input spellCheck={false} value={prefix} onChange={(event) => setPrefix(event.target.value)} />
        </Field>
      </FormGrid>
      <ErrorBanner message={failure} />
      <Toolbar align="end">
        <Button type="submit" variant="accent" disabled={busy || token.trim() === '' || header.trim() === ''}>
          {busy ? 'Trying it…' : 'Try it and keep it'}
        </Button>
      </Toolbar>
    </form>
  );
}

function ReviewStep({ connection, onKept }: { connection: ConnectionView; onKept: (connection: ConnectionView) => void }): JSX.Element {
  const review = useAsync<ConnectionReview>(() => api.connectionReview(connection.id), [connection.id]);
  const [slug, setSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const data = review.data;
  const chosen = slug ?? data?.slug ?? '';
  const keep = async (): Promise<void> => {
    if (!data) return;
    setBusy(true);
    setFailure(null);
    try {
      onKept(await api.saveConnectionReview(connection.id, { hash: data.hash, ...(data.slugEditable ? { slug: chosen } : {}) }));
    } catch (error) {
      if (error instanceof ApiError && (error.detail as { code?: string } | undefined)?.code === 'changed') review.reload();
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };
  if (!data) {
    return review.error ? <ErrorBanner message={review.error} /> : <Empty>Reading what {connection.name} offers…</Empty>;
  }
  const usable = data.tools.filter((t) => t.problem === null).length;
  return (
    <div className="ui-stack">
      <p>
        Read what {connection.name} brings before it brings it. Each tool gets a buddi name and a tier from what the server says it does;
        anything that changes something asks you first, on the same approval card as every other tool.
      </p>
      <p className="ui-card-meta">buddi talks to <span className="mono">{data.host}</span> for these tools, and nowhere else.</p>
      {data.annotatedNothing ? (
        <Notice tone="warning">{connection.name} says nothing about what its tools do, so every one of them asks you first.</Notice>
      ) : null}
      {data.changes && (data.changes.added.length + data.changes.changed.length + data.changes.removed.length) > 0 ? (
        <Notice tone="warning" title={`${connection.name} changed its tools since your last review.`}>
          <ul className="connections-changes" aria-label="What changed">
            {data.changes.added.length > 0 ? <li>New: <span className="mono">{data.changes.added.join(', ')}</span></li> : null}
            {data.changes.changed.length > 0 ? <li>Changed: <span className="mono">{data.changes.changed.join(', ')}</span></li> : null}
            {data.changes.removed.length > 0 ? <li>Gone: <span className="mono">{data.changes.removed.join(', ')}</span></li> : null}
          </ul>
          <p>Until you keep this list, the new and changed tools wait; the others keep working.</p>
        </Notice>
      ) : null}
      {data.slugEditable ? (
        <Field label="Its name in buddi" hint={`Tools are called mcp.${chosen || '…'}.<tool>. Lower case, letters, digits, _ and -.`}>
          <input required spellCheck={false} maxLength={24} value={chosen} onChange={(event) => setSlug(event.target.value.toLowerCase())} />
        </Field>
      ) : null}
      {data.tools.length === 0 ? <Empty>{connection.name} lists no tools.</Empty> : (
        <div className="ui-list" aria-label="Tools">
          {data.tools.map((tool) => {
            const tier = tierLabel(tool);
            const fullName = data.slugEditable ? tool.fullName.replace(/^mcp\.[^.]+\./, `mcp.${chosen || data.slug}.`) : tool.fullName;
            return (
              <div key={tool.name} className="ui-list-row connections-tool">
                <div className="ui-stack" data-gap="sm">
                  <div className="ui-card-head">
                    <span className="mono">{fullName}</span>
                    {tool.problem ? <Pill tone="muted">Cannot be used</Pill> : <Pill tone={tier.tone}>{tier.label}</Pill>}
                    {tool.change === 'added' ? <Tag>New</Tag> : tool.change === 'changed' ? <Tag>Changed</Tag> : null}
                  </div>
                  {tool.description ? <p className="ui-card-meta">{tool.description}</p> : null}
                  {!tool.problem && tool.tier === 'gated' ? (
                    <p className="ui-card-meta">{tool.destructive ? NEVER_REMEMBERED : 'You can remember its approval for an agent when you give it the tools, or later on the agent’s Access page.'}</p>
                  ) : null}
                  {tool.problem ? <p className="ui-card-meta">Left out: {tool.problem}.</p> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ErrorBanner message={failure} />
      <Toolbar align="end">
        <Button variant="accent" onClick={() => void keep()} disabled={busy || (data.slugEditable && chosen.trim() === '')}>
          {usable === 1 ? 'Keep this tool' : `Keep these ${usable} tools`}
        </Button>
      </Toolbar>
    </div>
  );
}

function GrantStep({
  connection,
  agents,
  onDone,
}: {
  connection: ConnectionView;
  agents: ConnectionsView['agents'];
  onDone: () => void;
}): JSX.Element {
  const front = agents.find((a) => a.frontDesk) ?? agents[0];
  const [picked, setPicked] = useState<Set<string>>(() => new Set(front ? [front.id] : []));
  const tools = useAsync(() => api.connectionTools(connection.id), [connection.id]);
  const gated: ConnectionToolView[] = (tools.data?.tools ?? []).filter((t) => t.tier === 'gated');
  const [remember, setRemember] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const toggle = (id: string, on: boolean): void => {
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  };
  const give = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.grantConnection(connection.id, [...picked]);
      if (result.failed.length > 0) { setFailure(result.failed.map((f) => `${f.agent}: ${f.message}`).join(' ')); return; }
      // Remembered approval, per agent: the same row a card's "Always" writes.
      for (const agent of result.granted) {
        for (const tool of remember) await api.setRememberedApproval(agent, tool, true);
      }
      onDone();
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ui-stack">
      <p>{front ? `Give these tools to ${front.name}?` : 'Which agents get these tools?'} Each one you tick gets <span className="mono">{connection.grant}</span> on its tools line.</p>
      <div className="ui-stack" data-gap="sm" role="group" aria-label="Agents">
        {agents.map((agent) => (
          <label key={agent.id} className="backup-check">
            <input type="checkbox" checked={picked.has(agent.id)} onChange={(event) => toggle(agent.id, event.target.checked)} />
            <span>{agent.name}{agent.frontDesk ? ' (front desk)' : ''}</span>
          </label>
        ))}
      </div>
      <p className="ui-card-meta">No one is fine too: the connection waits here until you give it to someone.</p>
      {gated.length > 0 ? (
        <div className="ui-stack" data-gap="sm" role="group" aria-label="Remembered approval">
          <p>These ask you first. Tick one to remember your approval for the agents above, so it asks only once.</p>
          {gated.map((tool) => (
            <Stack key={tool.tool} gap="sm">
              <label className="backup-check">
                <input
                  type="checkbox"
                  disabled={!tool.rememberable}
                  checked={remember.has(tool.tool)}
                  onChange={(event) => setRemember((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(tool.tool); else next.delete(tool.tool);
                    return next;
                  })}
                />
                <span className="mono">{tool.tool}</span>
              </label>
              {tool.why ? <p className="ui-card-meta">{tool.why}</p> : null}
            </Stack>
          ))}
        </div>
      ) : null}
      <ErrorBanner message={failure} />
      <Toolbar align="end">
        <Button onClick={onDone} disabled={busy}>Not now</Button>
        <Button variant="accent" onClick={() => void give()} disabled={busy || picked.size === 0}>Give them</Button>
      </Toolbar>
    </div>
  );
}

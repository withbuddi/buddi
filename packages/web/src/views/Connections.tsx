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
 * question per screen, the primary answer on the right.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type ConnectionCard,
  type ConnectionReview,
  type ConnectionState,
  type ConnectionView,
  type ConnectionsView,
} from '../api';
import { fmtRelative } from '../format';
import { Button, Card, Empty, EmptyState, ErrorBanner, Field, Notice, PageFrame, Pill, Section, Sheet, Stack, Tag, Toolbar, useAsync, type Tone } from '../ui';

export const STATE_LABELS: Record<ConnectionState, { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'good' },
  'needs-reconnect': { label: 'Needs reconnect', tone: 'warning' },
  unreachable: { label: 'Unreachable', tone: 'critical' },
  'pending-review': { label: 'Not finished', tone: 'muted' },
};

/** What a tier means to the owner, in the words of an approval. */
export function tierLabel(tool: { tier: 'auto' | 'gated'; destructive: boolean }): { label: string; tone: Tone } {
  if (tool.tier === 'auto') return { label: 'Runs on its own', tone: 'good' };
  if (tool.destructive) return { label: 'Asks you every time', tone: 'critical' };
  return { label: 'Asks you first', tone: 'warning' };
}

type Step = 'address' | 'consent' | 'review' | 'grant';

/** The tab the consent page comes back to tells the one that sent it (`ConnectionCallback`). */
export const CONNECTIONS_CHANNEL = 'buddi-connections';
export const CALLBACK_PATH = '/connections/callback';
const MANUAL_SENTENCE =
  'This service does not let buddi register itself, so it needs a client id you create in the service’s developer settings, with the address below as its redirect.';

interface FlowStart {
  step: Step;
  card?: ConnectionCard;
  connection?: ConnectionView;
  /** Reconnect and "review again" end at review: the agents already hold the tools. */
  keepGrants?: boolean;
}

export function Connections({ embedded }: { embedded?: boolean } = {}): JSX.Element {
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
                    onFlow={setFlow}
                    onChanged={view.reload}
                  />
                ))
              )}
            </Stack>
          </Section>
        ) : null}
        {data ? (
          <Section title="Connect a service" aside="Each has an official remote server. You sign in on the service's own page.">
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
            </div>
          </Section>
        ) : null}
      </Stack>
      {flow && data ? (
        <ConnectFlow
          start={flow}
          agents={data.agents}
          onClose={() => { setFlow(null); view.reload(); }}
        />
      ) : null}
    </PageFrame>
  );
}

function ConnectionRow({
  connection,
  agentName,
  onFlow,
  onChanged,
}: {
  connection: ConnectionView;
  agentName: (id: string) => string;
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
          {!pending ? <Button size="sm" onClick={() => onFlow({ step: 'review', connection, keepGrants: true })}>Review again</Button> : null}
          {connection.authKind === 'oauth' && !pending ? (
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
  onClose,
  pollMs = 2000,
}: {
  start: FlowStart;
  agents: ConnectionsView['agents'];
  onClose: () => void;
  pollMs?: number;
}): JSX.Element {
  const [step, setStep] = useState<Step>(start.step);
  const [connection, setConnection] = useState<ConnectionView | undefined>(start.connection);
  const [signIn, setSignIn] = useState<'dynamic' | 'manual'>('dynamic');
  const name = connection?.name ?? start.card?.name ?? 'the service';
  const title = step === 'address' ? 'Connect a service'
    : step === 'consent' ? `Sign in to ${name}`
    : step === 'review' ? `What ${name} brings`
    : 'Who gets these tools';
  return (
    <Sheet title={title} onClose={onClose} size="wide">
      {step === 'address' ? (
        <AddressStep
          card={start.card}
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
          manual={signIn === 'manual'}
          pollMs={pollMs}
          onSignedIn={(fresh) => {
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

function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function AddressStep({
  card,
  onDone,
}: {
  card?: ConnectionCard;
  onDone: (connection: ConnectionView, signIn: 'none' | 'dynamic' | 'manual') => void;
}): JSX.Element {
  const [url, setUrl] = useState(card?.url ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const open = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const added = await api.addConnection(url.trim(), card?.name);
      onDone(added.connection, added.signIn);
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); void open(); }}>
      {card ? (
        <p>buddi opens {card.name}’s server, reads its name and what it offers, and asks whether it wants you to sign in. Nothing else is sent.</p>
      ) : (
        <p>Where is the server? buddi opens it, reads its name and what it offers, and nothing else until you have read its tools.</p>
      )}
      <Field label="Address" hint="An https:// address. Servers that run as a program on this computer are not supported yet.">
        <input required autoFocus={!card} spellCheck={false} value={url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} />
      </Field>
      {card && !card.verified ? <p className="ui-card-meta">This address is the one {card.name} published; buddi has not checked it since.</p> : null}
      <ErrorBanner message={failure} />
      <Toolbar align="end">
        <Button type="submit" variant="accent" disabled={busy || url.trim() === ''}>{busy ? 'Opening…' : 'Continue'}</Button>
      </Toolbar>
    </form>
  );
}

function ConsentStep({
  connection,
  manual,
  pollMs,
  onSignedIn,
}: {
  connection: ConnectionView;
  manual: boolean;
  pollMs: number;
  onSignedIn: (connection: ConnectionView) => void;
}): JSX.Element {
  const [needsClientId, setNeedsClientId] = useState<string | null>(manual ? MANUAL_SENTENCE : null);
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
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
        if (!connection.signedIn && fresh.signedIn) { void finish(); return; }
      } catch {
        // Keep asking.
      }
      if (Date.now() - started > 10 * 60_000) { setWaiting(false); setFailure('The sign-in did not come back within ten minutes. Start it again.'); return; }
      timer = window.setTimeout(() => void ask(), pollMs);
    };
    timer = window.setTimeout(() => void ask(), pollMs);
    return () => { stopped = true; channel?.close(); window.clearTimeout(timer); };
  }, [waiting, connection, pollMs]);

  const begin = async (): Promise<void> => {
    // Opened now, inside the click, so no popup blocker stands in the way;
    // pointed at the consent page once buddi has it.
    const tab = window.open('', '_blank');
    setBusy(true);
    setFailure(null);
    try {
      const { authorizeUrl } = await api.connectionConsent(connection.id, needsClientId !== null ? clientId.trim() : undefined);
      if (tab) {
        tab.opener = null;
        tab.location.href = authorizeUrl;
      } else {
        setLink(authorizeUrl);
      }
      setWaiting(true);
    } catch (error) {
      tab?.close();
      if (error instanceof ApiError && (error.detail as { code?: string } | undefined)?.code === 'client-id') {
        setNeedsClientId(error.message);
      } else {
        setFailure(failureOf(error));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ui-stack">
      <p>
        {connection.name} asks you to sign in. buddi opens its own consent page in a new tab; you say yes there, to {connection.name}, and
        the tab comes back here. buddi keeps the sign-in in its vault, and no agent ever sees it.
      </p>
      {needsClientId !== null ? (
        <>
          <Notice tone="warning">{needsClientId}</Notice>
          <Field label="Client id">
            <input required spellCheck={false} value={clientId} onChange={(event) => setClientId(event.target.value)} />
          </Field>
          <p className="ui-card-meta">Its redirect address: <span className="mono">{redirect}</span></p>
        </>
      ) : null}
      {waiting ? <Notice tone="accent" role="status">Waiting for you to say yes on {connection.name}’s page…</Notice> : null}
      {link ? <p><a href={link} target="_blank" rel="noopener noreferrer">Open {connection.name}’s sign-in page</a></p> : null}
      <ErrorBanner message={failure} />
      <Toolbar align="end">
        <Button variant="accent" onClick={() => void begin()} disabled={busy || (needsClientId !== null && clientId.trim() === '')}>
          {waiting ? 'Open it again' : `Sign in to ${connection.name}`}
        </Button>
      </Toolbar>
    </div>
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
                  </div>
                  {tool.description ? <p className="ui-card-meta">{tool.description}</p> : null}
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
      if (result.failed.length > 0) setFailure(result.failed.map((f) => `${f.agent}: ${f.message}`).join(' '));
      else onDone();
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
      <ErrorBanner message={failure} />
      <Toolbar align="end">
        <Button onClick={onDone} disabled={busy}>Not now</Button>
        <Button variant="accent" onClick={() => void give()} disabled={busy || picked.size === 0}>Give them</Button>
      </Toolbar>
    </div>
  );
}

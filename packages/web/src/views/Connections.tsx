/**
 * Settings → Connections (docs/connections.md).
 *
 * A service that speaks MCP — GitHub, Notion, Linear, any remote server — is
 * connected once: its address, its own consent page, a review of every tool it
 * brings with the tier buddi gives it, and which agents get them.
 *
 * Drawn as Plugins' sibling (the kit's Settings → Connections): each
 * connection is a compact row — its face, one quiet line, where it stands —
 * and a row opens the detail in a sheet, with Review again, Reconnect or
 * Change, and Disconnect, which asks in the same small dialog as Remove and
 * names the agents it takes the tools from. The catalog leaves out what is
 * already connected; "Add your own" is one block whose segment picks an
 * address, a program or a pasted config, each opening its own screen.
 *
 * The four screens are one sheet, in the first-run wizard's voice: one
 * question per screen, the primary answer on the right. Signing in is the
 * service's own page, a code you type on its site (the device way, with
 * buddi's own app), a token you paste, or a client id; "I have a config"
 * reads the block another MCP client takes into the same screens.
 *
 * "A program on this computer" is a server buddi starts itself (npx, uvx, a
 * local binary): a form for its command, arguments and variables, each with
 * a Secret switch. The form shows the whole command line; Continue records
 * it, and the review is the first time it runs, only to list its tools.
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
  type ProgramForm,
} from '../api';
import { fmtRelative, fmtTime } from '../format';
import { AppIcon, Button, Code, Empty, ErrorBanner, Field, FormGrid, Icon, KV, List, ListRow, Modal, Notice, PageFrame, Panel, Pill, Section, Segment, Sheet, Spacer, Stack, Tag, Toolbar, useAsync, type Tone } from '../ui';
import { settingsRoute } from '../routes';
import { looksSecret, parsePastedServer, shellWords, type PastedConfig, type PastedHeader, type PastedProgram } from '@buddi/core/connection-config';
import { SignInCode } from './parts/SignInCode';

/**
 * Where a connection stands, in the owner's words. A program that stopped
 * answering failed; a server that did is unreachable and retried.
 */
export function connectionState(connection: ConnectionView): { label: string; tone: Tone; dot?: boolean } {
  if (connection.phase === 'starting') return { label: 'Starting', tone: 'accent' };
  switch (connection.state) {
    case 'connected': return { label: 'Connected', tone: 'good', dot: true };
    case 'needs-reconnect': return { label: 'Sign in again', tone: 'warning' };
    case 'needs-review': return { label: 'Needs review', tone: 'warning' };
    case 'unreachable': return { label: connection.transport === 'stdio' ? 'Failed' : 'Unreachable', tone: 'critical' };
    default: return { label: 'Not finished', tone: 'muted' };
  }
}

/** Why a tool's approval is never remembered: the server said it destroys something. */
export const NEVER_REMEMBERED = 'It can delete or destroy something, so it asks you every time and is never remembered.';

/** What a tier means to the owner, in the words of an approval. */
export function tierLabel(tool: { tier: 'auto' | 'gated'; destructive: boolean }): { label: string; tone: Tone } {
  if (tool.tier === 'auto') return { label: 'Runs on its own', tone: 'good' };
  if (tool.destructive) return { label: 'Asks you every time', tone: 'critical' };
  return { label: 'Asks you first', tone: 'warning' };
}

type Step = 'paste' | 'address' | 'program' | 'consent' | 'review' | 'grant';

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

/** The line under Connections' title; Settings draws the title when the page is one of its sections. */
export const CONNECTIONS_LEDE = 'Services and programs your team can use, and the tools each one brings.';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The catalog card a connection was made from, when its address is one of theirs. */
function cardOf(connection: ConnectionView, catalog: ConnectionCard[]): ConnectionCard | undefined {
  return connection.transport === 'stdio' ? undefined : catalog.find((card) => sameAddress(card.url, connection.url));
}

/** The face: a catalog service's monogram, a globe for any other server, a terminal for a program. */
function ConnectionFace({ connection, card, size }: { connection?: ConnectionView; card?: ConnectionCard; size?: 'lg' }): JSX.Element {
  if (card) return <AppIcon letter={card.name.slice(0, 1).toUpperCase()} size={size} />;
  return <AppIcon icon={connection?.transport === 'stdio' ? 'terminal' : 'globe'} size={size} />;
}

function StatePill({ connection }: { connection: ConnectionView }): JSX.Element {
  const state = connectionState(connection);
  return <Pill tone={state.tone} dot={state.dot}>{state.label}</Pill>;
}

/** Buttons inside a clickable row keep the click to themselves. */
const stop =
  (fn: () => void) =>
  (event: { stopPropagation: () => void }): void => {
    event.stopPropagation();
    fn();
  };

/** The three ways to add your own, behind one segment like "Add a plugin". */
type AddWay = 'address' | 'program' | 'paste';
const ADD_WAYS: Array<{ value: AddWay; label: string; text: string; button: string }> = [
  { value: 'address', label: 'An address', text: 'Any server on the web, by its https:// address. buddi opens it and reads what it offers, and nothing else until you have read its tools.', button: 'Give its address' },
  { value: 'program', label: 'A program', text: 'A server buddi starts itself on this computer, like npx or uvx, with its arguments and variables.', button: 'Describe it' },
  { value: 'paste', label: 'A config', text: 'The mcpServers block another app uses for it, or the claude mcp add line its docs print.', button: 'Paste it' },
];
const WAY_KEY = 'buddi.connections.add-way';
function rememberedWay(): AddWay {
  try {
    const saved = window.localStorage.getItem(WAY_KEY);
    return ADD_WAYS.some((w) => w.value === saved) ? (saved as AddWay) : 'address';
  } catch {
    return 'address';
  }
}

/**
 * `connection` is the id a link asked for (`#/settings/connections?connection=<id>`):
 * that connection's sheet opens, and a new link opens it again.
 */
export function Connections({ embedded, timezone, connection: linked }: { embedded?: boolean; timezone?: string; connection?: string | null } = {}): JSX.Element {
  const view = useAsync(() => api.connections(), [], 30_000);
  const [flow, setFlow] = useState<FlowStart | null>(null);
  const [opened, setOpened] = useState<string | null>(linked ?? null);
  useEffect(() => { if (linked) setOpened(linked); }, [linked]);
  const [asking, setAsking] = useState<string | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const data = view.data;
  const agentName = (id: string): string => data?.agents.find((a) => a.id === id)?.name ?? id;
  const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const connections = data?.connections ?? [];
  const catalog = data?.catalog ?? [];
  // A service already connected is not offered again.
  const offer = catalog.filter((card) => !connections.some((c) => c.transport !== 'stdio' && sameAddress(card.url, c.url)));
  const openedConnection = opened ? connections.find((c) => c.id === opened) : undefined;
  const askingConnection = asking ? connections.find((c) => c.id === asking) : undefined;
  const holdingConnection = holding ? connections.find((c) => c.id === holding) : undefined;
  const start = (next: FlowStart): void => { setOpened(null); setFlow(next); };
  return (
    <PageFrame embedded={embedded} title="Connections" lede={CONNECTIONS_LEDE}>
      <Stack gap="lg">
        <p className="plugins-quiet connections-quiet">
          <Icon name="plug" size={14} />
          <span>
            A connection is a service or program buddi talks to; a plugin is code buddi installs and runs.{' '}
            <a href={settingsRoute('plugins')}>Plugins</a>
          </span>
        </p>
        {!data && !view.error ? <Empty>Reading your connections…</Empty> : null}
        <ErrorBanner message={view.error} />
        {data && !data.vault ? (
          <Notice tone="warning">This installation has no vault, so a service that asks for a sign-in cannot be connected. Turn the vault on first.</Notice>
        ) : null}
        {data ? (
          <Panel flush title="Your connections" tool={connections.length > 0 ? plural(connections.length, 'connection', 'connections') : undefined}>
            {connections.length === 0 ? (
              <Empty title="Nothing connected yet">
                Pick a service below, or add your own: an address, a program on this computer, or a config you already have.
              </Empty>
            ) : (
              <div className="connections-rows">
                <List>
                  {connections.map((connection) => (
                    <ConnectionRow
                      key={connection.id}
                      connection={connection}
                      card={cardOf(connection, catalog)}
                      twin={connection.slug !== null && connections.some((other) => other.id !== connection.id && other.name === connection.name)}
                      onOpen={() => setOpened(connection.id)}
                      onFlow={start}
                    />
                  ))}
                </List>
              </div>
            )}
          </Panel>
        ) : null}
        {data && offer.length > 0 ? (
          <Panel title="Connect a service">
            <div className="connections-tiles">
              {offer.map((card) => (
                <div key={card.id} className="connections-tile">
                  <ConnectionFace card={card} />
                  <span className="connections-tile-main">
                    <span className="connections-tile-name">{card.name}</span>
                    <span className="connections-tile-blurb">{card.blurb}</span>
                  </span>
                  <Button size="sm" onClick={() => start({ step: 'address', card })} aria-label={`Connect ${card.name}`}>Connect</Button>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}
        {data ? <AddYourOwn onFlow={(step) => start({ step })} /> : null}
      </Stack>
      {openedConnection ? (
        <ConnectionSheet
          connection={openedConnection}
          card={cardOf(openedConnection, catalog)}
          agentName={agentName}
          timezone={zone}
          onClose={() => setOpened(null)}
          onFlow={start}
          onDisconnect={() => setAsking(openedConnection.id)}
          onHolders={() => setHolding(openedConnection.id)}
        />
      ) : null}
      {holdingConnection && data ? (
        <HoldersDialog
          key={holdingConnection.id}
          connection={holdingConnection}
          agents={data.agents}
          onCancel={() => setHolding(null)}
          onDone={() => { setHolding(null); view.reload(); }}
        />
      ) : null}
      {askingConnection ? (
        <DisconnectDialog
          key={askingConnection.id}
          connection={askingConnection}
          agentName={agentName}
          onCancel={() => setAsking(null)}
          onDone={() => { setAsking(null); setOpened(null); view.reload(); }}
        />
      ) : null}
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

/** One connection as a compact row: its face, its name, one quiet line and where it stands. */
function ConnectionRow({
  connection,
  card,
  twin,
  onOpen,
  onFlow,
}: {
  connection: ConnectionView;
  card: ConnectionCard | undefined;
  /** Another connection has the same name (two GitHub accounts): the row adds its own. */
  twin?: boolean;
  onOpen: () => void;
  onFlow: (flow: FlowStart) => void;
}): JSX.Element {
  const pending = connection.state === 'pending-review';
  const title = twin ? `${connection.name} (${connection.slug})` : connection.name;
  const program = connection.transport === 'stdio' ? connection.program : undefined;
  const where = program ? program.line : connection.host;
  const tools = pending ? 'its tools are not reviewed yet' : plural(connection.toolCount, 'tool', 'tools');
  return (
    <ListRow
      onClick={onOpen}
      label={`${title}: details`}
      lead={<ConnectionFace connection={connection} card={card} />}
      title={title}
      sub={<span className="connections-sub" data-kind={program ? 'program' : undefined}>{`${where} · ${tools}`}</span>}
      side={
        <span className="plugins-side">
          {pending ? (
            <span className="connections-act">
              <Button size="sm" variant="accent" onClick={stop(() => onFlow({ step: connection.signedIn ? 'review' : 'consent', connection }))}>Finish</Button>
            </span>
          ) : connection.state === 'needs-reconnect' && connection.authKind !== 'none' ? (
            <span className="connections-act">
              <Button size="sm" onClick={stop(() => onFlow({ step: 'consent', connection, keepGrants: true }))}>Sign in</Button>
            </span>
          ) : connection.state === 'needs-review' ? (
            <span className="connections-act">
              <Button size="sm" onClick={stop(() => onFlow({ step: 'review', connection, keepGrants: true }))}>Review</Button>
            </span>
          ) : null}
          <StatePill connection={connection} />
          <Icon name="chevron-right" size={14} />
        </span>
      }
    />
  );
}

const SIGN_IN_WORDS: Record<ConnectionView['authKind'], string> = {
  oauth: 'Its own sign-in page. buddi keeps the sign-in in its vault.',
  token: 'A token you pasted, kept in buddi’s vault and sent only here.',
  none: 'Nothing; it asks for no sign-in.',
};

/** The detail of one connection: what it is, where it stands, and what can be done about it. */
function ConnectionSheet({
  connection,
  card,
  agentName,
  timezone,
  onClose,
  onFlow,
  onHolders,
  onDisconnect,
}: {
  connection: ConnectionView;
  card: ConnectionCard | undefined;
  agentName: (id: string) => string;
  timezone: string;
  onClose: () => void;
  onFlow: (flow: FlowStart) => void;
  /** Change which agents hold its tools. */
  onHolders: () => void;
  onDisconnect: () => void;
}): JSX.Element {
  const pending = connection.state === 'pending-review';
  const program = connection.transport === 'stdio' ? connection.program : undefined;
  const signIn = (): void => onFlow({ step: 'consent', connection, keepGrants: true });
  const review = (): void => onFlow({ step: 'review', connection, keepGrants: true });
  const finish = (): void => onFlow({ step: connection.signedIn ? 'review' : 'consent', connection });
  return (
    <Sheet
      title={
        <span className="plugins-sheet-title">
          <ConnectionFace connection={connection} card={card} size="lg" />
          <span className="plugins-sheet-name">
            <span>{connection.name}</span>
            <span className="plugins-sheet-by">
              {program ? 'A program on this computer' : 'A service at an address'}
              {' · '}
              <StatePill connection={connection} />
            </span>
          </span>
        </span>
      }
      onClose={onClose}
      foot={
        <Toolbar>
          <Button variant="danger-ghost" onClick={onDisconnect}>Disconnect…</Button>
          <Spacer />
          {program ? <Button onClick={() => onFlow({ step: 'program', connection, keepGrants: true })}>Change</Button> : null}
          {connection.authKind !== 'none' && !pending ? (
            <Button variant={connection.state === 'needs-reconnect' ? 'accent' : undefined} onClick={signIn}>Reconnect</Button>
          ) : null}
          {pending ? (
            <Button variant="accent" onClick={finish}>Finish</Button>
          ) : (
            <Button variant={connection.state === 'needs-review' ? 'accent' : undefined} onClick={review}>Review again</Button>
          )}
        </Toolbar>
      }
    >
      {pending ? <Notice>Not finished: its tools are not reviewed yet, so no agent can use them.</Notice> : null}
      {connection.state === 'needs-reconnect' ? (
        <Notice tone="warning" action={connection.authKind !== 'none' ? <Button size="sm" variant="accent" onClick={signIn}>Sign in again</Button> : undefined}>
          Its sign-in ran out or was refused. Until you reconnect, each of its tools answers with one sentence instead of running.
        </Notice>
      ) : null}
      {connection.state === 'needs-review' ? (
        <Notice tone="warning" action={<Button size="sm" variant="accent" onClick={review}>Review it</Button>}>
          It changed its tools since you reviewed them. The new and changed ones wait until you review it again
          {connection.heldTools ? ` (${connection.heldTools} of the ones you kept ${connection.heldTools === 1 ? 'waits' : 'wait'})` : ''}; the others keep working.
        </Notice>
      ) : null}
      {connection.state === 'unreachable' && connection.unreachableSince ? (
        <Notice tone="critical">
          {program ? `It stopped answering at ${fmtTime(connection.unreachableSince, timezone)}; the next call starts it again.` : `Unreachable since ${fmtTime(connection.unreachableSince, timezone)}, retrying.`}
        </Notice>
      ) : null}
      {program?.changedSinceReview ? (
        <Notice tone="warning">Its command changed since you reviewed it, so its tools wait until you review it again.</Notice>
      ) : null}
      {connection.phase === 'starting' ? (
        <Notice tone="accent" role="status">Starting it… The first start can take a minute or two while it downloads.</Notice>
      ) : null}
      <div className="plugins-facts">
        <KV
          items={[
            program
              ? { label: 'Command', value: <span className="connections-line">{program.line}</span> }
              : { label: 'Address', value: <span className="connections-line">{connection.url}</span> },
            ...(program
              ? [{ label: 'Runs', value: 'On this computer as you, with your PATH and only the variables you named. It stops after ten quiet minutes.' }]
              : []),
            ...(program && program.env.length > 0
              ? [{ label: 'Variables', value: <span className="mono">{program.env.map((e) => `${e.name}${e.secret ? ' (secret)' : ''}`).join(', ')}</span> }]
              : []),
            ...(program ? [] : [{ label: 'Signs in with', value: SIGN_IN_WORDS[connection.authKind] }]),
            {
              label: 'Tools',
              value: pending
                ? 'Not reviewed yet'
                : `${plural(connection.toolCount, 'tool', 'tools')}${connection.reviewedAt ? ` · reviewed ${fmtRelative(connection.reviewedAt)}` : ''}`,
            },
            ...(pending
              ? []
              : [{
                label: 'Held by',
                value: (
                  <span className="connections-holders">
                    <span>{connection.agents.length === 0 ? 'No agent holds these tools yet.' : connection.agents.map(agentName).join(', ')}</span>
                    <Button size="sm" onClick={onHolders} aria-label="Change who holds it">{connection.agents.length === 0 ? 'Give them' : 'Change'}</Button>
                  </span>
                ),
              }]),
          ]}
        />
      </div>
      {connection.stderr && connection.stderr.length > 0 ? (
        <Section title="What the program last said">
          <Code label="Its last lines on stderr">{connection.stderr.join('\n')}</Code>
        </Section>
      ) : null}
      {card && !pending ? (
        <div className="connections-another">
          <p>
            Another {card.name} account or workspace? It connects beside this one, with its own sign-in and its own name.
            In the browser, sign in as that other account.
          </p>
          <Button size="sm" onClick={() => onFlow({ step: 'address', card })}>Add another account</Button>
        </div>
      ) : null}
    </Sheet>
  );
}

/** Who holds a connection's tools: tick to give, untick to take away, in one save. */
function HoldersDialog({
  connection,
  agents,
  onCancel,
  onDone,
}: {
  connection: ConnectionView;
  agents: Array<{ id: string; name: string; frontDesk: boolean }>;
  onCancel: () => void;
  onDone: () => void;
}): JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(connection.agents));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const toggle = (id: string, on: boolean): void => setPicked((set) => { const next = new Set(set); if (on) next.add(id); else next.delete(id); return next; });
  const unchanged = picked.size === connection.agents.length && connection.agents.every((id) => picked.has(id));
  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.grantConnection(connection.id, [...picked], true);
      if (result.failed.length > 0) setFailure(result.failed.map((f) => `${f.agent}: ${f.message}`).join('; '));
      else onDone();
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Who holds ${connection.name}`}
      onClose={onCancel}
      foot={
        <>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button variant="accent" disabled={busy || unchanged} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <p className="plugins-dialog-text">Each agent you tick can use its tools; untick one to take them away. Approvals still ask as before.</p>
      <div className="ui-stack" data-gap="sm" role="group" aria-label="Agents">
        {agents.map((agent) => (
          <label key={agent.id} className="backup-check">
            <input type="checkbox" checked={picked.has(agent.id)} onChange={(event) => toggle(agent.id, event.target.checked)} />
            <span>{agent.name}{agent.frontDesk ? ' (front desk)' : ''}</span>
          </label>
        ))}
      </div>
      <ErrorBanner message={failure} />
    </Modal>
  );
}

/** Disconnect, asked once in the same small dialog as Plugins' Disable and Remove. */
function DisconnectDialog({
  connection,
  agentName,
  onCancel,
  onDone,
}: {
  connection: ConnectionView;
  agentName: (id: string) => string;
  onCancel: () => void;
  onDone: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const holders = connection.agents.map(agentName);
  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await api.disconnect(connection.id);
      onDone();
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Disconnect ${connection.name}?`}
      onClose={onCancel}
      foot={
        <>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
        </>
      }
    >
      <p className="plugins-dialog-text">
        buddi forgets its sign-in and its tools.{' '}
        {holders.length > 0
          ? `${holders.join(' and ')} ${holders.length === 1 ? 'loses' : 'lose'} them.`
          : 'No agent holds its tools.'}
      </p>
      <ErrorBanner message={failure} />
    </Modal>
  );
}

/** "Add your own": one block like "Add a plugin"; its segment picks the way, its button opens that screen. */
function AddYourOwn({ onFlow }: { onFlow: (step: AddWay) => void }): JSX.Element {
  const [way, setWay] = useState<AddWay>(rememberedWay);
  const chosen = ADD_WAYS.find((w) => w.value === way) ?? ADD_WAYS[0]!;
  const choose = (next: AddWay): void => {
    setWay(next);
    try {
      window.localStorage.setItem(WAY_KEY, next);
    } catch {
      // A browser that keeps nothing still works; it forgets the choice.
    }
  };
  return (
    <Panel
      title="Add your own"
      actions={<Segment<AddWay> label="How to add it" options={ADD_WAYS.map(({ value, label }) => ({ value, label }))} value={way} onChange={choose} />}
    >
      <div className="connections-add">
        <p className="connections-add-text">{chosen.text}</p>
        <Button variant="accent" onClick={() => onFlow(way)}>{chosen.button}</Button>
      </div>
    </Panel>
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
  const [pastedProgram, setPastedProgram] = useState<PastedProgram | null>(null);
  const address = pasted?.url ?? connection?.url;
  const card = start.card ?? catalog.find((c) => address !== undefined && sameAddress(c.url, address));
  const name = connection?.name ?? card?.name ?? pasted?.name ?? 'the service';
  const title = step === 'paste' ? 'Paste a config'
    : step === 'address' ? 'Connect a service'
    : step === 'program' ? (connection ? `Change ${connection.name}` : 'A program on this computer')
    : step === 'consent' ? `Sign in to ${name}`
    : step === 'review' ? `What ${name} brings`
    : 'Who gets these tools';
  return (
    <Sheet title={title} onClose={onClose} size="wide">
      {step === 'paste' ? (
        <PasteStep
          onRead={(read) => {
            if (read.kind === 'program') { setPastedProgram(read.program); setStep('program'); }
            else { setPasted(read.config); setStep('address'); }
          }}
        />
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
      {step === 'program' ? (
        <ProgramStep
          connection={connection}
          pasted={pastedProgram}
          tokens={tokens}
          onDone={(saved) => {
            setPastedProgram(null);
            setConnection(saved);
            // A change that keeps the command, arguments and names needs no review.
            if (start.keepGrants && !saved.program?.changedSinceReview && saved.state !== 'pending-review') onClose();
            else setStep('review');
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
type PastedRead = { kind: 'remote'; config: PastedConfig } | { kind: 'program'; program: PastedProgram };

function PasteStep({ onRead }: { onRead: (read: PastedRead) => void }): JSX.Element {
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const read = (): void => {
    try {
      const read = parsePastedServer(text);
      setText('');
      setFailure(null);
      onRead(read);
    } catch (error) {
      setFailure(failureOf(error));
    }
  };
  return (
    <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); read(); }}>
      <p>
        Paste the block another app uses for this server, the one with <span className="mono">mcpServers</span>, or the{' '}
        <span className="mono">claude mcp add</span> line its docs print. A remote server gives its address, name and one header; a program
        its command, arguments and variables. Nothing is kept before you have read it on the next screen.
      </p>
      <Field label="Config" hint="A url for a remote server, or a command for a program on this computer.">
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
      <Field label="Address" hint="An https:// address. A server you start with npx, uvx or a local command is “A program on this computer” instead.">
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
  /** The site is open: the sheet waits rather than instructs. */
  const [opened, setOpened] = useState(false);
  const landed = useRef(onSignedIn);
  landed.current = onSignedIn;

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    setCode(null);
    setFailure(null);
    setLink(null);
    setOpened(false);
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
    setOpened(true);
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
        {code ? `Open ${address}, type this code there and say yes.` : `Type a code on ${service}’s site and say yes there.`} buddi keeps the sign-in in its vault and sends it only to{' '}
        <span className="mono">{connection.host}</span>. No agent ever sees it.
      </p>
      {code === null && failure === null ? <Empty>Asking {service} for a code…</Empty> : null}
      {code && failure === null ? (
        <>
          <SignInCode code={code.userCode} label={`Your code for ${service}`} large />
          {opened ? <Notice tone="accent" role="status">Waiting for you to approve on {service}…</Notice> : null}
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

interface ArgRow { key: number; value: string }
interface EnvRow { key: number; name: string; value: string; secret: boolean; kept: boolean }

/** One word as a shell needs it written, for the command line the form shows. */
function shellQuoted(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * "A program on this computer": name, command, arguments one per row,
 * variables with a Secret switch. The whole command line is shown before
 * Continue; nothing runs until the review. On a change, a secret shows as
 * kept and stays so unless a new value is typed.
 */
export function ProgramStep({
  connection,
  pasted,
  tokens = true,
  onDone,
}: {
  connection?: ConnectionView;
  pasted?: PastedProgram | null;
  /** Whether a secret can be kept (a vault). */
  tokens?: boolean;
  onDone: (connection: ConnectionView) => void;
}): JSX.Element {
  const existing = connection?.program;
  const seq = useRef(0);
  const next = (): number => { seq.current += 1; return seq.current; };
  const [name, setName] = useState(connection?.name ?? pasted?.name ?? '');
  const [command, setCommand] = useState(existing?.command ?? pasted?.command ?? '');
  const [args, setArgs] = useState<ArgRow[]>(() => (existing?.args ?? pasted?.args ?? []).map((value) => ({ key: next(), value })));
  const [env, setEnv] = useState<EnvRow[]>(() => (existing
    ? existing.env.map((e) => ({ key: next(), name: e.name, value: e.value ?? '', secret: e.secret, kept: e.secret }))
    : (pasted?.env ?? []).map((e) => ({ key: next(), name: e.name, value: e.value, secret: e.secret, kept: false }))));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A whole line typed into Command ("npx -y @trokky/mcp@3") is a command and
  // its first arguments, split as a shell would; the form shows it that way.
  const typed = /\s/.test(command.trim()) ? shellWords(command.trim()) : [command.trim()];
  const head = typed[0] ?? '';
  const allArgs = [...typed.slice(1), ...args.map((a) => a.value)];
  const words = [head, ...allArgs].filter((w, i) => i > 0 || w !== '');
  const unfold = (): void => {
    if (typed.length < 2) return;
    setCommand(head);
    setArgs((rows) => [...typed.slice(1).map((value) => ({ key: next(), value })), ...rows]);
  };
  const line = words.map(shellQuoted).join(' ');
  const missing = env.filter((e) => e.secret && e.value === '' && !e.kept).map((e) => e.name || 'a variable');
  const placeholders = (pasted?.env ?? []).filter((e) => e.placeholder).map((e) => e.name);

  const setArg = (key: number, value: string): void => setArgs((rows) => rows.map((r) => (r.key === key ? { ...r, value } : r)));
  const setVar = (key: number, patch: Partial<EnvRow>): void => setEnv((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const form: ProgramForm = {
      name: name.trim(),
      command: head,
      args: allArgs,
      env: env.filter((e) => e.name.trim() !== '').map((e) => ({ name: e.name.trim(), value: e.value, secret: e.secret })),
    };
    try {
      if (connection) onDone(await api.updateProgram(connection.id, form));
      else onDone((await api.addProgram(form)).connection);
      setEnv((rows) => rows.map((r) => (r.secret ? { ...r, value: '' } : r)));
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p>
        A server buddi starts itself on this computer, as you, when an agent needs it, and stops after ten quiet minutes. It runs
        with your PATH and only the variables you name here. The review screen is the first time it runs, only to list its tools.
      </p>
      <FormGrid columns={2}>
        <Field label="Name">
          <input required autoFocus={!pasted && !connection} maxLength={80} spellCheck={false} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Command" hint="The program that starts the server: npx, uvx, node, or a full path. A whole line is split into it and its arguments.">
          <input required spellCheck={false} autoComplete="off" className="mono" value={command} placeholder="npx" onChange={(event) => setCommand(event.target.value)} onBlur={unfold} />
        </Field>
      </FormGrid>
      <Field label="Arguments" group hint="One per row, exactly as the server's docs give them. No shell: quotes and $VARIABLES are passed as they are.">
        <div className="ui-stack" data-gap="sm">
          {args.map((arg, index) => (
            <div key={arg.key} className="connections-row">
              <input
                aria-label={`Argument ${index + 1}`}
                className="mono"
                spellCheck={false}
                autoComplete="off"
                value={arg.value}
                onChange={(event) => setArg(arg.key, event.target.value)}
              />
              <Button size="sm" variant="ghost" onClick={() => setArgs((rows) => rows.filter((r) => r.key !== arg.key))} aria-label={`Remove argument ${index + 1}`}>Remove</Button>
            </div>
          ))}
          <Toolbar>
            <Button size="sm" onClick={() => setArgs((rows) => [...rows, { key: next(), value: '' }])}>Add an argument</Button>
          </Toolbar>
        </div>
      </Field>
      <Field label="Environment variables" group hint="A secret is kept in buddi's vault and handed to the program only when it starts. Names with TOKEN, KEY, SECRET or PASSWORD start as secrets.">
        <div className="ui-stack" data-gap="sm">
          {env.map((row, index) => (
            <div key={row.key} className="connections-row" data-kind="env">
              <input
                aria-label={`Variable ${index + 1} name`}
                className="mono"
                spellCheck={false}
                autoComplete="off"
                placeholder="NAME"
                value={row.name}
                onChange={(event) => {
                  const value = event.target.value;
                  // A fresh row follows its name until the switch is touched.
                  setVar(row.key, row.value === '' && !row.kept ? { name: value, secret: looksSecret(value) } : { name: value });
                }}
              />
              <input
                aria-label={`Variable ${index + 1} value`}
                type={row.secret ? 'password' : 'text'}
                spellCheck={false}
                autoComplete="off"
                placeholder={row.kept && row.value === '' ? 'Kept. Type to replace it.' : 'value'}
                value={row.value}
                onChange={(event) => setVar(row.key, { value: event.target.value })}
              />
              <label className="backup-check">
                <input type="checkbox" checked={row.secret} onChange={(event) => setVar(row.key, { secret: event.target.checked, kept: event.target.checked && row.kept })} />
                <span>Secret</span>
              </label>
              <Button size="sm" variant="ghost" onClick={() => setEnv((rows) => rows.filter((r) => r.key !== row.key))} aria-label={`Remove variable ${index + 1}`}>Remove</Button>
            </div>
          ))}
          <Toolbar>
            <Button size="sm" onClick={() => setEnv((rows) => [...rows, { key: next(), name: '', value: '', secret: false, kept: false }])}>Add a variable</Button>
          </Toolbar>
        </div>
      </Field>
      {placeholders.length > 0 ? (
        <Notice tone="accent">Your config had a placeholder for {placeholders.join(', ')}. Type the value itself.</Notice>
      ) : null}
      {!tokens && env.some((e) => e.secret) ? (
        <Notice tone="warning">This installation has no vault, so a secret cannot be kept. Turn the vault on first, or switch Secret off.</Notice>
      ) : null}
      <p className="ui-card-meta">
        A server that signs you in through a browser opens it on this computer, so it needs a screen. On a machine without one, give
        it a token as a secret variable instead.
      </p>
      <div className="ui-stack" data-gap="sm">
        <span className="ui-field-label">It will run</span>
        <Code label="The command line">{line || '…'}</Code>
      </div>
      <ErrorBanner message={failure} />
      <Toolbar align="end">
        <Button
          type="submit"
          variant="accent"
          disabled={busy || name.trim() === '' || command.trim() === '' || missing.length > 0}
          title={missing.length > 0 ? `Give ${missing.join(', ')} a value.` : undefined}
        >
          {busy ? 'Saving…' : connection ? 'Save' : 'Continue'}
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
    if (review.error) return <ErrorBanner message={review.error} />;
    return connection.transport === 'stdio'
      ? <Empty>Starting {connection.name}… The first start can take a minute or two while it downloads.</Empty>
      : <Empty>Reading what {connection.name} offers…</Empty>;
  }
  const usable = data.tools.filter((t) => t.problem === null).length;
  return (
    <div className="ui-stack">
      <p>
        Read what {connection.name} brings before it brings it. Each tool gets a buddi name and a tier from what the server says it does;
        anything that changes something asks you first, on the same approval card as every other tool.
      </p>
      {data.program ? (
        <Notice tone="warning" title="This runs on this computer as you">
          <Stack gap="sm">
            <Code label="The command">{data.program.line}</Code>
            <p>
              It can read and change what you can, and reach the network. buddi starts it with only the variables below, stops it after
              ten quiet minutes, and asks you again if its command changes.
            </p>
            {data.program.env.length > 0 ? (
              <p className="ui-card-meta">
                Variables: {data.program.env.map((e) => `${e.name}${e.secret ? ' (secret)' : ''}`).join(', ')}
              </p>
            ) : null}
          </Stack>
        </Notice>
      ) : (
        <p className="ui-card-meta">buddi talks to <span className="mono">{data.host}</span> for these tools, and nowhere else.</p>
      )}
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
                    <p className="ui-card-meta">{tool.destructive ? NEVER_REMEMBERED : 'You can remember its approval for an agent when you give it the tools, or later on the agent’s Tools tab.'}</p>
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

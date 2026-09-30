/**
 * The connections one agent holds (Setup → Access), the per-agent mirror of
 * the connection sheet's "Held by → Change": a switch per connection, saved as
 * it changes through `POST /api/connections/:id/holders/:agent`, which writes
 * only this agent's file. A connection not ready to give (its tools not
 * reviewed, or its sign-in lapsed) is listed with why, and a way to fix it.
 */
import { useState } from 'react';
import { api, type ConnectionView } from '../../api';
import { Empty, ErrorBanner, Notice, Pill, Section, useAsync } from '../../ui';
import { settingsRoute } from '../../routes';
import { connectionState } from '../Connections';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Why the switch cannot give it now, or null when it can. */
export function notReady(connection: ConnectionView): string | null {
  if (connection.state === 'pending-review' || !connection.slug) return 'Not finished: its tools are not reviewed yet.';
  if (connection.state === 'needs-review') return 'Its tools changed and need your review.';
  if (connection.state === 'needs-reconnect') return 'Its sign-in ended; sign in again first.';
  return null;
}

export function AgentConnections({ agentId, agentName, readOnly, version, onSaved }: {
  agentId: string;
  /** The agent's grant as its file says it. */
  version: string;
  agentName: string;
  readOnly: boolean;
  /** The agent file changed: the tools picker above reads it again. */
  onSaved?: () => void;
}): JSX.Element {
  const [held, setHeld] = useState<Record<string, boolean>>({});
  // Read again when the agent's file changes (a tools save above); a fresh read replaces the switches' own answers.
  const view = useAsync(() => api.connections().then((v) => { setHeld({}); return v; }), [version]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const settings = settingsRoute('connections');

  const toggle = async (connection: ConnectionView, on: boolean): Promise<void> => {
    setBusy(connection.id);
    setFailure(null);
    try {
      const result = await api.setConnectionHolder(connection.id, agentId, on);
      setHeld((current) => ({ ...current, [connection.id]: result.held }));
      onSaved?.();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const data = view.data;
  const connections = data?.connections ?? [];
  const holds = (c: ConnectionView): boolean => held[c.id] ?? c.agents.includes(agentId);
  const canHold = data ? data.agents.some((a) => a.id === agentId) : true;
  const count = connections.filter(holds).length;

  return (
    <Section title="Connections" aside={data && connections.length > 0 ? `holds ${count} of ${connections.length} · saved as you change them` : undefined} panel>
      <ErrorBanner message={view.error ?? failure} />
      {!data ? (
        view.error ? null : <Empty>Loading the connections…</Empty>
      ) : connections.length === 0 ? (
        <p className="ui-card-meta">Nothing is connected yet. <a href={settings}>Connect a service in Connections</a></p>
      ) : !canHold ? (
        <p className="ui-card-meta">{agentName} makes and changes agents, so it holds no connections.</p>
      ) : (
        <>
          {readOnly ? (
            <Notice tone="warning">This agent ships with buddi, so its connections are read-only here. Ask Agent Father to make it yours, then it can change.</Notice>
          ) : null}
          <ul className="ui-list delegate-list" aria-label={`Connections ${agentName} holds`}>
            {connections.map((c) => {
              const on = holds(c);
              const why = notReady(c);
              const where = c.transport === 'stdio' ? 'on this computer' : c.host;
              const tools = c.slug ? plural(c.toolCount, 'tool', 'tools') : 'tools not reviewed';
              const inputId = `holds-${agentId}-${c.id}`;
              return (
                <li key={c.id} className="ui-list-row">
                  <input
                    type="checkbox"
                    role="switch"
                    id={inputId}
                    checked={on}
                    aria-checked={on}
                    // Taking a connection away is always allowed; giving one waits until it is ready.
                    disabled={readOnly || busy !== null || (why !== null && !on)}
                    onChange={(e) => void toggle(c, e.target.checked)}
                  />
                  <label htmlFor={inputId} className="ui-list-main">
                    <span className="ui-list-title">{c.name}{why ? <> <Pill tone="warning">{connectionState(c).label}</Pill></> : null}</span>
                    <span className="ui-list-sub">{`${where} · ${tools}`}</span>
                    {why ? <span className="ui-list-sub">{why} <a href={settings}>Open Connections</a></span> : null}
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Section>
  );
}

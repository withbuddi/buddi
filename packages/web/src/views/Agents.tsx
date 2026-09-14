/**
 * The catalog: every agent installed as a file under `agents/`, with the tools
 * it may call, the skills composed into its prompt, and the provider it is
 * pinned to — including *which environment variable* holds the credential, and
 * never the credential itself.
 *
 * The engine controls write through `POST /api/agents/:id/engine`, which calls
 * the same core function `buddi agents set` calls: the agent file is edited, and
 * the file stays the only source of truth. Two things the page is careful to
 * say out loud, because they are the two ways a control like this misleads:
 *
 *  - the model list is filtered to the selected provider, and a cross-provider
 *    model is refused by the server with the catalogue's own sentence — a model
 *    is never migrated for anyone;
 *  - the running surfaces (this process included) keep the catalog they loaded
 *    at boot, so every successful change repeats that a restart is needed.
 */
import { useState } from 'react';
import { api, type AgentEngine, type AgentRow, type ProviderModels } from '../api';
import { Empty, ErrorBanner, useAsync } from '../ui';

const LANGUAGES = ['mirror', 'en', 'fr'];

export function Agents(): JSX.Element {
  const { data, error, reload } = useAsync(() => api.agents(), []);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (work: Promise<{ note: string; changed: string[] }>): Promise<void> => {
    setFailure(null);
    setNote(null);
    try {
      const result = await work;
      setNote(
        result.changed.length === 0
          ? 'That is already what the file says; nothing was written.'
          : `Changed ${result.changed.join(', ')} — ${result.note}.`,
      );
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <h2>Agents</h2>
      <p className="lede">Provider choice is pinned per agent — it decides where your data goes.</p>
      <ErrorBanner message={error ?? failure} />
      {note ? (
        <div className="attention" style={{ borderLeftColor: 'var(--ok)' }}>
          {note}
        </div>
      ) : null}
      {!data || data.agents.length === 0 ? (
        <Empty>No agents are installed.</Empty>
      ) : (
        data.agents.map((agent) => (
          <Agent
            key={agent.id}
            agent={agent}
            engine={data.engines.find((e) => e.id === agent.id)}
            providers={data.providers}
            onRun={run}
          />
        ))
      )}
    </>
  );
}

function Agent({
  agent,
  engine,
  providers,
  onRun,
}: {
  agent: AgentRow;
  engine: AgentEngine | undefined;
  providers: ProviderModels[];
  onRun: (work: Promise<{ note: string; changed: string[] }>) => void;
}): JSX.Element {
  const provider = engine?.provider ?? agent.provider.kind;
  const group = providers.find((p) => p.kind === provider);
  const model = engine?.model ?? agent.model;
  const [turns, setTurns] = useState(String(engine?.maxTurns ?? agent.maxTurns));

  const set = (change: Record<string, unknown>): void => {
    onRun(api.setAgentEngine(agent.id, change));
  };

  // Switching provider carries a model with it: the server refuses a pin the
  // new provider does not serve, so the page proposes that provider's default
  // rather than sending a request it knows would be rejected.
  const switchProvider = (kind: string): void => {
    const target = providers.find((p) => p.kind === kind);
    set({ provider: kind, model: target?.defaultModel ?? model });
  };

  const known = group?.models.map((m) => m.id) ?? [];
  const options = known.includes(model) ? known : [model, ...known];

  return (
    <div className="attention" key={agent.id} style={{ borderLeftColor: 'var(--accent)' }}>
      <div className="bar" style={{ marginBottom: 4 }}>
        <strong style={{ flex: '1 1 auto' }}>
          {agent.name} <span className="mono muted">@{agent.handle}</span>
        </strong>
        {agent.isDefault ? <span className="pill">default</span> : null}
        <span className="pill">{engine?.language ?? agent.language}</span>
        <span className="pill">{engine?.maxTurns ?? agent.maxTurns} turns</span>
      </div>
      <div className="muted">{agent.description}</div>

      <h3>Engine</h3>
      <div className="bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label>
          <span className="muted">provider </span>
          <select value={provider} onChange={(e) => switchProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.kind}
                {p.usable ? '' : ' (no credential)'}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="muted">model </span>
          <input
            list={`models-${agent.id}`}
            defaultValue={model}
            onBlur={(e) => {
              if (e.target.value.trim() !== '' && e.target.value.trim() !== model) {
                set({ model: e.target.value.trim() });
              }
            }}
          />
          <datalist id={`models-${agent.id}`}>
            {options.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>

        <label>
          <span className="muted">max turns </span>
          <input
            type="number"
            min={1}
            style={{ width: 70 }}
            value={turns}
            onChange={(e) => setTurns(e.target.value)}
            onBlur={() => {
              const n = Number(turns);
              if (Number.isInteger(n) && n >= 1 && n !== (engine?.maxTurns ?? agent.maxTurns)) {
                set({ maxTurns: n });
              }
            }}
          />
        </label>

        <label>
          <span className="muted">language </span>
          <select
            value={engine?.language ?? agent.language}
            onChange={(e) => set({ language: e.target.value })}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="muted" style={{ marginTop: 6 }}>
        {engine?.credentialKind ?? agent.provider.credentialKind} from{' '}
        <span className="mono">{engine?.credentialEnv ?? agent.provider.credentialEnv}</span>
        {group && !group.usable ? ` · default model ${group.defaultModel} (${group.defaultFrom})` : ''}
      </div>
      {engine ? (
        <div
          className="muted"
          style={{ marginTop: 4, color: engine.available ? undefined : 'var(--warn)' }}
        >
          {engine.available
            ? 'available on this machine'
            : `unavailable: ${engine.unavailableReason ?? 'no credential'}`}
          {engine.restartRequired
            ? ' · this file has changed since the service loaded it — run `buddi service restart`'
            : ''}
        </div>
      ) : null}

      <h3>Tools ({agent.tools.length})</h3>
      <div>
        {agent.tools.map((tool) => (
          <span className="pill mono" key={tool} style={{ marginRight: 4, marginBottom: 4 }}>
            {tool}
          </span>
        ))}
      </div>

      <h3>Skills ({agent.skills.length})</h3>
      {agent.skills.length === 0 ? (
        <span className="muted">none</span>
      ) : (
        <div>
          {agent.skills.map((skill) => (
            <span className="pill" key={skill.file} style={{ marginRight: 4 }}>
              {skill.name} · {skill.provenance}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The catalog: every agent installed as a file under `agents/`, with the tools
 * it may call, the skills composed into its prompt, and the provider it is
 * pinned to — including *which environment variable* holds the credential, and
 * never the credential itself.
 */
import { api } from '../api';
import { Empty, ErrorBanner, useAsync } from '../ui';

export function Agents(): JSX.Element {
  const { data, error } = useAsync(() => api.agents(), []);

  return (
    <>
      <h2>Agents</h2>
      <p className="lede">Provider choice is pinned per agent — it decides where your data goes.</p>
      <ErrorBanner message={error} />
      {!data || data.agents.length === 0 ? (
        <Empty>No agents are installed.</Empty>
      ) : (
        data.agents.map((agent) => (
          <div className="attention" key={agent.id} style={{ borderLeftColor: 'var(--accent)' }}>
            <div className="bar" style={{ marginBottom: 4 }}>
              <strong style={{ flex: '1 1 auto' }}>
                {agent.name} <span className="mono muted">@{agent.handle}</span>
              </strong>
              {agent.isDefault ? <span className="pill">default</span> : null}
              <span className="pill">{agent.language}</span>
              <span className="pill">{agent.maxTurns} turns</span>
            </div>
            <div className="muted">{agent.description}</div>
            <div className="muted" style={{ marginTop: 6 }}>
              {agent.provider.kind} · <span className="mono">{agent.provider.model}</span> ·{' '}
              {agent.provider.credentialKind} from <span className="mono">{agent.provider.credentialEnv}</span>
            </div>

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
        ))
      )}
    </>
  );
}

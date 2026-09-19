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
 *  - the service reloads its catalog for new runs; existing runs retain their
 *    selected adapter. Older read-only catalog fixtures still report restart.
 */
import { useState } from 'react';
import { api, type AgentEngine, type AgentRow, type ProviderModels, type ProviderAccountsView } from '../api';
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Notice,
  Page,
  PageHeader,
  Pill,
  Row,
  Section,
  Stack,
  Toolbar,
  useAsync,
} from '../ui';
import { ModelPicker } from '../ModelPicker';

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
          ? `No file change needed — ${result.note}.`
          : `Changed ${result.changed.join(', ')} — ${result.note}.`,
      );
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Agents"
        lede="Provider choice is pinned per agent — it decides where your data goes."
        actions={<a href="#/providers">Manage provider credentials and defaults →</a>}
      />
      <ErrorBanner message={error ?? failure} />
      {note ? (
        <Notice tone="good" role="status">
          {note}
        </Notice>
      ) : null}
      {!data || data.agents.length === 0 ? (
        <Empty>No agents are installed.</Empty>
      ) : (
        <Stack>
          {data.agents.map((agent) => (
            <Agent
              key={`${agent.id}:${data.engines.find((e) => e.id === agent.id)?.model}:${data.providerAccounts?.bindings.find((b) => b.agentId === agent.id)?.accountId}`}
              agent={agent}
              engine={data.engines.find((e) => e.id === agent.id)}
              providers={data.providers}
              accounts={data.providerAccounts}
              onRun={run}
            />
          ))}
        </Stack>
      )}
    </Page>
  );
}

function Agent({
  agent,
  engine,
  providers,
  accounts,
  onRun,
}: {
  agent: AgentRow;
  engine: AgentEngine | undefined;
  providers: ProviderModels[];
  accounts?: ProviderAccountsView;
  onRun: (work: Promise<{ note: string; changed: string[] }>) => void;
}): JSX.Element {
  const provider = engine?.provider ?? agent.provider.kind;
  const group = providers.find((p) => p.kind === provider);
  const model = engine?.model ?? agent.model;
  const [turns, setTurns] = useState(String(engine?.maxTurns ?? agent.maxTurns));
  const binding = accounts?.bindings.find((b) => b.agentId === agent.id);

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
  const available = engine ? engine.available : true;

  return (
    <Card
      tone={available ? 'accent' : 'warning'}
      title={
        <>
          {agent.name} <span className="mono muted">@{agent.handle}</span>
        </>
      }
      meta={
        <>
          {agent.isDefault ? <Pill tone="accent">default</Pill> : null}
          <Pill>{engine?.language ?? agent.language}</Pill>
          <Pill>{engine?.maxTurns ?? agent.maxTurns} turns</Pill>
        </>
      }
    >
      <p className="ui-card-meta">{agent.description}</p>

      <Section title="Engine">
        <Toolbar valign="end">
          {accounts ? (
            <AccountChoice agentId={agent.id} accounts={accounts} onRun={onRun} />
          ) : (
            <>
              <Field label="Provider">
                <select value={provider} onChange={(e) => switchProvider(e.target.value)}>
                  {providers.map((p) => (
                    <option key={p.kind} value={p.kind}>
                      {p.kind}
                      {p.usable ? '' : ' (no credential)'}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model">
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
              </Field>
            </>
          )}

          <Field label="Max turns">
            <input
              type="number"
              min={1}
              value={turns}
              onChange={(e) => setTurns(e.target.value)}
              onBlur={() => {
                const n = Number(turns);
                if (Number.isInteger(n) && n >= 1 && n !== (engine?.maxTurns ?? agent.maxTurns)) {
                  set({ maxTurns: n });
                }
              }}
            />
          </Field>

          <Field label="Language">
            <select value={engine?.language ?? agent.language} onChange={(e) => set({ language: e.target.value })}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </Toolbar>

        <p className="ui-card-meta">
          {accounts ? (
            <>
              Account: {accounts.accounts.find((a) => a.id === binding?.accountId)?.label ?? 'Not selected'} · Model:{' '}
              {binding?.model ?? 'Not selected'}
            </>
          ) : (
            <>
              {engine?.credentialKind ?? agent.provider.credentialKind} from{' '}
              <span className="mono">{engine?.credentialEnv ?? agent.provider.credentialEnv}</span>
            </>
          )}
          {!accounts && group && !group.usable ? ` · default model ${group.defaultModel} (${group.defaultFrom})` : ''}
        </p>
        {engine ? (
          <p className={engine.available ? 'ui-card-meta' : 'warning'}>
            {engine.available
              ? 'available on this machine'
              : `unavailable: ${engine.unavailableReason ?? 'no credential'}`}
            {engine.restartRequired
              ? ' · this file has changed since the service loaded it — run `buddi service restart`'
              : ''}
          </p>
        ) : null}
      </Section>

      <Section title="Built-in context">
        <p className="ui-card-meta">
          Every agent receives current time, owner timezone and server-host information. system.time and system.info
          are always available, without grants or approval. Host and browser access still require their own
          permissions.
        </p>
      </Section>

      <Section title={`Granted tools (${agent.tools.length})`}>
        {agent.tools.length === 0 ? (
          <span className="muted">none</span>
        ) : (
          <Row>
            {agent.tools.map((tool) => (
              <Pill mono key={tool}>
                {tool}
              </Pill>
            ))}
          </Row>
        )}
      </Section>

      <Section title={`Skills (${agent.skills.length})`}>
        {agent.skills.length === 0 ? (
          <span className="muted">none</span>
        ) : (
          <Row>
            {agent.skills.map((skill) => (
              <Pill key={skill.file}>
                {skill.name} · {skill.provenance}
              </Pill>
            ))}
          </Row>
        )}
      </Section>
    </Card>
  );
}

function AccountChoice({
  agentId,
  accounts,
  onRun,
}: {
  agentId: string;
  accounts: ProviderAccountsView;
  onRun: (work: Promise<{ note: string; changed: string[] }>) => void;
}): JSX.Element {
  const binding = accounts.bindings.find((b) => b.agentId === agentId);
  const [id, setId] = useState(binding?.accountId ?? '');
  const [model, setModel] = useState(binding?.model ?? '');
  const [busy, setBusy] = useState(false);
  const chosen = accounts.accounts.find((a) => a.id === id);
  return (
    <>
      <Field label="Account">
        <select
          value={id}
          disabled={busy}
          onChange={(e) => {
            setId(e.target.value);
            setModel(accounts.accounts.find((a) => a.id === e.target.value)?.defaultModel ?? '');
          }}
        >
          <option value="">Choose an account</option>
          {accounts.accounts.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.enabled}>
              {a.label}
              {!a.enabled ? ' (disabled)' : !a.configured ? ' (needs credential)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <ModelPicker
        key={`${id}:${chosen?.revision}`}
        accountId={chosen?.configured ? id : undefined}
        label="Model"
        value={model}
        onChange={setModel}
        disabled={busy}
      />
      <Button
        disabled={busy || !id || !model.trim() || (id === binding?.accountId && model === binding.model)}
        onClick={() => {
          setBusy(true);
          onRun(api.assignProviderAccount(agentId, id, model).finally(() => setBusy(false)));
        }}
      >
        Save account selection
      </Button>
    </>
  );
}

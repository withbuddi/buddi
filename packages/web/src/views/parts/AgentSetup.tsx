/**
 * How one agent is wired: the account and model it runs on, its turn budget
 * and language, the tools it may call and the skills composed into its
 * prompt. The engine controls write through `POST /api/agents/:id/engine`,
 * which calls the same core function `buddi agents set` calls: the agent file
 * is edited, and the file stays the only source of truth.
 *
 *  - the model list is filtered to the selected provider, and a cross-provider
 *    model is refused by the server with the catalogue's own sentence;
 *  - the service reloads its catalog for new runs; existing runs keep their
 *    adapter.
 */
import { useState } from 'react';
import { api, type AgentEngine, type AgentRow, type ProviderModels, type ProviderAccountsView } from '../../api';
import { Button, Empty, ErrorBanner, Field, Notice, Pill, Row, Section, Stack, Toolbar, useAsync } from '../../ui';
import { ModelPicker } from '../../ModelPicker';

const LANGUAGES = ['mirror', 'en', 'fr'];

export function AgentSetup({ agentId }: { agentId: string }): JSX.Element {
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
          ? `No file change needed. ${result.note}.`
          : `Changed ${result.changed.join(', ')}. ${result.note}.`,
      );
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  const agent = data?.agents.find((a) => a.id === agentId);
  return (
    <Stack gap="lg">
      <ErrorBanner message={error ?? failure} />
      {note ? (
        <Notice tone="good" role="status">
          {note}
        </Notice>
      ) : null}
      {!data ? (
        <Empty>Loading…</Empty>
      ) : !agent ? (
        <Empty>This agent is not installed as a file.</Empty>
      ) : (
        <Agent
          key={`${agent.id}:${data.engines.find((e) => e.id === agent.id)?.model}:${data.providerAccounts?.bindings.find((b) => b.agentId === agent.id)?.accountId}`}
          agent={agent}
          engine={data.engines.find((e) => e.id === agent.id)}
          providers={data.providers}
          accounts={data.providerAccounts}
          onRun={run}
        />
      )}
    </Stack>
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
    <Stack gap="lg" divided>
      {!available ? (
        <Notice tone="warning">
          This agent cannot run right now: {engine?.unavailableReason ?? 'no credential'}.
        </Notice>
      ) : null}

      <Section title="Runs on">
        {accounts ? (
          <AccountChoice agentId={agent.id} accounts={accounts} onRun={onRun} />
        ) : (
          <Toolbar valign="end">
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
          </Toolbar>
        )}
        {!accounts ? (
          <p className="ui-card-meta">
            {engine?.credentialKind ?? agent.provider.credentialKind} from{' '}
            <span className="mono">{engine?.credentialEnv ?? agent.provider.credentialEnv}</span>
            {group && !group.usable ? ` · default model ${group.defaultModel} (${group.defaultFrom})` : ''}
          </p>
        ) : null}
        {engine && !engine.available ? (
          <p className="warning">unavailable: {engine.unavailableReason ?? 'no credential'}</p>
        ) : null}
        {engine?.restartRequired ? (
          <p className="warning">This file has changed since the service loaded it. Run `buddi service restart`.</p>
        ) : null}
      </Section>

      <Section title="Behaviour" aside={<span className="muted">saved as you change them</span>}>
        <Toolbar valign="end">
          <Field label="Max turns" hint="Per run. The agent stops when it runs out.">
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
          <Field label="Language" hint="Mirror answers in whatever language you write.">
            <select value={engine?.language ?? agent.language} onChange={(e) => set({ language: e.target.value })}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </Toolbar>
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
    </Stack>
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
  const dirty = id !== (binding?.accountId ?? '') || model !== (binding?.model ?? '');
  const current = accounts.accounts.find((a) => a.id === binding?.accountId);
  return (
    <div className="ui-stack">
      <Toolbar valign="end">
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
      </Toolbar>
      <Toolbar>
        {dirty && id && model.trim() ? (
          <span className="warning">Not saved yet. New runs still use {current ? `${current.label}, ${binding?.model ?? ''}` : 'nothing'}.</span>
        ) : (
          <span className="muted">
            {current ? `Running on ${current.label} with ${binding?.model ?? 'no model'}.` : 'No account chosen yet: this agent cannot run until you save one.'}
          </span>
        )}
        <span className="ui-toolbar-spacer" />
        <Button
          variant="accent"
          disabled={busy || !id || !model.trim() || !dirty}
          onClick={() => {
            setBusy(true);
            onRun(api.assignProviderAccount(agentId, id, model).finally(() => setBusy(false)));
          }}
        >
          Save account selection
        </Button>
      </Toolbar>
    </div>
  );
}

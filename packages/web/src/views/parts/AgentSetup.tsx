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
import { useEffect, useState } from 'react';
import { AGENTS_CHANGED, api, type AgentEngine, type AgentRow, type ProviderModels, type ProviderAccountsView } from '../../api';
import { Button, Empty, ErrorBanner, Field, Notice, Pill, Row, Section, Stack, Toolbar, useAsync } from '../../ui';
import { ModelPicker } from '../../ModelPicker';
import { grantFrom, sameTools, ToolPicker } from './ToolPicker';
import { Avatar, type Face } from './Avatar';

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
          all={data.agents}
          engine={data.engines.find((e) => e.id === agent.id)}
          providers={data.providers}
          accounts={data.providerAccounts}
          onRun={run}
          onSaved={reload}
        />
      )}
    </Stack>
  );
}

function Agent({
  agent,
  all,
  engine,
  providers,
  accounts,
  onRun,
  onSaved,
}: {
  agent: AgentRow;
  all: AgentRow[];
  onSaved: () => void;
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

      <Identity agent={agent} onSaved={onSaved} />

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
          <Field label="Thinking" hint="Reasoning before the answer. Off is faster; the model's default is usually on for local models.">
            <select
              aria-label="Thinking"
              value={engine?.thinking ?? 'default'}
              onChange={(e) => set({ thinking: e.target.value === 'default' ? null : e.target.value })}
            >
              <option value="default">Model default</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </Field>
        </Toolbar>
      </Section>

      <Delegation agent={agent} all={all} onSaved={onSaved} />

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

/**
 * The front matter the runtime actually reads, edited in place.
 *
 * Everything here is a field of `agent.md`, and the server validates the whole
 * file exactly as the loader would before it writes a byte — the same code
 * `platform.update_agent` runs, so a handle two agents would answer to is
 * refused here in the loader's own words rather than discovered at the next
 * restart. What is deliberately absent is `default`: which agent a chat with
 * no agent named lands on is a fact about the installation, recorded from the
 * picker at the head of the Agents page, not a flag inside one persona.
 */
function Identity({ agent, onSaved }: { agent: AgentRow; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(agent.name);
  const [handle, setHandle] = useState(agent.handle);
  const [description, setDescription] = useState(agent.description);
  const picker = useAsync(() => api.agentTools(agent.id), [agent.id]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [roles, setRoles] = useState((agent.roles ?? []).join(', '));
  const [avatar, setAvatar] = useState(agent.avatar ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const list = (text: string, separator: RegExp): string[] =>
    text.split(separator).map((t) => t.trim()).filter((t) => t !== '');
  const granted = picker.data?.granted ?? agent.tools;
  const chosen = picked ?? granted;
  const toolsChanged = picker.data !== undefined && !sameTools(chosen, granted);
  const nextRoles = list(roles, /[\n,]/);
  const same = (a: readonly string[], b: readonly string[]): boolean => a.join(',') === b.join(',');
  const dirty =
    name.trim() !== agent.name ||
    handle.trim().replace(/^@/, '') !== agent.handle ||
    description.trim() !== agent.description ||
    avatar.trim() !== (agent.avatar ?? '') ||
    toolsChanged ||
    !same(nextRoles, agent.roles ?? []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setSaved(null);
    try {
      const result = await api.updateAgentFile(agent.id, {
        name: name.trim(),
        handle: handle.trim().replace(/^@/, ''),
        description: description.trim(),
        // Only a changed selection is sent, so a rename never rewrites the grant.
        ...(toolsChanged && picker.data ? { tools: grantFrom(picker.data.groups, chosen) } : {}),
        roles: nextRoles,
        ...(avatar.trim() === '' ? {} : { avatar: avatar.trim() }),
      });
      setSaved(result.message);
      setPicked(null);
      picker.reload();
      onSaved();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Who it is" aside={<span className="muted mono">{agent.id}</span>}>
      {agent.isExample ? (
        <Notice tone="warning">
          This agent ships with buddi, so its file is read-only here. Ask Agent Father to make it yours,
          then these fields can change.
        </Notice>
      ) : null}
      {saved ? <Notice tone="good" role="status">{saved}</Notice> : null}
      <Toolbar valign="end">
        <Field label="Name" hint="What it is called, everywhere.">
          <input value={name} disabled={busy || agent.isExample} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Handle" hint="What you type to reach it. One handle, one agent.">
          <input value={handle} disabled={busy || agent.isExample} onChange={(e) => setHandle(e.target.value)} />
        </Field>
        <Field label="Face" hint="An emoji. Left empty, its initials are drawn.">
          <input value={avatar} disabled={busy || agent.isExample} onChange={(e) => setAvatar(e.target.value)} />
        </Field>
        <Field label="Roles" hint="Capabilities it answers for, comma separated.">
          <input value={roles} disabled={busy || agent.isExample} onChange={(e) => setRoles(e.target.value)} />
        </Field>
      </Toolbar>
      <Picture agent={agent} onChanged={onSaved} />
      <Field label="Description" hint="One or two sentences. Its colleagues read this.">
        <textarea rows={2} value={description} disabled={busy || agent.isExample} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="ui-field">
        <span className="ui-field-label">Tools</span>
        {picker.error ? (
          <ErrorBanner message={picker.error} />
        ) : !picker.data ? (
          <Empty>Loading the installed tools…</Empty>
        ) : (
          <ToolPicker view={picker.data} chosen={chosen} onChange={setPicked} disabled={busy || agent.isExample} />
        )}
      </div>
      <p className="ui-card-meta">
        Its persona — the body of the file below the front matter — is not edited here. Ask the agent that
        makes agents to rewrite it, or edit <span className="mono">agent.md</span> directly.
      </p>
      {!agent.isExample ? (
        <Toolbar>
          {failure ? (
            <span className="critical save-error" role="alert">{failure}</span>
          ) : (
            <span className={dirty ? 'warning' : 'muted'}>
              {dirty ? 'Not saved yet.' : 'Saved. Applies to new runs.'}
            </span>
          )}
          <span className="ui-toolbar-spacer" />
          <Button variant="accent" disabled={!dirty || busy} onClick={() => void save()}>
            Save who it is
          </Button>
        </Toolbar>
      ) : null}
    </Section>
  );
}

/** The icon the file names, as the roster draws it: an image in its folder, or an emoji. */
function iconOf(agent: AgentRow): Face['avatar'] {
  if (!agent.avatar) return undefined;
  return /^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i.test(agent.avatar)
    ? { kind: 'image', url: `/api/agents/${encodeURIComponent(agent.id)}/avatar` }
    : { kind: 'emoji', value: agent.avatar.slice(0, 8) };
}

/**
 * The uploaded picture, beside the Face. It lives in the database, not in
 * `agent.md`, so it is saved on its own and a shipped example can have one.
 */
export function Picture({ agent, onChanged }: { agent: AgentRow; onChanged: () => void }): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [input, setInput] = useState(0);

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const changed = (message: string | null): void => {
    setFile(null);
    setInput((n) => n + 1);
    setNote(message);
    onChanged();
    window.dispatchEvent(new Event(AGENTS_CHANGED));
  };
  const act = async (work: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      changed(await work());
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const save = (): Promise<void> =>
    act(async () => {
      const saved = await api.uploadAgentPicture(agent.id, file!);
      return saved.note ?? null;
    });
  const remove = (): Promise<void> =>
    act(async () => {
      await api.removeAgentPicture(agent.id);
      return null;
    });

  const face: Face = {
    avatar: iconOf(agent),
    ...(agent.accent ? { accent: agent.accent } : {}),
    roles: agent.roles,
    tools: agent.tools,
    ...(preview ?? agent.picture ? { picture: (preview ?? agent.picture)! } : {}),
  };
  return (
    <div className="ui-field">
      <span className="ui-field-label">Picture</span>
      <Toolbar>
        <Avatar id={agent.id} name={agent.name} size="xl" face={face} />
        <input
          key={input}
          type="file"
          aria-label="Choose a picture"
          accept="image/png,image/gif,image/svg+xml,.png,.gif,.svg"
          disabled={busy}
          onChange={(e) => {
            setFailure(null);
            setNote(null);
            setFile(e.target.files?.[0] ?? null);
          }}
        />
        <span className="ui-toolbar-spacer" />
        {agent.picture && !file ? (
          <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
            Remove picture
          </Button>
        ) : null}
        <Button variant="accent" disabled={!file || busy} onClick={() => void save()}>
          Save picture
        </Button>
      </Toolbar>
      {failure ? (
        <span className="critical save-error" role="alert">{failure}</span>
      ) : (
        <span className="ui-field-hint">
          {note ??
            'A PNG, GIF or SVG up to 1 MB, kept as a square PNG of at most 512 px; a GIF keeps its first frame. Without one, the Face above is drawn.'}
        </span>
      )}
    </div>
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


/** The tools that make an agent a writer of the installation. Never reachable by delegation. */
const WRITER_TOOLS = ['platform.create_agent', 'platform.update_agent', 'platform.write_skill', 'platform.delete_agent', 'platform.accept_plugin_agent', 'platform.accept_plugin_skill'];
const isWriter = (a: AgentRow): boolean => a.tools.some((t) => WRITER_TOOLS.includes(t));

/**
 * Who this agent may ask, and who may ask it. The first is the owner's to
 * change here; the second is read from everybody else's list.
 */
function Delegation({ agent, all, onSaved }: { agent: AgentRow; all: AgentRow[]; onSaved: () => void }): JSX.Element {
  const [chosen, setChosen] = useState<string[]>(agent.delegates);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [base, setBase] = useState<string[]>(agent.delegates);
  const others = all.filter((a) => a.id !== agent.id);
  const dirty = [...chosen].sort().join(',') !== [...base].sort().join(',');
  const askedBy = all.filter((a) => a.id !== agent.id && a.delegates.includes(agent.id));
  const toggle = (id: string): void => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const save = async (): Promise<void> => {
    setBusy(true); setFailure(null); setSaved(false);
    try { const result = await api.setDelegates(agent.id, chosen); setBase(result.delegates); setChosen(result.delegates); setSaved(true); onSaved(); }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Section title="Can ask" aside={<span className="muted">{agent.tools.includes('agent.delegate') ? 'holds agent.delegate' : 'no agent.delegate tool: it cannot ask anyone until granted'}</span>}>
        {agent.isExample ? (
          <Notice tone="warning">This agent ships with buddi, so its allowlist is read-only here. Ask Agent Father to make it yours, then it can change.</Notice>
        ) : null}
        <ErrorBanner message={failure} />
        {others.length === 0 ? (
          <Empty>Nobody else is installed.</Empty>
        ) : (
          <ul className="ui-list delegate-list" aria-label="Agents this one may ask">
            {others.map((a) => {
              const writer = isWriter(a);
              return (
                <li key={a.id} className="ui-list-row">
                  <input
                    type="checkbox"
                    id={`can-ask-${agent.id}-${a.id}`}
                    checked={chosen.includes(a.id)}
                    disabled={writer || agent.isExample || busy}
                    onChange={() => toggle(a.id)}
                  />
                  <label htmlFor={`can-ask-${agent.id}-${a.id}`} className="ui-list-main">
                    <span className="ui-list-title">{a.name} <span className="mono muted">@{a.handle}</span></span>
                    <span className="ui-list-sub">{writer ? 'Makes and changes agents. Never reachable by delegation.' : a.description}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {!agent.isExample ? (
          <Toolbar>
            <span className={dirty ? 'warning' : 'muted'}>
              {dirty ? 'Not saved yet.' : saved ? 'Saved. Applies to the next run.' : chosen.length === 0 ? 'Asks nobody.' : `May ask ${chosen.length} agent${chosen.length === 1 ? '' : 's'}.`}
            </span>
            <span className="ui-toolbar-spacer" />
            <Button variant="accent" disabled={!dirty || busy} onClick={() => void save()}>Save who it can ask</Button>
          </Toolbar>
        ) : null}
      </Section>

      <Section title="Asked by">
        {askedBy.length === 0 ? (
          <p className="ui-card-meta">No other agent may hand work to {agent.name}.</p>
        ) : (
          <Row>
            {askedBy.map((a) => <Pill key={a.id}>{a.name}</Pill>)}
          </Row>
        )}
      </Section>
    </>
  );
}

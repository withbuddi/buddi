/**
 * How one agent is wired, in three parts chosen from a row at the top:
 *
 *  - Identity: its name, handle, face, description and persona;
 *  - Brain: the account and model it runs on, its turn budget, language and
 *    thinking;
 *  - Access: its roles, the tools it may call, and who it may ask.
 *
 * The part is carried in the address (`#/agents/<id>/setup/brain`), so a
 * reload or a link keeps the place. All three stay mounted and only one is
 * shown, so an edit not saved yet survives a switch to another part.
 *
 * The engine controls write through `POST /api/agents/:id/engine`, which
 * calls the same core function `buddi agents set` calls: the agent file is
 * edited, and the file stays the only source of truth.
 *
 *  - the model list is filtered to the selected provider, and a cross-provider
 *    model is refused by the server with the catalogue's own sentence;
 *  - the service reloads its catalog for new runs; existing runs keep their
 *    adapter.
 */
import { THINKING_UP_TO_MODEL, effectiveProviderKind, thinkingIsHonoured } from '../../shell/thinking';
import { useEffect, useRef, useState } from 'react';
import { AGENTS_CHANGED, api, type AgentEngine, type AgentRow, type ProviderModels, type ProviderAccountsView } from '../../api';
import { Button, Details, Empty, ErrorBanner, Field, FormGrid, Notice, Pill, Row, Section, Stack, Tab, Tabs, Toolbar, useAsync } from '../../ui';
import { ModelPicker } from '../../ModelPicker';
import { agentRoute } from '../../routes';
import { grantFrom, sameTools, ToolPicker } from './ToolPicker';
import { Avatar, type Face } from './Avatar';
import { FacePicker, mascotFile, type FaceChoice } from './FacePicker';
import { KNOWN_ROLES, holderOf, isKnownRole, orderRoles } from '../../shell/roles';

const LANGUAGES = ['mirror', 'en', 'fr'];

export const SETUP_SECTIONS = [
  { id: 'identity', label: 'Identity' },
  { id: 'brain', label: 'Brain' },
  { id: 'access', label: 'Access' },
] as const;
type SetupSection = (typeof SETUP_SECTIONS)[number]['id'];
const asSection = (value: string | undefined): SetupSection =>
  SETUP_SECTIONS.find((s) => s.id === value)?.id ?? 'identity';

export function AgentSetup({
  agentId,
  section,
  navigate,
}: {
  agentId: string;
  /** From the address; identity when it names none, or one that is not a part. */
  section?: string | undefined;
  navigate?: (route: string) => void;
}): JSX.Element {
  const { data, error, reload } = useAsync(() => api.agents(), []);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [shown, setShown] = useState<SetupSection>(asSection(section));
  useEffect(() => setShown(asSection(section)), [section]);
  const show = (next: SetupSection): void => {
    setShown(next);
    navigate?.(agentRoute(agentId, 'setup', next));
  };

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
      <Tabs level="secondary" label="Setup">
        {SETUP_SECTIONS.map((s) => (
          <Tab
            key={s.id}
            href={agentRoute(agentId, 'setup', s.id)}
            active={shown === s.id}
            onClick={(e) => { e.preventDefault(); show(s.id); }}
          >
            {s.label}
          </Tab>
        ))}
      </Tabs>
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
          shown={shown}
          onShow={show}
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
  shown,
  onShow,
  onRun,
  onSaved,
}: {
  agent: AgentRow;
  all: AgentRow[];
  onSaved: () => void;
  engine: AgentEngine | undefined;
  providers: ProviderModels[];
  accounts?: ProviderAccountsView;
  shown: SetupSection;
  onShow: (section: SetupSection) => void;
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
  const available = engine ? engine.available : true;
  const reason = engine?.unavailableReason ?? 'no credential';

  // Every part stays mounted, so a draft outlives a switch; `hidden` only hides.
  return (
    <>
      <div hidden={shown !== 'identity'}>
        <Stack gap="lg">
          {!available ? (
            <Notice tone="warning">
              This agent cannot run right now.{' '}
              <a href={agentRoute(agent.id, 'setup', 'brain')} onClick={(e) => { e.preventDefault(); onShow('brain'); }}>
                See Brain.
              </a>
            </Notice>
          ) : null}
          <Identity agent={agent} onSaved={onSaved} />
        </Stack>
      </div>

      <div hidden={shown !== 'brain'}>
        <Stack gap="lg">
          {!available ? <Notice tone="warning">This agent cannot run right now: {reason}.</Notice> : null}
          <Section panel>
            <Stack divided>
              <Section title="Runs on">
                {accounts ? (
                  <AccountChoice agentId={agent.id} accounts={accounts} onRun={onRun} />
                ) : (
                  <FormGrid>
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
                  </FormGrid>
                )}
                {!accounts ? (
                  <p className="ui-card-meta">
                    {engine?.credentialKind ?? agent.provider.credentialKind} from{' '}
                    <span className="mono">{engine?.credentialEnv ?? agent.provider.credentialEnv}</span>
                    {group && !group.usable ? ` · default model ${group.defaultModel} (${group.defaultFrom})` : ''}
                  </p>
                ) : null}
                {engine?.restartRequired ? (
                  <p className="warning">This file has changed since the service loaded it. Run `buddi service restart`.</p>
                ) : null}
              </Section>

              <Section title="Behaviour" aside="saved as you change them">
                <FormGrid>
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
                  {thinkingIsHonoured(effectiveProviderKind(engine ?? { id: agent.id, provider }, accounts)) ? (
                    <Field label="Thinking" hint="Reasoning before the answer. Off is faster and cheaper.">
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
                  ) : (
                    <Field label="Thinking" hint={THINKING_UP_TO_MODEL}>
                      <span className="ui-card-meta">Up to the model</span>
                    </Field>
                  )}
                </FormGrid>
              </Section>
            </Stack>
          </Section>
        </Stack>
      </div>

      <div hidden={shown !== 'access'}>
        <Stack gap="lg">
          <Access agent={agent} all={all} onSaved={onSaved} />
          <Delegation agent={agent} all={all} onSaved={onSaved} />
          <Details summary="Built-in context" boxed>
            <p className="ui-card-meta">
              Every agent receives current time, owner timezone and server-host information. system.time and system.info
              are always available, without grants or approval. Host and browser access still require their own
              permissions.
            </p>
          </Details>
        </Stack>
      </div>
    </>
  );
}

/** A Save row at the foot of a panel: what is unsaved or refused on the left, the button on the right. */
function SaveFoot({ dirty, busy, failure, label, onSave }: {
  dirty: boolean; busy: boolean; failure: string | null; label: string; onSave: () => void;
}): JSX.Element {
  return (
    <>
      {failure ? (
        <span className="critical save-error" role="alert">{failure}</span>
      ) : (
        <span className={dirty ? 'warning' : 'muted'}>
          {dirty ? 'Not saved yet.' : 'Saved. Applies to new runs.'}
        </span>
      )}
      <span className="ui-toolbar-spacer" />
      <Button variant="accent" disabled={!dirty || busy} onClick={onSave}>
        {label}
      </Button>
    </>
  );
}

const READ_ONLY_FILE = (
  <Notice tone="warning">
    This agent ships with buddi, so its file is read-only here. Ask Agent Father to make it yours,
    then these fields can change.
  </Notice>
);

/**
 * Who it is: the front matter the runtime reads for its name and face, and
 * the persona that is the body of its file, edited in place.
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
  const [avatar, setAvatar] = useState(agent.avatar ?? '');
  const [choosingFace, setChoosingFace] = useState(false);
  // The persona is the body of the file: what the owner (or the wizard) wrote
  // there is what is shown, and what is saved back.
  const file = useAsync(() => api.agentFile(agent.id), [agent.id]);
  const [persona, setPersona] = useState<string | null>(null);
  const writtenPersona = file.data?.persona.trim() ?? '';
  const nextPersona = persona ?? writtenPersona;
  const personaChanged = file.data !== undefined && persona !== null && persona.trim() !== writtenPersona;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const dirty =
    name.trim() !== agent.name ||
    handle.trim().replace(/^@/, '') !== agent.handle ||
    description.trim() !== agent.description ||
    avatar.trim() !== (agent.avatar ?? '') ||
    personaChanged;

  // The face it wears now, with an emoji picked but not saved already on it.
  const emojiChosen = avatar.trim() !== '' && (avatar.trim() !== (agent.avatar ?? '') || !agent.picture);
  const icon = emojiChosen ? iconOf({ ...agent, avatar: avatar.trim() }) : iconOf(agent);
  const face: Face = {
    ...(icon ? { avatar: icon } : {}),
    ...(agent.accent ? { accent: agent.accent } : {}),
    roles: agent.roles,
    tools: agent.tools,
    ...(!emojiChosen && agent.picture ? { picture: agent.picture } : {}),
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setSaved(null);
    try {
      const result = await api.updateAgentFile(agent.id, {
        name: name.trim(),
        handle: handle.trim().replace(/^@/, ''),
        description: description.trim(),
        ...(avatar.trim() === '' ? {} : { avatar: avatar.trim() }),
        ...(personaChanged && nextPersona.trim() !== '' ? { persona: nextPersona.trim() } : {}),
      });
      // An emoji chosen over a picture takes the picture away, or the picture
      // would go on winning over it everywhere.
      if (agent.picture && avatar.trim() !== '' && avatar.trim() !== (agent.avatar ?? '')) {
        await api.removeAgentPicture(agent.id);
        window.dispatchEvent(new Event(AGENTS_CHANGED));
      }
      setPersona(null);
      file.reload();
      setSaved(result.message);
      onSaved();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Who it is"
      aside={<span className="mono">{agent.id}</span>}
      panel
      foot={agent.isExample ? undefined : <SaveFoot dirty={dirty} busy={busy} failure={failure} label="Save who it is" onSave={() => void save()} />}
    >
      <Stack>
      {agent.isExample ? READ_ONLY_FILE : null}
      {saved ? <Notice tone="good" role="status">{saved}</Notice> : null}
      <FormGrid>
        <Field label="Name" hint="What it is called, everywhere.">
          <input value={name} disabled={busy || agent.isExample} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Handle" hint="What you type to reach it. One handle, one agent.">
          <input value={handle} disabled={busy || agent.isExample} onChange={(e) => setHandle(e.target.value)} />
        </Field>
      </FormGrid>
      <Toolbar>
        <Avatar id={agent.id} name={name.trim() || agent.name} size="xl" face={face} />
        <Button aria-expanded={choosingFace} onClick={() => setChoosingFace((open) => !open)}>
          {choosingFace ? 'Hide faces' : 'Change face'}
        </Button>
      </Toolbar>
      {choosingFace ? <FaceField agent={agent} avatar={avatar} onEmoji={setAvatar} onChanged={onSaved} disabled={busy} /> : null}
      <Field label="Description" hint="One or two sentences. Its colleagues read this.">
        <textarea rows={2} value={description} disabled={busy || agent.isExample} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Persona" hint={<>Who it is and how it works, in its own file. It reads this before every conversation; <code>{'{{today}}'}</code> is filled in with the date at run time.</>} wide>
        {file.error ? (
          <ErrorBanner message={file.error} />
        ) : !file.data ? (
          <Empty>Reading its file…</Empty>
        ) : (
          <textarea
            className="setup-persona"
            value={nextPersona}
            rows={Math.max(6, nextPersona.split('\n').length + 1)}
            disabled={busy || agent.isExample}
            onChange={(e) => setPersona(e.target.value)}
          />
        )}
      </Field>
      </Stack>
    </Section>
  );
}

/**
 * What it may do: the roles surfaces route by, and the tools it may call.
 * Saved on their own, through the same file edit as Identity, sending only
 * these fields; the tools only when the selection changed.
 */
function Access({ agent, all, onSaved }: { agent: AgentRow; all: readonly AgentRow[]; onSaved: () => void }): JSX.Element {
  const picker = useAsync(() => api.agentTools(agent.id), [agent.id]);
  const [picked, setPicked] = useState<string[] | null>(null);
  // The four roles the surfaces know are chips; anything else is a line of text.
  const [knownRoles, setKnownRoles] = useState<ReadonlySet<string>>(() => new Set((agent.roles ?? []).filter(isKnownRole)));
  const [otherRoles, setOtherRoles] = useState((agent.roles ?? []).filter((r) => !isKnownRole(r)).join(', '));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const list = (text: string, separator: RegExp): string[] =>
    text.split(separator).map((t) => t.trim()).filter((t) => t !== '');
  const granted = picker.data?.granted ?? agent.tools;
  const chosen = picked ?? granted;
  const toolsChanged = picker.data !== undefined && !sameTools(chosen, granted);
  const nextRoles = orderRoles(knownRoles, list(otherRoles, /[\n,]/));
  const toggleRole = (role: string): void =>
    setKnownRoles((current) => {
      const next = new Set(current);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  const same = (a: readonly string[], b: readonly string[]): boolean => a.join(',') === b.join(',');
  const dirty =
    toolsChanged ||
    // Against the file's roles in the order the page saves them, so a file that
    // lists them otherwise does not open as unsaved.
    !same(nextRoles, orderRoles(new Set(agent.roles ?? []), agent.roles ?? []));

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setSaved(null);
    try {
      const result = await api.updateAgentFile(agent.id, {
        // Only a changed selection is sent, so a role change never rewrites the grant.
        ...(toolsChanged && picker.data ? { tools: grantFrom(picker.data.groups, chosen) } : {}),
        roles: nextRoles,
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
    <Section
      title="Roles and tools"
      panel
      foot={agent.isExample ? undefined : <SaveFoot dirty={dirty} busy={busy} failure={failure} label="Save roles and tools" onSave={() => void save()} />}
    >
      <Stack>
      {agent.isExample ? READ_ONLY_FILE : null}
      {saved ? <Notice tone="good" role="status">{saved}</Notice> : null}
      <div className="ui-field">
        <span className="ui-field-label" id={`roles-${agent.id}`}>Roles</span>
        <div className="role-chips" role="group" aria-labelledby={`roles-${agent.id}`}>
          {KNOWN_ROLES.map((role) => {
            const holder = holderOf(all, role.id);
            const elsewhere = holder && holder.id !== agent.id ? holder : undefined;
            return (
              <button
                key={role.id}
                type="button"
                className="role-chip"
                aria-pressed={knownRoles.has(role.id)}
                data-on={knownRoles.has(role.id) ? 'true' : undefined}
                disabled={busy || agent.isExample}
                onClick={() => toggleRole(role.id)}
              >
                <span className="role-chip-label">{role.label}</span>
                <span className="role-chip-meaning">{role.meaning}</span>
                {elsewhere ? (
                  <span className="role-chip-holder">
                    Held by {elsewhere.name}. If both claim it, the one listed first keeps it.
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <span className="ui-field-hint">Where buddi sends things when you do not say who. Tools are granted below.</span>
      </div>
      <Field label="Other roles" hint="Only a plugin that asks for a role by name reads these. Comma separated.">
        <input value={otherRoles} disabled={busy || agent.isExample} onChange={(e) => setOtherRoles(e.target.value)} />
      </Field>
      <div className="ui-field">
        <span className="ui-field-label">Tools · {granted.length} granted</span>
        {picker.error ? (
          <ErrorBanner message={picker.error} />
        ) : !picker.data ? (
          <Empty>Loading the installed tools…</Empty>
        ) : (
          <ToolPicker view={picker.data} chosen={chosen} onChange={setPicked} disabled={busy || agent.isExample} />
        )}
      </div>
      <RememberedApprovals agentId={agent.id} version={granted.join(',')} disabled={busy || agent.isExample} />
      </Stack>
    </Section>
  );
}

/**
 * The agent's connection tools that ask first (docs/connections.md): each may
 * have its approval remembered for this agent — the row a card's "Always"
 * writes — unless the server says it destroys something. Nothing is drawn
 * for an agent that holds none.
 */
export function RememberedApprovals({ agentId, version, disabled }: { agentId: string; version: string; disabled: boolean }): JSX.Element | null {
  const view = useAsync(() => Promise.resolve().then(() => api.rememberedApprovals(agentId)), [agentId, version]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const tools = view.data?.tools ?? [];
  if (tools.length === 0) return null;
  const toggle = async (tool: string, remember: boolean): Promise<void> => {
    setBusy(tool);
    setFailure(null);
    try {
      await api.setRememberedApproval(agentId, tool, remember);
      view.reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="ui-field">
      <span className="ui-field-label">Connection tools that ask first</span>
      <div className="ui-stack" data-gap="sm" role="group" aria-label="Remembered approvals">
        {tools.map((tool) => (
          <Stack key={tool.tool} gap="sm">
            <label className="backup-check">
              <input
                type="checkbox"
                checked={tool.remembered}
                disabled={disabled || !tool.rememberable || busy !== null}
                onChange={(event) => void toggle(tool.tool, event.target.checked)}
              />
              <span><span className="mono">{tool.tool}</span> · remember my approval</span>
            </label>
            {tool.why ? <p className="ui-card-meta">{tool.why}</p> : null}
          </Stack>
        ))}
      </div>
      <ErrorBanner message={failure} />
      <span className="ui-field-hint">Remembered, it asks once and then runs for this agent. Never for a tool that deletes or destroys.</span>
    </div>
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
 * The face, picked as in the wizard: a mascot is uploaded as the picture at
 * once, an emoji is a line in the file saved with the rest of "Who it is",
 * and the owner's own picture is the upload under both rows.
 */
function FaceField({ agent, avatar, onEmoji, onChanged, disabled }: {
  agent: AgentRow; avatar: string; onEmoji: (emoji: string) => void; onChanged: () => void; disabled: boolean;
}): JSX.Element {
  const [pending, setPending] = useState<FaceChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const emojiChosen = avatar.trim() !== '' && (avatar.trim() !== (agent.avatar ?? '') || !agent.picture);
  const face: FaceChoice | null = pending
    ?? (emojiChosen ? { kind: 'emoji', value: avatar.trim() } : agent.picture ? { kind: 'kept', url: agent.picture } : null);
  const pick = async (choice: FaceChoice): Promise<void> => {
    setFailure(null);
    if (choice.kind === 'emoji') { onEmoji(choice.value); return; }
    if (choice.kind === 'kept') { onEmoji(agent.avatar ?? ''); return; }
    setPending(choice);
    setBusy(true);
    try {
      await api.uploadAgentPicture(agent.id, await mascotFile(choice.role));
      onEmoji(agent.avatar ?? '');
      onChanged();
      window.dispatchEvent(new Event(AGENTS_CHANGED));
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
      setBusy(false);
    }
  };
  return (
    <div className="ui-field">
      <span className="ui-field-label">Face</span>
      <FacePicker
        face={face}
        label="Face"
        kept={agent.picture}
        disabled={disabled || busy}
        disableEmoji={agent.isExample}
        onPick={(choice) => void pick(choice)}
      >
        <Picture agent={agent} onChanged={onChanged} />
      </FacePicker>
      {failure ? <span className="critical save-error" role="alert">{failure}</span> : null}
    </div>
  );
}

/**
 * The uploaded picture, under the Face. It lives in the database, not in
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
  const [dragging, setDragging] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);
  const take = (next: File | null | undefined): void => {
    setFailure(null);
    setNote(null);
    setFile(next ?? null);
  };
  return (
    <div
      className="setup-upload"
      data-dragging={dragging ? 'true' : undefined}
      onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) take(e.dataTransfer.files?.[0]); }}
    >
      <Toolbar>
        <Avatar id={agent.id} name={agent.name} size="xl" face={face} />
        {/* The OS dialog cannot be styled; the control that opens it can. */}
        <input
          ref={chooser}
          key={input}
          className="sr-only"
          type="file"
          aria-label="Choose a picture"
          accept="image/png,image/gif,image/svg+xml,.png,.gif,.svg"
          disabled={busy}
          onChange={(e) => take(e.target.files?.[0])}
        />
        <Button disabled={busy} onClick={() => chooser.current?.click()}>
          Upload a picture
        </Button>
        <span className="setup-upload-name">{file ? file.name : 'or drop one here'}</span>
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
            'Your own picture: a PNG, GIF or SVG up to 1 MB, kept as a square PNG; a GIF keeps its first frame.'}
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

/** The roles that may ask everyone by default (core's `OPEN_DELEGATION_ROLES`). */
const OPEN_ROLES = ['front-desk', 'maker'] as const;
const EVERYONE_AS: Record<string, string> = { 'front-desk': 'Can ask: everyone, as the front desk', maker: 'Can ask: everyone, as the maker', list: 'Can ask: everyone' };

/**
 * Who this agent may ask, and who may ask it. The first is the owner's to
 * change here; the second is read from everybody else's list.
 *
 * The front desk and the maker ask everyone unless the owner limits them: that
 * state is a sentence and a "Limit to…" action, which opens the same picker
 * every other agent has.
 */
function Delegation({ agent, all, onSaved }: { agent: AgentRow; all: AgentRow[]; onSaved: () => void }): JSX.Element {
  const [chosen, setChosen] = useState<string[]>(agent.delegates);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [base, setBase] = useState<string[]>(agent.delegates);
  const [everyone, setEveryone] = useState<AgentRow['asksEveryone']>(agent.asksEveryone);
  const [limiting, setLimiting] = useState(false);
  const others = all.filter((a) => a.id !== agent.id);
  const openRole = OPEN_ROLES.find((r) => agent.roles?.includes(r));
  const picking = everyone === undefined || limiting;
  const dirty = limiting || [...chosen].sort().join(',') !== [...base].sort().join(',');
  const askedBy = all.filter((a) => a.id !== agent.id && (a.delegates.includes(agent.id) || (a.asksEveryone !== undefined && !isWriter(agent))));
  const toggle = (id: string): void => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const send = async (list: string[]): Promise<void> => {
    setBusy(true); setFailure(null); setSaved(false);
    try {
      const result = await api.setDelegates(agent.id, list);
      setBase(result.delegates); setChosen(result.delegates); setEveryone(result.asksEveryone); setLimiting(false); setSaved(true); onSaved();
    }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const limit = (): void => {
    // Start from everyone it can reach now, so limiting is unticking.
    setChosen(others.filter((a) => !isWriter(a)).map((a) => a.id));
    setLimiting(true); setSaved(false);
  };
  const status = dirty
    ? 'Not saved yet.'
    : saved ? 'Saved. Applies to the next run.'
    : !picking ? 'Asks everyone.'
    : chosen.length === 0 ? 'Asks nobody.' : `May ask ${chosen.length} agent${chosen.length === 1 ? '' : 's'}.`;
  return (
    <Section
      title="Delegation"
      aside={agent.tools.includes('agent.delegate') ? 'holds agent.delegate' : 'no agent.delegate tool: it cannot ask anyone until granted'}
      panel
      foot={
        agent.isExample ? undefined : (
          <>
            <span className={dirty ? 'warning' : 'muted'}>{status}</span>
            <span className="ui-toolbar-spacer" />
            {picking && openRole !== undefined ? (
              <Button disabled={busy} onClick={() => void send(['*'])}>Let it ask everyone</Button>
            ) : null}
            {picking ? (
              <Button variant="accent" disabled={!dirty || busy} onClick={() => void send(chosen)}>Save who it can ask</Button>
            ) : (
              <Button variant="accent" disabled={busy} onClick={limit}>Limit to…</Button>
            )}
          </>
        )
      }
    >
      <Stack divided>
        <Section title="Can ask">
          {agent.isExample ? (
            <Notice tone="warning">This agent ships with buddi, so its allowlist is read-only here. Ask Agent Father to make it yours, then it can change.</Notice>
          ) : null}
          <ErrorBanner message={failure} />
          {!picking ? (
            <p className="ui-card-meta">{EVERYONE_AS[everyone ?? 'list']}. New agents are included without being added here; agents that make and change agents are never reachable by delegation.</p>
          ) : others.length === 0 ? (
            <Empty>Nobody else is installed.</Empty>
          ) : (
            <>
            <p className="ui-card-meta">Only the agents ticked here. New teammates must be added here before it can ask them.</p>
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
            </>
          )}
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
      </Stack>
    </Section>
  );
}

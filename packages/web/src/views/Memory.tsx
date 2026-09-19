/**
 * Memory: what the agents have kept, across every scope, and the means to
 * correct it.
 *
 * Two kinds, kept apart because they are different things. Preferences are
 * what you told an agent you want — one current value per key, corrected by
 * revision, never overwritten. Notes are what an agent wrote down with
 * provenance: a fact you stated, a pattern it noticed, a thing to come back to.
 * Each carries a scope: shared with every agent, or private to one.
 *
 * What an agent sees at the start of a turn is the shared set plus its own,
 * with the ten newest notes; the rest stays reachable by search. This page
 * shows all of it, because it is yours.
 */
import { useState } from 'react';
import { ApiError, api, type MemoryNote, type MemoryPreference } from '../api';
import type { ChatAgent } from '../chat/types';
import { fmtRelative } from '../format';
import { Button, Empty, ErrorBanner, Field, Notice, PageFrame, Panel, Pill, Section, Sheet, Stack, Table, Toolbar, useAsync } from '../ui';

const KINDS = ['fact', 'observation', 'todo'] as const;

export function Memory({ embedded, agents, timezone }: { embedded?: boolean; agents: ChatAgent[]; timezone: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.memory(), [], 30_000);
  /** The preference sheet: open with a key to correct, or empty for a new one. */
  const [adding, setAdding] = useState<{ key: string; scope: string } | null>(null);
  const [editing, setEditing] = useState<MemoryNote | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const nameOf = (scope: string): string => scope === 'shared' ? 'Everyone' : (agents.find((a) => a.id === scope)?.name ?? scope);

  const run = async (work: Promise<unknown>): Promise<void> => {
    setProblem(null);
    try { await work; reload(); }
    catch (err) { setProblem(err instanceof ApiError ? err.message : String(err)); }
  };

  return (
    <PageFrame
      embedded={embedded}
      title="Memory"
      lede="What your agents have kept about you. Correct anything here; they see the change on their next turn."
      actions={<Button variant="accent" onClick={() => setAdding({ key: '', scope: 'shared' })}>Add a preference</Button>}
    >
      <ErrorBanner message={error ?? problem} />
      <Stack divided>
        <Section title="Preferences" aside={<span className="muted">what you said you want, one current value each</span>}>
          {!data ? null : data.preferences.length === 0 ? (
            <Empty>Nothing stated yet. Tell any agent "from now on…" or add one here.</Empty>
          ) : (
            <Panel flush>
              <Table>
                <thead><tr><th>Preference</th><th>Value</th><th>Who sees it</th><th className="num">Since</th><th /></tr></thead>
                <tbody>
                  {data.preferences.map((pref) => (
                    <tr key={`${pref.scope}:${pref.key}`}>
                      <td className="mono">{pref.key}</td>
                      <td>{pref.value}</td>
                      <td><ScopePill scope={pref.scope} name={nameOf(pref.scope)} /></td>
                      <td className="num muted" title={pref.updatedAt ?? ''}>{pref.updatedAt ? fmtRelative(pref.updatedAt, Date.now()) : ''}{pref.revision > 1 ? ` · rev ${pref.revision}` : ''}</td>
                      <td className="num">
                        <Toolbar align="end">
                          <Button size="sm" onClick={() => setAdding({ key: pref.key, scope: pref.scope })} title="Store a new value for this key">Change</Button>
                          <Button size="sm" variant="ghost" onClick={() => void run(api.forgetPreference({ key: pref.key, scope: pref.scope }))}>Forget</Button>
                        </Toolbar>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          )}
        </Section>

        <Section title="Notes" aside={<span className="muted">what an agent wrote down, with who wrote it</span>}>
          {!data ? null : data.notes.length === 0 ? (
            <Empty>No notes yet. An agent writes one when you state something durable about your life.</Empty>
          ) : (
            <Panel flush>
              <Table>
                <thead><tr><th>Note</th><th>Kind</th><th>Who sees it</th><th>Written by</th><th className="num">When</th><th /></tr></thead>
                <tbody>
                  {data.notes.map((note) => (
                    <tr key={note.id}>
                      <td className="memory-note">{note.content}</td>
                      <td><Pill tone={note.kind === 'todo' ? 'warning' : note.kind === 'fact' ? 'good' : undefined}>{note.kind}</Pill></td>
                      <td><ScopePill scope={note.scope} name={nameOf(note.scope)} /></td>
                      <td className="muted">{note.createdByAgent ? nameOf(note.createdByAgent) : ''}</td>
                      <td className="num muted" title={note.createdAt ?? ''}>
                        {note.createdAt ? fmtRelative(note.createdAt, Date.now()) : ''}
                        {note.expiresAt ? <span className="memory-expires"> · until {new Date(note.expiresAt).toLocaleDateString(undefined, { timeZone: timezone })}</span> : null}
                      </td>
                      <td className="num">
                        <Toolbar align="end">
                          <Button size="sm" onClick={() => setEditing(note)}>Edit</Button>
                          <Button size="sm" variant="ghost" onClick={() => void run(api.forgetNote(note.id))}>Forget</Button>
                        </Toolbar>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          )}
        </Section>
      </Stack>

      {adding ? (
        <PreferenceSheet
          agents={agents}
          existing={data?.preferences ?? []}
          initial={adding}
          onClose={() => setAdding(null)}
          onSave={(body) => run(api.setPreference(body)).then(() => setAdding(null))}
        />
      ) : null}
      {editing ? (
        <NoteSheet
          note={editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSave={(change) => run(api.updateNote(editing.id, change)).then(() => setEditing(null))}
        />
      ) : null}
    </PageFrame>
  );
}

function ScopePill({ scope, name }: { scope: string; name: string }): JSX.Element {
  return <Pill tone={scope === 'shared' ? 'accent' : undefined} title={scope === 'shared' ? 'Every agent reads this' : `Only ${name} reads this`}>{name}</Pill>;
}

function ScopeSelect({ value, agents, onChange }: { value: string; agents: ChatAgent[]; onChange: (scope: string) => void }): JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="shared">Everyone</option>
      {agents.map((agent) => <option key={agent.id} value={agent.id}>Only {agent.name}</option>)}
    </select>
  );
}

function PreferenceSheet({ agents, existing, initial, onClose, onSave }: {
  agents: ChatAgent[];
  existing: MemoryPreference[];
  initial: { key: string; scope: string };
  onClose: () => void;
  onSave: (body: { key: string; value: string; scope: string }) => Promise<void>;
}): JSX.Element {
  const [key, setKey] = useState(initial.key);
  const [value, setValue] = useState('');
  const [scope, setScope] = useState(initial.scope);
  const [busy, setBusy] = useState(false);
  const normalised = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const current = existing.find((p) => p.key === normalised && p.scope === scope);
  const ok = normalised !== '' && value.trim() !== '';
  return (
    <Sheet title="A preference" onClose={onClose}>
      <Stack>
        <Notice>A preference is a standing choice, in your words: "paid biweekly on Thursdays", "answers short, numbers first". Storing the same key again records a correction and keeps the old value in the history.</Notice>
        <Field label="Key" hint={normalised && normalised !== key ? `Stored as ${normalised}` : 'Short and stable, like reporting_currency or tone.'}>
          <input value={key} autoFocus={initial.key === ''} onChange={(e) => setKey(e.target.value)} placeholder="reporting_currency" />
        </Field>
        <Field label={current ? 'New value' : 'Value'}>
          <textarea rows={3} value={value} maxLength={2000} autoFocus={initial.key !== ''} onChange={(e) => setValue(e.target.value)} placeholder={current?.value ?? 'EUR'} />
        </Field>
        <Field label="Who should know" hint="Shared reaches every agent. Private stays with one.">
          <ScopeSelect value={scope} agents={agents} onChange={setScope} />
        </Field>
        {current ? <Notice tone="warning">This replaces the current value, "{current.value}" (revision {current.revision}).</Notice> : null}
        <Toolbar align="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!ok || busy} onClick={() => { setBusy(true); void onSave({ key: normalised, value: value.trim(), scope }).finally(() => setBusy(false)); }}>
            {current ? 'Save correction' : 'Save'}
          </Button>
        </Toolbar>
      </Stack>
    </Sheet>
  );
}

function NoteSheet({ note, agents, onClose, onSave }: {
  note: MemoryNote;
  agents: ChatAgent[];
  onClose: () => void;
  onSave: (change: { content?: string; scope?: string; kind?: string }) => Promise<void>;
}): JSX.Element {
  const [content, setContent] = useState(note.content);
  const [scope, setScope] = useState(note.scope);
  const [kind, setKind] = useState(note.kind);
  const [busy, setBusy] = useState(false);
  const dirty = content.trim() !== note.content || scope !== note.scope || kind !== note.kind;
  return (
    <Sheet title="A note" onClose={onClose}>
      <Stack>
        <Field label="What it says" hint="One sentence that makes sense months from now, on its own.">
          <textarea rows={4} value={content} maxLength={2000} autoFocus onChange={(e) => setContent(e.target.value)} />
        </Field>
        <Toolbar valign="end">
          <Field label="Kind">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>
          <Field label="Who sees it">
            <ScopeSelect value={scope} agents={agents} onChange={setScope} />
          </Field>
        </Toolbar>
        {note.createdByAgent ? <p className="muted">Written by {agents.find((a) => a.id === note.createdByAgent)?.name ?? note.createdByAgent}{note.createdAt ? `, ${fmtRelative(note.createdAt, Date.now())}` : ''}. Editing keeps that record.</p> : null}
        <Toolbar align="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!dirty || content.trim() === '' || busy} onClick={() => {
            setBusy(true);
            const change: { content?: string; scope?: string; kind?: string } = {};
            if (content.trim() !== note.content) change.content = content.trim();
            if (scope !== note.scope) change.scope = scope;
            if (kind !== note.kind) change.kind = kind;
            void onSave(change).finally(() => setBusy(false));
          }}>Save</Button>
        </Toolbar>
      </Stack>
    </Sheet>
  );
}

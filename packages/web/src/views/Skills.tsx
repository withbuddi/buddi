/**
 * Agents → Skills: the short texts agents follow, and who uses each.
 *
 * A skill is one Markdown file: a name, a "when it's used" line, then the
 * steps. One flush panel, grouped as Keys and secrets groups its rows —
 * Yours, Learned, From plugins, From the catalogue — an empty group not
 * drawn. A row is the title, when it's used, and one quiet line of who uses
 * it and where it came from. A problem is one sentence in the warning ink
 * with its one fix as the row's button: untrusted text → Mark as mine;
 * nobody uses it → Choose agents. ⋯ holds the rest.
 *
 * The sheet: when it's used, who uses it (Take away per agent, Change… opens
 * the picker), the text (Read · Source), Edit in place, Download, Delete….
 * A plugin's skill reads only. Write a skill and an uploaded .md open the
 * same form; an upload is untrusted until it is marked as the owner's.
 *
 * The kit's Skills.jsx is the source; the server is gateway/src/web/skills.ts.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { ApiError } from '../api';
import type { ChatAgent } from '../chat/types';
import { Markdown } from '../chat/markdown';
import { settingsRoute } from '../routes';
import {
  ActionMenu,
  AppIcon,
  Avatar,
  Button,
  Code,
  Empty,
  ErrorBanner,
  Field,
  Icon,
  List,
  ListRow,
  Modal,
  Notice,
  Panel,
  SearchField,
  Segment,
  Sheet,
  Spacer,
  Toolbar,
  useAsync,
} from '../ui';
import {
  SKILL_GROUPS,
  capitalized,
  currentHolders,
  deleteSentence,
  downloadSkill,
  editNote,
  holdersLine,
  nobodyUses,
  originLine,
  pluginTitle,
  readSkillFile,
  shortFile,
  skillsApi,
  untrustedLine,
  type SkillRow,
  type SkillsAgent,
  type SkillsView,
} from './parts/skills-data';

/** The largest file the page reads: the gateway takes 50 KB. */
const UPLOAD_MAX = 50_000;

const message = (err: unknown): string => (err instanceof ApiError ? err.message : String(err));

/** Stop a click inside a row's side from opening the row's sheet. */
const stop = (run?: () => void) => (event: { stopPropagation: () => void }): void => {
  event.stopPropagation();
  run?.();
};

/** What the page head asks of the tab: open the form, or the file picker. */
export interface SkillsCommand {
  kind: 'write' | 'upload';
  at: number;
}

/* ------------------------------------------------------------------ *
 * the tab
 * ------------------------------------------------------------------ */

export type SkillDialog =
  | { kind: 'picker'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'write' }
  | { kind: 'upload'; file: { name: string; size: number; title: string; description: string; body: string } }
  | null;

export function SkillsTab({
  faces,
  navigate,
  command,
  openSkill,
}: {
  /** The roster, for the agents' faces. */
  faces: readonly ChatAgent[];
  navigate: (route: string) => void;
  command?: SkillsCommand | null;
  /** A skill to open at once (`#/agents?tab=skills&skill=<id>`). */
  openSkill?: string | null;
}): JSX.Element {
  const view = useAsync(() => skillsApi.list(), []);
  const [open, setOpen] = useState<{ id: string; edit?: boolean } | null>(openSkill ? { id: openSkill } : null);
  const [dialog, setDialog] = useState<SkillDialog>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (openSkill) setOpen({ id: openSkill }); }, [openSkill]);
  // The page head's Upload a .md and Write a skill.
  useEffect(() => {
    if (!command) return;
    if (command.kind === 'write') setDialog({ kind: 'write' });
    else fileRef.current?.click();
  }, [command]);

  const pickFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.md$/i.test(file.name)) {
      setProblem(`“${file.name}” isn’t a .md file. A skill is one Markdown file.`);
      return;
    }
    if (file.size > UPLOAD_MAX) {
      setProblem(`“${file.name}” is over 50 KB. A skill is a short text.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setProblem(null);
      setDialog({ kind: 'upload', file: { name: file.name, size: file.size, ...readSkillFile(file.name, String(reader.result)) } });
    };
    reader.readAsText(file);
  };

  const changed = (note?: string): void => {
    setFailure(null);
    if (note !== undefined) setDone(note);
    view.reload();
  };

  return (
    <>
      <input ref={fileRef} type="file" accept=".md,text/markdown" hidden data-testid="skill-file" onChange={pickFile} />
      {problem ? (
        <Notice tone="warning" action={<Button size="sm" onClick={() => { setProblem(null); fileRef.current?.click(); }}>Pick another file</Button>}>
          {problem}
        </Notice>
      ) : null}
      <ErrorBanner message={failure} />
      {done ? <Notice tone="good" role="status">{done}</Notice> : null}
      <SkillsList
        view={view}
        onOpen={(row) => setOpen({ id: row.id })}
        onAct={(row, what) => act(row, what)}
      />
      <SkillOverlays
        view={view.data}
        faces={faces}
        open={open}
        setOpen={setOpen}
        dialog={dialog}
        setDialog={setDialog}
        navigate={navigate}
        onChanged={changed}
        onFailed={setFailure}
      />
      {dialog?.kind === 'write' && view.data ? (
        <SkillForm agents={view.data.agents} faces={faces} onClose={() => setDialog(null)} onSaved={(row) => { setDialog(null); changed(`Saved “${row.title}”.`); }} />
      ) : null}
      {dialog?.kind === 'upload' && view.data ? (
        <SkillForm
          agents={view.data.agents}
          faces={faces}
          upload={dialog.file}
          onClose={() => setDialog(null)}
          onSaved={(row) => { setDialog(null); changed(`Saved “${row.title}”.`); }}
        />
      ) : null}
    </>
  );

  function act(row: SkillRow, what: RowAction): void {
    setDone(null);
    if (what === 'trust') {
      skillsApi.trust(row.id).then(() => changed(), (err) => setFailure(message(err)));
    } else if (what === 'download') downloadSkill(row.id);
    else if (what === 'plugin') navigate(settingsRoute('plugins'));
    else if (what === 'edit') { setDialog(null); setOpen({ id: row.id, edit: true }); }
    else setDialog({ kind: what, id: row.id });
  }
}

type RowAction = 'trust' | 'picker' | 'edit' | 'download' | 'plugin' | 'delete';

function SkillsList({
  view,
  onOpen,
  onAct,
}: {
  view: { data: SkillsView | undefined; error: string | null; reload: () => void };
  onOpen: (row: SkillRow) => void;
  onAct: (row: SkillRow, what: RowAction) => void;
}): JSX.Element {
  if (!view.data && view.error) {
    return (
      <Empty warm title="Couldn’t load your skills" action={<Button variant="accent" size="sm" onClick={view.reload}>Try again</Button>}>
        buddi didn’t answer. Your skill files are untouched.
      </Empty>
    );
  }
  if (!view.data) return <SkillsSkeleton />;
  const { skills, agents } = view.data;
  if (skills.length === 0) {
    return (
      <Empty warm title="No skills yet">
        A skill teaches an agent one kind of task, in plain words. Write one here, or upload a .md file you already have.
      </Empty>
    );
  }
  return (
    <Panel flush>
      {SKILL_GROUPS.map((group) => {
        const rows = skills.filter((s) => s.group === group.id);
        if (!rows.length) return null;
        return (
          <section key={group.id} className="skills-group" aria-label={group.title}>
            <header className="skills-group-head">
              <h3 className="skills-group-title">{group.title}</h3>
              <span className="skills-group-aside">{group.aside}</span>
            </header>
            <List>
              {rows.map((row) => <SkillListRow key={row.id} row={row} agents={agents} onOpen={onOpen} onAct={onAct} />)}
            </List>
          </section>
        );
      })}
    </Panel>
  );
}

function SkillListRow({
  row,
  agents,
  onOpen,
  onAct,
}: {
  row: SkillRow;
  agents: readonly SkillsAgent[];
  onOpen: (row: SkillRow) => void;
  onAct: (row: SkillRow, what: RowAction) => void;
}): JSX.Element {
  const fix: [RowAction, string] | null = row.untrusted ? ['trust', 'Mark as mine'] : nobodyUses(row) ? ['picker', 'Choose agents'] : null;
  const holders = holdersLine(row, agents);
  return (
    <ListRow
      onClick={() => onOpen(row)}
      label={`${row.title}: details`}
      lead={<AppIcon icon="files" />}
      title={row.title}
      sub={
        <>
          <span className="skills-line">{row.description}</span>
          <span className="skills-line skills-meta">{holders} · {originLine(row, agents, true)}</span>
          {row.untrusted ? <span className="skills-status" data-tone="warning">{untrustedLine(row, agents)}</span> : null}
        </>
      }
      side={
        <span className="skills-side">
          {fix ? <Button size="sm" onClick={stop(() => onAct(row, fix[0]))}>{fix[1]}</Button> : null}
          <ActionMenu
            label={`More for ${row.title}`}
            sheet={{ title: row.title, sub: holders }}
            items={[
              { label: 'Choose agents…', hint: 'Give it or take it away', onSelect: () => onAct(row, 'picker') },
              row.editable ? { label: 'Edit text', onSelect: () => onAct(row, 'edit') } : null,
              { label: 'Download', hint: '.md file', onSelect: () => onAct(row, 'download') },
              row.from?.kind === 'plugin' ? { label: `Open ${pluginTitle(row.from.plugin)}`, onSelect: () => onAct(row, 'plugin') } : null,
              row.deletable && row.from?.kind !== 'plugin' ? 'separator' : null,
              row.deletable && row.from?.kind !== 'plugin' ? { label: 'Delete…', tone: 'critical', onSelect: () => onAct(row, 'delete') } : null,
            ]}
          />
        </span>
      }
    />
  );
}

function SkillsSkeleton(): JSX.Element {
  return (
    <Panel flush>
      <div className="skills-group skills-loading" aria-busy="true" aria-label="Loading skills">
        <header className="skills-group-head"><i className="cat-skel-line" data-w="20" /></header>
        <List>
          {[0, 1, 2].map((i) => (
            <div key={i} className="ui-list-row">
              <span className="ui-app-icon" />
              <span className="ui-list-main skills-skel"><i className="cat-skel-line" data-w="40" /><i className="cat-skel-line" data-w="70" /></span>
            </div>
          ))}
        </List>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * the sheets and dialogs, shared with the agent page
 * ------------------------------------------------------------------ */

export function SkillOverlays({
  view,
  faces,
  open,
  setOpen,
  dialog,
  setDialog,
  navigate,
  onChanged,
  onFailed,
}: {
  view: SkillsView | undefined;
  faces: readonly ChatAgent[];
  open: { id: string; edit?: boolean } | null;
  setOpen: (open: { id: string; edit?: boolean } | null) => void;
  dialog: SkillDialog;
  setDialog: (dialog: SkillDialog) => void;
  navigate: (route: string) => void;
  /** Something was written: re-read the list; `note` is what to say. */
  onChanged: (note?: string) => void;
  onFailed: (error: string) => void;
}): JSX.Element | null {
  if (!view) return null;
  const find = (id: string): SkillRow | undefined => view.skills.find((s) => s.id === id);
  const sheetRow = open ? find(open.id) : undefined;
  const dialogRow = dialog && 'id' in dialog ? find(dialog.id) : undefined;
  return (
    <>
      {sheetRow ? (
        <SkillSheet
          key={`${sheetRow.id}-${open?.edit ? 'edit' : 'read'}`}
          row={sheetRow}
          agents={view.agents}
          faces={faces}
          initialEdit={!!open?.edit}
          onClose={() => setOpen(null)}
          onPicker={() => setDialog({ kind: 'picker', id: sheetRow.id })}
          onDelete={() => setDialog({ kind: 'delete', id: sheetRow.id })}
          onChanged={onChanged}
          onFailed={onFailed}
          navigate={navigate}
        />
      ) : null}
      {dialog?.kind === 'picker' && dialogRow ? (
        <AgentPicker
          row={dialogRow}
          agents={view.agents}
          faces={faces}
          onCancel={() => setDialog(null)}
          onSaved={() => { setDialog(null); onChanged(); }}
        />
      ) : null}
      {dialog?.kind === 'delete' && dialogRow ? (
        <DeleteSkill
          row={dialogRow}
          agents={view.agents}
          onCancel={() => setDialog(null)}
          onDeleted={(note) => { setDialog(null); setOpen(null); onChanged(note); }}
        />
      ) : null}
    </>
  );
}

function SheetTitle({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <span className="skills-sheet-title">
      <AppIcon icon="files" size="lg" />
      <span className="skills-sheet-name">
        <span>{title}</span>
        <span className="skills-sheet-by">{sub}</span>
      </span>
    </span>
  );
}

function SheetSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="skills-sec" aria-label={title}>
      <header className="skills-sec-head">
        <h3 className="skills-sec-title">{title}</h3>
        {aside ? <span className="skills-sec-aside">{aside}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** The text, rendered or as the file is written. */
function SkillText({ file, body, text }: { file: string; body: string; text: string }): JSX.Element {
  const [shown, setShown] = useState<'read' | 'source'>('read');
  return (
    <>
      <div className="skills-text-bar">
        <Segment label="Show the text as" value={shown} onChange={setShown} options={[{ value: 'read', label: 'Read' }, { value: 'source', label: 'Source' }]} />
        <span className="skills-file mono">{file}</span>
      </div>
      {shown === 'read' ? <Markdown className="wb-md skills-md" text={body} /> : <Code label={file}>{text}</Code>}
    </>
  );
}

/** One skill: when it's used, who uses it, the text. Delete, Download, Edit text in the foot. */
export function SkillSheet({
  row,
  agents,
  faces,
  initialEdit,
  onClose,
  onPicker,
  onDelete,
  onChanged,
  onFailed,
  navigate,
}: {
  row: SkillRow;
  agents: readonly SkillsAgent[];
  faces: readonly ChatAgent[];
  initialEdit?: boolean;
  onClose: () => void;
  onPicker: () => void;
  onDelete: () => void;
  onChanged: (note?: string) => void;
  onFailed: (error: string) => void;
  navigate: (route: string) => void;
}): JSX.Element {
  const detail = useAsync(() => skillsApi.detail(row.id), [row.id, row.updatedAt, row.untrusted, row.learned?.version]);
  const [editing, setEditing] = useState(!!initialEdit && row.editable);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = detail.data?.text ?? '';
  const origin = capitalized(originLine(row, agents));
  const note = editNote(row, agents);
  const plugin = row.from?.kind === 'plugin' ? pluginTitle(row.from.plugin) : null;
  const face = (id: string): ChatAgent | undefined => faces.find((f) => f.id === id);

  const run = async (work: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      after?.();
      onChanged();
    } catch (err) {
      setError(message(err));
      onFailed(message(err));
    } finally {
      setBusy(false);
    }
  };
  const takeAway = (agent: string): void => {
    void run(() => skillsApi.grant(row.id, { agents: currentHolders(row).filter((a) => a !== agent) }));
  };
  const save = (): void => {
    void run(() => skillsApi.saveText(row.id, draft ?? text), () => { setEditing(false); setDraft(null); });
  };
  const holderSub = (agent: string, how: string): string | undefined => {
    if (row.learned?.by === agent) return 'Proposed it';
    if (row.from?.kind === 'catalogue' && row.from.agent === agent) return 'Came with it';
    if (how === 'home') return 'In its own folder';
    return undefined;
  };

  return (
    <Sheet
      size="wide"
      title={<SheetTitle title={row.title} sub={origin} />}
      onClose={onClose}
      foot={
        editing ? (
          <Toolbar align="end">
            <Button variant="ghost" disabled={busy} onClick={() => { setEditing(false); setDraft(null); }}>Cancel</Button>
            <Button variant="accent" disabled={busy || !detail.data} onClick={save}>Save</Button>
          </Toolbar>
        ) : (
          <Toolbar>
            {row.deletable && !plugin ? <Button variant="danger-ghost" onClick={onDelete}>Delete…</Button> : null}
            <Spacer />
            <Button onClick={() => downloadSkill(row.id)}>Download</Button>
            {row.editable ? <Button variant={row.untrusted ? undefined : 'accent'} onClick={() => setEditing(true)}>Edit text</Button> : null}
          </Toolbar>
        )
      }
    >
      {row.untrusted ? (
        <Notice tone="warning" action={<Button size="sm" variant="accent" disabled={busy} onClick={() => void run(() => skillsApi.trust(row.id))}>Mark as mine</Button>}>
          {untrustedLine(row, agents)} Mark it as yours once you’ve read it.
        </Notice>
      ) : null}
      <ErrorBanner message={error} />
      <div className="skills-sheet">
        <SheetSection title="When it’s used">
          <p className="skills-desc">{row.description}</p>
        </SheetSection>
        <SheetSection title="Used by" aside={<Button size="sm" onClick={onPicker}>Change…</Button>}>
          {row.every ? (
            <List>
              <ListRow lead={<AppIcon icon="agents" />} title="Every agent" sub="Now, and any you add later." />
            </List>
          ) : row.holders.length ? (
            <List>
              {row.holders.map((h) => {
                const a = agents.find((x) => x.id === h.agent);
                return (
                  <ListRow
                    key={h.agent}
                    lead={<Avatar id={h.agent} name={a?.name ?? h.agent} size="sm" face={face(h.agent)} />}
                    title={<>{a?.name ?? h.agent} <span className="skills-handle">@{a?.handle ?? h.agent}</span></>}
                    sub={holderSub(h.agent, h.how)}
                    side={
                      h.how === 'home' ? undefined : (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => takeAway(h.agent)} aria-label={`Take away from ${a?.name ?? h.agent}`}>
                          Take away
                        </Button>
                      )
                    }
                  />
                );
              })}
            </List>
          ) : (
            <p className="skills-note">No agent uses it yet, so it does nothing. Choose who should.</p>
          )}
        </SheetSection>
        <SheetSection title="The text">
          {!detail.data ? (
            detail.error ? <ErrorBanner message={detail.error} /> : <Empty>Reading the file…</Empty>
          ) : editing ? (
            <textarea
              className="skills-editor"
              value={draft ?? text}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`Text of ${row.title}`}
              spellCheck={false}
              autoFocus
            />
          ) : (
            <SkillText file={shortFile(row)} body={detail.data.body} text={text} />
          )}
          {editing && note ? <p className="skills-note">{note}</p> : null}
          {plugin ? (
            <p className="skills-note">
              Comes with {plugin}, so it’s changed there. To stop an agent using it, take it away above.{' '}
              <a href={settingsRoute('plugins')} onClick={(e) => { e.preventDefault(); navigate(settingsRoute('plugins')); }}>Open Plugins</a>
            </p>
          ) : null}
        </SheetSection>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * pickers, like the tool picker: tick rows, a search, Save
 * ------------------------------------------------------------------ */

function CheckRow({
  checked,
  disabled,
  onChange,
  lead,
  title,
  sub,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  lead?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
}): JSX.Element {
  return (
    <label className="skills-pick-row" data-disabled={disabled ? 'true' : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {lead}
      <span className="skills-pick-text">
        <span className="skills-pick-title">{title}</span>
        {sub ? <span className="skills-pick-sub">{sub}</span> : null}
      </span>
    </label>
  );
}

function PickSearch({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): JSX.Element {
  return (
    <div className="cat-search">
      <Icon name="search" size={16} />
      <SearchField label={label} value={value} placeholder={label} onChange={onChange} />
    </div>
  );
}

/** Who uses one skill: every agent, or the ones ticked; saved in each agent's file. */
export function AgentPicker({
  row,
  agents,
  faces,
  onCancel,
  onSaved,
}: {
  row: SkillRow;
  agents: readonly SkillsAgent[];
  faces: readonly ChatAgent[];
  onCancel: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [every, setEvery] = useState(row.every);
  const [picked, setPicked] = useState<string[]>(currentHolders(row));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const shown = agents.filter((a) => !q || `${a.name} ${a.handle}`.toLowerCase().includes(q));
  const toggle = (id: string, on: boolean): void => setPicked(on ? [...picked, id] : picked.filter((x) => x !== id));
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await skillsApi.grant(row.id, every ? { every: true, agents: [] } : { agents: picked });
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Who uses “${row.title}”?`}
      onClose={onCancel}
      foot={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="accent" disabled={busy} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <div className="skills-pick">
        <PickSearch label="Find an agent" value={query} onChange={setQuery} />
        <ErrorBanner message={error} />
        <div className="skills-pick-list">
          {q || !row.shareable ? null : (
            <CheckRow checked={every} onChange={setEvery} lead={<AppIcon icon="agents" />} title="Every agent" sub="Now, and any you add later." />
          )}
          {shown.map((a) => {
            const home = row.home === a.id;
            const fixed = home || !a.writable;
            return (
              <CheckRow
                key={a.id}
                checked={every || home || picked.includes(a.id)}
                disabled={every || fixed}
                onChange={(on) => toggle(a.id, on)}
                lead={<Avatar id={a.id} name={a.name} size="sm" face={faces.find((f) => f.id === a.id)} />}
                title={<>{a.name} <span className="skills-handle">@{a.handle}</span></>}
                sub={home ? 'Its own skill, in its folder' : !a.writable ? 'Ships with buddi, so its file doesn’t change' : undefined}
              />
            );
          })}
          {shown.length ? null : <p className="skills-note skills-pick-none">No agent called “{query.trim()}”.</p>}
        </div>
        <p className="skills-note">Saved in each agent’s file, so the file stays the record.</p>
      </div>
    </Modal>
  );
}

/** The skills one agent uses, grouped as on the Skills page. One every agent uses is ticked and fixed. */
export function SkillPickerFor({
  agent,
  view,
  onCancel,
  onSaved,
}: {
  agent: SkillsAgent;
  view: SkillsView;
  onCancel: () => void;
  onSaved: () => void;
}): JSX.Element {
  const holds = (s: SkillRow): boolean => s.every || s.holders.some((h) => h.agent === agent.id);
  const [picked, setPicked] = useState<string[]>(view.skills.filter(holds).map((s) => s.id));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const match = (s: SkillRow): boolean => !q || `${s.title} ${s.description}`.toLowerCase().includes(q);
  const fixed = (s: SkillRow): boolean => s.every || s.home === agent.id || !agent.writable;
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      for (const s of view.skills) {
        if (fixed(s)) continue;
        const want = picked.includes(s.id);
        if (want === holds(s)) continue;
        const now = currentHolders(s);
        await skillsApi.grant(s.id, { agents: want ? [...now, agent.id] : now.filter((a) => a !== agent.id) });
      }
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const any = view.skills.some(match);
  return (
    <Modal
      title={`Skills ${agent.name} uses`}
      onClose={onCancel}
      foot={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="accent" disabled={busy || !agent.writable} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <div className="skills-pick">
        <PickSearch label="Find a skill" value={query} onChange={setQuery} />
        <ErrorBanner message={error} />
        {!agent.writable ? <p className="skills-note">{agent.name} ships with buddi, so its file doesn’t change. Ask Agent Father to make it yours first.</p> : null}
        <div className="skills-pick-list">
          {SKILL_GROUPS.map((group) => {
            const rows = view.skills.filter((s) => s.group === group.id && match(s));
            if (!rows.length) return null;
            return (
              <div key={group.id} className="skills-pick-group" role="group" aria-label={group.title}>
                <div className="skills-pick-group-title">{group.title}</div>
                {rows.map((s) => (
                  <CheckRow
                    key={s.id}
                    checked={s.every || picked.includes(s.id)}
                    disabled={fixed(s)}
                    onChange={(on) => setPicked(on ? [...picked, s.id] : picked.filter((x) => x !== s.id))}
                    title={s.title}
                    sub={s.every ? 'Every agent uses it' : s.home === agent.id ? 'Its own skill, in its folder' : s.description}
                  />
                ))}
              </div>
            );
          })}
          {any ? null : <p className="skills-note skills-pick-none">No skill matches “{query.trim()}”.</p>}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * write a skill, or what an uploaded .md holds
 * ------------------------------------------------------------------ */

export function SkillForm({
  agents,
  faces,
  upload,
  onClose,
  onSaved,
}: {
  agents: readonly SkillsAgent[];
  faces: readonly ChatAgent[];
  upload?: { name: string; size: number; title: string; description: string; body: string };
  onClose: () => void;
  onSaved: (row: SkillRow) => void;
}): JSX.Element {
  const [title, setTitle] = useState(upload?.title ?? '');
  const [description, setDescription] = useState(upload?.description ?? '');
  const [body, setBody] = useState(upload?.body ?? '');
  const [who, setWho] = useState<string[]>([]);
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = title.trim() !== '' && description.trim() !== '' && body.trim() !== '';
  const size = upload ? `${Math.max(1, Math.round(upload.size / 1024))} KB` : '';
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { skill } = await skillsApi.create({
        title: title.trim(),
        description: description.trim(),
        body,
        agents: who,
        ...(upload ? { upload: { filename: upload.name, mine } } : {}),
      });
      onSaved(skill);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      size="wide"
      title={upload ? <SheetTitle title={upload.name} sub={`${size} · read, not saved yet`} /> : 'Write a skill'}
      onClose={onClose}
      foot={
        <Toolbar align="end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!ready || busy} onClick={() => void save()}>Save skill</Button>
        </Toolbar>
      }
    >
      <ErrorBanner message={error} />
      <div className="skills-sheet">
        <section className="skills-sec skills-form">
          <Field label="Name" hint="Short, like a task: “Weekly money recap”.">
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={!upload} />
          </Field>
          <Field label="When it’s used" hint="One line. Agents read it to decide when the skill applies.">
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When I ask about the week’s spending" />
          </Field>
          <Field label="The text" hint="Plain Markdown: steps, rules, what a good answer looks like.">
            <textarea
              className="skills-editor"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              placeholder={'1. Total spent this week.\n2. The three biggest charges.\n3. Anything odd.'}
            />
          </Field>
        </section>
        <SheetSection title="Who uses it">
          <div className="skills-who">
            {agents.map((a) => (
              <CheckRow
                key={a.id}
                checked={who.includes(a.id)}
                disabled={!a.writable}
                onChange={(on) => setWho(on ? [...who, a.id] : who.filter((x) => x !== a.id))}
                lead={<Avatar id={a.id} name={a.name} size="sm" face={faces.find((f) => f.id === a.id)} />}
                title={a.name}
              />
            ))}
          </div>
          <p className="skills-note">You can change this later. With nobody ticked it’s kept and does nothing.</p>
        </SheetSection>
        {upload ? (
          <section className="skills-sec">
            <label className="plugins-check">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              <span>
                <span className="plugins-check-title">Mark as mine</span>
                <span className="plugins-check-hint">I wrote it, or I’ve read it and trust it. Otherwise agents read it as outside text.</span>
              </span>
            </label>
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * delete, asked once
 * ------------------------------------------------------------------ */

function DeleteSkill({
  row,
  agents,
  onCancel,
  onDeleted,
}: {
  row: SkillRow;
  agents: readonly SkillsAgent[];
  onCancel: () => void;
  onDeleted: (note: string) => void;
}): JSX.Element {
  const detail = useAsync(() => skillsApi.detail(row.id), [row.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentence = useMemo(() => (detail.data ? deleteSentence(row, detail.data.onDelete, agents) : null), [detail.data, row, agents]);
  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await skillsApi.remove(row.id);
      onDeleted(`Deleted “${row.title}”.${result.movedTo ? ' The file is in the trash folder.' : result.versionsKept ? ' Its earlier versions are kept.' : ''}`);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Delete “${row.title}”?`}
      onClose={onCancel}
      foot={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" disabled={busy || !detail.data} onClick={() => void remove()}>Delete</Button>
        </>
      }
    >
      <ErrorBanner message={error ?? detail.error} />
      <p className="skills-dialog-text">{sentence ?? 'Checking who uses it…'}</p>
    </Modal>
  );
}

/** Who holds it, by name — for the agent page's rows. */
export function groupTitle(row: SkillRow): string {
  return SKILL_GROUPS.find((g) => g.id === row.group)?.title ?? '';
}


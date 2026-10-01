/**
 * A group's own things, from its room's ⋯ menu (docs/groups.md, "From the
 * room's menu"): who is in it, its name, its history, and deleting it.
 *
 * The menu is about the group. A member's page is one row's secondary
 * action inside Members, never what the menu is for. Each change in Members
 * is kept as it is made, the way the lock screen's editor keeps its own:
 * adding someone is reversible by removing them, so neither asks first.
 * Clearing and deleting ask once, in a sentence that names what goes and
 * what stays.
 */
import { useEffect, useState } from 'react';
import { ApiError, chatApi } from '../api';
import type { ChatAgent, GroupView } from '../chat/types';
import { agentRoute } from '../routes';
import { ActionMenu, AgentAvatar, Button, Field, List, ListRow, Modal, Notice, Pill, Sheet, Stack } from '../ui';
import { groupableAgents } from './roster';

export type GroupAction = 'members' | 'rename' | 'clear' | 'delete';

/** "Ledger", "Ledger and Tempo", "Ledger, Postie and Tempo". */
export function namesSentence(names: readonly string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Who of the group's members buddi still has, in the room's order. */
export function presentMembers(group: GroupView, agents: readonly ChatAgent[]): ChatAgent[] {
  return group.members.map((id) => agents.find((a) => a.id === id)).filter((a): a is ChatAgent => a !== undefined);
}

/**
 * What a room that lost an agent says, or null when nothing is missing. The
 * coordinator gone stops the room — the server refuses its turns — so that
 * one replaces the composer; one member left only says so above it.
 */
export function groupProblem(group: GroupView, agents: readonly ChatAgent[]): { kind: 'coordinator' | 'alone'; text: string; action: string } | null {
  const present = presentMembers(group, agents);
  const gone = group.members.filter((id) => !agents.some((a) => a.id === id));
  if (!agents.some((a) => a.id === group.coordinator)) {
    return { kind: 'coordinator', text: `${group.coordinator} coordinated this group and is no longer in buddi, so the group can't take requests.`, action: 'Choose a coordinator' };
  }
  if (present.length < 2) {
    const lost = gone.length > 0 ? `: ${gone.join(', ')} ${gone.length === 1 ? 'was' : 'were'} removed from buddi` : '';
    return { kind: 'alone', text: `Only ${present[0]?.name ?? group.coordinator} is left here${lost}.`, action: 'Add a member' };
  }
  return null;
}

/** The dashed face of an agent the room remembers and buddi no longer has. */
function GoneFace(): JSX.Element {
  return <span className="ui-avatar group-gone-face" aria-hidden="true">?</span>;
}

/**
 * Members: the coordinator first with its part named, then the rest in the
 * room's order; each row's ⋯ hands over the coordinator's part, opens the
 * agent's page, or takes it out. Below, who could join, with Add.
 */
export function MembersSheet({ group, agents, onClose, onSaved }: {
  group: GroupView;
  agents: ChatAgent[];
  onClose: () => void;
  onSaved: (group: GroupView) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const order = [group.coordinator, ...group.members.filter((id) => id !== group.coordinator)];
  const canRemove = group.members.length > 2;
  const addable = groupableAgents(agents).filter((a) => !group.members.includes(a.id));
  /* The coordinator left buddi: the one fix is on every row that could take its place, not behind ⋯. */
  const orphaned = !agents.some((a) => a.id === group.coordinator);

  const change = async (patch: { members?: string[]; coordinator?: string }): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await chatApi.updateGroup(group.id, patch));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = (id: string): void => void change({ members: group.members.filter((m) => m !== id) });

  return (
    <Sheet title="Members" onClose={onClose}>
      <p className="group-lede">
        {group.name} · {group.members.length} agents. Each keeps its own account, tools and approvals; being here grants nothing.
      </p>
      {orphaned ? <Notice tone="warning">{group.coordinator} coordinated this group and is no longer in buddi. Pick who coordinates now.</Notice> : null}
      {problem ? <Notice tone="critical">{problem}</Notice> : null}
      <List>
        {order.map((id) => {
          const agent = agents.find((a) => a.id === id);
          const coordinator = id === group.coordinator;
          if (!agent) {
            return (
              <ListRow
                key={id}
                lead={<GoneFace />}
                title={<span className="group-gone-id">{id}</span>}
                sub={<span className="group-gone-line">No longer in buddi{coordinator ? ' · was the coordinator' : !canRemove ? ' · add a member to take it out' : ''}</span>}
                side={canRemove && !coordinator ? <Button size="sm" disabled={busy} onClick={() => remove(id)}>Remove</Button> : undefined}
              />
            );
          }
          return (
            <ListRow
              key={id}
              lead={<AgentAvatar agents={agents} id={id} />}
              title={agent.name}
              sub={agent.description}
              side={
                <>
                  {coordinator ? <Pill tone="accent">Coordinator</Pill> : null}
                  {orphaned && agent.available ? <Button size="sm" disabled={busy} onClick={() => void change({ coordinator: id })}>Make coordinator</Button> : null}
                  <ActionMenu
                    label={`More for ${agent.name}`}
                    {...(coordinator ? { note: 'Coordinates the group' } : {})}
                    items={[
                      !coordinator && agent.available && { label: 'Make coordinator', hint: 'Reads your requests, answers for the room', onSelect: () => void change({ coordinator: id }) },
                      { label: `Open ${agent.name}'s page`, onSelect: () => { window.location.hash = agentRoute(id); } },
                      !coordinator && 'separator',
                      !coordinator && {
                        label: 'Remove from group',
                        hint: canRemove ? 'What it said stays' : 'A group needs two',
                        tone: 'critical' as const,
                        onSelect: () => { if (canRemove) remove(id); else setProblem('A group needs two agents. Add someone before taking this one out.'); },
                      },
                    ]}
                  />
                </>
              }
            />
          );
        })}
      </List>
      <div className="group-add">
        <h3 className="group-add-title">Add a member</h3>
        {addable.length > 0 ? (
          <List>
            {addable.map((agent) => (
              <ListRow
                key={agent.id}
                lead={<AgentAvatar agents={agents} id={agent.id} size="sm" />}
                title={agent.name}
                sub={agent.description}
                side={<Button size="sm" disabled={busy} onClick={() => void change({ members: [...group.members, agent.id] })}>Add</Button>}
              />
            ))}
          </List>
        ) : (
          <p className="group-quiet">Everyone who can join a group is here.</p>
        )}
      </div>
      <p className="group-quiet">
        Members read what is said here and what they recall from shared and group memory; nothing an agent knows privately comes in on its own. Taking a member out leaves what it said in the history.
      </p>
    </Sheet>
  );
}

export function RenameGroupModal({ group, onClose, onSaved }: { group: GroupView; onClose: () => void; onSaved: (group: GroupView) => void }): JSX.Element {
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = name.trim() !== '' && name.trim() !== group.name && !busy;
  const save = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await chatApi.updateGroup(group.id, { name: name.trim() }));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Rename group"
      onClose={onClose}
      foot={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="accent" disabled={!ready} onClick={() => void save()}>{busy ? 'Renaming…' : 'Rename'}</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Stack>
          <Field label="Name" hint="What this team is for: Household finances, The move, Tax season.">
            <input value={name} autoFocus maxLength={80} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setName(e.target.value)} />
          </Field>
          {problem ? <Notice tone="critical">{problem}</Notice> : null}
        </Stack>
      </form>
    </Modal>
  );
}

/** "4 conversations", read when the dialog opens; a sentence without the count until then. */
function useHistorySize(groupId: string): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    chatApi.group(groupId).then((g) => { if (live) setCount(g.history?.conversations ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [groupId]);
  return count;
}

function conversationsPhrase(count: number | null): string {
  if (count === null) return 'Its conversations';
  if (count === 0) return 'Nothing has been said yet, and its next conversation';
  return `Its ${count} ${count === 1 ? 'conversation' : 'conversations'}`;
}

export function ClearGroupModal({ group, onClose, onCleared }: { group: GroupView; onClose: () => void; onCleared: () => void }): JSX.Element {
  const count = useHistorySize(group.id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const clear = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await chatApi.clearGroup(group.id);
      onCleared();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  const empty = count === 0;
  return (
    <Modal
      title={`Clear the history of ${group.name}?`}
      onClose={onClose}
      foot={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy || empty} data-testid="group-clear-confirm" onClick={() => void clear()}>{busy ? 'Clearing…' : 'Clear history'}</Button></>}
    >
      <p className="group-dialog-text">
        {empty
          ? 'Nothing has been said in this group yet, so there is nothing to clear.'
          : `${conversationsPhrase(count)} ${count === 1 ? 'is' : 'are'} deleted for good, and anything it is doing now stops. The group, its members and what it remembers stay; files it made stay in Files.`}
      </p>
      {problem ? <Notice tone="critical">{problem}</Notice> : null}
    </Modal>
  );
}

export function DeleteGroupModal({ group, agents, onClose, onDeleted }: {
  group: GroupView;
  agents: ChatAgent[];
  onClose: () => void;
  onDeleted: (undoUntil: string) => void;
}): JSX.Element {
  const count = useHistorySize(group.id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const names = presentMembers(group, agents).map((a) => a.name);
  const remove = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const { undoUntil } = await chatApi.deleteGroup(group.id);
      onDeleted(undoUntil);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  const history = count === null ? 'its conversations' : count === 0 ? 'nothing said yet' : `its ${count} ${count === 1 ? 'conversation' : 'conversations'}`;
  return (
    <Modal
      title={`Delete ${group.name}?`}
      onClose={onClose}
      foot={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy} data-testid="group-delete-confirm" onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete group'}</Button></>}
    >
      <p className="group-dialog-text">
        The group goes with {history} and what it remembers.{' '}
        {names.length > 0 ? `${namesSentence(names)} ${names.length === 1 ? 'is' : 'are'} not touched, and files it made stay in Files.` : 'Files it made stay in Files.'}
      </p>
      {problem ? <Notice tone="critical">{problem}</Notice> : null}
    </Modal>
  );
}

/**
 * A group: making one, and changing the one you have.
 *
 * The same sheet does both, because they are the same three decisions — a
 * name, a coordinator, who is in the room — and an owner who learned the form
 * once should not have to learn a second one to add a member. What changes is
 * the title, the word on the button, and that an existing group can be
 * archived from here. The one sentence about memory (docs/groups.md) is shown
 * either way: it is as true on the day a member is added as on the first day.
 */
import { useState } from 'react';
import { ApiError, chatApi } from '../api';
import type { ChatAgent, GroupView } from '../chat/types';
import { canGroup, groupableAgents, makerName } from './roster';
import { Button, Field, Notice, Sheet, Stack, Toolbar } from '../ui';
import { AgentAvatar } from '../ui';

export function GroupSheet({ agents, group, onClose, onCreated, onSaved, onArchived }: {
  agents: ChatAgent[];
  /** The group being changed. Absent: a new one is being made. */
  group?: GroupView | null;
  onClose: () => void;
  onCreated?: (group: GroupView) => void;
  onSaved?: (group: GroupView) => void;
  onArchived?: (id: string) => void;
}): JSX.Element {
  /*
   * Reached by a link, with nobody to group.
   *
   * The rail stops offering this until there are two agents who could be in a
   * room together, but a bookmarked route does not go through the rail. One
   * sentence saying what is missing and where it is fixed — and no form,
   * because a form that can only be filled in wrongly is worse than no form.
   *
   * A group that already exists is past that question: its members are in it,
   * and an installation that lost an account must still be able to edit or
   * archive the room rather than meet a sentence about making another agent.
   */
  if (!group && !canGroup(agents)) {
    return (
      <Sheet title="A new group" onClose={onClose}>
        <Notice>A group needs two agents. Make another one with {makerName(agents)} first.</Notice>
      </Sheet>
    );
  }
  return (
    <GroupForm
      agents={choices(agents, group)}
      group={group ?? null}
      onClose={onClose}
      {...(onCreated ? { onCreated } : {})}
      {...(onSaved ? { onSaved } : {})}
      {...(onArchived ? { onArchived } : {})}
    />
  );
}

/**
 * Who the form may offer. The ones that could be grouped today, plus whoever
 * is already in this room: a member whose account broke is still a member, and
 * a checkbox list it silently vanished from would take it out on the next save
 * without anyone deciding to.
 */
function choices(agents: ChatAgent[], group?: GroupView | null): ChatAgent[] {
  const offered = groupableAgents(agents);
  const extra = (group?.members ?? [])
    .filter((id) => !offered.some((a) => a.id === id))
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is ChatAgent => a !== undefined);
  return [...offered, ...extra];
}

function GroupForm({ agents, group, onClose, onCreated, onSaved, onArchived }: {
  agents: ChatAgent[];
  group: GroupView | null;
  onClose: () => void;
  onCreated?: (group: GroupView) => void;
  onSaved?: (group: GroupView) => void;
  onArchived?: (id: string) => void;
}): JSX.Element {
  const editing = group !== null;
  const [name, setName] = useState(group?.name ?? '');
  const [members, setMembers] = useState<string[]>(group?.members ?? []);
  const [coordinator, setCoordinator] = useState<string>(
    group?.coordinator ?? agents.find((a) => a.roles.includes('front-desk'))?.id ?? agents[0]?.id ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = [...new Set([coordinator, ...members])].filter(Boolean);
  const ok = name.trim() !== '' && coordinator !== '' && chosen.length >= 2;

  const toggle = (id: string): void =>
    setMembers((current) => (current.includes(id) ? current.filter((m) => m !== id) : [...current, id]));

  /** One handler: the form is the same, and so is what it sends. */
  const save = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      if (group) onSaved?.(await chatApi.updateGroup(group.id, { name: name.trim(), coordinator, members: chosen }));
      else onCreated?.(await chatApi.createGroup({ name: name.trim(), coordinator, members: chosen.filter((id) => id !== coordinator) }));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (): Promise<void> => {
    if (!group) return;
    setBusy(true);
    setProblem(null);
    try {
      await chatApi.archiveGroup(group.id);
      onArchived?.(group.id);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Sheet title={editing ? `${group.name}: members` : 'A new group'} onClose={onClose}>
      <Stack>
        <Field label="Name" hint="What this team is for: Household finances, The move, Tax season.">
          <input value={name} autoFocus maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Household finances" />
        </Field>
        <Field label="Coordinator" hint="Reads your request, brings members in, and answers for the group. Concierge by default.">
          <select value={coordinator} onChange={(e) => setCoordinator(e.target.value)}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </Field>
        <Field label="Members" hint="Each keeps its own account, tools and approvals. Membership grants nothing.">
          <div className="group-pick" role="group" aria-label="Members">
            {agents.filter((agent) => agent.id !== coordinator).map((agent) => (
              <label key={agent.id} className="group-pick-row" data-on={members.includes(agent.id) || undefined}>
                <input type="checkbox" checked={members.includes(agent.id)} onChange={() => toggle(agent.id)} />
                <AgentAvatar agents={agents} id={agent.id} size="sm" />
                <span className="group-pick-text">
                  <span className="group-pick-name">{agent.name}</span>
                  <span className="group-pick-desc">{agent.description}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <Notice>
          Members read what is said in this group and what they recall from shared and group memory. Nothing an agent knows privately is brought in on its own: what enters the room is seen by the room.
        </Notice>
        {editing ? (
          <Notice>
            Taking a member out leaves everything it already said in the transcript. It simply takes no new turns.
          </Notice>
        ) : null}
        {problem ? <Notice tone="critical">{problem}</Notice> : null}
        <Toolbar align="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!ok || busy} onClick={() => void save()}>
            {busy ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save' : 'Create group'}
          </Button>
        </Toolbar>
        {/*
          Archiving is not part of the form, so it sits below it, quiet, and
          asks once. The sentence is what is actually about to happen — the
          room leaves the rail and stops taking requests; nothing said in it is
          deleted — because "are you sure?" teaches nobody anything.
        */}
        {editing ? (
          <div className="group-archive">
            {confirming ? (
              <Stack>
                <Notice tone="warning">
                  Archive {group.name}? It leaves the rail and takes no new requests. Everything said in it stays readable.
                </Notice>
                <Toolbar align="end">
                  <Button onClick={() => setConfirming(false)}>Keep it</Button>
                  <Button variant="danger" disabled={busy} data-testid="group-archive-confirm" onClick={() => void archive()}>
                    Archive group
                  </Button>
                </Toolbar>
              </Stack>
            ) : (
              <Button variant="ghost" disabled={busy} data-testid="group-archive" onClick={() => setConfirming(true)}>
                Archive group
              </Button>
            )}
          </div>
        ) : null}
      </Stack>
    </Sheet>
  );
}

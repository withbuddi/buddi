/**
 * Making a group: a name, a coordinator, who is in the room, and the one
 * sentence about memory (docs/groups.md).
 *
 * Changing the group afterwards is its room's ⋯ menu (GroupRoom.tsx):
 * Members, Rename, Clear history, Delete. Each of those is one decision with
 * its own surface, rather than this whole form again.
 */
import { useState } from 'react';
import { ApiError, chatApi } from '../api';
import type { ChatAgent, GroupView } from '../chat/types';
import { canGroup, groupableAgents, makerName } from './roster';
import { Button, Field, Notice, Sheet, Stack, Toolbar } from '../ui';
import { AgentAvatar } from '../ui';
import { FRONT_DESK_ROLE } from './roles';

export function GroupSheet({ agents, onClose, onCreated }: {
  agents: ChatAgent[];
  onClose: () => void;
  onCreated?: (group: GroupView) => void;
}): JSX.Element {
  /*
   * Reached by a link, with nobody to group.
   *
   * The rail stops offering this until there are two agents who could be in a
   * room together, but a bookmarked route does not go through the rail. One
   * sentence saying what is missing and where it is fixed — and no form,
   * because a form that can only be filled in wrongly is worse than no form.
   */
  if (!canGroup(agents)) {
    return (
      <Sheet title="A new group" onClose={onClose}>
        <Notice>A group needs two agents. Make another one with {makerName(agents)} first.</Notice>
      </Sheet>
    );
  }
  return <GroupForm agents={groupableAgents(agents)} onClose={onClose} {...(onCreated ? { onCreated } : {})} />;
}

function GroupForm({ agents, onClose, onCreated }: {
  agents: ChatAgent[];
  onClose: () => void;
  onCreated?: (group: GroupView) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [coordinator, setCoordinator] = useState<string>(
    agents.find((a) => a.roles.includes(FRONT_DESK_ROLE))?.id ?? agents[0]?.id ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = [...new Set([coordinator, ...members])].filter(Boolean);
  const ok = name.trim() !== '' && coordinator !== '' && chosen.length >= 2;

  const toggle = (id: string): void =>
    setMembers((current) => (current.includes(id) ? current.filter((m) => m !== id) : [...current, id]));

  const save = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      onCreated?.(await chatApi.createGroup({ name: name.trim(), coordinator, members: chosen.filter((id) => id !== coordinator) }));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="A new group" onClose={onClose}>
      <Stack>
        <Field label="Name" hint="What this team is for: Household finances, The move, Tax season.">
          <input value={name} autoFocus maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Household finances" />
        </Field>
        <Field label="Coordinator" hint="Reads your request, brings members in, and answers for the group. Concierge by default.">
          <select value={coordinator} onChange={(e) => setCoordinator(e.target.value)}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </Field>
        <Field label="Members" hint="The coordinator may ask the room's members in this room's conversations; each member keeps its own account, tools and approvals.">
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
        {problem ? <Notice tone="critical">{problem}</Notice> : null}
        <Toolbar align="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!ok || busy} onClick={() => void save()}>
            {busy ? 'Creating…' : 'Create group'}
          </Button>
        </Toolbar>
      </Stack>
    </Sheet>
  );
}

/**
 * Creating a group: a name, the members, the coordinator, and the one
 * sentence about memory the owner must have read (docs/groups.md).
 */
import { useState } from 'react';
import { ApiError, chatApi } from '../api';
import type { ChatAgent, GroupView } from '../chat/types';
import { Button, Field, Notice, Sheet, Stack, Toolbar } from '../ui';
import { AgentAvatar } from '../ui';

export function GroupSheet({ agents, onClose, onCreated }: {
  agents: ChatAgent[];
  onClose: () => void;
  onCreated: (group: GroupView) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [coordinator, setCoordinator] = useState<string>(agents.find((a) => a.roles.includes('front-desk'))?.id ?? agents[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = [...new Set([coordinator, ...members])].filter(Boolean);
  const ok = name.trim() !== '' && coordinator !== '' && chosen.length >= 2;

  const toggle = (id: string): void =>
    setMembers((current) => (current.includes(id) ? current.filter((m) => m !== id) : [...current, id]));

  const create = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      onCreated(await chatApi.createGroup({ name: name.trim(), coordinator, members: chosen.filter((id) => id !== coordinator) }));
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
        {problem ? <Notice tone="critical">{problem}</Notice> : null}
        <Toolbar align="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!ok || busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create group'}</Button>
        </Toolbar>
      </Stack>
    </Sheet>
  );
}

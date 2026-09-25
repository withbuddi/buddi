/**
 * The agent sheet's Skills tab: the procedures this agent follows.
 *
 * Two kinds, kept apart like the Memory tab keeps preferences and notes. The
 * skills it learned are files it proposed and you kept (docs/specs/learning.md):
 * each shows its version, where it came from, the untrusted mark when a page
 * or a mail was in view as it was proposed, a link back to the proposal, and
 * "Remove". Removing deletes the current file only; every version stays in
 * the folder named under it, and the agent will not propose it again for 90
 * days. The rest (skills you wrote, and the ones a plugin proposed and you
 * accepted) are shown as they are and changed where they were made.
 */
import { useState } from 'react';
import { ApiError, api, type AgentSkillRow } from '../../api';
import { fmtRelative } from '../../format';
import { settingsRoute, transcriptRoute } from '../../routes';
import { Button, Code, Details, Empty, ErrorBanner, Notice, Panel, Pill, Section, Stack, Table, Toolbar, useAsync, EmptyState } from '../../ui';

export function AgentSkills({ agentId, agentName }: { agentId: string; agentName: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.agentSkills(agentId), [agentId], 30_000);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (skill: AgentSkillRow): Promise<void> => {
    setProblem(null);
    setDone(null);
    setBusy(skill.name);
    try {
      const result = await api.removeSkill(agentId, skill.name);
      setDone(`Removed ${result.name}. Its versions are kept, and ${agentName} will not propose it again for 90 days.`);
      reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!data) return error ? <ErrorBanner message={error} /> : <Empty>Loading…</Empty>;
  const learned = data.skills.filter((s) => s.learned !== null);
  const others = data.skills.filter((s) => s.learned === null);

  return (
    <Stack divided>
      <ErrorBanner message={error ?? problem} />
      {done ? <Notice tone="good" role="status">{done}</Notice> : null}
      <Section title="Learned" aside={<span className="muted">what {agentName} proposed and you kept</span>}>
        {learned.length === 0 ? (
          <EmptyState icon="bulb" title="Nothing learned yet">
            {data.writable
              ? `When ${agentName} proposes a procedure and you keep it on Settings → Proposals, it appears here.`
              : `${agentName} ships with buddi, so it keeps no learned skills of its own until it is yours.`}
          </EmptyState>
        ) : (
          <Panel flush>
            <Table>
              <thead>
                <tr><th>Skill</th><th>Version</th><th>Came from</th><th className="num">Kept</th><th /></tr>
              </thead>
              <tbody>
                {learned.map((skill) => (
                  <LearnedRow key={skill.name} skill={skill} busy={busy === skill.name} onRemove={() => void remove(skill)} />
                ))}
              </tbody>
            </Table>
          </Panel>
        )}
      </Section>
      <Section title="From files and plugins" aside={<span className="muted">read-only here</span>}>
        {others.length === 0 ? (
          <Empty>No other skills.</Empty>
        ) : (
          <Panel flush>
            <Table>
              <thead>
                <tr><th>Skill</th><th>What it is for</th><th>Whose</th></tr>
              </thead>
              <tbody>
                {others.map((skill) => (
                  <tr key={`${skill.scope}:${skill.name}`}>
                    <td>
                      <Details summary={<span className="mono">{skill.name}</span>}>
                        <Code>{skill.body}</Code>
                        <p className="muted mono skill-file">{skill.file}</p>
                      </Details>
                    </td>
                    <td>{skill.description}</td>
                    <td>
                      <Stack gap="sm">
                        <Pill>{skill.scope === 'shared' ? 'shared' : `${agentName} only`}</Pill>
                        <span className="muted">{whose(skill)}</span>
                      </Stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        )}
      </Section>
    </Stack>
  );
}

function whose(skill: AgentSkillRow): string {
  if (skill.provenance === 'imported') return skill.source ? `from ${skill.source}` : 'imported';
  if (skill.provenance === 'agent') return 'written by an agent';
  return 'yours';
}

function LearnedRow({ skill, busy, onRemove }: { skill: AgentSkillRow; busy: boolean; onRemove: () => void }): JSX.Element {
  const meta = skill.learned!;
  return (
    <tr>
      <td>
        <Details summary={<span>{meta.title} <span className="muted mono">{skill.name}</span></span>}>
          <p className="muted">When: {skill.description}</p>
          <Code>{skill.body}</Code>
          <p className="muted mono skill-file">
            {skill.file}
            {meta.versions.length > 1 ? ` · earlier versions in ${meta.versionsDir}` : ''}
          </p>
        </Details>
      </td>
      <td>
        <Stack gap="sm">
          <span>v{meta.version}{meta.edited ? ' · your correction' : ''}</span>
          {meta.untrusted ? <Pill tone="warning">untrusted text in view</Pill> : null}
        </Stack>
      </td>
      <td>
        <Stack gap="sm">
          {meta.conversation ? (
            <a href={transcriptRoute(meta.conversation)}>{meta.turn ? `conversation, turn ${meta.turn}` : 'conversation'}</a>
          ) : (
            <span className="muted">no conversation</span>
          )}
          <a href={settingsRoute('proposals')}>the proposal</a>
          {meta.sources.length > 0 ? (
            <ul className="proposal-sources">
              {meta.sources.map((source) => <li key={source} className="mono">{source}</li>)}
            </ul>
          ) : null}
        </Stack>
      </td>
      <td className="num muted" title={meta.keptAt}>{meta.keptAt ? fmtRelative(meta.keptAt, Date.now()) : ''}</td>
      <td className="num">
        <Toolbar align="end">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>Remove</Button>
        </Toolbar>
      </td>
    </tr>
  );
}

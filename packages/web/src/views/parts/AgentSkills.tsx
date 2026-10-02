/**
 * The agent page's Skills tab: the skills this agent uses, from the Skills
 * page's one list (`/api/skills`), with "Choose skills…" — the Skills page's
 * picker the other way round, grouped like the page — and "All skills" into
 * Agents → Skills. A row opens the same sheet the Skills page opens; an
 * untrusted one keeps its Mark as mine. The kit's Skills.jsx (AgentPage).
 */
import { useState } from 'react';
import type { ChatAgent } from '../../chat/types';
import { AppIcon, Button, Empty, ErrorBanner, Icon, List, ListRow, Notice, Panel, useAsync } from '../../ui';
import { SkillOverlays, SkillPickerFor, groupTitle, type SkillDialog } from '../Skills';
import { originLine, skillsApi, skillsRoute, untrustedLine, type SkillRow } from './skills-data';

export function AgentSkills({
  agentId,
  agentName,
  faces = [],
  navigate,
}: {
  agentId: string;
  agentName: string;
  faces?: readonly ChatAgent[];
  navigate: (route: string) => void;
}): JSX.Element {
  const view = useAsync(() => skillsApi.list(), [agentId]);
  const [open, setOpen] = useState<{ id: string; edit?: boolean } | null>(null);
  const [dialog, setDialog] = useState<SkillDialog>(null);
  const [choosing, setChoosing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const changed = (note?: string): void => {
    setFailure(null);
    setDone(note ?? null);
    view.reload();
  };
  const trust = (row: SkillRow): void => {
    skillsApi.trust(row.id).then(() => changed(), (err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
  };

  if (!view.data) {
    return view.error ? (
      <Empty warm title="Couldn’t load the skills" action={<Button variant="accent" size="sm" onClick={view.reload}>Try again</Button>}>
        buddi didn’t answer. The skill files are untouched.
      </Empty>
    ) : (
      <Empty>Loading…</Empty>
    );
  }
  const data = view.data;
  const agent = data.agents.find((a) => a.id === agentId) ?? { id: agentId, handle: agentId, name: agentName, writable: false };
  const mine = data.skills.filter((s) => s.every || s.holders.some((h) => h.agent === agentId));
  const allSkills = skillsRoute();

  return (
    <>
      <ErrorBanner message={failure} />
      {done ? <Notice tone="good" role="status">{done}</Notice> : null}
      <Panel
        flush
        title="Skills"
        actions={
          <>
            <a className="skills-all" href={allSkills} onClick={(e) => { e.preventDefault(); navigate(allSkills); }}>
              All skills
              <Icon name="chevron-right" size={12} />
            </a>
            <Button size="sm" onClick={() => setChoosing(true)}>Choose skills…</Button>
          </>
        }
      >
        {mine.length ? (
          <div className="skills-group">
            <List>
              {mine.map((row) => (
                <ListRow
                  key={row.id}
                  onClick={() => setOpen({ id: row.id })}
                  label={`${row.title}: details`}
                  lead={<AppIcon icon="files" />}
                  title={row.title}
                  sub={
                    <>
                      <span className="skills-line">{row.description}</span>
                      <span className="skills-line skills-meta">{groupTitle(row)} · {row.every ? 'every agent uses it' : originLine(row, data.agents, true)}</span>
                      {row.untrusted ? <span className="skills-status" data-tone="warning">{untrustedLine(row, data.agents)}</span> : null}
                    </>
                  }
                  side={
                    <span className="skills-side">
                      {row.untrusted ? (
                        <Button size="sm" onClick={(e) => { e.stopPropagation(); trust(row); }}>Mark as mine</Button>
                      ) : (
                        <span className="skills-chevron" aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
                      )}
                    </span>
                  }
                />
              ))}
            </List>
          </div>
        ) : (
          <Empty>{agentName} uses no skills yet. Choose some, or write one on the Skills page.</Empty>
        )}
      </Panel>
      <SkillOverlays
        view={data}
        faces={faces}
        open={open}
        setOpen={setOpen}
        dialog={dialog}
        setDialog={setDialog}
        navigate={navigate}
        onChanged={changed}
        onFailed={setFailure}
      />
      {choosing ? (
        <SkillPickerFor agent={agent} view={data} onCancel={() => setChoosing(false)} onSaved={() => { setChoosing(false); changed(); }} />
      ) : null}
    </>
  );
}

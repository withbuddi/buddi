/**
 * The agent page's Skills tab: the skills this agent uses from the one
 * Skills list, All skills into Agents → Skills, Choose skills… writing a
 * grant per changed skill, a row opening the shared sheet, and Mark as mine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { skillsApi, type SkillRow, type SkillsView } from './parts/skills-data';
import { AgentSkills } from './parts/AgentSkills';

vi.mock('./parts/skills-data', async (importOriginal) => {
  const original = await importOriginal<typeof import('./parts/skills-data')>();
  return {
    ...original,
    skillsApi: { ...original.skillsApi, list: vi.fn(), detail: vi.fn(), grant: vi.fn(), trust: vi.fn() },
  };
});

const row = (over: Partial<SkillRow> & Pick<SkillRow, 'id' | 'title' | 'group' | 'holders'>): SkillRow => ({
  name: over.id,
  description: `When ${over.title}.`,
  file: `/owner/skills/${over.id}.md`,
  home: null,
  every: false,
  untrusted: null,
  provenance: 'owner',
  source: null,
  created: null,
  updatedAt: null,
  learned: null,
  from: null,
  editable: true,
  deletable: true,
  shareable: true,
  ...over,
});

const VOICE = row({ id: 'my-voice', title: 'Write in my voice', group: 'mine', every: true, holders: [{ agent: 'dev', how: 'every' }, { agent: 'ledger', how: 'every' }] });
const OPEN = row({
  id: 'dev/open-project',
  title: 'Open a project',
  group: 'learned',
  home: 'dev',
  shareable: false,
  holders: [{ agent: 'dev', how: 'home' }],
  untrusted: 'page',
  learned: { by: 'dev', version: 1, edited: false, keptAt: new Date().toISOString() },
});
const RECAP = row({ id: 'weekly-recap', title: 'Weekly money recap', group: 'mine', holders: [{ agent: 'ledger', how: 'granted' }] });
const VIEW: SkillsView = {
  skills: [VOICE, OPEN, RECAP],
  agents: [
    { id: 'dev', handle: 'dev', name: 'Dev', writable: true },
    { id: 'ledger', handle: 'ledger', name: 'Ledger', writable: true },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(skillsApi.list).mockResolvedValue(VIEW);
  vi.mocked(skillsApi.grant).mockResolvedValue({ skill: RECAP });
  vi.mocked(skillsApi.trust).mockResolvedValue({ skill: OPEN });
  vi.mocked(skillsApi.detail).mockImplementation(async (id) => {
    const skill = VIEW.skills.find((s) => s.id === id)!;
    return { skill, body: '# x', text: '# x', onDelete: { stops: [], every: false, then: 'trash' } };
  });
});

const show = async () => {
  const navigate = vi.fn();
  render(<AgentSkills agentId="dev" agentName="Dev" navigate={navigate} />);
  await screen.findByText('Open a project');
  return navigate;
};

describe('the agent page’s Skills', { timeout: 180_000 }, () => {
  it('lists the skills this agent uses, with where each sits', async () => {
    await show();
    expect(screen.getByText('Write in my voice')).toBeInTheDocument();
    expect(screen.getByText('Yours · every agent uses it')).toBeInTheDocument();
    expect(screen.getByText(/^Learned · v1 · kept/)).toBeInTheDocument();
    expect(screen.queryByText('Weekly money recap')).not.toBeInTheDocument();
  });

  it('links to every skill on the Skills page', async () => {
    const navigate = await show();
    const link = screen.getByRole('link', { name: 'All skills' });
    expect(link).toHaveAttribute('href', '#/agents?tab=skills');
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('#/agents?tab=skills');
  });

  it('marks an untrusted skill as mine from its row', async () => {
    await show();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark as mine' })); });
    expect(skillsApi.trust).toHaveBeenCalledWith('dev/open-project');
  });

  it('opens the shared sheet from a row', async () => {
    await show();
    fireEvent.click(screen.getByLabelText('Open a project: details'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('When it’s used');
  });

  it('chooses skills: one every agent uses and its own are fixed, a change is one grant', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Choose skills…' }));
    const picker = await screen.findByRole('alertdialog');
    expect(within(picker).getByRole('checkbox', { name: /Write in my voice/ })).toBeDisabled();
    expect(within(picker).getByRole('checkbox', { name: /Open a project/ })).toBeDisabled();
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Weekly money recap/ }));
    await act(async () => { fireEvent.click(within(picker).getByRole('button', { name: 'Save' })); });
    expect(skillsApi.grant).toHaveBeenCalledTimes(1);
    expect(skillsApi.grant).toHaveBeenCalledWith('weekly-recap', { agents: ['ledger', 'dev'] });
  });

  it('says so when the agent uses no skills', async () => {
    vi.mocked(skillsApi.list).mockResolvedValue({ ...VIEW, skills: [RECAP] });
    render(<AgentSkills agentId="dev" agentName="Dev" navigate={vi.fn()} />);
    expect(await screen.findByText('Dev uses no skills yet. Choose some, or write one on the Skills page.')).toBeInTheDocument();
  });
});

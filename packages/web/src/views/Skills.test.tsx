/**
 * Agents → Skills: the groups and their rows in words, loading / error /
 * empty, the untrusted line with Mark as mine, an unused skill's Choose
 * agents, the sheet (Take away, Read · Source, edit in place, Download,
 * Delete asked once with what it does), the agent picker, Write a skill and
 * Upload a .md with the untrusted default, and each write it leads to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../api';
import { downloadSkill, skillsApi, type SkillRow, type SkillsView } from './parts/skills-data';
import { SkillsTab, type SkillsCommand } from './Skills';

vi.mock('./parts/skills-data', async (importOriginal) => {
  const original = await importOriginal<typeof import('./parts/skills-data')>();
  return {
    ...original,
    downloadSkill: vi.fn(),
    skillsApi: {
      ...original.skillsApi,
      list: vi.fn(),
      detail: vi.fn(),
      create: vi.fn(),
      saveText: vi.fn(),
      grant: vi.fn(),
      trust: vi.fn(),
      remove: vi.fn(),
    },
  };
});

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
const base = {
  provenance: 'owner',
  source: null,
  created: null,
  updatedAt: ago(20),
  learned: null,
  from: null,
  editable: true,
  deletable: true,
  shareable: true,
  home: null,
  every: false,
  untrusted: null,
} as const;

const RECAP: SkillRow = {
  ...base,
  id: 'weekly-recap',
  name: 'weekly-recap',
  group: 'mine',
  title: 'Weekly money recap',
  description: 'When I ask about the week’s spending.',
  file: '/owner/skills/weekly-recap.md',
  holders: [{ agent: 'ledger', how: 'granted' }, { agent: 'scout', how: 'granted' }],
  created: '2026-09-12',
  updatedAt: '2026-09-12T10:00:00Z',
};
const PACKING: SkillRow = {
  ...base,
  id: 'packing-list',
  name: 'packing-list',
  group: 'mine',
  title: 'Trip packing list',
  description: 'When I’m getting ready for a trip.',
  file: '/owner/skills/packing-list.md',
  holders: [],
  untrusted: 'upload',
  from: { kind: 'upload', filename: 'packing-list.md' },
};
const LEARNED: SkillRow = {
  ...base,
  id: 'dev/open-project',
  name: 'open-project',
  group: 'learned',
  title: 'Open a project',
  description: 'When I ask to open one of my repos.',
  file: '/owner/agents/dev/skills/open-project.md',
  home: 'dev',
  shareable: false,
  holders: [{ agent: 'dev', how: 'home' }],
  untrusted: 'page',
  learned: { by: 'dev', version: 2, edited: true, keptAt: ago(3) },
};
const PLUGIN: SkillRow = {
  ...base,
  id: 'triage',
  name: 'triage',
  group: 'plugin',
  title: 'Triage a new message',
  description: 'When a new message arrives.',
  file: '/owner/skills/triage.md',
  holders: [{ agent: 'postie', how: 'granted' }],
  editable: false,
  deletable: false,
  from: { kind: 'plugin', plugin: 'mail', version: '0.1.3', installed: true },
};

const AGENTS = [
  { id: 'ledger', handle: 'ledger', name: 'Ledger', writable: true },
  { id: 'scout', handle: 'scout', name: 'Scout', writable: true },
  { id: 'dev', handle: 'dev', name: 'Dev', writable: true },
  { id: 'postie', handle: 'postie', name: 'Postie', writable: true },
  { id: 'buddi', handle: 'buddi', name: 'Buddi', writable: false },
];
const VIEW: SkillsView = { skills: [RECAP, PACKING, LEARNED, PLUGIN], agents: AGENTS };

const detailOf = (row: SkillRow) => ({
  skill: row,
  body: `# ${row.title}\n\n1. First step.`,
  text: `---\nname: ${row.name}\ndescription: ${row.description}\n---\n\n# ${row.title}\n\n1. First step.`,
  onDelete: {
    stops: row.holders.map((h) => h.agent),
    every: row.every,
    then: row.group === 'learned' ? ('versions-kept' as const) : ('trash' as const),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(skillsApi.list).mockResolvedValue(VIEW);
  vi.mocked(skillsApi.detail).mockImplementation(async (id) => detailOf(VIEW.skills.find((s) => s.id === id)!));
  vi.mocked(skillsApi.grant).mockResolvedValue({ skill: RECAP });
  vi.mocked(skillsApi.trust).mockResolvedValue({ skill: PACKING });
  vi.mocked(skillsApi.saveText).mockResolvedValue({ skill: RECAP });
  vi.mocked(skillsApi.create).mockResolvedValue({ skill: { ...PACKING, title: 'New one' } });
  vi.mocked(skillsApi.remove).mockResolvedValue({ deleted: 'weekly-recap', stopped: ['ledger'], movedTo: '/trash/x.md' });
});

const show = async (props: { openSkill?: string; command?: SkillsCommand } = {}) => {
  const navigate = vi.fn();
  const view = render(<SkillsTab faces={[]} navigate={navigate} {...props} />);
  if (props.openSkill) await screen.findByRole('dialog');
  else await waitFor(() => expect(screen.queryByLabelText('Loading skills')).not.toBeInTheDocument());
  return { navigate, ...view };
};

const sheet = (): HTMLElement => screen.getByRole('dialog');

describe('the list', { timeout: 180_000 }, () => {
  it('draws quiet rows while loading', async () => {
    vi.mocked(skillsApi.list).mockReturnValue(new Promise(() => {}));
    render(<SkillsTab faces={[]} navigate={vi.fn()} />);
    expect(screen.getByLabelText('Loading skills')).toHaveAttribute('aria-busy', 'true');
  });

  it('offers Try again when buddi does not answer', async () => {
    vi.mocked(skillsApi.list).mockRejectedValueOnce(new ApiError(0, 'buddi isn’t answering.'));
    render(<SkillsTab faces={[]} navigate={vi.fn()} />);
    expect(await screen.findByText('Couldn’t load your skills')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Weekly money recap')).toBeInTheDocument();
    expect(skillsApi.list).toHaveBeenCalledTimes(2);
  });

  it('says so when there are no skills', async () => {
    vi.mocked(skillsApi.list).mockResolvedValue({ skills: [], agents: AGENTS });
    await show();
    expect(screen.getByText('No skills yet')).toBeInTheDocument();
  });

  it('groups the rows and leaves an empty group out', async () => {
    await show();
    expect(screen.getByRole('region', { name: 'Yours' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Learned' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'From plugins' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'From the catalogue' })).not.toBeInTheDocument();
    const yours = screen.getByRole('region', { name: 'Yours' });
    expect(within(yours).getByText(/^Ledger and Scout · written by you on/)).toBeInTheDocument();
    expect(within(yours).getByText('No agent uses it yet · uploaded · packing-list.md')).toBeInTheDocument();
    const learned = screen.getByRole('region', { name: 'Learned' });
    expect(within(learned).getByText('Dev · v2 with your correction · kept 3 days ago')).toBeInTheDocument();
    expect(within(learned).getByText('Untrusted: a web page was in view when Dev proposed it.')).toBeInTheDocument();
    expect(screen.getByText('Postie · from Mail 0.1.3')).toBeInTheDocument();
  });

  it('marks an uploaded skill as mine from its row', async () => {
    await show();
    expect(screen.getByText('Untrusted: it came from a file, so agents read it as outside text.')).toBeInTheDocument();
    const row = screen.getByLabelText('Trip packing list: details');
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Mark as mine' })); });
    expect(skillsApi.trust).toHaveBeenCalledWith('packing-list');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the picker from an unused skill’s Choose agents', async () => {
    const unused = { ...PACKING, untrusted: null, id: 'unused', title: 'Unused' };
    vi.mocked(skillsApi.list).mockResolvedValue({ skills: [unused], agents: AGENTS });
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Choose agents' }));
    expect(await screen.findByText('Who uses “Unused”?')).toBeInTheDocument();
  });

  it('offers Delete in the row’s menu, and not for a plugin’s', async () => {
    await show();
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    await user.click(screen.getByLabelText('More for Triage a new message'));
    expect(await screen.findByRole('menuitem', { name: 'Open Mail' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Edit text' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByLabelText('More for Weekly money recap'));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    expect(await screen.findByText('Delete “Weekly money recap”?')).toBeInTheDocument();
  });
});

describe('the sheet', { timeout: 180_000 }, () => {
  it('says when it is used, who uses it, and takes it away from one agent', async () => {
    await show({ openSkill: 'weekly-recap' });
    expect(within(sheet()).getByText(/^Written by you on/)).toBeInTheDocument();
    expect(within(sheet()).getByText('When I ask about the week’s spending.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(sheet()).getByRole('button', { name: 'Take away from Scout' })); });
    expect(skillsApi.grant).toHaveBeenCalledWith('weekly-recap', { agents: ['ledger'] });
  });

  it('keeps the agent whose folder holds it: no Take away there', async () => {
    await show({ openSkill: 'dev/open-project' });
    expect(within(sheet()).getByText('Proposed it')).toBeInTheDocument();
    expect(within(sheet()).queryByRole('button', { name: /Take away/ })).not.toBeInTheDocument();
  });

  it('shows the text read, and as the file is written', async () => {
    await show({ openSkill: 'weekly-recap' });
    expect(await within(sheet()).findByText('First step.')).toBeInTheDocument();
    expect(within(sheet()).getByText('skills/weekly-recap.md')).toBeInTheDocument();
    fireEvent.click(within(sheet()).getByRole('radio', { name: 'Source' }));
    expect(within(sheet()).getByText(/name: weekly-recap/)).toBeInTheDocument();
  });

  it('edits the text in place and saves the whole file', async () => {
    await show({ openSkill: 'dev/open-project' });
    await within(sheet()).findByText('First step.');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Edit text' }));
    const editor = within(sheet()).getByLabelText('Text of Open a project');
    expect(within(sheet()).getByText('Saved as v3, your correction. v2 stays in Dev’s folder.')).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: '---\nname: open-project\ndescription: x\n---\n\nNew text.' } });
    await act(async () => { fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' })); });
    expect(skillsApi.saveText).toHaveBeenCalledWith('dev/open-project', '---\nname: open-project\ndescription: x\n---\n\nNew text.');
    expect(within(sheet()).queryByLabelText('Text of Open a project')).not.toBeInTheDocument();
  });

  it('marks an untrusted skill as mine from the notice', async () => {
    await show({ openSkill: 'dev/open-project' });
    await act(async () => { fireEvent.click(within(sheet()).getByRole('button', { name: 'Mark as mine' })); });
    expect(skillsApi.trust).toHaveBeenCalledWith('dev/open-project');
  });

  it('downloads the file', async () => {
    await show({ openSkill: 'weekly-recap' });
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Download' }));
    expect(downloadSkill).toHaveBeenCalledWith('weekly-recap');
  });

  it('reads only for a plugin’s skill', async () => {
    await show({ openSkill: 'triage' });
    expect(within(sheet()).queryByRole('button', { name: 'Edit text' })).not.toBeInTheDocument();
    expect(within(sheet()).queryByRole('button', { name: 'Delete…' })).not.toBeInTheDocument();
    expect(within(sheet()).getByText(/Comes with Mail, so it’s changed there/)).toBeInTheDocument();
  });

  it('asks once before deleting, naming who stops and where the file goes', async () => {
    await show({ openSkill: 'weekly-recap' });
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Delete…' }));
    expect(await screen.findByText('Ledger and Scout stop using it. The file goes to the trash folder.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    expect(skillsApi.remove).toHaveBeenCalledWith('weekly-recap');
    expect(await screen.findByText('Deleted “Weekly money recap”. The file is in the trash folder.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says what deleting a learned skill keeps', async () => {
    await show({ openSkill: 'dev/open-project' });
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Delete…' }));
    expect(await screen.findByText('Dev stops using it and won’t propose it again for 90 days. Earlier versions stay in its folder.')).toBeInTheDocument();
  });
});

describe('the agent picker', { timeout: 180_000 }, () => {
  const openPicker = async () => {
    await show({ openSkill: 'weekly-recap' });
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Change…' }));
    return screen.findByRole('alertdialog');
  };

  it('saves the agents ticked', async () => {
    const picker = await openPicker();
    expect(within(picker).getByRole('checkbox', { name: /Ledger/ })).toBeChecked();
    expect(within(picker).getByRole('checkbox', { name: /Buddi/ })).toBeDisabled();
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Dev/ }));
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Scout/ }));
    await act(async () => { fireEvent.click(within(picker).getByRole('button', { name: 'Save' })); });
    expect(skillsApi.grant).toHaveBeenCalledWith('weekly-recap', { agents: ['ledger', 'dev'] });
  });

  it('gives it to every agent', async () => {
    const picker = await openPicker();
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Every agent/ }));
    await act(async () => { fireEvent.click(within(picker).getByRole('button', { name: 'Save' })); });
    expect(skillsApi.grant).toHaveBeenCalledWith('weekly-recap', { every: true, agents: [] });
  });

  it('finds an agent by name', async () => {
    const picker = await openPicker();
    fireEvent.change(within(picker).getByRole('searchbox', { name: 'Find an agent' }), { target: { value: 'zz' } });
    expect(within(picker).getByText('No agent called “zz”.')).toBeInTheDocument();
  });

  it('shows the gateway’s refusal and stays open', async () => {
    vi.mocked(skillsApi.grant).mockRejectedValueOnce(new ApiError(409, 'Dev already has a skill called "weekly-recap"; one name, one procedure.'));
    const picker = await openPicker();
    await act(async () => { fireEvent.click(within(picker).getByRole('button', { name: 'Save' })); });
    expect(within(picker).getByText(/one name, one procedure/)).toBeInTheDocument();
  });

  it('offers no Every agent for a skill in an agent’s folder', async () => {
    await show({ openSkill: 'dev/open-project' });
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Change…' }));
    const picker = await screen.findByRole('alertdialog');
    expect(within(picker).queryByRole('checkbox', { name: /Every agent/ })).not.toBeInTheDocument();
    expect(within(picker).getByRole('checkbox', { name: /Dev/ })).toBeDisabled();
  });
});

describe('write and upload', { timeout: 180_000 }, () => {
  it('writes a skill from the page head’s command', async () => {
    await show({ command: { kind: 'write', at: 1 } });
    const form = await screen.findByRole('dialog');
    const save = within(form).getByRole('button', { name: 'Save skill' });
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Weekly recap' } });
    fireEvent.change(within(form).getByLabelText('When it’s used'), { target: { value: 'On Fridays' } });
    fireEvent.change(within(form).getByLabelText('The text'), { target: { value: '1. Sum it up.' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: /Ledger/ }));
    await act(async () => { fireEvent.click(save); });
    expect(skillsApi.create).toHaveBeenCalledWith({ title: 'Weekly recap', description: 'On Fridays', body: '1. Sum it up.', agents: ['ledger'] });
    expect(await screen.findByText('Saved “New one”.')).toBeInTheDocument();
  });

  it('says a file that is not .md is not a skill', async () => {
    await show();
    const input = screen.getByTestId('skill-file');
    fireEvent.change(input, { target: { files: [new File(['x'], 'cover.pdf', { type: 'application/pdf' })] } });
    expect(screen.getByText('“cover.pdf” isn’t a .md file. A skill is one Markdown file.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pick another file' })).toBeInTheDocument();
  });

  it('reads an uploaded .md into the form, untrusted unless marked as mine', async () => {
    await show();
    const text = '---\nname: packing-list\ndescription: When I travel.\n---\n\n# Trip packing list\n\nAsk where.';
    const file = new File([text], 'packing-list.md', { type: 'text/markdown' });
    await act(async () => { fireEvent.change(screen.getByTestId('skill-file'), { target: { files: [file] } }); });
    const form = await screen.findByRole('dialog');
    expect(within(form).getByLabelText('Name')).toHaveValue('Trip packing list');
    expect(within(form).getByLabelText('When it’s used')).toHaveValue('When I travel.');
    expect(within(form).getByRole('checkbox', { name: /Mark as mine/ })).not.toBeChecked();
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save skill' })); });
    expect(skillsApi.create).toHaveBeenCalledWith({
      title: 'Trip packing list',
      description: 'When I travel.',
      body: '# Trip packing list\n\nAsk where.',
      agents: [],
      upload: { filename: 'packing-list.md', mine: false },
    });
  });
});

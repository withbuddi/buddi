/**
 * Skills, part 2 — bundles, as the kit's SkillBundles.jsx draws them: rows
 * with BUNDLE and the scripts line, the bundle's sheet (who can run its
 * scripts, the tree with a viewer, a script's note, Edit SKILL.md only,
 * Download .zip), a card's Show the script opening that script, the picker's
 * two groups, the upload sheet (drop zone, the refusals in place) and the
 * preview with Add the skill; and the script-run card in chat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalRow } from '../api';
import { SkillRunDock, skillRunOf } from '../chat/SkillRunDock';
import { BundleRefused, skillsApi, type SkillRow, type SkillsView, type StagedBundle } from './parts/skills-data';
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
      grant: vi.fn(),
      trust: vi.fn(),
      saveText: vi.fn(),
      file: vi.fn(),
      uploadBundle: vi.fn(),
      stagedFile: vi.fn(),
      acceptBundle: vi.fn(),
      discardBundle: vi.fn(),
    },
  };
});

const base = {
  provenance: 'imported', source: 'upload/cover-art-kit.zip', created: '2026-10-03', updatedAt: '2026-10-03T10:00:00Z', learned: null,
  editable: true, deletable: true, shareable: true, home: null, every: false, group: 'mine',
} as const;

const COVER: SkillRow = {
  ...base,
  id: 'cover-art-kit', name: 'cover-art-kit', title: 'Cover art kit',
  description: 'When I ask for a cover, a poster or album art with a title on it.',
  file: '/owner/skills/cover-art-kit/SKILL.md',
  holders: [{ agent: 'dev', how: 'granted' }, { agent: 'scout', how: 'granted' }],
  untrusted: 'upload', from: { kind: 'upload', filename: 'cover-art-kit.zip' },
  bundle: { files: 6, scripts: ['scripts/fit_title.py', 'scripts/make_cover.py', 'scripts/setup.sh'], size: 413 * 1024 },
};
const LETTERHEAD: SkillRow = {
  ...base,
  id: 'letterhead', name: 'letterhead', title: 'Letterhead', provenance: 'owner',
  description: 'When writing a letter, an invoice or any document I’ll send or print under my name.',
  file: '/owner/skills/letterhead/SKILL.md', created: '2026-09-18',
  holders: [{ agent: 'postie', how: 'granted' }, { agent: 'ledger', how: 'granted' }],
  untrusted: null, from: { kind: 'upload', filename: 'letterhead.zip' },
  bundle: { files: 2, scripts: [], size: 9 * 1024 },
};

const AGENTS = [
  { id: 'dev', handle: 'dev', name: 'Dev', writable: true, canRunScripts: true },
  { id: 'scout', handle: 'scout', name: 'Scout', writable: true, canRunScripts: false },
  { id: 'postie', handle: 'postie', name: 'Postie', writable: true, canRunScripts: false },
  { id: 'ledger', handle: 'ledger', name: 'Ledger', writable: true, canRunScripts: false },
];
const VIEW: SkillsView = { skills: [COVER, LETTERHEAD], agents: AGENTS };

const COVER_FILES = [
  { path: 'SKILL.md', size: 2048, kind: 'skill' as const },
  { path: 'assets/fonts/Fraunces-Bold.ttf', size: 214 * 1024, kind: 'font' as const },
  { path: 'assets/logo.png', size: 7 * 1024, kind: 'image' as const },
  { path: 'assets/palette.json', size: 1024, kind: 'data' as const },
  { path: 'scripts/fit_title.py', size: 3 * 1024, kind: 'script' as const },
  { path: 'scripts/make_cover.py', size: 6 * 1024, kind: 'script' as const },
  { path: 'scripts/setup.sh', size: 1024, kind: 'script' as const, setup: true },
];

const detailOf = (row: SkillRow) => ({
  skill: row,
  body: `# ${row.title}\n\n1. Run \`scripts/make_cover.py\`.`,
  text: `---\nname: ${row.name}\ndescription: ${row.description}\n---\n\n# ${row.title}\n\n1. Run \`scripts/make_cover.py\`.`,
  bundle: row.id === 'cover-art-kit'
    ? { files: COVER_FILES, size: 413 * 1024, scripts: COVER.bundle!.scripts }
    : { files: [{ path: 'SKILL.md', size: 1024, kind: 'skill' as const }, { path: 'assets/letterhead.md', size: 1024, kind: 'template' as const }, { path: 'assets/logo.svg', size: 7 * 1024, kind: 'image' as const }], size: 9 * 1024, scripts: [] },
  onDelete: { stops: row.holders.map((h) => h.agent), every: false, then: 'trash' as const },
});

const STAGED: StagedBundle = {
  id: '6f1c2b0e-0000-4000-8000-000000000000', filename: 'cover-art-kit.zip', packed: 388 * 1024, size: 413 * 1024,
  files: COVER_FILES, scripts: COVER.bundle!.scripts,
  skill: { name: 'cover-art-kit', title: 'Cover art kit', description: COVER.description, firstLines: 'Make a square cover with the title set in the kit’s fonts.' },
  createdAt: '2026-10-03T10:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(skillsApi.list).mockResolvedValue(VIEW);
  vi.mocked(skillsApi.detail).mockImplementation(async (id) => detailOf(VIEW.skills.find((s) => s.id === id)!));
  vi.mocked(skillsApi.file).mockImplementation(async (_id, path) => ({
    file: { ...(COVER_FILES.find((f) => f.path === path) ?? { path, size: 1, kind: 'other' as const }), ...(path.endsWith('.png') ? { binary: true, image: true } : path.endsWith('.ttf') ? { binary: true } : { text: `# ${path}\nprint("x")` }) },
  }));
  vi.mocked(skillsApi.stagedFile).mockImplementation(async (_id, path) => ({ file: { ...(COVER_FILES.find((f) => f.path === path)!), text: path === 'SKILL.md' ? '---\nname: cover-art-kit\n---\n\n# Cover art kit' : '#!/bin/sh\npip install pillow' } }));
  vi.mocked(skillsApi.acceptBundle).mockResolvedValue({ skill: COVER });
  vi.mocked(skillsApi.discardBundle).mockResolvedValue({ discarded: STAGED.id });
  vi.mocked(skillsApi.grant).mockResolvedValue({ skill: COVER });
});

const show = async (props: { openSkill?: string; openFile?: string; command?: SkillsCommand } = {}) => {
  const view = render(<SkillsTab faces={[]} navigate={vi.fn()} {...props} />);
  if (props.openSkill) await screen.findByRole('dialog');
  else await waitFor(() => expect(screen.queryByLabelText('Loading skills')).not.toBeInTheDocument());
  return view;
};

describe('bundle rows', { timeout: 180_000 }, () => {
  it('says BUNDLE, who can run its scripts, and that an untrusted one’s cannot run', async () => {
    await show();
    const cover = screen.getByLabelText('Cover art kit: details');
    expect(within(cover).getByText('bundle')).toBeInTheDocument();
    expect(within(cover).getByText('3 scripts · they can’t run until you mark it as yours')).toBeInTheDocument();
    expect(within(cover).getByText('Untrusted: it came in a .zip, so agents read its text as outside text and its scripts can’t run.')).toBeInTheDocument();
    const letter = screen.getByLabelText('Letterhead: details');
    expect(within(letter).getByText('No scripts · 2 files beside the text')).toBeInTheDocument();
  });

  it('names who can run them once it is marked as mine', async () => {
    vi.mocked(skillsApi.list).mockResolvedValue({ ...VIEW, skills: [{ ...COVER, untrusted: null }, LETTERHEAD] });
    await show();
    expect(screen.getByText('3 scripts · Dev can run them, asking first; Scout reads the text only')).toBeInTheDocument();
  });
});

describe('the bundle’s sheet', { timeout: 180_000 }, () => {
  it('shows who can run its scripts, the tree, SKILL.md read, Download .zip and Edit SKILL.md', async () => {
    await show({ openSkill: 'cover-art-kit' });
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText(/^Bundle · 7 files · 413 KB · uploaded/)).toBeInTheDocument();
    expect(within(sheet).getByText(/Mark it as yours once you’ve read it and its scripts\./)).toBeInTheDocument();
    expect(within(sheet).getByText('Its scripts can’t run until you mark it as yours. Then they run only when an agent you allow runs them, and ask first. Nothing ran when it was uploaded.')).toBeInTheDocument();
    expect(within(sheet).getByText(/Can run its scripts with/)).toBeInTheDocument();
    expect(within(sheet).getByText('Reads the text only: it has no tool that runs scripts')).toBeInTheDocument();
    const tree = await within(sheet).findByRole('listbox', { name: 'Files in the bundle' });
    expect(within(tree).getByRole('option', { name: /SKILL\.md/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(tree).getByText('setup')).toBeInTheDocument();
    expect(within(sheet).getByText('skills/cover-art-kit/SKILL.md')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Download .zip' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Edit SKILL.md' })).toBeInTheDocument();
  });

  it('reads a script with its note, a picture drawn, a font as its size', async () => {
    await show({ openSkill: 'cover-art-kit' });
    const sheet = screen.getByRole('dialog');
    const tree = await within(sheet).findByRole('listbox', { name: 'Files in the bundle' });
    fireEvent.click(within(tree).getByRole('option', { name: /make_cover\.py/ }));
    expect(await within(sheet).findByText(/print\("x"\)/)).toBeInTheDocument();
    expect(within(sheet).getByText(/It can’t run until you mark the bundle as yours/)).toBeInTheDocument();
    fireEvent.click(within(tree).getByRole('option', { name: /logo\.png/ }));
    expect(await within(sheet).findByRole('img', { name: 'assets/logo.png' })).toBeInTheDocument();
    fireEvent.click(within(tree).getByRole('option', { name: /Fraunces/ }));
    expect(await within(sheet).findByText(/A font\./)).toBeInTheDocument();
  });

  it('opens the script a card asked about', async () => {
    vi.mocked(skillsApi.list).mockResolvedValue({ ...VIEW, skills: [{ ...COVER, untrusted: null }, LETTERHEAD] });
    await show({ openSkill: 'cover-art-kit', openFile: 'scripts/make_cover.py' });
    const sheet = screen.getByRole('dialog');
    const tree = await within(sheet).findByRole('listbox', { name: 'Files in the bundle' });
    expect(within(tree).getByRole('option', { name: /make_cover\.py/ })).toHaveAttribute('aria-selected', 'true');
    expect(await within(sheet).findByText(/It runs only when Dev runs it with host\.exec, and asks you first\./)).toBeInTheDocument();
  });

  it('edits SKILL.md only, holding the tree still', async () => {
    vi.mocked(skillsApi.saveText).mockResolvedValue({ skill: COVER });
    await show({ openSkill: 'cover-art-kit' });
    const sheet = screen.getByRole('dialog');
    await within(sheet).findByRole('listbox', { name: 'Files in the bundle' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Edit SKILL.md' }));
    expect(within(sheet).queryByRole('listbox', { name: 'Files in the bundle' })).not.toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText('Text of Cover art kit'), { target: { value: '---\nname: cover-art-kit\n---\n\nNew.' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save SKILL.md' }));
    await waitFor(() => expect(skillsApi.saveText).toHaveBeenCalledWith('cover-art-kit', '---\nname: cover-art-kit\n---\n\nNew.'));
  });
});

describe('the picker', { timeout: 180_000 }, () => {
  it('groups agents by whether they can run its scripts', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    await show();
    await user.click(screen.getByRole('button', { name: 'More for Cover art kit' }));
    await user.click(await screen.findByRole('menuitem', { name: /Choose agents/ }));
    await screen.findByText('Who uses “Cover art kit”?');
    const dialog = document.body;
    expect(within(dialog).getByText(/3 scripts come with it\. Only an agent with a tool that runs commands can run them/)).toBeInTheDocument();
    const run = within(dialog).getByRole('group', { name: 'Can run its scripts' });
    expect(within(run).getByText('Dev')).toBeInTheDocument();
    const text = within(dialog).getByRole('group', { name: 'Text only' });
    expect(within(text).getByText('Scout')).toBeInTheDocument();
    expect(within(text).queryByText('Dev')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Now and later. Scripts still ask each time.')).toBeInTheDocument();
  });
});

describe('upload', { timeout: 180_000 }, () => {
  const openDrop = async () => {
    await show({ command: { kind: 'upload', at: 1 } });
    return screen.findByRole('dialog', { name: 'Upload a skill' });
  };
  const choose = async (file: File) => {
    await act(async () => { fireEvent.change(screen.getByTestId('skill-drop-file'), { target: { files: [file] } }); });
  };

  it('opens the drop zone from the page head, with the limits and what a bundle looks like', async () => {
    const sheet = await openDrop();
    expect(within(sheet).getByText('Drop a .zip or a .md here')).toBeInTheDocument();
    expect(within(sheet).getByText('Up to 20 MB and 500 files. Nothing in it runs when you upload it.')).toBeInTheDocument();
    expect(within(sheet).getByText('What a bundle looks like')).toBeInTheDocument();
  });

  it('refuses a file that is neither, and one too big, before sending it', async () => {
    const sheet = await openDrop();
    await choose(new File(['x'], 'cover.pdf'));
    expect(within(sheet).getByText('“cover.pdf” isn’t a .zip or a .md')).toBeInTheDocument();
    expect(within(sheet).getByText('Drop another file here')).toBeInTheDocument();
    const big = new File(['x'], 'video-kit.zip');
    Object.defineProperty(big, 'size', { value: 46 * 1024 * 1024 });
    await choose(big);
    expect(within(sheet).getByText('“video-kit.zip” is too big')).toBeInTheDocument();
    expect(within(sheet).getByText(/It’s 46 MB; a bundle can be up to 20 MB unpacked/)).toBeInTheDocument();
    expect(skillsApi.uploadBundle).not.toHaveBeenCalled();
  });

  it('shows buddi’s refusal in place: entries that reach outside, no SKILL.md', async () => {
    vi.mocked(skillsApi.uploadBundle).mockRejectedValueOnce(new BundleRefused({
      kind: 'paths', filename: 'tools.zip',
      entries: [{ path: '../../.zshrc', why: 'climbs out of the folder' }, { path: 'scripts/python', why: 'is a link', target: '/usr/bin/python3' }],
    }));
    const sheet = await openDrop();
    await choose(new File(['zip'], 'tools.zip'));
    expect(await within(sheet).findByText('“tools.zip” was refused')).toBeInTheDocument();
    expect(within(sheet).getByText(/Two entries reach outside the bundle, so nothing was unpacked/)).toBeInTheDocument();
    expect(within(sheet).getByText('../../.zshrc')).toBeInTheDocument();
    expect(within(sheet).getByText('is a link to /usr/bin/python3')).toBeInTheDocument();
    vi.mocked(skillsApi.uploadBundle).mockRejectedValueOnce(new BundleRefused({ kind: 'noskill', filename: 'photo-tools.zip', looked: ['', 'photo-tools-main/'] }));
    await choose(new File(['zip'], 'photo-tools.zip'));
    expect(await within(sheet).findByText('No SKILL.md in “photo-tools.zip”')).toBeInTheDocument();
    expect(within(sheet).getByText(/buddi looked at the top and inside photo-tools-main\//)).toBeInTheDocument();
  });

  it('previews what is inside, and adds it for the agents ticked, untrusted unless marked as mine', async () => {
    vi.mocked(skillsApi.uploadBundle).mockResolvedValueOnce(STAGED);
    await openDrop();
    await choose(new File(['zip'], 'cover-art-kit.zip'));
    const preview = await screen.findByRole('dialog', { name: /cover-art-kit\.zip/ });
    expect(within(preview).getByText('3 scripts inside. None of them ran.')).toBeInTheDocument();
    expect(within(preview).getByText('7 files · 413 KB unpacked · read, not saved yet')).toBeInTheDocument();
    expect(within(preview).getByText('413 KB unpacked · 388 KB as a .zip')).toBeInTheDocument();
    // The setup script is shown first, with its note.
    expect(await within(preview).findByText(/A setup script\. It didn’t run when you uploaded the bundle/)).toBeInTheDocument();
    expect(within(preview).getByText('can run scripts')).toBeInTheDocument();
    expect(within(preview).getByText('Only Dev has a tool that runs scripts; the others read the text. You can change this later.')).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole('checkbox', { name: 'Dev can run scripts' }));
    fireEvent.click(within(preview).getByRole('button', { name: 'Add the skill' }));
    await waitFor(() => expect(skillsApi.acceptBundle).toHaveBeenCalledWith(STAGED.id, { agents: ['dev'], mine: false }));
    expect(await screen.findByText('Added “Cover art kit”.')).toBeInTheDocument();
  });

  it('drops the staged upload when the preview is cancelled', async () => {
    vi.mocked(skillsApi.uploadBundle).mockResolvedValueOnce(STAGED);
    await openDrop();
    await choose(new File(['zip'], 'cover-art-kit.zip'));
    const preview = await screen.findByRole('dialog', { name: /cover-art-kit\.zip/ });
    fireEvent.click(within(preview).getByRole('button', { name: 'Cancel' }));
    expect(skillsApi.discardBundle).toHaveBeenCalledWith(STAGED.id);
    expect(skillsApi.acceptBundle).not.toHaveBeenCalled();
  });
});

describe('the script-run card in chat', () => {
  const action = {
    id: 'a-1', tool: 'host.exec', agentId: 'dev', state: 'pending', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    envelope: {
      command: "python3 '/owner/skills/cover-art-kit/scripts/make_cover.py' '--title' 'Night Train'",
      skillRun: {
        bundle: 'cover-art-kit', title: 'Cover art kit', script: 'scripts/make_cover.py', interpreter: 'python3',
        args: ['--title', 'Night Train', '--size', '3000x3000'], reads: '/owner/skills/cover-art-kit', writes: '/data/host/skill-runs/cover-art-kit/ab12', files: 7,
      },
    },
  } as unknown as ApprovalRow;

  it('shows the script, the bundle, the arguments, the folder and what it may touch, with no Always', () => {
    const onDecide = vi.fn();
    render(<SkillRunDock action={action} run={skillRunOf(action)!} agentName="Dev" count={1} busy={null} error={null} onDecide={onDecide} />);
    expect(screen.getByText('Dev wants to run a script from Cover art kit')).toBeInTheDocument();
    expect(screen.getByText('python3 scripts/make_cover.py')).toBeInTheDocument();
    expect(screen.getByText('--title "Night Train"')).toBeInTheDocument();
    expect(screen.getByText('--size 3000x3000')).toBeInTheDocument();
    expect(screen.getByText('/data/host/skill-runs/cover-art-kit/ab12')).toBeInTheDocument();
    expect(screen.getByText(/Reads Cover art kit’s 7 files without changing them/)).toBeInTheDocument();
    expect(screen.getByText('Scripts ask every time.')).toBeInTheDocument();
    expect(screen.queryByText(/Always/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the script' }));
    expect(window.location.hash).toBe('#/agents?tab=skills&skill=cover-art-kit&skfile=scripts%2Fmake_cover.py');
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(onDecide).toHaveBeenCalledWith('approve');
  });

  it('is only for a bundle script’s envelope', () => {
    expect(skillRunOf({ ...action, envelope: { command: 'ls' } } as unknown as ApprovalRow)).toBeNull();
    expect(skillRunOf(null)).toBeNull();
  });
});

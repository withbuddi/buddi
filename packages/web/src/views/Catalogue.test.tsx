/**
 * The agent catalogue's screens (agent-catalogue.md §6, §12 "Web"): search and
 * the category chips, each card state, loading / offline / stale / no match,
 * the detail page, the install sheet from confirm through progress to done or
 * failure (and the approval handoff), the update sheet both ways, the
 * suggestion rules, the handover card, Remove from team and Browse's filter.
 */
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type CatalogueAgent, type CatalogueJob, type CataloguePlan, type CatalogueView } from '../api';
import type { ChatAgent } from '../chat/types';
import { DRAFT_KEY } from '../chat/draft';
import { NEEDS_ROUTE } from '../routes';
import { Catalogue, CatCard, cardState } from './Catalogue';
import { CatalogueLine, RemoveFromTeam } from './parts/AgentCatalogueBits';
import { HandoverTeam, suggestFrom, suggestNames, teamIsNew } from './parts/CatalogueSuggest';
import { UpdateSheet } from './parts/CatalogueSheets';
import { reachRows } from './parts/catalogue-words';
import { Plugins } from './Plugins';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: {
      ...real.api,
      catalogue: vi.fn(),
      cataloguePlan: vi.fn(),
      catalogueInstall: vi.fn(),
      catalogueJob: vi.fn(),
      catalogueConfirm: vi.fn(),
      catalogueUpdatePlan: vi.fn(),
      catalogueUpdate: vi.fn(),
      agentRemovePreview: vi.fn(),
      removeAgent: vi.fn(),
      plugins: vi.fn(),
      market: vi.fn(),
      acceptPluginAgent: vi.fn(),
      agents: vi.fn(),
    },
  };
});

function pkg(name: string, over: Partial<CatalogueAgent> = {}): CatalogueAgent {
  const title = name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return {
    name,
    version: '1.0.0',
    handle: name,
    title,
    pitch: `${title} does its one job well.`,
    description: `${title}.`,
    about: `What ${title} does, and what it does not.`,
    category: 'work',
    trust: 'by-buddi',
    author: { name: 'withbuddi' },
    requires: {},
    optional: {},
    needs: [],
    tools: ['memory.*', 'reminder.*', 'owner.notify'],
    missions: [],
    fills: [],
    examples: ['First ask', 'Second ask', 'Third ask'],
    skills: [],
    changes: 'First version.',
    replaces: [],
    avatar: `https://withbuddi.com/plugins/agents/${name}/avatar.png`,
    page: null,
    state: 'ready',
    addable: true,
    ...over,
  };
}

const CHIEF = pkg('chief-of-staff', { optional: { calendar: '>=0.1.0', weather: '>=0.1.0' }, needs: ['mailbox?'], skills: [
  { name: 'morning-brief', description: 'How the morning brief is written.', text: 'Lead with what needs you today.' },
  { name: 'draft-a-reply', description: 'Replies in your voice.', text: 'Keep it short.' },
],
  missions: [{ id: 'morning-brief', name: 'Morning brief', cron: '0 8 * * *', when: 'Every day at 08:00', prompt: '…' }],
  tools: ['email.search', 'email.read', 'email.draft', 'calendar.events?', 'memory.*', 'owner.notify'] });
const RESEARCHER = pkg('researcher', { state: 'installed', installed: { agentId: 'researcher', handle: 'researcher', version: '1.0.0', drift: 'current' } });
const CFO = pkg('cfo', { title: 'CFO', category: 'money', requires: { finance: '>=0.1.4' }, state: 'needs',
  missing: [{ kind: 'plugin', name: 'finance', range: '>=0.1.4', fix: 'install', title: 'Finance', listed: true, byBuddi: true, version: '0.1.4' }],
  missions: [{ id: 'friday-recap', name: 'Friday recap', cron: '0 17 * * 5', when: 'Fridays at 17:00', prompt: '…' }] });
const WRITER = pkg('writer', { version: '1.1.0', changes: 'Shorter edits by default.', state: 'installed', installed: { agentId: 'writer', handle: 'writer', version: '1.0.0', drift: 'update' } });
const HOME_MANAGER = pkg('home-manager', { category: 'home', version: '1.2.0', state: 'installed', installed: { agentId: 'home', handle: 'home', version: '1.1.0', drift: 'edited-update' } });
const ILLUSTRATOR = pkg('illustrator', { requires: { image: '>=0.1.0' }, needs: ['image-account'], state: 'needs', addable: false,
  missing: [{ kind: 'plugin', name: 'image', range: '>=0.1.0', fix: 'install', title: 'Image', listed: true, byBuddi: true }, { kind: 'need', name: 'image-account', fix: 'accounts' }] });
const TUTOR = pkg('tutor', { category: 'learning', optional: { speech: '>=0.1.0' } });
const CHEF = pkg('chef', { category: 'home', optional: { weather: '>=0.1.0' } });

const VIEW: CatalogueView = {
  fetchedAt: new Date().toISOString(),
  agents: [CHIEF, RESEARCHER, CFO, WRITER, HOME_MANAGER, ILLUSTRATOR, TUTOR, CHEF],
  fromPlugins: [{ plugin: 'email', pluginVersion: '1.0.0', agent: 'mail-triage', handle: 'mail', name: 'Mail Triage', description: 'Triage.', text: 'Reads new mail and brings you only what needs you.', state: 'installed' }],
  delisted: [],
};

const FATHER = { id: 'agent-father', handle: 'father', name: 'Agent Father', description: 'Makes agents.', available: true, roles: ['maker'], provider: 'anthropic', model: 'm' } as unknown as ChatAgent;

let visited: string[] = [];
function Harness({ name, agents = [FATHER] }: { name?: string; agents?: ChatAgent[] }): JSX.Element {
  const [at, setAt] = useState(name);
  const navigate = (route: string): void => {
    visited.push(route);
    const m = /^#\/agents\/catalogue(?:\/([a-z0-9-]+))?$/.exec(route);
    if (m) setAt(m[1]);
  };
  return <Catalogue name={at} agents={agents} navigate={navigate} />;
}

beforeEach(() => {
  visited = [];
  vi.clearAllMocks();
  window.sessionStorage.clear();
  vi.mocked(api.catalogue).mockResolvedValue(VIEW);
  vi.mocked(api.plugins).mockResolvedValue({
    installed: [{ name: 'calendar', loaded: true }, { name: 'weather', loaded: true }],
    staged: [], trust: '', restartNeeded: false, checkout: false,
  } as never);
});

const card = (name: string): HTMLElement => screen.getByTestId(`cat-card-${name}`);

describe('the catalogue page', () => {
  it('draws each card in its state: Add, Added, Update, See what changed, and what a card needs or uses', async () => {
    render(<Harness />);
    await screen.findByTestId('cat-grid');
    expect(within(card('chief-of-staff')).getByRole('button', { name: 'Add Chief Of Staff' })).toBeInTheDocument();
    expect(within(card('chief-of-staff')).getByText('Uses Calendar and Weather')).toBeInTheDocument();
    expect(within(card('researcher')).getByText('Added')).toBeInTheDocument();
    expect(within(card('researcher')).getByText('On your team as @researcher')).toBeInTheDocument();
    expect(within(card('cfo')).getByText('Needs Finance')).toBeInTheDocument();
    expect(within(card('cfo')).getByRole('button', { name: 'Add CFO' })).toBeInTheDocument();
    expect(within(card('writer')).getByRole('button', { name: 'Update Writer' })).toBeInTheDocument();
    expect(within(card('writer')).getByText('1.1 is out: shorter edits by default.')).toBeInTheDocument();
    expect(within(card('home-manager')).getByRole('button', { name: 'See what changed' })).toBeInTheDocument();
    expect(within(card('home-manager')).getByText('You’ve changed Home Manager; 1.2 is out.')).toBeInTheDocument();
    expect(within(card('illustrator')).getByText('Needs Image and a drawing account')).toBeInTheDocument();
    expect(within(card('mail-triage')).getAllByText(/From Email/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Opening this page fetched the list from withbuddi.com/)).toBeInTheDocument();
    // The face is the package's picture, through the gateway.
    expect(card('chief-of-staff').querySelector('img')).toHaveAttribute('src', '/api/market/asset?url=https%3A%2F%2Fwithbuddi.com%2Fplugins%2Fagents%2Fchief-of-staff%2Favatar.png');
  });

  it('narrows by search and by category chip', async () => {
    render(<Harness />);
    await screen.findByTestId('cat-grid');
    fireEvent.click(screen.getByRole('button', { name: 'Money' }));
    expect(screen.getByTestId('cat-card-cfo')).toBeInTheDocument();
    expect(screen.queryByTestId('cat-card-chief-of-staff')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search teammates' }), { target: { value: 'learning' } });
    expect(screen.getByTestId('cat-card-tutor')).toBeInTheDocument();
    expect(screen.queryByTestId('cat-card-cfo')).not.toBeInTheDocument();
  });

  it('says no teammate matches, with Show all and Ask Agent Father carrying the words', async () => {
    render(<Harness />);
    await screen.findByTestId('cat-grid');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search teammates' }), { target: { value: 'gardening' } });
    expect(screen.getByText('No teammate for that yet')).toBeInTheDocument();
    expect(screen.getByText(/Nothing in the catalogue does “gardening”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Agent Father' }));
    expect(visited).toEqual(['#/chat/agent-father']);
    expect(JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? '{}')).toEqual({ agentId: 'agent-father', text: "I'd like a teammate for this: gardening" });
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByTestId('cat-grid')).toBeInTheDocument();
  });

  it('draws quiet cards while loading', async () => {
    vi.mocked(api.catalogue).mockReturnValue(new Promise(() => {}));
    render(<Harness />);
    expect(screen.getByTestId('cat-loading')).toHaveAttribute('aria-busy', 'true');
  });

  it('offline with no copy: says it needs withbuddi.com, and Try again asks afresh', async () => {
    vi.mocked(api.catalogue).mockResolvedValue({ agents: [], fromPlugins: [], delisted: [], unavailable: "The catalogue needs withbuddi.com; try again when you're online." });
    render(<Harness />);
    expect(await screen.findByText('The catalogue needs withbuddi.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.catalogue).toHaveBeenLastCalledWith(true));
  });

  it('a stale copy says so in the quiet line, with Try again', async () => {
    vi.mocked(api.catalogue).mockResolvedValue({ ...VIEW, stale: true, fetchedAt: new Date(Date.now() - 26 * 3_600_000).toISOString() });
    render(<Harness />);
    expect(await screen.findByTestId('cat-stale')).toHaveTextContent('From the list kept yesterday: withbuddi.com didn’t answer just now.');
    fireEvent.click(within(screen.getByTestId('cat-stale')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.catalogue).toHaveBeenLastCalledWith(true));
  });

  it('a card opens its detail page', async () => {
    render(<Harness />);
    await screen.findByTestId('cat-grid');
    fireEvent.click(screen.getByLabelText('Chief Of Staff: details'));
    expect(visited).toEqual(['#/agents/catalogue/chief-of-staff']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Chief Of Staff' })).toBeInTheDocument();
  });
});

describe('the catalogue gaps', () => {
  it('says "Uses your mailbox" on a card that reads mail once a mailbox is connected', async () => {
    vi.mocked(api.catalogue).mockResolvedValue({ ...VIEW, mailbox: true });
    render(<Harness />);
    await screen.findByTestId('cat-grid');
    expect(within(card('chief-of-staff')).getByText('Uses Calendar, Weather and your mailbox')).toBeInTheDocument();
    expect(within(card('chef')).getByText('Uses Weather')).toBeInTheDocument();
  });

  it('lists the delisted agents: they keep working, no updates will come', async () => {
    vi.mocked(api.catalogue).mockResolvedValue({ ...VIEW, delisted: [{ agentId: 'gardener', handle: 'garden', name: 'Gardener', package: 'gardener', version: '1.0.0' }] });
    render(<Harness />);
    const list = await screen.findByTestId('cat-delisted');
    expect(within(list).getByText('Gardener')).toBeInTheDocument();
    expect(within(list).getByText('@garden keeps working as it is; no updates will come.')).toBeInTheDocument();
    fireEvent.click(within(list).getByText('Gardener'));
    expect(visited).toEqual(['#/agents/gardener']);
  });

  it('draws a delisted agent with the picture it was installed with', async () => {
    vi.mocked(api.catalogue).mockResolvedValue({ ...VIEW, delisted: [{ agentId: 'gardener', handle: 'garden', name: 'Gardener', package: 'gardener', version: '1.0.0' }] });
    const gardener = { id: 'gardener', handle: 'garden', name: 'Gardener', available: true, picture: '/api/agents/gardener/avatar?v=abc' } as unknown as ChatAgent;
    render(<Harness agents={[FATHER, gardener]} />);
    const list = await screen.findByTestId('cat-delisted');
    expect(list.querySelector('.ui-avatar[data-kind="image"] img')?.getAttribute('src')).toBe('/api/agents/gardener/avatar?v=abc');
  });

  it('?add=1 opens the install sheet over the detail page (the front desk\'s "Add Chef")', async () => {
    vi.mocked(api.cataloguePlan).mockResolvedValue(PLAN);
    window.location.hash = '#/agents/catalogue/cfo?add=1';
    try {
      render(<Harness name="cfo" />);
      expect(await screen.findByRole('heading', { level: 1, name: 'CFO' })).toBeInTheDocument();
      await waitFor(() => expect(api.cataloguePlan).toHaveBeenCalled());
      expect(vi.mocked(api.cataloguePlan).mock.calls[0]?.[0]).toBe('cfo');
    } finally {
      window.location.hash = '';
    }
  });

  it("an agent's page draws its catalogue line from /api/agents, and fetches the list only for the update sheet", async () => {
    const navigate = vi.fn();
    const { unmount } = render(
      <CatalogueLine entry={{ agentId: 'writer', source: 'market', package: 'writer', title: 'Writer', version: '1.0.0', latest: '1.1.0', drift: 'update', delisted: false }} navigate={navigate} onUpdated={() => {}} />,
    );
    expect(screen.getByText('From the catalogue')).toBeInTheDocument();
    expect(api.catalogue).not.toHaveBeenCalled();
    vi.mocked(api.catalogueUpdatePlan).mockReturnValue(new Promise(() => {}));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update to 1.1' })); });
    expect(api.catalogue).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.catalogueUpdatePlan).toHaveBeenCalledWith('writer', 'writer'));
    unmount();
    render(
      <CatalogueLine entry={{ agentId: 'gardener', source: 'market', package: 'gardener', title: 'Gardener', version: '1.0.0', latest: null, drift: 'current', delisted: true }} navigate={navigate} onUpdated={() => {}} />,
    );
    expect(screen.getByText('No longer in the catalogue')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the detail page', () => {
  it('shows the sections: what it does, ask it (off until added), skills read-only, reach, missions off, plugins', async () => {
    render(<Harness name="chief-of-staff" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Chief Of Staff' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Chief Of Staff' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'First ask' })).toBeDisabled();
    expect(screen.getByText('Once it’s on your team, a tap opens a chat with it.')).toBeInTheDocument();
    const skills = screen.getByTestId('cat-skills');
    expect(within(skills).getByText('Morning brief')).toBeInTheDocument();
    expect(within(skills).getByText('How the morning brief is written.')).toBeInTheDocument();
    expect(within(skills).getByText('Draft a reply')).toBeInTheDocument();
    expect(within(skills).queryByRole('button')).not.toBeInTheDocument();
    // Each opens to its text, read-only.
    expect(within(skills).getByText('Lead with what needs you today.')).not.toBeVisible();
    fireEvent.click(within(skills).getAllByText('Read it')[0]!);
    expect(within(skills).getByText('Lead with what needs you today.')).toBeVisible();
    expect(screen.getByText('Reads and searches your mail. Writes drafts; you send them.')).toBeInTheDocument();
    expect(screen.getByText('Every day at 08:00')).toBeInTheDocument();
    expect(screen.getByText('off until you turn it on')).toBeInTheDocument();
    expect(screen.getAllByText('Installed').length).toBe(2);
  });

  it('once added, an example opens a chat with it, the ask left in the composer', async () => {
    render(<Harness name="researcher" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Second ask' }));
    expect(visited).toEqual(['#/chat/researcher']);
    expect(JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? '{}')).toEqual({ agentId: 'researcher', text: 'Second ask' });
  });
});

const PLAN: CataloguePlan = {
  name: 'cfo', version: '1.0.0', title: 'CFO',
  plugins: [{ name: 'finance', title: 'Finance', version: '0.1.4', byBuddi: true, fix: 'install' }],
  blocked: [], handle: 'cfo',
  fills: [{ id: 'recap-time', kind: 'time', label: 'Friday recap at', value: '17:00', mission: 'friday-recap' }],
  tools: [{ name: 'finance.overview', tier: 'auto' }, { name: 'finance.delete_account', tier: 'gated' }, { name: 'memory.remember', tier: 'auto' }],
  missions: [{ id: 'friday-recap', name: 'Friday recap', cron: '0 17 * * 5', enabled: false, prompt: '…' }],
  preview: null,
};

function job(over: Partial<CatalogueJob>): CatalogueJob {
  return {
    id: '11111111-1111-1111-1111-111111111111', name: 'cfo', version: '1.0.0', title: 'CFO', state: 'running',
    steps: [{ kind: 'plugin', name: 'finance', title: 'Finance', state: 'installing' }, { kind: 'agent', name: 'cfo', title: 'CFO', state: 'waiting' }],
    startedAt: new Date().toISOString(),
    ...over,
  };
}

async function openInstall(): Promise<void> {
  render(<Harness />);
  await screen.findByTestId('cat-grid');
  fireEvent.click(within(card('cfo')).getByRole('button', { name: 'Add CFO' }));
  await screen.findByText('Installed on the way');
}

describe('the install sheet', () => {
  it('confirms what it does, sends the picks, the handle and the missions turned on, then follows the job to done', async () => {
    vi.mocked(api.cataloguePlan).mockResolvedValue(PLAN);
    vi.mocked(api.catalogueInstall).mockResolvedValue({ jobId: '11111111-1111-1111-1111-111111111111' });
    vi.mocked(api.catalogueJob)
      .mockResolvedValueOnce(job({}))
      .mockResolvedValue(job({ state: 'done', agent: { id: 'cfo', handle: 'money', name: 'CFO' }, steps: [{ kind: 'plugin', name: 'finance', title: 'Finance', state: 'done' }, { kind: 'agent', name: 'cfo', title: 'CFO', state: 'done' }] }));
    await openInstall();
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Installs Finance, then adds CFO.')).toBeInTheDocument();
    expect(screen.getByLabelText('Friday recap at')).toHaveValue('17:00');
    const handle = screen.getByLabelText('Handle');
    fireEvent.change(handle, { target: { value: 'Money!' } });
    expect(handle).toHaveValue('money');
    const recap = screen.getByRole('switch', { name: 'Turn on Friday recap' });
    expect(recap).not.toBeChecked();
    fireEvent.click(recap);
    expect(screen.getByText(/Reaches Finance and Memory\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See all' }));
    expect(screen.getByText(/Asks you first before it changes anything/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add CFO' })); });
    expect(api.catalogueInstall).toHaveBeenCalledWith('cfo', {
      version: '1.0.0', fills: { 'recap-time': '17:00' }, handle: 'money', missionsOn: ['friday-recap'],
      // The grant the sheet listed: the click approves that, never more.
      tools: ['finance.overview', 'finance.delete_account', 'memory.remember'],
    });
    expect(await screen.findByTestId('cat-progress')).toHaveTextContent('Installing Finance…');
    expect(await screen.findByText('CFO is on your team.', {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.getByTestId('cat-done')).toHaveTextContent('@money · Finance installed');
    fireEvent.click(screen.getByRole('button', { name: 'Say hello' }));
    expect(visited).toContain('#/chat/cfo');
    // The list is read again so the card says Added.
    expect(vi.mocked(api.catalogue).mock.calls.length).toBeGreaterThan(1);
  });

  it('a failure says what and why, nothing added, the staged plugin in Settings → Plugins, and Try again', async () => {
    vi.mocked(api.cataloguePlan).mockResolvedValue(PLAN);
    vi.mocked(api.catalogueInstall).mockResolvedValue({ jobId: '11111111-1111-1111-1111-111111111111' });
    vi.mocked(api.catalogueJob).mockResolvedValue(job({
      state: 'failed', error: 'Finance was not installed: withbuddi.com stopped answering. CFO was not added',
      steps: [{ kind: 'plugin', name: 'finance', title: 'Finance', state: 'failed', reason: 'withbuddi.com stopped answering' }, { kind: 'agent', name: 'cfo', title: 'CFO', state: 'waiting' }],
    }));
    await openInstall();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add CFO' })); });
    expect(await screen.findByText('CFO wasn’t added')).toBeInTheDocument();
    expect(screen.getByTestId('cat-failed')).toHaveTextContent('Finance didn’t install');
    expect(screen.getByText('Finance was not installed: withbuddi.com stopped answering. CFO was not added.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing was added and nothing else changed\. Finance waits in/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(api.catalogueInstall).toHaveBeenCalledTimes(2);
  });

  it('when the job waits on an approval, says so and opens Needs you', async () => {
    vi.mocked(api.cataloguePlan).mockResolvedValue({ ...PLAN, plugins: [] });
    vi.mocked(api.catalogueInstall).mockResolvedValue({ jobId: '11111111-1111-1111-1111-111111111111' });
    vi.mocked(api.catalogueJob).mockResolvedValue(job({ approvalId: 'act-9', steps: [{ kind: 'agent', name: 'cfo', title: 'CFO', state: 'adding' }] }));
    render(<Harness />);
    await screen.findByTestId('cat-grid');
    fireEvent.click(within(card('cfo')).getByRole('button', { name: 'Add CFO' }));
    await screen.findByText('Nothing runs until you add it.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add CFO' })); });
    expect(await screen.findByText('Adding CFO waits for your approval in Needs you.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(visited).toContain(NEEDS_ROUTE);
  });

  it('when the plugins resolve more than the sheet showed, it stops and asks with the grant as it is', async () => {
    vi.mocked(api.cataloguePlan).mockResolvedValue(PLAN);
    vi.mocked(api.catalogueInstall).mockResolvedValue({ jobId: '11111111-1111-1111-1111-111111111111' });
    vi.mocked(api.catalogueJob).mockResolvedValue(job({
      state: 'confirm', approvalId: 'act-3',
      steps: [{ kind: 'plugin', name: 'finance', title: 'Finance', state: 'done' }, { kind: 'agent', name: 'cfo', title: 'CFO', state: 'confirm' }],
      confirm: { tools: [{ name: 'finance.overview', tier: 'auto' }, { name: 'email.send', tier: 'gated' }], unshown: ['email.send'], preview: 'Add CFO …' },
    }));
    vi.mocked(api.catalogueConfirm).mockResolvedValue(job({
      state: 'done', agent: { id: 'cfo', handle: 'cfo', name: 'CFO' },
      steps: [{ kind: 'plugin', name: 'finance', title: 'Finance', state: 'done' }, { kind: 'agent', name: 'cfo', title: 'CFO', state: 'done' }],
    }));
    await openInstall();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add CFO' })); });
    expect(await screen.findByText('CFO would get more than the list showed.')).toBeInTheDocument();
    expect(screen.getByTestId('cat-confirm')).toHaveTextContent('Installed Finance');
    expect(screen.getByText(/including email\.send/)).toBeInTheDocument();
    expect(screen.getByText(/Reaches Finance and Mail\./)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add CFO' })); });
    expect(api.catalogueConfirm).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', true);
    expect(await screen.findByText('CFO is on your team.')).toBeInTheDocument();
  });

  it('something it cannot install on the way holds Add, with its one fix', async () => {
    vi.mocked(api.cataloguePlan).mockResolvedValue({ ...PLAN, name: 'illustrator', title: 'Illustrator', plugins: [{ name: 'image', title: 'Image', version: '0.1.0', byBuddi: true, fix: 'install' }], blocked: [{ kind: 'need', name: 'image-account', fix: 'accounts' }], fills: [], missions: [] });
    render(<Harness />);
    await screen.findByTestId('cat-grid');
    fireEvent.click(within(card('illustrator')).getByRole('button', { name: 'Add Illustrator' }));
    expect(await screen.findByText(/Illustrator needs a drawing account first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Illustrator' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a drawing account' }));
    expect(visited.at(-1)).toMatch(/image/);
  });

  it('a refused start (the listing moved on) is said on the sheet', async () => {
    const { ApiError } = await import('../api');
    vi.mocked(api.cataloguePlan).mockResolvedValue(PLAN);
    vi.mocked(api.catalogueInstall).mockRejectedValue(new ApiError(409, 'The catalogue now lists CFO 1.0.1; look at it again before adding it.'));
    await openInstall();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add CFO' })); });
    expect(await screen.findByText('The catalogue now lists CFO 1.0.1; look at it again before adding it.')).toBeInTheDocument();
  });
});

describe('the update sheet', () => {
  it('untouched: the changes, the diff, reach and missions in a sentence; Update is one click', async () => {
    vi.mocked(api.catalogueUpdatePlan).mockResolvedValue({
      agentId: 'writer', handle: 'writer', name: 'writer', title: 'Writer', fromVersion: '1.0.0', version: '1.1.0', changes: 'Shorter edits by default.',
      edited: false, widened: false, added: [], removed: [], personaDiff: ['- Rewrite freely.', '+ Edit lightly.'], missionsAdded: [], preview: null,
      plan: 'fp-writer', retires: ['old-habit'],
    });
    vi.mocked(api.catalogueUpdate).mockResolvedValue({ approvalId: 'a1', result: null });
    const updated = vi.fn();
    render(<UpdateSheet entry={WRITER} agentId="writer" onClose={() => {}} onUpdated={updated} />);
    expect(await screen.findByText('Update Writer to 1.1')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Writer 1.0 against 1.1' })).toHaveTextContent('Edit lightly.');
    expect(screen.getByText('No new tools. It reaches what it reaches today.')).toBeInTheDocument();
    expect(screen.getByText('None added. Yours stay as they are.')).toBeInTheDocument();
    expect(screen.getByText('1.1 no longer has old-habit; it goes to the trash folder.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update Writer' })); });
    expect(api.catalogueUpdate).toHaveBeenCalledWith('writer', 'writer', 'fp-writer', false);
    expect(await screen.findByText('Writer is on 1.1.')).toBeInTheDocument();
    expect(updated).toHaveBeenCalled();
  });

  it('edited: nothing is touched; Keep mine closes, See what changed shows the diff, Replace my changes replaces', async () => {
    vi.mocked(api.catalogueUpdatePlan).mockResolvedValue({
      agentId: 'home', handle: 'home', name: 'home-manager', title: 'Home Manager', fromVersion: '1.1.0', version: '1.2.0', changes: 'Asks about frost only when it is cold.',
      edited: true, widened: false, added: [], removed: [], personaDiff: ['- The garage code is in the blue folder.', '+ Check for frost under 2 °C.'], missionsAdded: [], preview: null,
      plan: 'fp-home',
    });
    vi.mocked(api.catalogueUpdate).mockResolvedValue({ approvalId: 'a2', result: null });
    const close = vi.fn();
    render(<UpdateSheet entry={HOME_MANAGER} agentId="home" onClose={close} />);
    expect(await screen.findByText('Home Manager 1.2 is out')).toBeInTheDocument();
    expect(screen.getByText('1 line only in your file, 1 line new in 1.2.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'See what changed' })[0]!);
    expect(screen.getByRole('region', { name: 'Your Home Manager against 1.2' })).toHaveTextContent('The garage code is in the blue folder.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(close).toHaveBeenCalled();
    expect(api.catalogueUpdate).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Replace my changes' })); });
    expect(api.catalogueUpdate).toHaveBeenCalledWith('home-manager', 'home', 'fp-home', true);
    expect(await screen.findByText('Your version is in the trash folder if you want any of it back.')).toBeInTheDocument();
  });
});

describe('suggestions', () => {
  it('follows the rule: mailbox or My days → Chief of Staff; Finance → CFO; Pictures → Illustrator; filled with Researcher, then Tutor', () => {
    expect(suggestNames({ mailbox: true })).toEqual(['chief-of-staff', 'researcher', 'tutor']);
    expect(suggestNames({ days: true })).toEqual(['chief-of-staff', 'researcher', 'tutor']);
    expect(suggestNames({ days: true, money: true, pictures: true })).toEqual(['chief-of-staff', 'cfo', 'illustrator']);
    expect(suggestNames({})).toEqual(['researcher', 'tutor']);
    expect(suggestNames({ money: true })).toEqual(['cfo', 'researcher', 'tutor']);
  });

  it('suggests only what is listed, not on the team and addable now; a filler stands in', () => {
    // Researcher is added and Illustrator cannot be added yet: Tutor fills in.
    expect(suggestFrom(VIEW.agents, { days: true, pictures: true }).map((a) => a.name)).toEqual(['chief-of-staff', 'tutor']);
    expect(suggestFrom(VIEW.agents, { days: true, money: true }).map((a) => a.name)).toEqual(['chief-of-staff', 'cfo', 'tutor']);
  });

  it('the team is new while it is the front desk and the maker plus at most one more', () => {
    const a = (id: string, roles: string[] = []): ChatAgent => ({ id, roles } as unknown as ChatAgent);
    expect(teamIsNew([a('desk'), a('father', ['maker'])], 'desk')).toBe(true);
    expect(teamIsNew([a('desk'), a('father', ['maker']), a('cfo')], 'desk')).toBe(true);
    expect(teamIsNew([a('desk'), a('father', ['maker']), a('cfo'), a('chef')], 'desk')).toBe(false);
  });

  it('the handover card adds the ticked ones in one go and says who joined', async () => {
    vi.mocked(api.catalogueInstall).mockImplementation(async (name: string) => ({ jobId: `job-${name}` }));
    vi.mocked(api.catalogueJob).mockImplementation(async (id: string) => job({ id, name: id.slice(4), state: 'done' }));
    const navigate = vi.fn();
    render(<HandoverTeam setUp={{ days: true, mailbox: true, money: true }} navigate={navigate} />);
    expect(await screen.findByText('Who do you want on your team?')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(boxes[2]!);
    expect(screen.getByRole('button', { name: 'Add these 2' })).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add these 2' })); });
    expect(await screen.findByText('Chief Of Staff and CFO are on your team.')).toBeInTheDocument();
    expect(api.catalogueInstall).toHaveBeenNthCalledWith(1, 'chief-of-staff', { version: '1.0.0', tools: expect.any(Array) });
    expect(api.catalogueInstall).toHaveBeenNthCalledWith(2, 'cfo', { version: '1.0.0', tools: expect.any(Array) });
    fireEvent.click(screen.getByRole('button', { name: 'See all teammates' }));
    expect(navigate).toHaveBeenCalledWith('#/agents/catalogue');
  });
});

describe('remove from team', () => {
  it('shows what removing does before it does it, and the click is the approval', async () => {
    vi.mocked(api.agentRemovePreview).mockResolvedValue({ id: 'chef', handle: 'chef', name: 'Chef', pausesMissions: [{ id: 'agent:chef:sunday', name: 'Sunday meal plan' }], unusedPlugins: ['weather'], preview: '…' });
    vi.mocked(api.removeAgent).mockResolvedValue({ approvalId: 'a3', result: null });
    const navigate = vi.fn();
    render(<RemoveFromTeam agentId="chef" name="Chef" navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Chef…' }));
    const preview = await screen.findByTestId('remove-preview');
    expect(preview).toHaveTextContent('Its mission Sunday meal plan is paused.');
    expect(preview).toHaveTextContent('No other agent uses Weather; it stays installed.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove from team' })); });
    expect(api.removeAgent).toHaveBeenCalledWith('chef');
    expect(navigate).toHaveBeenCalledWith('#/agents');
  });
});

describe("Browse's kind filter", () => {
  it('Agents shows the catalogue cards, each opening its page', async () => {
    vi.mocked(api.market).mockResolvedValue({ plugins: [] });
    const navigate = vi.fn();
    render(<Plugins hash="#/settings/plugins?tab=browse&kind=agents" navigate={navigate} />);
    const grid = await screen.findByTestId('browse-agents');
    expect(within(grid).getByTestId('cat-card-cfo')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Agents' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('searchbox', { name: 'Search plugins' })).not.toBeInTheDocument();
    fireEvent.click(within(grid).getByRole('button', { name: 'Add CFO' }));
    expect(navigate).toHaveBeenCalledWith('#/agents/catalogue/cfo');
    fireEvent.click(screen.getByRole('link', { name: 'Open the catalogue' }));
    expect(navigate).toHaveBeenCalledWith('#/agents/catalogue');
  });

  it('All shows the plugins, then three teammates and See all', async () => {
    vi.mocked(api.market).mockResolvedValue({ plugins: [] });
    render(<Plugins hash="#/settings/plugins?tab=browse" navigate={vi.fn()} />);
    const grid = await screen.findByTestId('browse-agents');
    expect(within(grid).getAllByTestId(/^cat-card-/)).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'See all 8' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search plugins' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Plugins' }));
    expect(screen.queryByTestId('browse-agents')).not.toBeInTheDocument();
  });
});

describe('the words', () => {
  it('card states from the list', () => {
    expect(VIEW.agents.map(cardState)).toEqual(['ready', 'added', 'ready', 'update', 'edited', 'ready', 'ready', 'ready']);
    expect(cardState(pkg('keeper', { state: 'installed', installed: { agentId: 'keeper', handle: 'keeper', version: '0.1.0', drift: 'edited-update', via: 'buddi/keeper' } }))).toBe('edited');
    expect(cardState(pkg('keeper', { state: 'installed', installed: { agentId: 'keeper', handle: 'keeper', version: '0.1.0', drift: 'update', via: 'buddi/keeper' } }))).toBe('update');
  });

  it('an older agent the package replaces is offered as an update, by its handle', () => {
    const entry = pkg('researcher', { title: 'Researcher', state: 'installed', installed: { agentId: 'scout', handle: 'scout', version: 'unknown', drift: 'edited-update', via: 'buddi/scout' } });
    const onUpdate = vi.fn();
    render(<CatCard entry={entry} loaded={new Set()} onOpen={() => {}} onAdd={() => {}} onUpdate={onUpdate} />);
    expect(screen.getByText('Replaces your @scout, which you’ve changed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See what changed' }));
    expect(onUpdate).toHaveBeenCalled();
  });

  it('reach is read family by family, a missions grant folded into reminders', () => {
    expect(reachRows(['reminder.set', 'schedule.create', 'web.search', 'browser.status', 'weather.forecast?', 'garden.water'])).toEqual([
      ['Reminders', 'Sets reminders and runs its own missions.'],
      ['Web', 'Searches and reads web pages.'],
      ['Weather', 'Reads the forecast for your places.'],
      ['Garden', 'One of its tools.'],
    ]);
  });
});

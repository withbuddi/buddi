/**
 * First run, as the owner sees it.
 *
 * Who is sent here, what each of the five chapters looks like, the map that
 * says where the owner is, and the endings that have to be right: an answer
 * that saves and moves on, installs that run behind the chapters without
 * blocking any of them, and an assistant that never speaks leaving the owner
 * a way forward rather than a spinner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, api, chatApi, type BrowserStatus, type OllamaProbe, type OnboardingView, type OwnerView, type ProviderAccountsView, type TakeOnView } from '../api';
import { App } from '../App';
import { Meet, FIRST_MESSAGE_TIMEOUT_MS, PATIENCE_MS, TAKE_ON_POLL_MS, calendarRowState } from './Meet';
import { BANNED_WORDS, DEFAULT_ASSISTANT_NAME, SCRIPT } from './meet/script';
import { resetInstallPrompt } from './parts/KeepClose';
import { SHEETS } from './parts/FirstRunSheets';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: {
      ...real.api,
      onboarding: vi.fn(),
      onboardingStep: vi.fn(),
      completeOnboarding: vi.fn(),
      skipOnboarding: vi.fn(),
      takeOn: vi.fn(),
      takeOnProgress: vi.fn(),
      createFirstAgent: vi.fn(),
      updateFirstAgent: vi.fn(),
      firstAgentPersona: vi.fn(),
      uploadAgentPicture: vi.fn(),
      removeAgentPicture: vi.fn(),
      assignProviderAccount: vi.fn(),
      bindBrain: vi.fn(),
      owner: vi.fn(),
      setOwner: vi.fn(),
      providerAccounts: vi.fn(),
      providers: vi.fn(),
      anthropicAccountAction: vi.fn(),
      codexAccountAction: vi.fn(),
      ollamaConnect: vi.fn(),
      ollamaPoll: vi.fn(),
      accountModels: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      removeProviderAccount: vi.fn(),
      probeModels: vi.fn(),
      ollama: vi.fn(),
      ollamaPull: vi.fn(),
      ollamaPullState: vi.fn(),
      mlxh: vi.fn(),
      telegram: vi.fn(),
      saveTelegramToken: vi.fn(),
      telegramPairing: vi.fn(),
      telegramBot: vi.fn(),
      session: vi.fn(),
      version: vi.fn(),
      overview: vi.fn(),
      conversations: vi.fn(),
      browser: vi.fn(),
      browserInstall: vi.fn(),
      browserCheck: vi.fn(),
      pages: vi.fn(),
      pageQuery: vi.fn(),
      pageAct: vi.fn(),
      firstRunRestore: vi.fn(),
      backupJob: vi.fn(),
      catalogue: vi.fn(),
      catalogueInstall: vi.fn(),
      catalogueJob: vi.fn(),
    },
    chatApi: {
      ...real.chatApi,
      agents: vi.fn(),
      groups: vi.fn(),
      startConversation: vi.fn(),
      conversation: vi.fn(),
      send: vi.fn(),
    },
  };
});

const view = (over: Partial<OnboardingView> = {}): OnboardingView => ({
  state: 'pending',
  stepsDone: [],
  details: {},
  needs: { owner: true, model: true, agent: true },
  ...over,
});

const owner = (over: Partial<OwnerView> = {}): OwnerView => ({
  preferredName: null,
  timezone: null,
  language: null,
  about: null,
  displayName: null,
  detectedTimezone: 'UTC',
  zones: ['UTC', 'America/New_York'],
  ...over,
});

const accounts = (list: Array<Record<string, unknown>> = [], over: Partial<ProviderAccountsView> = {}): ProviderAccountsView =>
  ({
    vault: { kind: 'file', locked: false, advice: '' },
    bindings: [],
    accounts: list.map((account, at) => ({
      id: `a${at}`,
      label: 'Ollama',
      kind: 'openai-compatible',
      auth: 'none',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'qwen3:4b',
      enabled: true,
      revision: 1,
      configured: true,
      refreshable: false,
      tokenExpiresAt: null,
      subscriptionRenewsAt: null,
      assignedAgents: [],
      test: null,
      ...account,
    })),
    ...over,
  }) as ProviderAccountsView;

const progress = (over: Partial<TakeOnView> = {}): TakeOnView => ({ tiles: [], plugins: [], running: false, waiting: [], ...over });

/** The Gemini preset as the gateway names it; placeholders, never fetched. */
const GEMINI = { baseUrl: 'google-compatible/openai/', keyUrl: 'key-page' };

/** Every call the screen makes that a given test is not about. */
function quiet(): void {
  vi.mocked(api.session).mockResolvedValue({ csrf: 'x', timezone: 'UTC', host: '127.0.0.1', port: 4317 });
  vi.mocked(api.version).mockResolvedValue({ current: '' } as never);
  vi.mocked(api.onboarding).mockResolvedValue(view());
  vi.mocked(api.owner).mockResolvedValue(owner());
  vi.mocked(api.providerAccounts).mockResolvedValue(accounts());
  vi.mocked(api.ollama).mockResolvedValue({ running: false, models: [], downloadUrl: 'ollama.com/download', baseUrl: 'ollama-on-this-machine/v1', cloudBaseUrl: 'ollama-cloud/v1' });
  vi.mocked(api.mlxh).mockResolvedValue({ running: false, baseUrl: 'mlxh-on-this-machine/v1', manager: false, models: [] });
  vi.mocked(api.onboardingStep).mockResolvedValue(view());
  vi.mocked(api.takeOn).mockResolvedValue({ jobs: [] });
  vi.mocked(api.takeOnProgress).mockResolvedValue(progress());
  vi.mocked(api.pages).mockResolvedValue({ pages: [] });
  vi.mocked(api.pageQuery).mockRejectedValue(new Error('not in this test'));
  vi.mocked(api.telegram).mockResolvedValue({ configured: false, running: false, paired: false });
  vi.mocked(api.telegramBot).mockResolvedValue({ configured: true, running: true, username: 'amen_buddi_bot' });
  vi.mocked(chatApi.agents).mockResolvedValue({ agents: [], defaultAgentId: '' });
  // Another mode by default: the browser row has nothing to fetch.
  vi.mocked(api.browser).mockRejectedValue(new Error('not in this test'));
  vi.mocked(api.firstAgentPersona).mockResolvedValue({ id: 'ada', persona: 'Keep my books. Nothing else.', generated: true });
  for (const call of [api.overview, api.conversations, chatApi.groups, api.providers]) {
    vi.mocked(call as () => Promise<unknown>).mockRejectedValue(new Error('not in this test'));
  }
  // No theatre in a test, and a desktop-sized window.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  window.sessionStorage.clear();
  resetInstallPrompt();
  quiet();
  vi.mocked(api.catalogue).mockResolvedValue({ agents: [], fromPlugins: [], delisted: [] });
});

const meet = (navigate: (next: string, replace?: boolean) => void = () => {}): JSX.Element => (
  <Meet navigate={navigate} timezone="UTC" />
);

/** Chapter 2's key card, then one of its kinds. */
async function openKind(kind: 'service' | 'gemini'): Promise<void> {
  fireEvent.click(await screen.findByText(SCRIPT.brain.cards.key.title));
  fireEvent.click(await screen.findByRole('radio', { name: SCRIPT.brain.keyKinds[kind] }));
}

/** Answered through chapter 2: the record names the account the owner chose. */
function atTakeOn(details: OnboardingView['details'] = {}): void {
  vi.mocked(api.onboarding).mockResolvedValue(view({ stepsDone: ['you', 'model'], details: { accountId: 'a0', ...details }, needs: { owner: false, model: false, agent: true } }));
  vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
  vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{}]));
}

/** Answered through chapter 3. */
const atReach = (takeOn: string[] = []): void => atTakeOn({ takeOn });

/** Answered through chapter 4. */
function atAssistant(takeOn: string[] = []): void {
  vi.mocked(api.onboarding).mockResolvedValue(
    view({ stepsDone: ['you', 'model', 'take-on', 'reach'], details: { accountId: 'a0', takeOn, reach: {} }, needs: { owner: false, model: false, agent: true } }),
  );
  vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
  vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{}]));
}

/** The map's chapter rows, in order. */
function mapRows(): HTMLElement[] {
  return within(screen.getByRole('navigation', { name: 'Chapters' })).getAllByText((_, node) => node?.classList.contains('wiz-ch') ?? false);
}

describe('who is sent here', () => {
  it('sends a fresh installation with no model account to first run', async () => {
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe('#/welcome'));
  });

  it('leaves an installation that already has an account alone', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ needs: { owner: true, model: false, agent: true } }));
    render(<App />);
    await waitFor(() => expect(api.onboarding).toHaveBeenCalled());
    expect(window.location.hash).not.toContain('welcome');
  });

  it('leaves a finished, skipped or already-claimed record alone', async () => {
    for (const state of ['done', 'skipped', 'in-progress'] as const) {
      vi.clearAllMocks();
      window.location.hash = '';
      quiet();
      vi.mocked(api.onboarding).mockResolvedValue(view({ state }));
      const page = render(<App />);
      await waitFor(() => expect(api.onboarding).toHaveBeenCalled());
      expect(window.location.hash, state).not.toContain('welcome');
      page.unmount();
    }
  });
});

describe('the map', () => {
  it('names the five chapters, lights the open one and says where the owner is', async () => {
    render(meet());
    await screen.findByText(SCRIPT.hello.title);
    const rows = mapRows();
    expect(rows.map((row) => row.textContent)).toEqual(SCRIPT.chapters.map((name, at) => `${at + 1}${name}`));
    expect(rows[0]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText(SCRIPT.count(1))).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.mapNotes[0]!)).toBeInTheDocument();
  });

  it('ticks an answered chapter with its answer and a change link, and change reopens it in place', async () => {
    atTakeOn();
    render(meet());
    await screen.findByText(SCRIPT.takeOn.title);
    const rows = mapRows();
    expect(rows[0]).toHaveTextContent('Amen');
    expect(rows[0]).toHaveTextContent('UTC');
    expect(rows[1]).toHaveTextContent('Ollama');
    expect(rows[2]).toHaveAttribute('aria-current', 'step');
    fireEvent.click(within(rows[0]!).getByRole('button', { name: SCRIPT.change }));
    // The chapter opens with what was answered, and later answers stay.
    expect(await screen.findByDisplayValue('Amen')).toBeInTheDocument();
    expect(within(mapRows()[1]!).getByRole('button', { name: SCRIPT.change })).toBeInTheDocument();
  });

  it('goes back a chapter with Back, and on from there with the answer kept', async () => {
    atTakeOn();
    render(meet());
    await screen.findByText(SCRIPT.takeOn.title);
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.back }));
    // The brain is answered: its verdict, and "Use this brain" already lit.
    expect(await screen.findByText(SCRIPT.brain.works('qwen3:4b'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.submit }));
    expect(await screen.findByText(SCRIPT.takeOn.title)).toBeInTheDocument();
  });

  it('folds into a strip of dots at phone width', async () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    render(meet());
    expect(await screen.findByText(SCRIPT.strip(1, SCRIPT.chapters[0]))).toBeInTheDocument();
    expect(screen.getByLabelText(SCRIPT.count(1))).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Chapters' })).not.toBeInTheDocument();
    // The way out is still there, under the card.
    expect(screen.getByRole('button', { name: SCRIPT.later })).toBeInTheDocument();
  });
});

describe('a backup from another buddi', () => {
  it('offers itself in chapter 1 and opens in a sheet, which can be closed again', async () => {
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.restore.offer }));
    const sheet = await screen.findByRole('dialog', { name: SCRIPT.restore.sheet });
    expect(within(sheet).getByLabelText(SCRIPT.restore.file)).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: SCRIPT.restore.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByPlaceholderText(SCRIPT.name.placeholder)).toBeInTheDocument();
  });

  it('is not offered once there is an answer a restore would overwrite', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen' }));
    render(meet());
    expect(await screen.findByDisplayValue('Amen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SCRIPT.restore.offer })).not.toBeInTheDocument();
  });

  it('says each phase on the card, and picks up at the brain with the one sentence that matters', async () => {
    vi.mocked(api.firstRunRestore).mockResolvedValue({ job: { id: 'job-1' } } as never);
    vi.mocked(api.backupJob).mockResolvedValueOnce({ id: 'job-1', phase: 'database' } as never).mockResolvedValue({ id: 'job-1', phase: 'done' } as never);
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.restore.offer }));
    const sheet = await screen.findByRole('dialog', { name: SCRIPT.restore.sheet });
    fireEvent.change(within(sheet).getByLabelText(SCRIPT.restore.file), { target: { files: [new File(['x'], 'buddi-backup.tar')] } });
    // What comes back: a finished record, the owner, and an account with no key.
    vi.mocked(api.onboarding).mockResolvedValue(view({ state: 'done', needs: { owner: false, model: true, agent: false } }));
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    fireEvent.click(within(sheet).getByRole('button', { name: SCRIPT.restore.submit }));
    expect(await screen.findByText(SCRIPT.restore.phases.database)).toBeInTheDocument();
    // The brain is the one chapter a backup cannot bring back: it opens, with why.
    expect(await screen.findByText(SCRIPT.brain.title, undefined, { timeout: 6_000 })).toBeInTheDocument();
    expect(await screen.findByText(SCRIPT.restore.keys)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.restore.welcome('Amen'))).toBeInTheDocument();
  }, 10_000);
});

describe('chapter 1: hello', () => {
  it('opens with buddi saying hello and asking for a name and a clock, the caret in the name', async () => {
    render(meet());
    expect(await screen.findByText(SCRIPT.hello.title)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.hello.opening[1])).toBeInTheDocument();
    // The clock is this browser's, filled in, with the way to change it.
    expect(screen.getByLabelText(SCRIPT.clock.label)).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: SCRIPT.clock.change })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText(SCRIPT.name.placeholder)).toHaveFocus());
  });

  it('saves the name and the clock together and opens the brain, with the answer on the map', async () => {
    vi.mocked(api.setOwner).mockResolvedValue(owner({ preferredName: 'Amen' }));
    render(meet());
    const field = await screen.findByPlaceholderText(SCRIPT.name.placeholder);
    expect(screen.getByRole('button', { name: SCRIPT.hello.submit })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'Amen' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.hello.submit }));
    await waitFor(() => expect(api.setOwner).toHaveBeenCalledWith(expect.objectContaining({ preferredName: 'Amen', timezone: expect.any(String) })));
    expect(await screen.findByText(SCRIPT.brain.title)).toBeInTheDocument();
    expect(api.onboardingStep).toHaveBeenCalledWith('you', {});
    expect(mapRows()[0]).toHaveTextContent('Amen');
    expect(screen.getAllByRole('button', { name: SCRIPT.change }).length).toBeGreaterThan(0);
  });

  it('opens the zone picker on Change', async () => {
    vi.mocked(api.setOwner).mockResolvedValue(owner({ preferredName: 'Amen' }));
    render(meet());
    fireEvent.change(await screen.findByPlaceholderText(SCRIPT.name.placeholder), { target: { value: 'Amen' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.clock.change }));
    await waitFor(() => expect(screen.getByLabelText(SCRIPT.clock.label).tagName).toBe('SELECT'));
    fireEvent.change(screen.getByLabelText(SCRIPT.clock.label), { target: { value: 'America/New_York' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.hello.submit }));
    await waitFor(() => expect(api.setOwner).toHaveBeenCalledWith({ preferredName: 'Amen', timezone: 'America/New_York' }));
  });

  it('lines the dock up the same way: where you are on the left, the primary last on the right', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    const { container } = render(meet());
    await screen.findByText(SCRIPT.brain.title);
    const dock = container.querySelector('.ui-float-dock')!;
    expect(dock.firstElementChild).toHaveTextContent(SCRIPT.count(2));
    const buttons = within(dock as HTMLElement).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([SCRIPT.back, SCRIPT.brain.submit]);
  });
});

describe('chapter 2: a brain', () => {
  it('resumes at the brain, and offers Claude second, after the free start, unless the host hides that sign-in', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { anthropicOAuthEnabled: false }));
    const page = render(meet());
    expect(await screen.findByText(SCRIPT.brain.title)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.brain.cards.key.title)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.brain.cards.local.title)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.brain.cards.free.title)).toBeInTheDocument();
    expect(screen.queryByText(SCRIPT.brain.cards.claude.title)).not.toBeInTheDocument();
    page.unmount();

    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { anthropicOAuthEnabled: true }));
    render(meet());
    expect(await screen.findByText(SCRIPT.brain.cards.claude.title)).toBeInTheDocument();
    // "Uses its extra usage", never "monthly credits".
    expect(screen.getByText(SCRIPT.brain.cards.claude.line)).toBeInTheDocument();
    expect(SCRIPT.brain.cards.claude.line).toContain('extra usage');
    expect(SCRIPT.brain.cards.claude.line).not.toMatch(/monthly|credits/);
    const cards = within(screen.getByRole('group', { name: SCRIPT.brain.ask })).getAllByRole('button');
    expect(cards[0]).toHaveTextContent(SCRIPT.brain.cards.free.title);
    expect(cards[0]).toHaveTextContent(SCRIPT.brain.cards.free.pill);
    expect(cards[1]).toHaveTextContent(SCRIPT.brain.cards.claude.title);
  });

  it("starts a Claude account on the catalogue's default model", async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { anthropicOAuthEnabled: true }));
    vi.mocked(api.providers).mockResolvedValue({
      vault: { kind: 'file', locked: false, advice: '' },
      providers: [{ kind: 'anthropic', defaultModel: 'claude-opus-5-5' }, { kind: 'openai', defaultModel: 'gpt-5' }],
    } as never);
    vi.mocked(api.saveProviderAccount).mockRejectedValue(new Error('stop here'));
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.claude.title));
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.brain.claude.start }));
    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled());
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ auth: 'anthropic-oauth', defaultModel: 'claude-opus-5-5' });
  });

  it('falls back to Sonnet 5 for Claude when the catalogue names no default', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { anthropicOAuthEnabled: true }));
    vi.mocked(api.saveProviderAccount).mockRejectedValue(new Error('stop here'));
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.claude.title));
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.brain.claude.start }));
    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled());
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ defaultModel: 'claude-sonnet-5' });
  });

  it('says Ollama is there when the machine says so, and offers it', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.ollama).mockResolvedValue({ running: true, models: ['qwen3:4b'], downloadUrl: 'ollama.com/download', baseUrl: 'ollama-on-this-machine/v1', cloudBaseUrl: 'ollama-cloud/v1' });
    render(meet());
    expect(await screen.findByText(SCRIPT.brain.local.found({ ollama: 1 }))).toBeInTheDocument();
  });

  it('names what answered on this computer: Ollama, mlxh, both, or neither', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    const ollamaOn = { running: true, models: ['qwen3:4b', 'gemma4:12b'], downloadUrl: 'ollama.com/download', baseUrl: 'ollama-on-this-machine/v1', cloudBaseUrl: 'ollama-cloud/v1' };
    const mlxhOn = {
      running: true, baseUrl: 'mlxh-on-this-machine/v1', manager: true,
      models: ['bonsai2', 'gemma4-e2b', 'gemma4-e2b-it', 'klein', 'openjev'].map((id) => ({ id, loaded: false })),
    };
    // Neither: nothing local answered.
    let page = render(meet());
    expect(await screen.findByText(SCRIPT.brain.local.missing)).toBeInTheDocument();
    page.unmount();
    // mlxh alone.
    vi.mocked(api.mlxh).mockResolvedValue(mlxhOn);
    page = render(meet());
    expect(await screen.findByText(SCRIPT.brain.local.found({ mlxh: 5 }))).toBeInTheDocument();
    expect(SCRIPT.brain.local.found({ mlxh: 5 })).toContain('I found mlxh with 5 models');
    page.unmount();
    // Both.
    vi.mocked(api.ollama).mockResolvedValue(ollamaOn);
    render(meet());
    const both = SCRIPT.brain.local.found({ ollama: 2, mlxh: 5 });
    expect(both).toContain('I found Ollama with 2 models and mlxh with 5 models');
    expect(await screen.findByText(both)).toBeInTheDocument();
  });

  describe('Ollama on this computer, with no key', () => {
    const machine = (over: Partial<NonNullable<OllamaProbe['machine']>> = {}): NonNullable<OllamaProbe['machine']> => ({
      platform: 'darwin', memoryGb: 16, gpu: 'apple', installed: false,
      recommended: { model: 'qwen3:8b', sizeGb: 5.2 }, install: { url: 'ollama.com/download', command: 'brew install ollama' }, cloudSuggested: false,
      ...over,
    });
    const probe = (over: Partial<OllamaProbe> = {}): OllamaProbe => ({
      running: false, models: [], downloadUrl: 'ollama.com/download', baseUrl: 'ollama-on-this-machine/v1', cloudBaseUrl: 'ollama-cloud/v1', machine: machine(), pull: null, ...over,
    });

    it('shows the official Linux install command to copy, and never runs or fetches anything', async () => {
      vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
      vi.mocked(api.ollama).mockResolvedValue(probe({
        machine: machine({ platform: 'linux', gpu: 'none', cloudSuggested: true, install: { url: 'ollama.com/download', command: 'curl -fsSL https://ollama.com/install.sh | sh' } }),
      }));
      render(meet());
      fireEvent.click(await screen.findByText(SCRIPT.brain.cards.local.title));
      expect(await screen.findByText(SCRIPT.brain.ollama.missing('this computer'))).toBeInTheDocument();
      expect(screen.getByText('curl -fsSL https://ollama.com/install.sh | sh')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: SCRIPT.brain.ollama.copy })).toBeInTheDocument();
      // Slow here: Ollama Cloud is offered, worded for the machine.
      expect(screen.getByText(SCRIPT.brain.ollama.cloud('gpu', 16), { exact: false })).toBeInTheDocument();
      expect(api.ollamaPull).not.toHaveBeenCalled();
      expect(api.saveProviderAccount).not.toHaveBeenCalled();
    });

    it('offers the download and Homebrew on a Mac, then says when it is installed but not running', async () => {
      vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
      vi.mocked(api.ollama).mockResolvedValue(probe());
      const page = render(meet());
      fireEvent.click(await screen.findByText(SCRIPT.brain.cards.local.title));
      expect(await screen.findByText('brew install ollama')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: SCRIPT.brain.ollama.download })).toHaveAttribute('href', 'ollama.com/download');
      expect(screen.getByText(SCRIPT.brain.ollama.cloud(null, 16), { exact: false })).toBeInTheDocument();
      page.unmount();
      vi.mocked(api.ollama).mockResolvedValue(probe({ machine: machine({ installed: true }) }));
      render(meet());
      fireEvent.click(await screen.findByText(SCRIPT.brain.cards.local.title));
      expect(await screen.findByText(SCRIPT.brain.ollama.stopped('darwin'))).toBeInTheDocument();
    });

    it('fetches the model this machine suits with progress, then makes the account once and says what a small model can do', async () => {
      vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
      vi.mocked(api.ollama).mockResolvedValue(probe({ running: true }));
      vi.mocked(api.ollamaPull).mockResolvedValue({ pull: { model: 'qwen3:8b', state: 'pulling', completed: 0, total: 0, status: 'pulling manifest' } });
      const states = [
        { model: 'qwen3:8b', state: 'pulling' as const, completed: 2.6e9, total: 5.2e9, status: 'pulling a' },
        { model: 'qwen3:8b', state: 'done' as const, completed: 5.2e9, total: 5.2e9, status: 'success' },
      ];
      vi.mocked(api.ollamaPullState).mockImplementation(async () => ({ pull: states.length > 1 ? states.shift()! : states[0]! }));
      vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'local' } as never);
      vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
      render(meet());
      fireEvent.click(await screen.findByText(SCRIPT.brain.cards.local.title));
      expect(await screen.findByText(SCRIPT.brain.ollama.empty('this Mac', 16, 'qwen3:8b', 5.2))).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.ollama.fetch('qwen3:8b') }));
      expect(api.ollamaPull).toHaveBeenCalledWith('qwen3:8b');
      expect(await screen.findByText(SCRIPT.brain.ollama.fetching('qwen3:8b', '2.6', '5.2'), {}, { timeout: 3_000 })).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
      await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled(), { timeout: 4_000 });
      expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toEqual({
        label: 'Ollama', kind: 'openai-compatible', auth: 'none', baseUrl: 'ollama-on-this-machine/v1', defaultModel: 'qwen3:8b', enabled: true,
      });
      expect(await screen.findByText(SCRIPT.brain.works('qwen3:8b'))).toBeInTheDocument();
      expect(screen.getByText(SCRIPT.brain.ollama.honest)).toBeInTheDocument();
      expect(api.saveProviderAccount).toHaveBeenCalledTimes(1);
    }, 15_000);

    it('says why a fetch stopped and tries the same model again', async () => {
      vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
      vi.mocked(api.ollama).mockResolvedValue(probe({
        running: true,
        pull: { model: 'qwen3:4b', state: 'failed', completed: 1, total: 10, status: 'pulling a', error: 'Ollama is not answering: reset.' },
      }));
      vi.mocked(api.ollamaPull).mockRejectedValue(new Error('stop here'));
      render(meet());
      fireEvent.click(await screen.findByText(SCRIPT.brain.cards.local.title));
      expect(await screen.findByText(SCRIPT.brain.ollama.failed('Ollama is not answering: reset.'))).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.ollama.again }));
      expect(api.ollamaPull).toHaveBeenCalledWith('qwen3:4b');
    });
  });

  it('makes an mlxh account from the probe and starts on its first language model, a loaded one first', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.saveProviderAccount).mockRejectedValue(new Error('stop here'));
    vi.mocked(api.mlxh).mockResolvedValue({
      running: true, baseUrl: 'mlxh-on-this-machine/v1', manager: true,
      models: [
        { id: 'bonsai2', loaded: false },
        { id: 'klein', loaded: true, kind: 'image' },
        { id: 'gemma4-e2b-it', loaded: true, kind: 'language' },
      ],
    });
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.local.title));
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.brain.mlxh.connect }));
    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled());
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toEqual({
      label: 'mlxh', kind: 'openai-compatible', auth: 'none', baseUrl: 'mlxh-on-this-machine/v1', defaultModel: 'gemma4-e2b-it', enabled: true,
    });
  });

  it('offers the five cards in the kit\'s order: free first, then the plans, a key, and Ollama here last', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { anthropicOAuthEnabled: true, codexEnabled: true }));
    render(meet());
    await screen.findByText(SCRIPT.brain.cards.free.title);
    const titles = within(screen.getByRole('group', { name: SCRIPT.brain.ask })).getAllByRole('button').map((card) => card.textContent ?? '');
    expect(titles.map((text) => ['free', 'claude', 'chatgpt', 'key', 'local'].find((id) => text.startsWith(SCRIPT.brain.cards[id as 'free'].title)))).toEqual(['free', 'claude', 'chatgpt', 'key', 'local']);
    expect(titles[0]).toContain(SCRIPT.brain.cards.free.line);
    // "Use this brain" waits for a brain that answered.
    expect(screen.getByRole('button', { name: SCRIPT.brain.submit })).toBeDisabled();
  });

  it('connects Ollama Cloud: the window opens in the tap, follows the connect page, and the model can change after', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    const cloudRow = { id: 'cloud', label: 'Ollama Cloud', auth: 'device-key', baseUrl: 'https://ollama.com/v1', defaultModel: 'gpt-oss:120b', configured: false };
    let saved = false;
    vi.mocked(api.providerAccounts).mockImplementation(async () => (saved ? accounts([cloudRow]) : accounts()));
    vi.mocked(api.saveProviderAccount).mockImplementation(async () => {
      saved = true;
      return { id: 'cloud' };
    });
    vi.mocked(api.ollamaConnect).mockResolvedValue({ state: 'pending', attemptId: 'try-1', verificationUrl: 'connect-page', deviceName: 'buddi on studio', expiresAt: '' });
    vi.mocked(api.ollamaPoll).mockResolvedValue({ state: 'connected', username: 'amen', deviceName: 'buddi on studio' });
    vi.mocked(api.accountModels).mockResolvedValue({ models: [{ id: 'gpt-oss:120b', name: 'gpt-oss:120b', isDefault: false }, { id: 'glm-5.3', name: 'glm-5.3', isDefault: false }], truncated: false });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    const opened = { location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window);
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.free.title));
    // Inside the tap, before any request: that is what gets past a popup blocker.
    expect(open).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(opened.location.href).toBe('connect-page'));
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ kind: 'openai-compatible', auth: 'device-key', baseUrl: '', defaultModel: 'gpt-oss:120b' });
    expect(api.ollamaConnect).toHaveBeenCalledWith('cloud', 1);
    expect(await screen.findByText(SCRIPT.brain.cloud.waiting)).toBeInTheDocument();
    expect(await screen.findByText(SCRIPT.brain.works('gpt-oss:120b'), undefined, { timeout: 4_000 })).toBeInTheDocument();
    expect(api.ollamaPoll).toHaveBeenCalledWith('cloud', 'try-1');
    expect(api.testProviderAccount).toHaveBeenCalledWith('cloud');

    // The list to change it, under the sentence it changes.
    const other = await screen.findByLabelText(SCRIPT.brain.model.change);
    fireEvent.change(other, { target: { value: 'glm-5.3' } });
    await waitFor(() => expect(vi.mocked(api.saveProviderAccount).mock.calls.at(-1)![0]).toMatchObject({ id: 'cloud', defaultModel: 'glm-5.3' }));
    expect(await screen.findByText(SCRIPT.brain.works('glm-5.3'))).toBeInTheDocument();
  }, 10_000);

  it('says what went wrong when ollama.com refuses, and offers to try again', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{ id: 'cloud', label: 'Ollama Cloud', auth: 'device-key', configured: false }]));
    vi.mocked(api.ollamaConnect).mockResolvedValue({ state: 'pending', attemptId: 'try-1', verificationUrl: 'connect-page', deviceName: 'buddi on studio', expiresAt: '' });
    vi.mocked(api.ollamaPoll).mockResolvedValue({ state: 'failed', message: 'ollama.com refused this device key.' });
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.free.title));
    expect(await screen.findByText('ollama.com refused this device key.', undefined, { timeout: 4_000 })).toBeInTheDocument();
    // The account was already there: reused, not made twice.
    expect(api.saveProviderAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.cloud.again }));
    await waitFor(() => expect(api.ollamaConnect).toHaveBeenCalledTimes(2));
  }, 10_000);

  it('offers ChatGPT right after Claude only when the host allows that sign-in', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { anthropicOAuthEnabled: true, codexEnabled: false }));
    const page = render(meet());
    await screen.findByText(SCRIPT.brain.cards.claude.title);
    expect(screen.queryByText(SCRIPT.brain.cards.chatgpt.title)).not.toBeInTheDocument();
    page.unmount();

    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { anthropicOAuthEnabled: true, codexEnabled: true }));
    render(meet());
    await screen.findByText(SCRIPT.brain.cards.chatgpt.title);
    const cards = within(screen.getByRole('group', { name: SCRIPT.brain.ask })).getAllByRole('button');
    expect(cards[1]).toHaveTextContent(SCRIPT.brain.cards.claude.title);
    expect(cards[2]).toHaveTextContent(SCRIPT.brain.cards.chatgpt.line);
    expect(cards[3]).toHaveTextContent(SCRIPT.brain.cards.key.title);
  });

  it('connects ChatGPT: the code once, the link, waiting, then who signed in and the plan default', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    const pending = { state: 'pending', verificationUrl: 'device-page', userCode: 'ABCD-EFGH', expiresAt: '2099-01-01T00:00:00Z' };
    const row = { id: 'gpt', label: 'ChatGPT', kind: 'codex', auth: 'chatgpt', baseUrl: '', defaultModel: 'gpt-5.5', configured: false };
    let saved = false;
    let login: Record<string, unknown> | null = null;
    vi.mocked(api.providerAccounts).mockImplementation(async () =>
      saved ? accounts([{ ...row, login }], { codexEnabled: true }) : accounts([], { codexEnabled: true }),
    );
    vi.mocked(api.saveProviderAccount).mockImplementation(async () => {
      saved = true;
      return { id: 'gpt' };
    });
    vi.mocked(api.codexAccountAction).mockImplementation(async () => {
      login = pending;
      return pending;
    });
    vi.mocked(api.accountModels).mockResolvedValue({ models: [{ id: 'gpt-5.5', name: 'gpt-5.5', isDefault: false }, { id: 'gpt-5.6', name: 'gpt-5.6', isDefault: true }], truncated: false });
    const open = vi.spyOn(window, 'open');
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.chatgpt.title));
    // No tab opens on the card: the code comes first, then the button opens the page.
    expect(open).not.toHaveBeenCalled();
    expect(await screen.findByText(SCRIPT.brain.chatgpt.instruct)).toBeInTheDocument();
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ kind: 'codex', auth: 'chatgpt', label: 'ChatGPT', defaultModel: 'gpt-5.5' });
    expect(api.codexAccountAction).toHaveBeenCalledWith('gpt', 'login', 1);
    // The code once, in its field, in the large monospace look.
    expect(screen.getByDisplayValue('ABCD-EFGH')).toHaveAttribute('data-code', 'large');
    expect(screen.queryByText('ABCD-EFGH')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: SCRIPT.brain.chatgpt.open });
    expect(link).toHaveAttribute('href', 'device-page');
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(await screen.findByText(SCRIPT.brain.chatgpt.waiting)).toBeInTheDocument();
    expect(screen.queryByText(SCRIPT.brain.chatgpt.instruct)).not.toBeInTheDocument();

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(api.accountModels).mockImplementation(() => held.then(() => ({ models: [{ id: 'gpt-5.5', name: 'gpt-5.5', isDefault: false }, { id: 'gpt-5.6', name: 'gpt-5.6', isDefault: true }], truncated: false })));
    login = { state: 'connected', account: 'amen@example.com' };
    expect(await screen.findByText(SCRIPT.brain.chatgpt.signedIn('amen@example.com'), undefined, { timeout: 4_000 })).toBeInTheDocument();
    release();
    expect(await screen.findByText(SCRIPT.brain.works('gpt-5.6'), undefined, { timeout: 4_000 })).toBeInTheDocument();
    expect(vi.mocked(api.saveProviderAccount).mock.calls.at(-1)![0]).toMatchObject({ id: 'gpt', defaultModel: 'gpt-5.6' });
    expect(api.testProviderAccount).not.toHaveBeenCalled();
    expect(api.codexAccountAction).not.toHaveBeenCalledWith('gpt', 'cancel-login', expect.anything());
    expect(await screen.findByLabelText(SCRIPT.brain.model.change)).toBeInTheDocument();
  }, 10_000);

  it('says why a ChatGPT sign-in failed, offers to try again, and cancels one left pending', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    const row = { id: 'gpt', label: 'ChatGPT', kind: 'codex', auth: 'chatgpt', baseUrl: '', defaultModel: 'gpt-5.5', configured: false };
    let login: Record<string, unknown> | null = null;
    vi.mocked(api.providerAccounts).mockImplementation(async () => accounts([{ ...row, login }], { codexEnabled: true }));
    vi.mocked(api.codexAccountAction).mockImplementation(async (_id, action) => {
      if (action !== 'login') return {};
      login = { state: 'pending', verificationUrl: 'device-page', userCode: 'ABCD-EFGH', expiresAt: '2099-01-01T00:00:00Z' };
      return login;
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.chatgpt.title));
    await screen.findByDisplayValue('ABCD-EFGH');
    // The account was already there: reused, not made twice.
    expect(api.saveProviderAccount).not.toHaveBeenCalled();
    login = { state: 'failed', message: 'Turn on device code sign-in for Codex in ChatGPT settings.' };
    expect(await screen.findByText('Turn on device code sign-in for Codex in ChatGPT settings.', undefined, { timeout: 4_000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.chatgpt.again }));
    await waitFor(() => expect(vi.mocked(api.codexAccountAction).mock.calls.filter((call) => call[1] === 'login')).toHaveLength(2));
    await screen.findByDisplayValue('ABCD-EFGH');
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.back }));
    await waitFor(() => expect(api.codexAccountAction).toHaveBeenCalledWith('gpt', 'cancel-login', 1));
  }, 10_000);

  it('opens the other-service card with the address the server offered', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    render(meet());
    await openKind('service');
    // The page names no address of its own: this is the one the gateway sent.
    expect(await screen.findByDisplayValue('ollama-cloud/v1')).toBeInTheDocument();
  });

  it('falls back to the placeholder when the server offers no address', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.ollama).mockResolvedValue({ running: false, models: [], downloadUrl: 'ollama.com/download', baseUrl: '', cloudBaseUrl: '' });
    render(meet());
    await openKind('service');
    const field = await screen.findByPlaceholderText(SCRIPT.brain.service.addressPlaceholder);
    expect(field).toHaveValue('');
  });

  it('offers Google AI under the key card, between the two other kinds, only when the server names its address', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { codexEnabled: true }));
    const page = render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.key.title));
    expect(await screen.findByRole('radio', { name: SCRIPT.brain.keyKinds.key })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: SCRIPT.brain.keyKinds.gemini })).not.toBeInTheDocument();
    page.unmount();

    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { codexEnabled: true, gemini: GEMINI }));
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.key.title));
    const kinds = within(await screen.findByRole('radiogroup', { name: SCRIPT.brain.keyKinds.label })).getAllByRole('radio').map((r) => r.textContent);
    expect(kinds).toEqual([SCRIPT.brain.keyKinds.key, SCRIPT.brain.keyKinds.gemini, SCRIPT.brain.keyKinds.service]);
  });

  it('connects Gemini with a key: Google\'s address, the newest Pro, and the model can change after', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    const row = { id: 'gem', label: 'Gemini', auth: 'api-key', baseUrl: 'google-compatible/openai', defaultModel: 'gemini-3.1-pro-preview' };
    let saved = false;
    vi.mocked(api.providerAccounts).mockImplementation(async () => accounts(saved ? [row] : [], { gemini: GEMINI }));
    const listed = ['models/gemini-2.5-pro', 'models/gemini-3-pro-image', 'models/gemini-3.8-flash', 'models/gemini-3.1-pro-preview', 'models/gemini-2.5-flash']
      .map((id) => ({ id, name: id, isDefault: false }));
    vi.mocked(api.probeModels).mockResolvedValue({ models: listed, truncated: false });
    vi.mocked(api.accountModels).mockResolvedValue({ models: listed.map((m) => ({ ...m, id: m.id.replace('models/', '') })), truncated: false });
    vi.mocked(api.saveProviderAccount).mockImplementation(async () => {
      saved = true;
      return { id: 'gem' };
    });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    render(meet());
    await openKind('gemini');
    expect(screen.getByRole('link', { name: SCRIPT.brain.gemini.get })).toHaveAttribute('href', GEMINI.keyUrl);
    expect(screen.getByRole('link', { name: SCRIPT.brain.gemini.get })).toHaveAttribute('target', '_blank');
    fireEvent.change(await screen.findByLabelText(SCRIPT.brain.gemini.field), { target: { value: 'AIza-fixture' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.gemini.submit }));
    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled());
    expect(api.probeModels).toHaveBeenCalledWith({ kind: 'openai-compatible', auth: 'api-key', baseUrl: GEMINI.baseUrl, secret: 'AIza-fixture' });
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({
      label: 'Gemini', kind: 'openai-compatible', auth: 'api-key', baseUrl: GEMINI.baseUrl, secret: 'AIza-fixture', defaultModel: 'gemini-3.1-pro-preview',
    });
    // Not asked which: the newest Pro is the answer.
    expect(screen.queryByText(SCRIPT.brain.model.ask)).not.toBeInTheDocument();
    expect(await screen.findByText(SCRIPT.brain.works('gemini-3.1-pro-preview'))).toBeInTheDocument();
    const other = await screen.findByLabelText(SCRIPT.brain.model.change);
    fireEvent.change(other, { target: { value: 'gemini-3.8-flash' } });
    await waitFor(() => expect(vi.mocked(api.saveProviderAccount).mock.calls.at(-1)![0]).toMatchObject({ id: 'gem', defaultModel: 'gemini-3.8-flash' }));
  });

  it('starts a free Google AI key on the newest Flash when Google refuses Pro, and says why', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    let model = 'gemini-3.1-pro';
    let saved = false;
    vi.mocked(api.providerAccounts).mockImplementation(async () =>
      accounts(saved ? [{ id: 'gem', label: 'Gemini', auth: 'api-key', baseUrl: 'google-compatible/openai', defaultModel: model }] : [], { gemini: GEMINI }));
    const listed = ['models/gemini-3.1-pro', 'models/gemini-3.8-flash-lite', 'models/gemini-3.8-flash', 'models/gemini-3.9-flash-image', 'models/gemini-2.5-flash']
      .map((id) => ({ id, name: id, isDefault: false }));
    vi.mocked(api.probeModels).mockResolvedValue({ models: listed, truncated: false });
    vi.mocked(api.accountModels).mockResolvedValue({ models: listed.map((m) => ({ ...m, id: m.id.replace('models/', '') })), truncated: false });
    vi.mocked(api.saveProviderAccount).mockImplementation(async (body) => {
      saved = true;
      model = body.defaultModel;
      return { id: 'gem' };
    });
    vi.mocked(api.testProviderAccount).mockImplementation(async () =>
      model === 'gemini-3.1-pro' ? { state: 'rate-limited', message: 'Google says no Pro.', httpStatus: 429 } : { state: 'connected', message: 'ok' });
    render(meet());
    await openKind('gemini');
    fireEvent.change(await screen.findByLabelText(SCRIPT.brain.gemini.field), { target: { value: 'AIza-fixture' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.gemini.submit }));
    expect(await screen.findByText(SCRIPT.brain.worksOnFlash('gemini-3.8-flash'))).toBeInTheDocument();
    expect(vi.mocked(api.saveProviderAccount).mock.calls.at(-1)![0]).toMatchObject({ id: 'gem', defaultModel: 'gemini-3.8-flash' });
    expect(api.testProviderAccount).toHaveBeenCalledTimes(2);
    expect(api.removeProviderAccount).not.toHaveBeenCalled();
    expect(await screen.findByLabelText(SCRIPT.brain.model.change)).toHaveValue('gemini-3.8-flash');
  });

  it('keeps the key and offers the list when Flash is refused too', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    let model = '';
    let saved = false;
    vi.mocked(api.providerAccounts).mockImplementation(async () =>
      accounts(saved ? [{ id: 'gem', label: 'Gemini', auth: 'api-key', baseUrl: 'google-compatible/openai', defaultModel: model }] : [], { gemini: GEMINI }));
    const listed = ['models/gemini-3.1-pro', 'models/gemini-3.8-flash', 'models/gemini-2.5-flash'].map((id) => ({ id, name: id, isDefault: false }));
    vi.mocked(api.probeModels).mockResolvedValue({ models: listed, truncated: false });
    vi.mocked(api.saveProviderAccount).mockImplementation(async (body) => {
      saved = true;
      model = body.defaultModel;
      return { id: 'gem' };
    });
    vi.mocked(api.removeProviderAccount).mockImplementation(async () => {
      saved = false;
      return {};
    });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'rate-limited', message: 'Google says this key has reached its limit.', httpStatus: 429 });
    render(meet());
    await openKind('gemini');
    fireEvent.change(await screen.findByLabelText(SCRIPT.brain.gemini.field), { target: { value: 'AIza-fixture' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.gemini.submit }));
    expect(await screen.findByText('Google says this key has reached its limit.')).toBeInTheDocument();
    expect(screen.getByLabelText(SCRIPT.brain.gemini.field)).toHaveValue('AIza-fixture');
    const picker = screen.getByLabelText(SCRIPT.brain.model.label);
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['gemini-3.1-pro', 'gemini-3.8-flash', 'gemini-2.5-flash']);
    fireEvent.change(picker, { target: { value: 'gemini-2.5-flash' } });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.gemini.submit }));
    expect(await screen.findByText(SCRIPT.brain.works('gemini-2.5-flash'))).toBeInTheDocument();
    // The list was already there: no second probe.
    expect(api.probeModels).toHaveBeenCalledTimes(1);
  });

  it('asks which model when the service offers several and names no default', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.probeModels).mockResolvedValue({
      models: [
        { id: 'gemma4:31b', name: 'gemma4:31b', isDefault: false },
        { id: 'nemotron:70b', name: 'nemotron:70b', isDefault: false },
      ],
      truncated: false,
    });
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'cloud' });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    render(meet());
    await openKind('service');
    fireEvent.change(await screen.findByLabelText(SCRIPT.brain.service.address), { target: { value: 'a-service/v1' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.service.submit }));
    // `models[0]` would have been arbitrary, so buddi asks instead.
    expect(await screen.findByText(SCRIPT.brain.model.ask)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(SCRIPT.brain.model.label), { target: { value: 'nemotron:70b' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.model.submit }));
    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled());
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ defaultModel: 'nemotron:70b' });
    // And the confirmation names the one they chose.
    expect(await screen.findByText(SCRIPT.brain.works('nemotron:70b'))).toBeInTheDocument();
  });

  it('does not ask when the service names its own default', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.probeModels).mockResolvedValue({
      models: [
        { id: 'gemma4:31b', name: 'gemma4:31b', isDefault: false },
        { id: 'nemotron:70b', name: 'nemotron:70b', isDefault: true },
      ],
      truncated: false,
    });
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'cloud' });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    render(meet());
    await openKind('service');
    fireEvent.change(await screen.findByLabelText(SCRIPT.brain.service.address), { target: { value: 'a-service/v1' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.service.submit }));
    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled());
    expect(screen.queryByText(SCRIPT.brain.model.ask)).not.toBeInTheDocument();
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ defaultModel: 'nemotron:70b' });
  });

  describe('a pasted key is tried before the model list', () => {
    const TWO = {
      models: [
        { id: 'gemma4:31b', name: 'gemma4:31b', isDefault: false },
        { id: 'nemotron:70b', name: 'nemotron:70b', isDefault: false },
      ],
      truncated: false,
    };
    const open = async (): Promise<void> => {
      vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
      // Ollama Cloud lists its models to anyone; the list proves nothing.
      vi.mocked(api.probeModels).mockResolvedValue(TWO);
      vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'cloud' });
      vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{ id: 'cloud', revision: 3 }]));
      render(meet());
      await openKind('service');
      fireEvent.change(await screen.findByLabelText(SCRIPT.brain.service.key), { target: { value: 'nonsense' } });
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.service.submit }));
    };

    it('refuses a wrong key where it was typed, with no picker and nothing left behind', async () => {
      vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'authentication-error', message: 'Ollama Cloud did not accept this key.', httpStatus: 401 });
      await open();
      expect(await screen.findByText(SCRIPT.brain.key.refused)).toBeInTheDocument();
      expect(screen.getByLabelText(SCRIPT.brain.service.address)).toHaveValue('ollama-cloud/v1');
      expect(screen.getByLabelText(SCRIPT.brain.service.key)).toBeInTheDocument();
      expect(screen.queryByText(SCRIPT.brain.model.ask)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(SCRIPT.brain.model.label)).not.toBeInTheDocument();
      expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ defaultModel: 'gemma4:31b', auth: 'api-key' });
      expect(api.removeProviderAccount).toHaveBeenCalledWith('cloud', 3);
    });

    it('keeps the list open with the reason when the key hit a limit', async () => {
      vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'rate-limited', message: 'Ollama Cloud says this key has reached its limit.', httpStatus: 429 });
      await open();
      expect(await screen.findByText('Ollama Cloud says this key has reached its limit.')).toBeInTheDocument();
      const picker = screen.getByLabelText(SCRIPT.brain.model.label);
      expect(picker).toHaveValue('gemma4:31b');
      fireEvent.change(picker, { target: { value: 'nemotron:70b' } });
      vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.model.retry }));
      expect(await screen.findByText(SCRIPT.brain.works('nemotron:70b'))).toBeInTheDocument();
      expect(api.probeModels).toHaveBeenCalledTimes(1);
    });

    it('offers the picker once the key answered', async () => {
      vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
      await open();
      expect(await screen.findByText(SCRIPT.brain.model.ask)).toBeInTheDocument();
      // The trial account is gone; the pick is saved for real.
      expect(api.removeProviderAccount).toHaveBeenCalledWith('cloud', 3);
      fireEvent.change(screen.getByLabelText(SCRIPT.brain.model.label), { target: { value: 'nemotron:70b' } });
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.model.submit }));
      expect(await screen.findByText(SCRIPT.brain.works('nemotron:70b'))).toBeInTheDocument();
      expect(vi.mocked(api.saveProviderAccount).mock.calls[1]![0]).toMatchObject({ defaultModel: 'nemotron:70b' });
    });

    const key = async (): Promise<void> => {
      vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
      vi.mocked(api.probeModels).mockResolvedValue({
        models: [
          { id: 'gpt-5', name: 'gpt-5', isDefault: false },
          { id: 'gpt-5-mini', name: 'gpt-5-mini', isDefault: false },
        ],
        truncated: false,
      });
      vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'k' });
      vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{ id: 'k' }]));
      render(meet());
      fireEvent.click(await screen.findByText(SCRIPT.brain.cards.key.title));
      fireEvent.change(await screen.findByPlaceholderText(SCRIPT.brain.key.placeholder), { target: { value: 'sk-proj-fixture' } });
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.key.submit }));
    };

    it('refuses a wrong key on the key card with no picker', async () => {
      vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'access-denied', message: 'OpenAI says no.', httpStatus: 403 });
      await key();
      expect(await screen.findByText(SCRIPT.brain.key.refused)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(SCRIPT.brain.key.placeholder)).toHaveValue('sk-proj-fixture');
      expect(screen.queryByLabelText(SCRIPT.brain.model.label)).not.toBeInTheDocument();
      expect(api.removeProviderAccount).toHaveBeenCalledWith('k', 1);
    });

    it('offers the key card the list on a limit, and binds on the pick', async () => {
      vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'rate-limited', message: 'OpenAI says this key has reached its limit for gpt-5.', httpStatus: 429 });
      await key();
      expect(await screen.findByText('OpenAI says this key has reached its limit for gpt-5.')).toBeInTheDocument();
      const picker = screen.getByLabelText(SCRIPT.brain.model.label);
      expect(picker).toHaveValue('gpt-5');
      fireEvent.change(picker, { target: { value: 'gpt-5-mini' } });
      vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.model.retry }));
      expect(await screen.findByText(SCRIPT.brain.works('gpt-5-mini'))).toBeInTheDocument();
    });

    it('goes straight on when the key card test passes', async () => {
      vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
      await key();
      expect(await screen.findByText(SCRIPT.brain.works('gpt-5'))).toBeInTheDocument();
      expect(screen.queryByLabelText(SCRIPT.brain.model.label)).not.toBeInTheDocument();
    });
  });

  it('asks Ollama the same question, and skips it when one model is pulled', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'local' });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    vi.mocked(api.ollama).mockResolvedValue({
      running: true,
      models: ['gemma4:12b', 'qwen3:8b'],
      downloadUrl: 'ollama.com/download',
      baseUrl: 'ollama-on-this-machine/v1',
      cloudBaseUrl: 'ollama-cloud/v1',
    });
    const page = render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.local.title));
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.brain.ollama.connect }));
    expect(await screen.findByText(SCRIPT.brain.model.ask)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(SCRIPT.brain.model.label), { target: { value: 'qwen3:8b' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.model.submit }));
    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled());
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ defaultModel: 'qwen3:8b' });
    page.unmount();

    // One model pulled is not a choice.
    vi.clearAllMocks();
    quiet();
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'local' });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    vi.mocked(api.ollama).mockResolvedValue({
      running: true,
      models: ['gemma4:12b'],
      downloadUrl: 'ollama.com/download',
      baseUrl: 'ollama-on-this-machine/v1',
      cloudBaseUrl: 'ollama-cloud/v1',
    });
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.local.title));
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.brain.ollama.connect }));
    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled());
    expect(screen.queryByText(SCRIPT.brain.model.ask)).not.toBeInTheDocument();
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ defaultModel: 'gemma4:12b' });
  });

  it('puts the cursor in the field it just opened', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    render(meet());
    // The key card: one field, and it is the only thing on the screen to type
    // into, so asking for a click first would be asking for nothing.
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.key.title));
    const key = await screen.findByPlaceholderText(SCRIPT.brain.key.placeholder);
    await waitFor(() => expect(key).toHaveFocus());
    // And the address card, whose first field is the address.
    fireEvent.click(screen.getByRole('radio', { name: SCRIPT.brain.keyKinds.service }));
    const address = await screen.findByLabelText(SCRIPT.brain.service.address);
    await waitFor(() => expect(address).toHaveFocus());
  });

  it('keeps a refused key in the thread with the field still open', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.probeModels).mockRejectedValue(new Error('no'));
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'one' });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'authentication-error', message: 'refused', httpStatus: 401 });
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.key.title));
    const field = await screen.findByPlaceholderText(SCRIPT.brain.key.placeholder);
    fireEvent.change(field, { target: { value: 'sk-ant-nope' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.key.submit }));
    expect(await screen.findByText(SCRIPT.brain.key.refused)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(SCRIPT.brain.key.placeholder)).toBeInTheDocument();
  });

  it('says it is checking from the click until the verdict', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.probeModels).mockRejectedValue(new Error('no'));
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'one' });
    let verdict: (value: { state: string; message: string; httpStatus?: number }) => void = () => {};
    vi.mocked(api.testProviderAccount).mockReturnValue(new Promise((resolve) => (verdict = resolve)) as never);
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.key.title));
    fireEvent.change(await screen.findByPlaceholderText(SCRIPT.brain.key.placeholder), { target: { value: 'sk-ant-slow' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.key.submit }));
    expect(await screen.findByText(SCRIPT.brain.checking.key)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SCRIPT.brain.key.submit })).toBeDisabled();
    verdict({ state: 'authentication-error', message: 'refused', httpStatus: 401 });
    expect(await screen.findByText(SCRIPT.brain.key.refused)).toBeInTheDocument();
    expect(screen.queryByText(SCRIPT.brain.checking.key)).not.toBeInTheDocument();
  });

  it('lights "Use this brain" only once the brain answered its one small call, and records it', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.probeModels).mockRejectedValue(new Error('no list'));
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'k' });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    render(meet());
    expect(await screen.findByRole('button', { name: SCRIPT.brain.submit })).toBeDisabled();
    fireEvent.click(screen.getByText(SCRIPT.brain.cards.key.title));
    fireEvent.change(await screen.findByPlaceholderText(SCRIPT.brain.key.placeholder), { target: { value: 'sk-ant-fixture' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.key.submit }));
    expect(await screen.findByText(SCRIPT.brain.works('claude-sonnet-5'))).toBeInTheDocument();
    expect(api.onboardingStep).toHaveBeenCalledWith('model', { accountId: 'k' });
    // The verdict does not move on by itself: the owner reads it, then goes.
    expect(screen.getByText(SCRIPT.brain.title)).toBeInTheDocument();
    const go = screen.getByRole('button', { name: SCRIPT.brain.submit });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    expect(await screen.findByText(SCRIPT.takeOn.title)).toBeInTheDocument();
  });
});

describe('chapter 3: what I take on', () => {
  it('offers six outcomes with My days and My mail on, and moves on at once while they install', async () => {
    atTakeOn();
    let answer: (value: { jobs: Array<{ plugin: string; jobId: string }> }) => void = () => {};
    vi.mocked(api.takeOn).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(meet());
    await screen.findByText(SCRIPT.takeOn.title);
    const tiles = within(screen.getByRole('group', { name: SCRIPT.takeOn.title })).getAllByRole('button');
    expect(tiles).toHaveLength(6);
    expect(tiles.filter((tile) => tile.getAttribute('aria-pressed') === 'true').map((tile) => tile.textContent)).toEqual([
      expect.stringContaining('My days'),
      expect.stringContaining('My mail'),
    ]);
    // Plugin names in small type under each outcome.
    expect(tiles[0]).toHaveTextContent('Weather · Calendar');
    fireEvent.click(tiles[2]!);
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.takeOn.submit }));
    await waitFor(() => expect(api.takeOn).toHaveBeenCalledWith(['days', 'mail', 'money']));
    answer({ jobs: [{ plugin: 'weather', jobId: 'j1' }] });
    // The route answers at once; chapter 4 does not wait for any install.
    expect(await screen.findByText(SCRIPT.reach.title)).toBeInTheDocument();
    expect(mapRows()[2]).toHaveTextContent('My days, my mail, my money');
  });

  it('draws only the tiles the gateway offers: no My code while its plugin is not listed', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(
      view({ stepsDone: ['you', 'model'], details: { accountId: 'a0' }, needs: { owner: false, model: false, agent: true }, offers: ['days', 'mail', 'money', 'voice', 'pictures'] }),
    );
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{}]));
    render(meet());
    await screen.findByText(SCRIPT.takeOn.title);
    const tiles = within(screen.getByRole('group', { name: SCRIPT.takeOn.title })).getAllByRole('button');
    expect(tiles.map((tile) => tile.querySelector('.wiz-opt-title')?.textContent)).toEqual(['My days', 'My mail', 'My money', 'Voice', 'Pictures']);
    expect(screen.queryByText('My code')).not.toBeInTheDocument();
  });

  it('stays a plain assistant with "Just an assistant for now"', async () => {
    atTakeOn();
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.takeOn.none }));
    await waitFor(() => expect(api.takeOn).toHaveBeenCalledWith([]));
    expect(await screen.findByText(SCRIPT.reach.title)).toBeInTheDocument();
    expect(mapRows()[2]).toHaveTextContent(SCRIPT.takeOn.answer([]));
  });

  it('says how the installs are going, on the map while they run, and reads them again every two seconds', async () => {
    atReach(['days']);
    const weather = { plugin: 'weather', title: 'Weather', state: 'ready' as const };
    vi.mocked(api.takeOnProgress)
      .mockResolvedValueOnce(progress({ tiles: ['days'], running: true, plugins: [weather, { plugin: 'calendar', title: 'Calendar', state: 'fetching' }] }))
      .mockResolvedValue(progress({ tiles: ['days'], running: false, plugins: [weather, { plugin: 'calendar', title: 'Calendar', state: 'ready' }] }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(meet());
      await waitFor(() => expect(mapRows()[2]).toHaveTextContent(SCRIPT.takeOn.installing(1, 2)));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TAKE_ON_POLL_MS + 50);
      });
      await waitFor(() => expect(mapRows()[2]).toHaveTextContent(SCRIPT.takeOn.installed));
      expect(api.takeOnProgress).toHaveBeenCalledTimes(2);
      // Back on chapter 3, the line under the tiles says the same.
      fireEvent.click(within(mapRows()[2]!).getByRole('button', { name: SCRIPT.change }));
      expect(await screen.findByText(SCRIPT.takeOn.ready(['Weather', 'Calendar']))).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a fetch that failed in one line, and blocks nothing', async () => {
    atReach(['voice']);
    vi.mocked(api.takeOnProgress).mockResolvedValue(
      progress({ tiles: ['voice'], plugins: [{ plugin: 'speech', title: 'Speech', state: 'failed', reason: 'withbuddi.com did not answer' }] }),
    );
    render(meet());
    // Chapter 4 opened regardless; back on chapter 3 the line says what did not come.
    await screen.findByText(SCRIPT.reach.title);
    fireEvent.click(within(mapRows()[2]!).getByRole('button', { name: SCRIPT.change }));
    expect(await screen.findByText(SCRIPT.takeOn.failed('Speech', 'withbuddi.com did not answer'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SCRIPT.takeOn.submit })).toBeEnabled();
  });
});

describe('chapter 4: reach me', () => {
  const own = (browser: NonNullable<BrowserStatus['browser']>): BrowserStatus =>
    ({ state: 'idle', enabled: true, busy: false, hasScreenshot: false, mode: 'playwright', browser }) as BrowserStatus;

  it('is all optional: Continue records the rows as not done and opens chapter 5', async () => {
    atReach();
    render(meet());
    await screen.findByText(SCRIPT.reach.title);
    expect(screen.getByText(SCRIPT.reach.phone.title)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.reach.mailbox.title)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.reach.app.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.reach.submit }));
    expect(await screen.findByText(SCRIPT.assistant.title)).toBeInTheDocument();
    expect(api.onboardingStep).toHaveBeenCalledWith('reach', { reach: { phone: false, mailbox: false, app: false, browser: false } });
    expect(mapRows()[3]).toHaveTextContent(SCRIPT.reach.answer([]));
  });

  it('names the mailbox for Mail Triage when My mail was taken on', async () => {
    atReach(['mail']);
    render(meet());
    expect(await screen.findByText(SCRIPT.reach.mailbox.forTriage)).toBeInTheDocument();
  });

  it('uses Chrome when it is there, launched once to be sure, downloading nothing', async () => {
    atReach();
    vi.mocked(api.browser).mockResolvedValue(own({ engine: 'chrome', headless: false }));
    vi.mocked(api.browserCheck).mockResolvedValue({ ok: true });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.app.chrome }));
    expect(await screen.findByText(SCRIPT.reach.app.ready('chrome'))).toBeInTheDocument();
    expect(api.browserInstall).not.toHaveBeenCalled();
    expect(api.browserCheck).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.reach.submit }));
    await waitFor(() => expect(api.onboardingStep).toHaveBeenCalledWith('browser'));
    expect(api.onboardingStep).toHaveBeenCalledWith('reach', { reach: { phone: false, mailbox: false, app: false, browser: true } });
  });

  it('fetches one when there is none, with a bar in its own words, checks it opens, then says it is ready', async () => {
    atReach();
    vi.mocked(api.browser)
      // The wizard's own read, then the row's: nothing here yet.
      .mockResolvedValueOnce(own({ engine: 'none', headless: false }))
      .mockResolvedValueOnce(own({ engine: 'none', headless: false }))
      .mockResolvedValueOnce(own({ engine: 'none', headless: false, install: { state: 'running', progress: { phase: 'downloading', percent: 45, what: 'Chromium', download: 1 } } }))
      .mockResolvedValue(own({ engine: 'chromium', headless: false, install: { state: 'done' } }));
    vi.mocked(api.browserInstall).mockResolvedValue(own({ engine: 'none', headless: false, install: { state: 'running' } }));
    vi.mocked(api.browserCheck).mockResolvedValue({ ok: true });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.app.fetch }));
    expect(await screen.findByText(SCRIPT.browser.needs)).toBeInTheDocument();
    expect(await screen.findByText('Fetching Chromium… 45%', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
    expect(await screen.findByText(SCRIPT.reach.app.ready('chromium'), {}, { timeout: 4000 })).toBeInTheDocument();
    expect(api.browserInstall).toHaveBeenCalledOnce();
    expect(api.browserCheck).toHaveBeenCalledOnce();
  });

  it('says why a browser that will not start will not, with the command to copy and Try again', async () => {
    atReach();
    vi.mocked(api.browser).mockResolvedValue(own({ engine: 'chromium', headless: true }));
    vi.mocked(api.browserCheck)
      .mockResolvedValueOnce({
        ok: false,
        problem: 'missing-libraries',
        message: 'The browser is installed, but this machine lacks system libraries it needs. Run once, with sudo:',
        command: 'sudo npx playwright install-deps chromium',
      })
      .mockResolvedValue({ ok: true });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.app.chromium }));
    expect(await screen.findByText(/lacks system libraries it needs/)).toBeInTheDocument();
    expect(screen.getByText('sudo npx playwright install-deps chromium')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.browser.retry }));
    expect(await screen.findByText(SCRIPT.reach.app.ready('chromium'))).toBeInTheDocument();
    expect(api.browserCheck).toHaveBeenCalledTimes(2);
  });

  it('says a system that will not let the browser start its sandbox, with its command to copy', async () => {
    atReach();
    vi.mocked(api.browser).mockResolvedValue(own({ engine: 'chromium', headless: true }));
    vi.mocked(api.browserCheck)
      .mockResolvedValueOnce({
        ok: false,
        problem: 'no-sandbox',
        message: 'The browser is installed, but this system does not let it start its sandbox. On Ubuntu 23.10 or newer, run once, with sudo:',
        command: 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
      })
      .mockResolvedValue({ ok: true });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.app.chromium }));
    expect(await screen.findByText(/does not let it start its sandbox/)).toBeInTheDocument();
    expect(screen.getByText('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.browser.retry }));
    expect(await screen.findByText(SCRIPT.reach.app.ready('chromium'))).toBeInTheDocument();
  });

  it('hands the browser\'s own install prompt over from "Install app"', async () => {
    atReach();
    const prompt = vi.fn(async () => undefined);
    const event = Object.assign(new Event('beforeinstallprompt'), { prompt, userChoice: Promise.resolve({ outcome: 'accepted' as const }) });
    window.dispatchEvent(event);
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.app.install }));
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(await screen.findByText(SCRIPT.reach.app.installed)).toBeInTheDocument();
  });

  it('inside buddi.app says it is in the Dock already: Start at Login and the extension, no install advice', async () => {
    atReach();
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 buddi-mac/0.1.0');
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'accepted' as const }) }));
    try {
      render(meet());
      expect(await screen.findByText(SCRIPT.reach.app.inApp.title)).toBeInTheDocument();
      expect(screen.getByText(SCRIPT.reach.app.inApp.line)).toHaveTextContent('Start at Login in the buddi menu');
      expect(screen.getByRole('link', { name: SCRIPT.reach.app.inApp.extension })).toHaveAttribute('href', expect.stringContaining('chromewebstore.google.com'));
      expect(screen.queryByRole('button', { name: SCRIPT.reach.app.install })).not.toBeInTheDocument();
      expect(screen.queryByText(/Add to Dock/)).not.toBeInTheDocument();
    } finally {
      ua.mockRestore();
    }
  });

  it('outside the app, Safari keeps its Add to Dock line', async () => {
    atReach();
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15');
    try {
      render(meet());
      expect(await screen.findByText('In Safari, choose File → Add to Dock.')).toBeInTheDocument();
      expect(screen.getByText(SCRIPT.reach.app.title)).toBeInTheDocument();
      expect(screen.queryByText(SCRIPT.reach.app.inApp.title)).not.toBeInTheDocument();
    } finally {
      ua.mockRestore();
    }
  });

  it('adds a mailbox in first run\'s own sheet, not the Mail settings page, and says which one', async () => {
    atReach(['mail']);
    vi.mocked(api.pages).mockResolvedValue({
      pages: [{ plugin: 'email', id: 'settings', title: 'Mail', place: 'settings', body: [{ kind: 'notice', text: 'The Mail settings page.' }] }] as never,
    });
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { accounts: [] } });
    vi.mocked(api.pageAct).mockResolvedValue({ result: { added: true, address: 'amen@fastmail.com' } });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.mailbox.add }));
    const sheet = await screen.findByRole('dialog', { name: SHEETS.mailbox.sheet });
    expect(within(sheet).queryByText('The Mail settings page.')).not.toBeInTheDocument();
    expect(within(sheet).getByText(SHEETS.mailbox.which)).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: /Fastmail/ }));
    fireEvent.change(within(sheet).getByLabelText(SHEETS.mailbox.address), { target: { value: 'amen@fastmail.com' } });
    fireEvent.change(within(sheet).getByLabelText(SHEETS.mailbox.password), { target: { value: 'app-pass' } });
    fireEvent.click(within(sheet).getByRole('button', { name: SHEETS.mailbox.submit }));
    expect(await within(sheet).findByText(SHEETS.mailbox.reading)).toBeInTheDocument();
    expect(await screen.findByText('amen@fastmail.com')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 4_000 });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.reach.submit }));
    await waitFor(() => expect(api.onboardingStep).toHaveBeenCalledWith('reach', { reach: { phone: false, mailbox: true, app: false, browser: false } }));
  });

  it('offers the calendar link and the bank only for what chapter 3 took on, each in its own small sheet', async () => {
    atReach(['days', 'money']);
    vi.mocked(api.pages).mockResolvedValue({
      pages: [{ plugin: 'calendar', id: 'settings', title: 'Calendar', place: 'settings', body: [{ kind: 'notice', text: 'The Calendar settings page.' }] }] as never,
    });
    vi.mocked(api.pageQuery).mockImplementation(async (plugin: string) => ({ data: plugin === 'calendar' ? { googleAvailable: false, calendars: [] } : { accounts: [] } }) as never);
    vi.mocked(api.pageAct).mockResolvedValue({ result: { note: 'Linked iCloud calendar (iCloud): 42 events read. The link is kept as a secret.' } });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.calendar.add }));
    const sheet = await screen.findByRole('dialog', { name: SHEETS.calendar.sheet });
    expect(within(sheet).queryByText('The Calendar settings page.')).not.toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText(SHEETS.calendar.field), { target: { value: 'webcal://p01-caldav.icloud.com/published/2/abc' } });
    fireEvent.click(within(sheet).getByRole('button', { name: SHEETS.calendar.submit }));
    expect(await within(sheet).findByText(SHEETS.calendar.events(42))).toBeInTheDocument();
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.add', args: { name: 'iCloud calendar', link: 'webcal://p01-caldav.icloud.com/published/2/abc' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 4_000 });
    expect(screen.getByText(SCRIPT.reach.calendar.linked)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: SCRIPT.reach.bank.add }));
    const bank = await screen.findByRole('dialog', { name: SHEETS.bank.sheet });
    fireEvent.click(within(bank).getByRole('button', { name: SHEETS.bank.ok }));
    expect(await screen.findByText(SCRIPT.reach.bank.later)).toBeInTheDocument();
  });

  it('shows the Google account the calendar plugin says is signed in, on the calendar row', async () => {
    atReach(['days']);
    vi.mocked(api.pages).mockResolvedValue({
      pages: [{ plugin: 'calendar', id: 'settings', title: 'Calendar', place: 'settings', body: [{ kind: 'notice', text: 'The Calendar settings page.' }] }] as never,
    } as never);
    vi.mocked(api.pageQuery).mockImplementation(async (plugin: string, query: string) =>
      ({ data: plugin === 'calendar' && query === 'settings' ? { calendars: [{ id: 'c1', name: 'Home' }], accounts: [{ id: 'g1', kind: 'google', label: 'Google', username: 'amen@gmail.com', needsSignIn: false }] } : { waiting: false } }) as never,
    );
    render(meet());
    expect(await screen.findByText(SCRIPT.reach.calendar.google('amen@gmail.com'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SCRIPT.reach.calendar.add })).not.toBeInTheDocument();
    expect(api.pageQuery).toHaveBeenCalledWith('calendar', 'sign_in');
  });

  it('leaves the calendar and bank rows out when chapter 3 did not take them on', async () => {
    atReach(['mail']);
    render(meet());
    await screen.findByText(SCRIPT.reach.mailbox.forTriage);
    expect(screen.queryByText(SCRIPT.reach.calendar.title)).not.toBeInTheDocument();
    expect(screen.queryByText(SCRIPT.reach.bank.title)).not.toBeInTheDocument();
  });

  it('pairs the phone from a tile in a sheet when the bot is running: waiting, then whose phone, then it closes', async () => {
    atReach();
    let phone = false;
    vi.mocked(api.telegram).mockImplementation(async () => ({ configured: true, running: true, paired: phone }));
    vi.mocked(api.telegramPairing).mockResolvedValue({ code: 'ABC', link: 'https://t.me/amen_buddi_bot?start=ABC', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.phone.pair }));
    const sheet = await screen.findByRole('dialog', { name: SCRIPT.telegram.sheet });
    const tile = await within(sheet).findByTestId('pairing-tile');
    // No token step: the bot is running. The square, its bot, two buttons and the waiting line; never the bare link.
    expect(within(sheet).queryByLabelText(SCRIPT.telegram.field)).not.toBeInTheDocument();
    expect(await within(tile).findByRole('img', { name: 'QR code for @amen_buddi_bot' })).toBeInTheDocument();
    expect(within(tile).getByText('@amen_buddi_bot')).toBeInTheDocument();
    expect(within(tile).getByRole('link', { name: 'Open in Telegram' })).toHaveAttribute('href', 'https://t.me/amen_buddi_bot?start=ABC');
    expect(within(tile).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(within(tile).getByRole('status')).toHaveTextContent(SCRIPT.telegram.waiting);
    expect(screen.queryByText('https://t.me/amen_buddi_bot?start=ABC')).not.toBeInTheDocument();
    phone = true;
    expect(await within(tile).findByText(SCRIPT.telegram.pairedWith('Amen'), {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(SCRIPT.telegram.pairedWith('Amen')).toBe('Paired with Amen’s phone');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 4_000 });
    expect(screen.getByText(SCRIPT.reach.phone.hello)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.reach.phone.paired)).toBeInTheDocument();
  }, 15_000);

  it('copies the pairing link from the tile', async () => {
    atReach();
    vi.mocked(api.telegram).mockResolvedValue({ configured: true, running: true, paired: false });
    vi.mocked(api.telegramPairing).mockResolvedValue({ code: 'ABC', link: 'https://t.me/amen_buddi_bot?start=ABC', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.phone.pair }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://t.me/amen_buddi_bot?start=ABC'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('asks for the BotFather token in a sheet when there is no bot yet, then shows the square', async () => {
    atReach();
    vi.mocked(api.saveTelegramToken).mockResolvedValue({ configured: true, running: true, paired: false, restartNeeded: false, botUsername: 'b' });
    vi.mocked(api.telegramPairing).mockResolvedValue({ code: 'ABC', link: 't.me/b?start=ABC', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.phone.setUp }));
    const token = await screen.findByLabelText(SCRIPT.telegram.field);
    await waitFor(() => expect(token).toHaveFocus());
    fireEvent.change(token, { target: { value: '8012345678:AAHfakeTokenForTestsOnly-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.telegram.submit }));
    expect(await screen.findByText(SCRIPT.telegram.scan)).toBeInTheDocument();
    // The bot the token named, under the square; the link is behind Open in Telegram, not printed.
    expect(within(await screen.findByTestId('pairing-tile')).getByText('@b')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Telegram' })).toHaveAttribute('href', 't.me/b?start=ABC');
    expect(screen.queryByText('t.me/b?start=ABC')).not.toBeInTheDocument();
    // Its actions stay in the sheet: the chapter's own dock is not where they went.
    expect(within(screen.getByRole('dialog', { name: SCRIPT.telegram.sheet })).getByRole('button', { name: SCRIPT.telegram.notNow })).toBeInTheDocument();
  });

  it('lets the owner out of the phone sheet at either step', async () => {
    for (const step of ['token', 'code'] as const) {
      vi.clearAllMocks();
      quiet();
      atReach();
      vi.mocked(api.saveTelegramToken).mockResolvedValue({ configured: true, running: true, paired: false, restartNeeded: false, botUsername: 'b' });
      vi.mocked(api.telegramPairing).mockResolvedValue({ code: 'ABC', link: 't.me/b?start=ABC', expiresAt: new Date(Date.now() + 600_000).toISOString() });
      const page = render(meet());
      fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.phone.setUp }));
      await screen.findByLabelText(SCRIPT.telegram.field);
      if (step === 'code') {
        fireEvent.change(screen.getByLabelText(SCRIPT.telegram.field), { target: { value: '8012345678:AAHfakeTokenForTestsOnly-1234567890' } });
        fireEvent.click(screen.getByRole('button', { name: SCRIPT.telegram.submit }));
        await screen.findByText(SCRIPT.telegram.scan);
      }
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.telegram.notNow }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByText(SCRIPT.reach.title)).toBeInTheDocument();
      page.unmount();
    }
  });

  it('closes the sheet on the phone\'s hello and marks the row paired', async () => {
    atReach();
    vi.mocked(api.saveTelegramToken).mockResolvedValue({ configured: true, running: true, paired: false, restartNeeded: false, botUsername: 'b' });
    vi.mocked(api.telegramPairing).mockResolvedValue({ code: 'ABC', link: 't.me/b?start=ABC', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    vi.mocked(api.telegram).mockResolvedValueOnce({ configured: false, running: false, paired: false }).mockResolvedValue({ configured: true, running: true, paired: true });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.reach.phone.setUp }));
    fireEvent.change(await screen.findByLabelText(SCRIPT.telegram.field), { target: { value: '8012345678:AAHfakeTokenForTestsOnly-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.telegram.submit }));
    expect(await screen.findByText(SCRIPT.telegram.pairedWith('Amen'), {}, { timeout: 5_000 })).toBeInTheDocument();
    // Done closes it at once; left alone it closes by itself a beat later.
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.telegram.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(SCRIPT.reach.phone.hello)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.reach.submit }));
    await waitFor(() => expect(api.onboardingStep).toHaveBeenCalledWith('reach', { reach: { phone: true, mailbox: false, app: false, browser: false } }));
  });
});

describe('chapter 5: your assistant', () => {
  it('offers a name, a colour and the persona, and names the team chapter 3 brought', async () => {
    atAssistant(['days', 'mail']);
    render(meet());
    expect(await screen.findByText(SCRIPT.assistant.title)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.assistant.ask + SCRIPT.assistant.team(['Mail Triage']))).toBeInTheDocument();
    // The persona, whole, in a field that holds more than a line.
    const purpose = screen.getByLabelText(SCRIPT.assistant.purpose);
    expect(purpose.tagName).toBe('TEXTAREA');
    expect(purpose).toHaveValue(SCRIPT.assistant.purposeValue);
    expect(SCRIPT.assistant.purposeValue).toMatch(/^You're not a chatbot\. You're becoming someone this person can count on\.\n/);
    // The brand is who the owner meets unless they change it, in its own blue.
    expect(screen.getByDisplayValue(DEFAULT_ASSISTANT_NAME)).toBeInTheDocument();
    const swatches = within(screen.getByRole('group', { name: SCRIPT.assistant.colour })).getAllByRole('button');
    expect(swatches).toHaveLength(5);
    expect(swatches[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('binds the assistant to the account that was just tested', async () => {
    atAssistant();
    vi.mocked(api.onboarding).mockResolvedValue(
      view({ stepsDone: ['reach'], details: { accountId: 'tested', takeOn: [], reach: {} }, needs: { owner: false, model: false, agent: true } }),
    );
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{ id: 'tested' }]));
    vi.mocked(api.createFirstAgent).mockResolvedValue({ agent: null, id: 'ada', handle: 'ada', file: '', live: true, accountId: 'tested' });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.assistant.submit }));
    await waitFor(() => expect(api.createFirstAgent).toHaveBeenCalled());
    expect(vi.mocked(api.createFirstAgent).mock.calls[0]![0]).toMatchObject({ accountId: 'tested', instructions: SCRIPT.assistant.purposeValue });
  });

  it('gives the assistant the Blob of its colour as its real picture, through the avatar upload', async () => {
    atAssistant();
    vi.mocked(api.createFirstAgent).mockResolvedValue({ agent: null, id: 'concierge', handle: 'buddi', file: '', live: true, accountId: 'a0' });
    vi.mocked(api.uploadAgentPicture).mockResolvedValue({ picture: '/api/agents/concierge/avatar?v=1', side: 256, source: 'png' });
    const fetched = vi.fn(async () => new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetched);
    try {
      render(meet());
      fireEvent.click(await screen.findByRole('button', { name: SCRIPT.assistant.swatch('Purple') }));
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.assistant.submit }));
      await waitFor(() => expect(api.uploadAgentPicture).toHaveBeenCalled());
      const body = vi.mocked(api.createFirstAgent).mock.calls[0]![0];
      expect(body).toMatchObject({ name: 'buddi', handle: 'buddi' });
      // A colour is a picture, not an emoji in the file.
      expect(body.avatar).toBeUndefined();
      expect(fetched).toHaveBeenCalledWith('./mascot/research.png');
      const [id, file] = vi.mocked(api.uploadAgentPicture).mock.calls[0]!;
      expect(id).toBe('concierge');
      expect(file.type).toBe('image/png');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('turns a refusal into a notice with the way to Agents, and keeps the button down', async () => {
    atAssistant();
    const message = 'You already have an agent of your own. Add another one from the Agents page.';
    vi.mocked(api.createFirstAgent).mockRejectedValue(new ApiError(409, message, { error: message, code: 'assistant-exists' }));
    const navigate = vi.fn();
    render(meet(navigate));
    const submit = await screen.findByRole('button', { name: SCRIPT.assistant.submit });
    fireEvent.click(submit);
    expect(await screen.findByText(SCRIPT.assistant.refusedTitle)).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SCRIPT.assistant.submit })).toBeDisabled();
    fireEvent.click(screen.getByRole('link', { name: SCRIPT.assistant.toAgents }));
    expect(navigate).toHaveBeenCalledWith('#/agents');
    expect(api.createFirstAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps any other 409 inline and lets the owner correct it and try again', async () => {
    atAssistant();
    const message = '@sam is already Sam. Pick another one.';
    vi.mocked(api.createFirstAgent)
      .mockRejectedValueOnce(new ApiError(409, message, { error: message }))
      .mockResolvedValueOnce({ agent: null, id: 'samwise', handle: 'samwise', file: '', live: true, accountId: null });
    render(meet());
    const submit = await screen.findByRole('button', { name: SCRIPT.assistant.submit });
    fireEvent.click(submit);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(SCRIPT.assistant.refusedTitle)).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue(DEFAULT_ASSISTANT_NAME), { target: { value: 'Samwise' } });
    const again = screen.getByRole('button', { name: SCRIPT.assistant.submit });
    expect(again).toBeEnabled();
    fireEvent.click(again);
    await waitFor(() => expect(api.createFirstAgent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.createFirstAgent).mock.calls[1]![0]).toMatchObject({ name: 'Samwise', handle: 'samwise' });
  });
});

describe('the handover', () => {
  /** Everything answered: the wizard is at the handover. */
  function ready(details: OnboardingView['details'] = { accountId: 'a0' }): void {
    vi.mocked(api.onboarding).mockResolvedValue(view({ state: 'in-progress', details, needs: { owner: false, model: false, agent: false } }));
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{}], { bindings: [{ agentId: 'ada', accountId: 'a0', model: 'qwen3:4b' }] }));
    vi.mocked(chatApi.agents).mockResolvedValue({
      agents: [{ id: 'ada', handle: 'ada', name: 'Ada', description: '', available: true, roles: [], provider: 'anthropic', model: 'qwen3:4b' }],
      defaultAgentId: 'ada',
    });
    vi.mocked(chatApi.startConversation).mockResolvedValue({ conversationId: 'c1' });
    vi.mocked(chatApi.send).mockResolvedValue({ conversationId: 'c1', runId: 'r1' });
  }
  const hello = (text = "I'm Ada. I can remember things for you.") =>
    vi.mocked(chatApi.conversation).mockResolvedValue({ id: 'c1', agentId: 'ada', messages: [{ id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text', text }] }], runs: [] } as never);

  it('has the assistant speak first, on a turn the owner never sees sent as its own kind', async () => {
    ready();
    hello();
    render(meet());
    expect(await screen.findByText(/I'm Ada\./)).toBeInTheDocument();
    // The instruction is marked as first run's, which is what keeps it out of
    // the transcript, the history and Activity — the server does the hiding.
    await waitFor(() => expect(chatApi.send).toHaveBeenCalled());
    expect(vi.mocked(chatApi.send).mock.calls[0]![1]).toMatchObject({ conversationId: 'c1', opening: true });
    // And the conversation is on the record before the turn goes out, so a
    // reload rejoins it instead of opening a second one.
    expect(api.onboardingStep).toHaveBeenCalledWith('hello', { conversationId: 'c1' });
    // Nothing is completed from here: the server recorded that when it claimed
    // the opening turn, which is the moment nothing was left to set up.
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    // Every chapter is ticked on the map.
    expect(mapRows().every((row) => row.getAttribute('data-state') === 'done')).toBe(true);
  });

  it('offers four first questions from what was set up, and sends the one tapped as the first message', async () => {
    ready({ accountId: 'a0', conversationId: 'c1', takeOn: ['days', 'mail'], reach: {} });
    hello();
    const navigate = vi.fn();
    render(meet(navigate));
    const starters = within(await screen.findByRole('group', { name: SCRIPT.handover.starterLabel })).getAllByRole('button');
    expect(starters.map((b) => b.textContent)).toEqual(['What’s my day like?', 'Show me around', 'Link my calendar', 'Remind me at 9 tomorrow']);
    fireEvent.click(starters[0]!);
    await waitFor(() => expect(chatApi.send).toHaveBeenCalledWith('ada', { conversationId: 'c1', text: 'What’s my day like?' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/chat/ada/c1', true));
  });

  it('asks who the owner wants on the team, from what chapters 3 and 4 set up', async () => {
    ready({ accountId: 'a0', conversationId: 'c1', takeOn: ['days', 'money'], reach: {} });
    hello();
    const listed = (name: string, title: string) => ({
      name, version: '1.0.0', handle: name, title, pitch: `${title} pitch.`, description: '', about: '', category: 'work', trust: 'by-buddi',
      author: { name: 'withbuddi' }, requires: {}, optional: {}, needs: [], tools: ['memory.*'], missions: [], fills: [], examples: [],
      skills: [], changes: '', replaces: [], avatar: null, page: null, state: 'ready' as const, addable: true,
    });
    vi.mocked(api.catalogue).mockResolvedValue({
      agents: [listed('chief-of-staff', 'Chief of Staff'), listed('cfo', 'CFO'), listed('researcher', 'Researcher'), listed('tutor', 'Tutor')],
      fromPlugins: [], delisted: [],
    });
    render(meet());
    const card = await screen.findByTestId('handover-team');
    expect(within(card).getByText('Who do you want on your team?')).toBeInTheDocument();
    // Each with its reason: the two the setup picked say why, the filler says popular.
    expect([...card.querySelectorAll('.cat-pick-name')].map((n) => n.textContent)).toEqual([
      'Chief of Staffbecause you set up My days',
      'CFObecause you set up My money',
      'Researcherpopular',
    ]);
    expect(within(card).getAllByRole('checkbox').every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(within(card).getByRole('button', { name: 'Add these' })).toBeEnabled();
  });

  it('picks from chapter 3 as the take-on record keeps it, and names who is already on the team', async () => {
    // The page reloaded since chapter 3: its own answers lost the tiles; the record has them.
    ready({ accountId: 'a0', conversationId: 'c1', takeOn: [], reach: {} });
    hello();
    vi.mocked(api.takeOnProgress).mockResolvedValue(progress({ tiles: ['pictures', 'mail'] }));
    vi.mocked(chatApi.agents).mockResolvedValue({
      agents: [
        { id: 'ada', handle: 'ada', name: 'Ada', roles: ['front-desk'] },
        { id: 'mail-triage', handle: 'mail', name: 'Mail Triage', roles: [] },
        { id: 'agent-father', handle: 'father', name: 'Agent Father', roles: ['maker'] },
      ] as never,
      defaultAgentId: 'ada',
    });
    const listed = (name: string, title: string) => ({
      name, version: '1.0.0', handle: name, title, pitch: `${title} pitch.`, description: '', about: '', category: 'work', trust: 'by-buddi',
      author: { name: 'withbuddi' }, requires: {}, optional: {}, needs: [], tools: ['memory.*'], missions: [], fills: [], examples: [],
      skills: [], changes: '', replaces: [], avatar: null, page: null, state: 'ready' as const, addable: true,
    });
    vi.mocked(api.catalogue).mockResolvedValue({
      agents: [listed('chief-of-staff', 'Chief of Staff'), listed('illustrator', 'Illustrator'), listed('researcher', 'Researcher')],
      fromPlugins: [], delisted: [],
    });
    render(meet());
    const card = await screen.findByTestId('handover-team');
    await waitFor(() =>
      expect([...card.querySelectorAll('.cat-pick-name')].map((n) => n.textContent)).toEqual([
        'Chief of Staffbecause you set up My mail',
        'Illustratorbecause you set up Pictures',
        'Researcherpopular',
      ]),
    );
    expect(await within(card).findByTestId('handover-team-now')).toHaveTextContent('On your team: Ada and Mail Triage.');
  });

  it('shows the warm card with exactly what is still waiting, and Open Home', async () => {
    ready({ accountId: 'a0', conversationId: 'c1', takeOn: ['days', 'mail'], reach: {} });
    hello();
    const waiting = ['Mail Triage is waiting for a mailbox', 'Calendar wants your calendar’s private link'];
    vi.mocked(api.takeOnProgress).mockResolvedValue(progress({ tiles: ['days', 'mail'], waiting }));
    const navigate = vi.fn();
    render(meet(navigate));
    expect(await screen.findByText(SCRIPT.handover.waitingTitle(2))).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.handover.waitingBody(waiting))).toBeInTheDocument();
    expect(SCRIPT.handover.waitingBody(waiting)).toBe('Mail Triage is waiting for a mailbox and Calendar wants your calendar’s private link. Both are on Home whenever you like.');
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.handover.home }));
    expect(navigate).toHaveBeenCalledWith('#/', true);
  });

  it('draws no waiting card when nothing is waiting', async () => {
    ready({ accountId: 'a0', conversationId: 'c1', takeOn: [], reach: {} });
    hello();
    render(meet());
    await screen.findByRole('group', { name: SCRIPT.handover.starterLabel });
    expect(screen.queryByRole('button', { name: SCRIPT.handover.home })).not.toBeInTheDocument();
  });

  it('rejoins the conversation the record already names instead of opening another', async () => {
    ready({ accountId: 'a0', conversationId: 'c-earlier' });
    vi.mocked(chatApi.conversation).mockResolvedValue({
      id: 'c-earlier',
      agentId: 'ada',
      messages: [{ id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Still me, Ada.' }] }],
    } as never);
    render(meet());
    expect(await screen.findByText('Still me, Ada.')).toBeInTheDocument();
    expect(chatApi.startConversation).not.toHaveBeenCalled();
    expect(chatApi.send).not.toHaveBeenCalled();
    expect(chatApi.conversation).toHaveBeenCalledWith('c-earlier');
  });

  it('stops offering to set up later once the assistant has spoken, and offers the way to the conversation', async () => {
    ready({ accountId: 'a0', conversationId: 'c1' });
    hello();
    render(meet());
    expect(await screen.findByText(/I'm Ada\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: SCRIPT.done.open })).toHaveAttribute('href', '#/chat/ada/c1'));
    // A render of its own: the link can be drawn a commit before the offer goes.
    await waitFor(() => expect(screen.queryByRole('button', { name: SCRIPT.later })).not.toBeInTheDocument());
  });

  it('sends a reload after first run to the conversation it happened in', async () => {
    ready({ accountId: 'a0', conversationId: 'c1' });
    vi.mocked(api.onboarding).mockResolvedValue(
      view({ state: 'done', details: { accountId: 'a0', conversationId: 'c1' }, needs: { owner: false, model: false, agent: false } }),
    );
    const navigate = vi.fn();
    render(meet(navigate));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/chat/ada/c1', true));
    // Nothing of the wizard is drawn on the way past.
    expect(screen.queryByText(SCRIPT.hello.title)).not.toBeInTheDocument();
  });

  it('sends it Home when the record names no conversation', async () => {
    ready();
    vi.mocked(api.onboarding).mockResolvedValue(view({ state: 'done', details: {}, needs: { owner: false, model: false, agent: false } }));
    const navigate = vi.fn();
    render(meet(navigate));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/', true));
  });

  /** One run, still going. A brain on this computer is slow, not broken. */
  const alive = { runId: 'r1', surface: 'web', startedAt: '', finishedAt: null, turns: null, stopped: null, usage: { input: 0, output: 0 }, actionId: null, resumed: false };

  it('waits while the run is alive, and says why rather than giving up at a minute', async () => {
    vi.useFakeTimers();
    try {
      ready();
      vi.mocked(chatApi.conversation).mockResolvedValue({ id: 'c1', agentId: 'ada', messages: [], runs: [alive] } as never);
      render(meet());
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(PATIENCE_MS + 2_000);
      expect(screen.getByText(SCRIPT.handover.slow)).toBeInTheDocument();
      expect(screen.queryByText(SCRIPT.handover.silent)).not.toBeInTheDocument();
      // Still nothing after five minutes is the end of waiting, even alive.
      await vi.advanceTimersByTimeAsync(FIRST_MESSAGE_TIMEOUT_MS);
      expect(screen.getByText(SCRIPT.handover.silent)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up at once when the run ended without a word, and offers another brain', async () => {
    vi.useFakeTimers();
    try {
      ready();
      vi.mocked(chatApi.conversation).mockResolvedValue({
        id: 'c1',
        agentId: 'ada',
        messages: [],
        runs: [{ ...alive, finishedAt: '2026-09-20T16:36:40.079Z', stopped: 'error' }],
      } as never);
      render(meet());
      await vi.advanceTimersByTimeAsync(10);
      expect(screen.getByText(SCRIPT.handover.silent)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: SCRIPT.handover.again })).toBeInTheDocument();
      expect(screen.queryByText(SCRIPT.handover.slow)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.handover.again }));
      await vi.advanceTimersByTimeAsync(10);
      expect(screen.getByText(SCRIPT.brain.title)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * A model that writes its reasoning into its own answer is the runtime's
   * problem, and it is fixed there — but the card must not be the thing that
   * shows it if anything ever slips through again.
   */
  it('never draws what the assistant thought, only what it said', async () => {
    ready();
    vi.mocked(chatApi.conversation).mockResolvedValue({
      id: 'c1',
      agentId: 'ada',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          at: '',
          blocks: [
            { type: 'thinking', text: 'The owner is Amen, setup is finished. I should introduce myself…' },
            { type: 'tool_use', id: 't1', name: 'owner.get_profile', input: {} },
            { type: 'text', text: "I'm Ada." },
          ],
        },
      ],
      runs: [],
    } as never);
    render(meet());
    expect(await screen.findByText("I'm Ada.")).toBeInTheDocument();
    expect(screen.queryByText(/I should introduce myself/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Thought for|Thoughts/)).not.toBeInTheDocument();
    // And the tool it called is not a row on this screen either.
    expect(screen.queryByText(/get_profile/)).not.toBeInTheDocument();
  });

  it('says nothing about waiting once the assistant has spoken', async () => {
    vi.useFakeTimers();
    try {
      ready();
      vi.mocked(chatApi.conversation).mockResolvedValue({
        id: 'c1',
        agentId: 'ada',
        messages: [{ id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text', text: "I'm Ada." }] }],
        runs: [alive],
      } as never);
      render(meet());
      await vi.advanceTimersByTimeAsync(PATIENCE_MS + FIRST_MESSAGE_TIMEOUT_MS);
      expect(screen.queryByText(SCRIPT.handover.slow)).not.toBeInTheDocument();
      expect(screen.queryByText(SCRIPT.handover.silent)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('change', () => {
  /** Answered through the assistant, so every chapter carries a change link. */
  function met(): void {
    vi.mocked(api.onboarding).mockResolvedValue(
      view({ state: 'in-progress', details: { accountId: 'a0', conversationId: 'c1' }, needs: { owner: false, model: false, agent: false } }),
    );
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{}], { bindings: [{ agentId: 'ada', accountId: 'a0', model: 'qwen3:4b' }] }));
    vi.mocked(chatApi.agents).mockResolvedValue({
      agents: [{ id: 'ada', handle: 'ada', name: 'Ada', description: 'Whatever I ask.', available: true, roles: [], provider: 'openai-compatible', model: 'qwen3:4b', avatar: { kind: 'emoji', value: '📚' } }],
      defaultAgentId: 'ada',
    });
    vi.mocked(chatApi.conversation).mockResolvedValue({ id: 'c1', agentId: 'ada', messages: [] } as never);
  }

  it('changes the assistant in place rather than trying to write a second one, keeping its face', async () => {
    met();
    vi.mocked(api.updateFirstAgent).mockResolvedValue({ agent: null, id: 'ada', handle: 'ada', file: '', live: true, accountId: null });
    render(meet());
    // The assistant's row is the last one on the map; its change link reopens
    // the chapter with what the installation actually holds.
    const changes = await screen.findAllByRole('button', { name: SCRIPT.change });
    fireEvent.click(changes[changes.length - 1]!);
    expect(await screen.findByDisplayValue('Ada')).toBeInTheDocument();
    // The persona from its file, not the card line.
    expect(await screen.findByDisplayValue('Keep my books. Nothing else.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Whatever I ask.')).not.toBeInTheDocument();
    // Its emoji face is kept: no colour is chosen for it.
    expect(within(screen.getByRole('group', { name: SCRIPT.assistant.colour })).getAllByRole('button').every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.assistant.submit }));
    await waitFor(() => expect(api.updateFirstAgent).toHaveBeenCalled());
    expect(api.createFirstAgent).not.toHaveBeenCalled();
    expect(api.uploadAgentPicture).not.toHaveBeenCalled();
    // Untouched, nothing is sent back as a persona, and the card line never is.
    expect(vi.mocked(api.updateFirstAgent).mock.calls[0]![0]).not.toHaveProperty('instructions');
    expect(vi.mocked(api.updateFirstAgent).mock.calls[0]![0]).not.toHaveProperty('description');
  });

  it('sends the persona back only when the owner edited it', async () => {
    met();
    vi.mocked(api.updateFirstAgent).mockResolvedValue({ agent: null, id: 'ada', handle: 'ada', file: '', live: true, accountId: null });
    render(meet());
    const changes = await screen.findAllByRole('button', { name: SCRIPT.change });
    fireEvent.click(changes[changes.length - 1]!);
    const field = await screen.findByDisplayValue('Keep my books. Nothing else.');
    fireEvent.change(field, { target: { value: 'Keep my books and my calendar.' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.assistant.submit }));
    await waitFor(() => expect(api.updateFirstAgent).toHaveBeenCalled());
    expect(vi.mocked(api.updateFirstAgent).mock.calls[0]![0]).toMatchObject({ instructions: 'Keep my books and my calendar.' });
    expect(vi.mocked(api.updateFirstAgent).mock.calls[0]![0]).not.toHaveProperty('description');
  });

  it('moves the assistant onto the new brain when the brain changes', async () => {
    met();
    vi.mocked(api.probeModels).mockRejectedValue(new Error('no list'));
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'second' });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    vi.mocked(api.bindBrain).mockResolvedValue({ assistant: 'ada', followed: ['agent-father'] });
    render(meet());
    const changes = await screen.findAllByRole('button', { name: SCRIPT.change });
    // Hello, brain, take on, reach, assistant — the brain's is the second.
    fireEvent.click(changes[1]!);
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.key.title));
    fireEvent.change(screen.getByPlaceholderText(SCRIPT.brain.key.placeholder), { target: { value: 'sk-ant-new' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.key.submit }));
    // One call moves the assistant and anything following it.
    await waitFor(() => expect(api.bindBrain).toHaveBeenCalledWith({ accountId: 'second', model: 'claude-sonnet-5' }));
    // And buddi names the model the assistant was actually moved onto.
    expect(await screen.findByText(SCRIPT.brain.works('claude-sonnet-5'))).toBeInTheDocument();
  });
});

describe('set up later', () => {
  it('goes home only when the server agrees it was recorded', async () => {
    vi.mocked(api.skipOnboarding).mockRejectedValue(new Error('the database is not there'));
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.later }));
    expect(await screen.findByText(/the database is not there/)).toBeInTheDocument();
  });
});

describe('start over', () => {
  it('is not offered in chapter 1 with nothing answered, and is from chapter 2', async () => {
    vi.mocked(api.setOwner).mockResolvedValue(owner({ preferredName: 'Amen' }));
    render(meet());
    const field = await screen.findByPlaceholderText(SCRIPT.name.placeholder);
    expect(screen.queryByRole('button', { name: SCRIPT.startOver.link })).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'Amen' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.hello.submit }));
    expect(await screen.findByRole('button', { name: SCRIPT.startOver.link })).toBeInTheDocument();
  });

  it('cancels a Claude sign-in waiting for its code and opens chapter 1 again', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(
      accounts([{ id: 'claude', label: 'Claude', kind: 'anthropic', auth: 'anthropic-oauth', configured: false }], { anthropicOAuthEnabled: true }),
    );
    vi.mocked(api.anthropicAccountAction).mockResolvedValue({ verificationUrl: 'consent-page', attemptId: 't1' } as never);
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.claude.title));
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.brain.claude.start }));
    expect(await screen.findByText(SCRIPT.brain.claude.waiting)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.startOver.link }));
    await waitFor(() => expect(api.anthropicAccountAction).toHaveBeenCalledWith('claude', 'cancel-login', 2));
    expect(await screen.findByPlaceholderText(SCRIPT.name.placeholder)).toHaveValue('');
    expect(screen.queryByText(SCRIPT.brain.title)).not.toBeInTheDocument();
    // Nothing was connected, so buddi says nothing about what stays.
    await waitFor(() => expect(api.telegram).toHaveBeenCalled());
    expect(screen.queryByText(/Starting again/)).not.toBeInTheDocument();
  });

  it('names what stays in Settings, and meets the connected brain as answered', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ state: 'in-progress', stepsDone: ['you', 'model'], details: { accountId: 'a0' }, needs: { owner: false, model: false, agent: true } }));
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{ label: 'Claude', defaultModel: 'claude-sonnet-5' }]));
    vi.mocked(api.telegram).mockResolvedValue({ configured: true, running: true, paired: true });
    vi.mocked(api.setOwner).mockImplementation(async (body) => owner({ preferredName: 'Amen', timezone: 'UTC', ...body }));
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.startOver.link }));
    expect(await screen.findByText(SCRIPT.startOver.said(`Claude, ${SCRIPT.startOver.telegram}`))).toBeInTheDocument();
    fireEvent.change(await screen.findByPlaceholderText(SCRIPT.name.placeholder), { target: { value: 'Amen' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.hello.submit }));
    // The brain is not asked again: it is there, ticked with its change link.
    expect(await screen.findByText(SCRIPT.takeOn.title)).toBeInTheDocument();
    expect(mapRows()[1]).toHaveTextContent('Claude');
    expect(within(mapRows()[1]!).getByRole('button', { name: SCRIPT.change })).toBeInTheDocument();
  });
});

describe('every word of it', () => {
  it('renders nothing from the list of words that are ours, not theirs, in any chapter', async () => {
    const seen: string[] = [];
    for (const at of [() => {}, () => atTakeOn(), () => atReach(['mail']), () => atAssistant(['days'])]) {
      vi.clearAllMocks();
      quiet();
      at();
      const { container, unmount } = render(meet());
      await waitFor(() => expect(container.querySelector('.wiz-title')).not.toBeNull());
      seen.push((container.textContent ?? '').toLowerCase());
      unmount();
    }
    for (const text of seen) for (const word of BANNED_WORDS) expect(text.includes(word), `the screen says "${word}"`).toBe(false);
  });
});

describe('the calendar row reads the calendar plugin', () => {
  it('says whose Google account, a sign-in under way, one to sign in again, or a private link', () => {
    const google = (needsSignIn: boolean) => ({ kind: 'google', username: 'amen@gmail.com', needsSignIn });
    expect(calendarRowState({ accounts: [google(false)], calendars: [{}] }, {})).toMatchObject({ kind: 'google', label: 'Google · amen@gmail.com' });
    expect(calendarRowState({ accounts: [] }, { waiting: true })).toMatchObject({ kind: 'waiting', label: SCRIPT.reach.calendar.googleWaiting });
    expect(calendarRowState({ accounts: [google(true)], calendars: [{}] }, {})).toMatchObject({ kind: 'expired', tone: 'warning' });
    expect(calendarRowState({ accounts: [], calendars: [{}] }, {})).toMatchObject({ kind: 'linked', label: SCRIPT.reach.calendar.linked });
    expect(calendarRowState({ accounts: [], calendars: [] }, {})).toBeNull();
  });
});

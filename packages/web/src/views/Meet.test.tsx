/**
 * First run, as the owner sees it.
 *
 * Who is sent here, what each question looks like, and the two endings that
 * have to be right: an answer that saves and moves the thread on, and an
 * assistant that never speaks leaving the owner a way forward rather than a
 * spinner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, chatApi, type OnboardingView, type OwnerView, type ProviderAccountsView } from '../api';
import { App } from '../App';
import { Meet, FIRST_MESSAGE_TIMEOUT_MS, LEAVE_MS, PATIENCE_MS } from './Meet';
import { BANNED_WORDS, SCRIPT } from './meet/script';

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
      createFirstAgent: vi.fn(),
      updateFirstAgent: vi.fn(),
      assignProviderAccount: vi.fn(),
      bindBrain: vi.fn(),
      owner: vi.fn(),
      setOwner: vi.fn(),
      providerAccounts: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      probeModels: vi.fn(),
      ollama: vi.fn(),
      telegram: vi.fn(),
      saveTelegramToken: vi.fn(),
      telegramPairing: vi.fn(),
      session: vi.fn(),
      overview: vi.fn(),
      conversations: vi.fn(),
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

/** Every call the screen makes that a given test is not about. */
function quiet(): void {
  vi.mocked(api.session).mockResolvedValue({ csrf: 'x', timezone: 'UTC', host: '127.0.0.1', port: 4317 });
  vi.mocked(api.onboarding).mockResolvedValue(view());
  vi.mocked(api.owner).mockResolvedValue(owner());
  vi.mocked(api.providerAccounts).mockResolvedValue(accounts());
  vi.mocked(api.ollama).mockResolvedValue({ running: false, models: [], downloadUrl: 'ollama.com/download', baseUrl: 'ollama-on-this-machine/v1', cloudBaseUrl: 'ollama-cloud/v1' });
  vi.mocked(api.onboardingStep).mockResolvedValue(view());
  vi.mocked(chatApi.agents).mockResolvedValue({ agents: [], defaultAgentId: '' });
  for (const call of [api.overview, api.conversations, chatApi.groups]) {
    vi.mocked(call as () => Promise<unknown>).mockRejectedValue(new Error('not in this test'));
  }
  // No theatre in a test: the reduced-motion path renders every bubble at once.
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
  quiet();
});

const meet = (navigate: (next: string, replace?: boolean) => void = () => {}): JSX.Element => (
  <Meet navigate={navigate} timezone="UTC" />
);

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

describe('the questions', () => {
  it('opens with buddi saying hello and asking for a name', async () => {
    render(meet());
    expect(await screen.findByText(SCRIPT.opening[0]!)).toBeInTheDocument();
    expect(await screen.findByText(SCRIPT.name.ask)).toBeInTheDocument();
    // The caret lands after the frame is painted, so this waits for it.
    await waitFor(() => expect(screen.getByPlaceholderText(SCRIPT.name.placeholder)).toHaveFocus());
  });

  it('saves the name and asks about the clock next, with the answer above it', async () => {
    vi.mocked(api.setOwner).mockResolvedValue(owner({ preferredName: 'Amen' }));
    render(meet());
    const field = await screen.findByPlaceholderText(SCRIPT.name.placeholder);
    fireEvent.change(field, { target: { value: 'Amen' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.name.submit }));
    await waitFor(() => expect(api.setOwner).toHaveBeenCalledWith({ preferredName: 'Amen' }));
    expect(await screen.findByText(/I'll set your clock to/)).toBeInTheDocument();
    // The answer is a bubble of the owner's, with the way back to it.
    expect(screen.getByText('Amen')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: SCRIPT.change }).length).toBeGreaterThan(0);
  });

  it('resumes at the brain, and offers Claude only where that sign-in exists', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    const page = render(meet());
    expect(await screen.findByText(SCRIPT.brain.ask)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.brain.cards.key.title)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.brain.cards.ollama.title)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.brain.cards.service.title)).toBeInTheDocument();
    expect(screen.queryByText(SCRIPT.brain.cards.claude.title)).not.toBeInTheDocument();
    page.unmount();

    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([], { anthropicOAuthEnabled: true }));
    render(meet());
    expect(await screen.findByText(SCRIPT.brain.cards.claude.title)).toBeInTheDocument();
  });

  it('says Ollama is there when the machine says so, and offers it', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.ollama).mockResolvedValue({ running: true, models: ['qwen3:4b'], downloadUrl: 'ollama.com/download', baseUrl: 'ollama-on-this-machine/v1', cloudBaseUrl: 'ollama-cloud/v1' });
    render(meet());
    expect(await screen.findByText(SCRIPT.brain.ollama.found)).toBeInTheDocument();
  });

  it('opens the other-service card with the address the server offered', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.service.title));
    // The page names no address of its own: this is the one the gateway sent.
    expect(await screen.findByDisplayValue('ollama-cloud/v1')).toBeInTheDocument();
  });

  it('falls back to the placeholder when the server offers no address', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.ollama).mockResolvedValue({ running: false, models: [], downloadUrl: 'ollama.com/download', baseUrl: '', cloudBaseUrl: '' });
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.service.title));
    const field = await screen.findByPlaceholderText(SCRIPT.brain.service.addressPlaceholder);
    expect(field).toHaveValue('');
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
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.service.title));
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
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.service.title));
    fireEvent.change(await screen.findByLabelText(SCRIPT.brain.service.address), { target: { value: 'a-service/v1' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.service.submit }));
    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalled());
    expect(screen.queryByText(SCRIPT.brain.model.ask)).not.toBeInTheDocument();
    expect(vi.mocked(api.saveProviderAccount).mock.calls[0]![0]).toMatchObject({ defaultModel: 'nemotron:70b' });
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
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.ollama.title));
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
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.ollama.title));
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
    fireEvent.click(screen.getByRole('button', { name: '←' }));
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.service.title));
    const address = await screen.findByLabelText(SCRIPT.brain.service.address);
    await waitFor(() => expect(address).toHaveFocus());
  });

  it('keeps a refused key in the thread with the field still open', async () => {
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.probeModels).mockRejectedValue(new Error('no'));
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'one' });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'invalid-key', message: 'refused' });
    render(meet());
    fireEvent.click(await screen.findByText(SCRIPT.brain.cards.key.title));
    const field = await screen.findByPlaceholderText(SCRIPT.brain.key.placeholder);
    fireEvent.change(field, { target: { value: 'sk-ant-nope' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.brain.key.submit }));
    expect(await screen.findByText(SCRIPT.brain.key.refused)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(SCRIPT.brain.key.placeholder)).toBeInTheDocument();
  });

  it('offers a name, a face and a purpose for the assistant once there is a brain', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ details: { accountId: 'a0' } }));
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{}]));
    render(meet());
    expect(await screen.findByText(SCRIPT.assistant.ask)).toBeInTheDocument();
    expect(screen.getByDisplayValue(SCRIPT.assistant.purposeValue)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: SCRIPT.assistant.face }).children.length).toBeGreaterThan(4);
    // And buddi has already said which model it will think with.
    expect(screen.getByText(SCRIPT.brain.works('qwen3:4b'))).toBeInTheDocument();
  });

  it('binds the assistant to the account that was just tested', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ details: { accountId: 'tested' } }));
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{ id: 'tested' }]));
    vi.mocked(api.createFirstAgent).mockResolvedValue({ agent: null, id: 'ada', handle: 'ada', file: '', live: true, accountId: 'tested' });
    render(meet());
    fireEvent.click(await screen.findByRole('button', { name: SCRIPT.assistant.submit }));
    await waitFor(() => expect(api.createFirstAgent).toHaveBeenCalled());
    expect(vi.mocked(api.createFirstAgent).mock.calls[0]![0]).toMatchObject({ accountId: 'tested' });
  });
});

describe('the switch', () => {
  /** Everything answered: the thread is at the handover. */
  function ready(details: { conversationId?: string; accountId?: string } = { accountId: 'a0' }): void {
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

  it('has the assistant speak first, on a turn the owner never sees sent as its own kind', async () => {
    ready();
    vi.mocked(chatApi.conversation).mockResolvedValue({
      id: 'c1',
      agentId: 'ada',
      messages: [
        { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text', text: "I'm Ada. I can remember things for you. What are you working on?" }] },
      ],
    } as never);
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
    expect(screen.getByText(SCRIPT.offers.phone)).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.offers.notNow)).toBeInTheDocument();
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

  it('gives up at once when the run ended without a word', async () => {
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
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * A model that writes its reasoning into its own answer is the runtime's
   * problem, and it is fixed there — but the board must not be the thing that
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

describe('the way out', () => {
  /** The assistant has spoken: first run is over and the board says so. */
  function spoken(): void {
    vi.mocked(api.onboarding).mockResolvedValue(
      view({ state: 'in-progress', details: { accountId: 'a0', conversationId: 'c1' }, needs: { owner: false, model: false, agent: false } }),
    );
    vi.mocked(api.owner).mockResolvedValue(owner({ preferredName: 'Amen', timezone: 'UTC' }));
    vi.mocked(api.providerAccounts).mockResolvedValue(accounts([{}], { bindings: [{ agentId: 'ada', accountId: 'a0', model: 'qwen3:4b' }] }));
    vi.mocked(chatApi.agents).mockResolvedValue({
      agents: [{ id: 'ada', handle: 'ada', name: 'Ada', description: '', available: true, roles: [], provider: 'openai-compatible', model: 'qwen3:4b' }],
      defaultAgentId: 'ada',
    });
    vi.mocked(chatApi.conversation).mockResolvedValue({
      id: 'c1',
      agentId: 'ada',
      messages: [{ id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text', text: "I'm Ada." }] }],
      runs: [],
    } as never);
  }

  it('stops offering to set up later once there is nothing left to set up', async () => {
    spoken();
    render(meet());
    expect(await screen.findByText(/I'm Ada\./)).toBeInTheDocument();
    // First run is complete at this point; "later" is no longer a thing that
    // can happen, and the quiet link is the way to the dashboard instead.
    await waitFor(() => expect(screen.getByRole('link', { name: SCRIPT.done.open })).toHaveAttribute('href', '#/chat/ada/c1'));
    expect(screen.queryByRole('button', { name: SCRIPT.later })).not.toBeInTheDocument();
  });

  it('ends the thread on "Not now", and leaves for the conversation by itself', async () => {
    // Motion allowed: this is the path where the board shows itself out.
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    spoken();
    const navigate = vi.fn();
    render(meet(navigate));
    // The thread first: the chips exist only once the assistant has spoken.
    await screen.findByText(SCRIPT.offers.notNow);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByText(SCRIPT.offers.notNow));
      expect(screen.getByText(SCRIPT.done.said)).toBeInTheDocument();
      const open = screen.getAllByRole('link', { name: SCRIPT.done.open });
      expect(open.some((link) => link.getAttribute('href') === '#/chat/ada/c1')).toBe(true);
      // The composer is still the composer: this is a conversation, not a page
      // that has ended.
      expect(screen.getByPlaceholderText(/Message Ada/)).toBeInTheDocument();
      expect(navigate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(LEAVE_MS + 100);
      expect(navigate).toHaveBeenCalledWith('#/chat/ada/c1', true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never moves an owner who asked for less motion; the button is the whole offer', async () => {
    // `quiet()` answers the reduced-motion query with "yes".
    spoken();
    const navigate = vi.fn();
    render(meet(navigate));
    fireEvent.click(await screen.findByText(SCRIPT.offers.notNow));
    expect(screen.getByText(SCRIPT.done.said)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, LEAVE_MS + 200));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getAllByRole('link', { name: SCRIPT.done.open }).length).toBeGreaterThan(0);
  });

  it('answers the phone offer where every other question was answered', async () => {
    spoken();
    // The token field takes the cursor the moment the card opens.

    vi.mocked(api.saveTelegramToken).mockResolvedValue({ configured: true, running: true, paired: false, restartNeeded: false, botUsername: 'b' });
    vi.mocked(api.telegramPairing).mockResolvedValue({ code: 'ABC', link: 't.me/b?start=ABC', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    vi.mocked(api.telegram).mockResolvedValue({ configured: true, running: true, paired: false });
    render(meet(vi.fn()));
    // The chips are the open question, so they are where the composer was.
    fireEvent.click(await screen.findByText(SCRIPT.offers.phone));
    const token = await screen.findByLabelText(SCRIPT.telegram.field);
    await waitFor(() => expect(token).toHaveFocus());
    // And the composer has stepped aside rather than sitting under a stray form.
    expect(screen.queryByPlaceholderText(/Message Ada/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(SCRIPT.telegram.field), { target: { value: '8012345678:AAHfakeTokenForTestsOnly-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.telegram.submit }));
    // A saved token puts the square and its link in the same place.
    expect(await screen.findByText(SCRIPT.telegram.scan)).toBeInTheDocument();
    expect(await screen.findByText('t.me/b?start=ABC')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Message Ada/)).not.toBeInTheDocument();
  });

  it('lets the owner out of the phone card at either step', async () => {
    for (const step of ['token', 'code'] as const) {
      vi.clearAllMocks();
      quiet();
      spoken();
      vi.mocked(api.saveTelegramToken).mockResolvedValue({ configured: true, running: true, paired: false, restartNeeded: false, botUsername: 'b' });
      vi.mocked(api.telegramPairing).mockResolvedValue({ code: 'ABC', link: 't.me/b?start=ABC', expiresAt: new Date(Date.now() + 600_000).toISOString() });
      vi.mocked(api.telegram).mockResolvedValue({ configured: true, running: true, paired: false });
      const page = render(meet(vi.fn()));
      fireEvent.click(await screen.findByText(SCRIPT.offers.phone));
      await screen.findByLabelText(SCRIPT.telegram.field);
      if (step === 'code') {
        fireEvent.change(screen.getByLabelText(SCRIPT.telegram.field), { target: { value: '8012345678:AAHfakeTokenForTestsOnly-1234567890' } });
        fireEvent.click(screen.getByRole('button', { name: SCRIPT.telegram.submit }));
        await screen.findByText(SCRIPT.telegram.scan);
      }
      fireEvent.click(screen.getByRole('button', { name: SCRIPT.offers.notNow }));
      // The composer is back, and the thread ends the way it ends.
      expect(await screen.findByPlaceholderText(/Message Ada/)).toBeInTheDocument();
      expect(screen.getByText(SCRIPT.done.said)).toBeInTheDocument();
      expect(screen.getAllByRole('link', { name: SCRIPT.done.open }).length).toBeGreaterThan(0);
      page.unmount();
    }
  });

  it('ends it the same way when the phone says hello', async () => {
    spoken();
    vi.mocked(api.saveTelegramToken).mockResolvedValue({ configured: true, running: true, paired: false, restartNeeded: false, botUsername: 'b' });
    vi.mocked(api.telegramPairing).mockResolvedValue({ code: 'ABC', link: 't.me/b?start=ABC', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    vi.mocked(api.telegram).mockResolvedValue({ configured: true, running: true, paired: true });
    render(meet(vi.fn()));
    fireEvent.click(await screen.findByText(SCRIPT.offers.phone));
    fireEvent.change(await screen.findByLabelText(SCRIPT.telegram.field), { target: { value: '8012345678:AAHfakeTokenForTestsOnly-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.telegram.submit }));
    // The pairing is watched until the phone says hello, and then the thread
    // ends exactly as "not now" ends it.
    expect(await screen.findByText(SCRIPT.telegram.paired, {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByText(SCRIPT.done.said)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: SCRIPT.done.open }).length).toBeGreaterThan(0);
  });

  it('sends a reload after first run to the conversation it happened in', async () => {
    spoken();
    vi.mocked(api.onboarding).mockResolvedValue(
      view({ state: 'done', details: { accountId: 'a0', conversationId: 'c1' }, needs: { owner: false, model: false, agent: false } }),
    );
    const navigate = vi.fn();
    render(meet(navigate));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/chat/ada/c1', true));
    // Nothing of the thread is drawn on the way past.
    expect(screen.queryByText(SCRIPT.name.ask)).not.toBeInTheDocument();
  });

  it('sends it Home when the record names no conversation', async () => {
    spoken();
    vi.mocked(api.onboarding).mockResolvedValue(
      view({ state: 'done', details: {}, needs: { owner: false, model: false, agent: false } }),
    );
    const navigate = vi.fn();
    render(meet(navigate));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/', true));
  });
});

describe('change', () => {
  /** Answered through the assistant, so both answers carry a change link. */
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

  it('changes the assistant in place rather than trying to write a second one', async () => {
    met();
    vi.mocked(api.updateFirstAgent).mockResolvedValue({ agent: null, id: 'ada', handle: 'ada', file: '', live: true, accountId: null });
    render(meet());
    // The assistant's own bubble is the last answered one; its change link
    // reopens the question with what the installation actually holds.
    const changes = await screen.findAllByRole('button', { name: SCRIPT.change });
    fireEvent.click(changes[changes.length - 1]!);
    expect(await screen.findByDisplayValue('Ada')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Whatever I ask.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SCRIPT.assistant.submit }));
    await waitFor(() => expect(api.updateFirstAgent).toHaveBeenCalled());
    expect(api.createFirstAgent).not.toHaveBeenCalled();
  });

  it('moves the assistant onto the new brain when the brain changes', async () => {
    met();
    vi.mocked(api.probeModels).mockRejectedValue(new Error('no list'));
    vi.mocked(api.saveProviderAccount).mockResolvedValue({ id: 'second' });
    vi.mocked(api.testProviderAccount).mockResolvedValue({ state: 'connected', message: 'ok' });
    vi.mocked(api.bindBrain).mockResolvedValue({ assistant: 'ada', followed: ['agent-father'] });
    render(meet());
    const changes = await screen.findAllByRole('button', { name: SCRIPT.change });
    // Name, clock, brain, assistant — the brain's is the third.
    fireEvent.click(changes[2]!);
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

describe('every word of it', () => {
  it('renders nothing from the list of words that are ours, not theirs', async () => {
    const { container } = render(meet());
    await screen.findByText(SCRIPT.name.ask);
    const text = (container.textContent ?? '').toLowerCase();
    for (const word of BANNED_WORDS) expect(text.includes(word), `the screen says "${word}"`).toBe(false);
  });
});

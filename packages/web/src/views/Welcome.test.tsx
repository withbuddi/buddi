/**
 * The wizard: who sees it, what opens Next, and where a reload lands.
 *
 * The redirect rule is the one with teeth — an installation that already has a
 * model account, or whose record is finished, must never be dropped into a
 * setup screen it passed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, chatApi } from '../api';
import { App } from '../App';
import { Welcome, resumeStep, suggestHandle } from './Welcome';
import type { OnboardingView } from '../api';

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
      owner: vi.fn(),
      providerAccounts: vi.fn(),
      session: vi.fn(),
      overview: vi.fn(),
      conversations: vi.fn(),
    },
    chatApi: { ...real.chatApi, agents: vi.fn(), groups: vi.fn() },
  };
});

const view = (over: Partial<OnboardingView> = {}): OnboardingView => ({
  state: 'pending',
  stepsDone: [],
  needs: { owner: true, model: true, agent: true },
  ...over,
});

/** Every call the shell makes that this file is not about. */
function quiet(): void {
  vi.mocked(api.session).mockResolvedValue({ csrf: 'x', timezone: 'UTC', host: '127.0.0.1', port: 4317 });
  for (const call of [api.overview, api.conversations, api.providerAccounts, api.owner, chatApi.agents, chatApi.groups]) {
    vi.mocked(call as () => Promise<unknown>).mockRejectedValue(new Error('not in this test'));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  quiet();
});

describe('the redirect rule', () => {
  it('sends a fresh installation with no model account to the wizard', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view());
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe('#/welcome'));
  });

  it('leaves an installation that already has a model account alone', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ needs: { owner: true, model: false, agent: true } }));
    render(<App />);
    await waitFor(() => expect(api.onboarding).toHaveBeenCalled());
    expect(window.location.hash).not.toContain('welcome');
  });

  it('leaves a finished, skipped or already-claimed record alone even with no model account', async () => {
    // `in-progress` belongs to whichever surface claimed the first run — a
    // Telegram or CLI interview may be mid-sentence — so the shell does not
    // redirect into it. The wizard's own link still resumes it.
    for (const state of ['done', 'skipped', 'in-progress'] as const) {
      vi.clearAllMocks();
      window.location.hash = '';
      quiet();
      vi.mocked(api.onboarding).mockResolvedValue(view({ state }));
      const { unmount } = render(<App />);
      await waitFor(() => expect(api.onboarding).toHaveBeenCalled());
      expect(window.location.hash).not.toContain('welcome');
      unmount();
    }
  });
});

describe('resuming', () => {
  it('starts at the beginning when nothing has been recorded', () => {
    expect(resumeStep(view())).toBe('welcome');
  });

  it('lands on the first screen whose question is still unanswered', () => {
    expect(resumeStep(view({ stepsDone: ['welcome', 'you'], needs: { owner: false, model: true, agent: true } }))).toBe('model');
  });

  it('otherwise lands on the screen after the last one recorded', () => {
    expect(resumeStep(view({ stepsDone: ['welcome', 'you', 'model', 'agent'], needs: { owner: false, model: false, agent: false } }))).toBe('hello');
  });
});

describe('the step gate', () => {
  const nav = vi.fn();

  it('keeps Next shut until a model account exists, and records the step when it opens', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ needs: { owner: false, model: true, agent: true } }));
    const { rerender } = render(<Welcome step="model" navigate={nav} timezone="UTC" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled());

    vi.mocked(api.onboarding).mockResolvedValue(view({ needs: { owner: false, model: false, agent: true } }));
    vi.mocked(api.onboardingStep).mockResolvedValue(view());
    rerender(<Welcome step="model" navigate={nav} timezone="UTC" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled(), { timeout: 6_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(api.onboardingStep).toHaveBeenCalledWith('model');
    expect(nav).toHaveBeenCalledWith('#/welcome?step=agent');
  });

  it('skips the whole thing and goes home from any screen', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view());
    vi.mocked(api.skipOnboarding).mockResolvedValue(view({ state: 'skipped' }));
    render(<Welcome step="welcome" navigate={nav} timezone="UTC" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up later' }));
    await waitFor(() => expect(nav).toHaveBeenCalledWith('#/'));
    expect(api.skipOnboarding).toHaveBeenCalled();
  });

  it('stays put and says why when the server refuses to record the ending', async () => {
    const { ApiError } = await vi.importActual<typeof import('../api')>('../api');
    vi.mocked(api.onboarding).mockResolvedValue(view());
    vi.mocked(api.skipOnboarding).mockRejectedValue(new ApiError(503, 'The database is not answering.'));
    render(<Welcome step="welcome" navigate={nav} timezone="UTC" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up later' }));
    expect(await screen.findByText('The database is not answering.')).toBeInTheDocument();
    expect(nav).not.toHaveBeenCalledWith('#/');
  });

  it('will not call setup finished while something is still missing', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ state: 'in-progress', needs: { owner: false, model: false, agent: true } }));
    render(<Welcome step="done" navigate={nav} timezone="UTC" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish' })).toBeDisabled());
    expect(await screen.findByRole('status')).toHaveTextContent(/an agent of your own/);
    fireEvent.click(screen.getByRole('link', { name: 'an agent of your own' }));
    expect(nav).toHaveBeenCalledWith('#/welcome?step=agent');
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });

  it('finishes once nothing is outstanding', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ state: 'in-progress', needs: { owner: false, model: false, agent: false } }));
    vi.mocked(api.completeOnboarding).mockResolvedValue(view({ state: 'done' }));
    render(<Welcome step="done" navigate={nav} timezone="UTC" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(nav).toHaveBeenCalledWith('#/'));
  });
});

describe('the first agent', () => {
  it('suggests a handle from the name and lets it be overridden', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ needs: { owner: false, model: false, agent: true } }));
    render(<Welcome step="agent" navigate={vi.fn()} timezone="UTC" />);
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Ada Bright' } });
    const handle = screen.getByLabelText('Handle') as HTMLInputElement;
    expect(handle.value).toBe('ada-bright');
    fireEvent.change(handle, { target: { value: 'ada' } });
    fireEvent.change(name, { target: { value: 'Ada Brighter' } });
    expect((screen.getByLabelText('Handle') as HTMLInputElement).value).toBe('ada');
  });

  it('shows what the server refused rather than guessing at it', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ needs: { owner: false, model: false, agent: true } }));
    const { ApiError } = await vi.importActual<typeof import('../api')>('../api');
    vi.mocked(api.createFirstAgent).mockRejectedValue(new ApiError(409, '@ada is already Ada. Pick another one.'));
    render(<Welcome step="agent" navigate={vi.fn()} timezone="UTC" />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('In a sentence or two'), { target: { value: 'Reads with me.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create the agent' }));
    expect(await screen.findByText('@ada is already Ada. Pick another one.')).toBeInTheDocument();
  });

  it('says the agent is there instead of asking for a second one', async () => {
    vi.mocked(api.onboarding).mockResolvedValue(view({ needs: { owner: false, model: false, agent: false } }));
    render(<Welcome step="agent" navigate={vi.fn()} timezone="UTC" />);
    expect(await screen.findByRole('status')).toHaveTextContent(/installed and ready/);
    expect(screen.queryByRole('button', { name: 'Create the agent' })).not.toBeInTheDocument();
  });
});

describe('the handle suggestion', () => {
  it('is a slug the loader would accept', () => {
    expect(suggestHandle('Ada Bright')).toBe('ada-bright');
    expect(suggestHandle('  Émile!  ')).toBe('emile');
    expect(suggestHandle('9 Lives')).toBe('lives');
    expect(suggestHandle('a very long name indeed for an agent')).toHaveLength(20);
  });
});

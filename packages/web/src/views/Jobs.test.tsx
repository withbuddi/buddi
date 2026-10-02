/** Activity → Jobs: failed jobs as decisions, grouped by cause, dismissed with Undo. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import * as Toast from '@radix-ui/react-toast';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FailureGroup, JobRow } from '../api';
import { api } from '../api';
import { Jobs } from './Jobs';

const job = (id: string, extra: Partial<JobRow> = {}): JobRow => ({
  id, kind: 'agent-run', state: 'failed', payload: {}, attempts: 8, maxAttempts: 8, runAfter: '2026-09-30T14:00:00Z',
  leaseOwner: null, lastError: 'raw provider text', result: null, conversationId: null, dedupKey: null, suspendedReason: null,
  acknowledgedAt: null, acknowledgedBy: null, createdAt: '2026-09-30T14:00:00Z', updatedAt: '2026-09-30T14:02:00Z', ...extra,
});

const SIG: FailureGroup = {
  key: 'gemini-thought-signature', label: 'Gemini thought_signature (400)', likelyFixed: true, count: 2,
  reason: 'Gemini refused the turn after a tool call. That was a defect in buddi, fixed since, so running them again should work.',
  firstAt: '2026-09-30T14:02:00Z', lastAt: '2026-09-30T18:40:00Z', agents: [{ id: 'ledger', name: 'Ledger' }],
  jobs: [
    { job: job('a'), agentId: 'ledger', agentName: 'Ledger', missionId: 'm1', missionName: 'Weekly cash check' },
    { job: job('b'), agentId: 'ledger', agentName: 'Ledger', missionId: null, missionName: null },
  ],
};
const KEY: FailureGroup = {
  key: 'openai-credential', label: 'OpenAI refused the key (401)', likelyFixed: false, count: 1,
  reason: 'OpenAI refused the key or sign-in the agent uses. Change it in Settings → Model accounts first.',
  firstAt: '2026-10-01T07:30:00Z', lastAt: '2026-10-01T07:30:00Z', agents: [{ id: 'tempo', name: 'Tempo' }],
  jobs: [{ job: job('c'), agentId: 'tempo', agentName: 'Tempo', missionId: 'm2', missionName: 'Morning agenda' }],
};
const OLD: FailureGroup = { ...KEY, key: 'connection', label: 'Connection failed', jobs: [{ ...KEY.jobs[0]!, job: job('d', { acknowledgedAt: '2026-09-20T00:00:00Z', acknowledgedBy: 'auto' }) }] };

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      jobs: vi.fn(async () => ({ jobs: [], counts: { failed: 3, dismissed: 1 }, paused: false })),
      jobFailures: vi.fn(async () => ({ open: [SIG, KEY], dismissed: [OLD] })),
      dismissJobs: vi.fn(async () => ({ ids: ['a', 'b'] })),
      undismissJobs: vi.fn(async () => ({ ids: ['a', 'b'] })),
      retryJobs: vi.fn(async () => ({ jobs: [job('c', { state: 'pending' })] })),
    },
  };
});

const renderJobs = () => render(<Toast.Provider><Jobs timezone="UTC" embedded initialState="failed" /><Toast.Viewport /></Toast.Provider>);

describe('Jobs: failed jobs as decisions', { timeout: 180_000 }, () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists one row per cause with its reason, Retry first when the cause has passed', async () => {
    renderJobs();
    const sig = (await screen.findByText('Gemini thought_signature (400) · 2')).closest('li')!;
    expect(within(sig).getByText(/fixed since/)).toBeInTheDocument();
    expect(within(sig).getByRole('button', { name: 'Retry all' })).toHaveAttribute('data-variant', 'accent');
    const key = screen.getByText('OpenAI refused the key (401)').closest('li')!;
    expect(within(key).getByRole('button', { name: 'Retry' })).not.toHaveAttribute('data-variant', 'accent');
    // A group of one names its job in the line.
    expect(within(key).getByRole('button', { name: 'Morning agenda' })).toBeInTheDocument();
    // The decisions view has no queue table under it.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 dismissed' })).toBeInTheDocument();
  });

  it('dismisses a group with Undo, and a single job inside it', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderJobs();
    const sig = (await screen.findByText('Gemini thought_signature (400) · 2')).closest('li')!;
    await user.click(within(sig).getByRole('button', { name: 'Dismiss' }));
    expect(api.dismissJobs).toHaveBeenCalledWith({ ids: ['a', 'b'] });
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(api.undismissJobs).toHaveBeenCalledWith(['a', 'b']);

    await user.click(within(sig).getByRole('button', { name: 'Show the 2' }));
    const items = within(sig).getAllByRole('button', { name: 'Dismiss' });
    await user.click(items[0]!);
    expect(api.dismissJobs).toHaveBeenLastCalledWith({ ids: ['a'] });
  });

  it('dismisses everything still asking at once', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderJobs();
    await user.click(await screen.findByRole('button', { name: 'Dismiss all' }));
    expect(api.dismissJobs).toHaveBeenCalledWith({ all: true });
  });

  it('retries, and says a cause that has not passed will fail the same way', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderJobs();
    const key = (await screen.findByText('OpenAI refused the key (401)')).closest('li')!;
    await user.click(within(key).getByRole('button', { name: 'Retry' }));
    expect(api.retryJobs).toHaveBeenCalledWith({ ids: ['c'] });
    expect(await screen.findByText(/will fail the same way/)).toBeInTheDocument();
  });

  it('shows what was dismissed, and that age dismissed it', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderJobs();
    await user.click(await screen.findByRole('button', { name: '1 dismissed' }));
    expect(screen.getByText('dismissed on its own after 14 days')).toBeInTheDocument();
  });
});

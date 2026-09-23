/**
 * Memory on an agent's sheet: its own first, the shared set under a fold, and
 * the same corrections the Settings page offers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type MemoryView } from '../api';
import { Memory } from './Memory';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      memory: vi.fn(),
      forgetNote: vi.fn(),
      forgetPreference: vi.fn(),
      setPreference: vi.fn(),
      updateNote: vi.fn(),
    },
  };
});

const AGENTS = [
  { id: 'developer', handle: 'dev', name: 'Developer', description: '', available: true, roles: [], provider: 'x', model: 'y' },
];

const VIEW: MemoryView = {
  preferences: [
    { key: 'branch_prefix', value: 'buddi/dev', scope: 'developer', revision: 1, updatedAt: '2026-09-22T10:00:00Z' },
    { key: 'tone', value: 'short', scope: 'shared', revision: 2, updatedAt: '2026-09-20T10:00:00Z' },
  ],
  notes: [
    { id: '11111111-1111-4111-8111-111111111111', content: 'buddi: start the db container, then pnpm dev', kind: 'fact', scope: 'developer', createdAt: '2026-09-22T10:00:00Z', expiresAt: null, createdByAgent: 'developer', sourceConversationId: null },
    { id: '22222222-2222-4222-8222-222222222222', content: 'the owner is paid on Thursdays', kind: 'fact', scope: 'shared', createdAt: '2026-09-21T10:00:00Z', expiresAt: null, createdByAgent: 'finance', sourceConversationId: null },
  ],
};

describe('Memory on an agent sheet', () => {
  beforeEach(() => {
    vi.mocked(api.memory).mockReset().mockResolvedValue(VIEW);
    vi.mocked(api.forgetNote).mockReset().mockResolvedValue(null);
  });

  it('asks for this agent only, and puts its own above the shared fold', async () => {
    render(<Memory embedded agents={AGENTS as never} timezone="UTC" agentId="developer" />);
    await screen.findByText('buddi: start the db container, then pnpm dev');
    expect(api.memory).toHaveBeenCalledWith('developer');

    const fold = screen.getByText(/Shared with every agent/).closest('details');
    expect(fold).not.toBeNull();
    expect(fold).not.toHaveAttribute('open');
    expect(fold).toContainElement(screen.getByText('the owner is paid on Thursdays'));
    expect(fold).toContainElement(screen.getByText('tone'));
    expect(fold).not.toContainElement(screen.getByText('branch_prefix'));
    expect(fold).not.toContainElement(screen.getByText('buddi: start the db container, then pnpm dev'));
  });

  it('forgets a private note the way the Settings page does', async () => {
    render(<Memory embedded agents={AGENTS as never} timezone="UTC" agentId="developer" />);
    const row = (await screen.findByText('buddi: start the db container, then pnpm dev')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(api.forgetNote).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111'));
  });

  it('still shows everything, unfolded, in Settings', async () => {
    render(<Memory embedded agents={AGENTS as never} timezone="UTC" />);
    await screen.findByText('the owner is paid on Thursdays');
    expect(api.memory).toHaveBeenCalledWith(undefined);
    expect(screen.queryByText(/Shared with every agent/)).toBeNull();
  });
});

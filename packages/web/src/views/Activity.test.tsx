/** The usage views say how much of the prompt came from the provider's cache. */
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { Transcript } from '../api';
import { Activity } from './Activity';

const TRANSCRIPT: Transcript = {
  id: 'c1', agentId: 'finance', createdAt: '2026-09-27T09:00:00Z', messages: [],
  runs: [
    { startedAt: '2026-09-27T09:00:00Z', finishedAt: '2026-09-27T09:00:05Z', turns: 1, stopped: 'end_turn', usage: { input: 12, output: 3, cacheRead: 9800 }, actionId: null, resumed: false },
    { startedAt: '2026-09-27T09:01:00Z', finishedAt: '2026-09-27T09:01:05Z', turns: 1, stopped: 'end_turn', usage: { input: 40, output: 5 }, actionId: null, resumed: false },
  ],
  usage: { input: 52, output: 8, cacheRead: 9800 },
};

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return { ...original, api: { ...original.api, conversation: vi.fn(async () => TRANSCRIPT) } };
});

describe('Activity transcript usage', () => {
  it('shows cached tokens beside input and in the runs table', async () => {
    render(<Activity {...({ hash: '#/activity/conversations/c1', timezone: 'UTC', navigate: () => {}, agents: [] } as any)} />);
    expect(await screen.findByText('input / output, cached 9,800')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Cached' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '9,800' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '—' })).toBeInTheDocument();
  });
});

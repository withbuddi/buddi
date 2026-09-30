/**
 * The toasts: a row kept for the dashboard is drawn, marked seen once, and
 * goes on dismiss; past three, the rest fold into "and N more".
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type NotificationRow } from '../api';
import { NotificationToasts, ToastStack, toastPlacement, useToastQueue } from './NotificationToasts';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return { ...original, api: { ...original.api, notifications: vi.fn(), notificationSeen: vi.fn(async () => ({ ok: true })) } };
});

function row(over: Partial<NotificationRow>): NotificationRow {
  return {
    id: 'n1', kind: 'watcher', urgency: 'now', title: 'Rent is due', text: 'The landlord wrote.\nMore below.', link: '#/chat/finance',
    agentId: null, pluginId: null, actionId: null, state: 'shown', dueAt: null, channel: 'dashboard',
    createdAt: '2026-09-25T10:00:00.000Z', sentAt: null, seenAt: null, actedAt: null, error: null, ...over,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

function Harness({ navigate = vi.fn() }: { navigate?: (route: string) => void }): JSX.Element {
  const toasts = useToastQueue(true);
  return (
    <>
      <button type="button" onClick={toasts.refresh}>poll</button>
      <NotificationToasts queue={toasts.queue} agents={[]} navigate={navigate} onDismiss={toasts.dismiss} />
    </>
  );
}

describe('the notification toasts', () => {
  it('draws a shown row with its first line and a See link, marks it seen, and goes on dismiss', async () => {
    vi.mocked(api.notifications).mockResolvedValue({
      notifications: [row({}), row({ id: 'old', seenAt: '2026-09-25T09:00:00.000Z' }), row({ id: 'held', state: 'held' })],
    });
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);
    await act(async () => { fireEvent.click(screen.getByText('poll')); });

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Rent is due');
    expect(toast).toHaveTextContent('The landlord wrote.');
    expect(toast).not.toHaveTextContent('More below.');
    expect(toast).toHaveAttribute('data-tone', 'warm');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(api.notificationSeen).toHaveBeenCalledTimes(1);
    expect(api.notificationSeen).toHaveBeenCalledWith('n1');

    // Polled again, the same row is not drawn twice nor marked twice.
    await act(async () => { fireEvent.click(screen.getByText('poll')); });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(api.notificationSeen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('link', { name: 'See' }));
    expect(navigate).toHaveBeenCalledWith('#/chat/finance');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("draws an agent's own message without the signature its face already gives", async () => {
    vi.mocked(api.notifications).mockResolvedValue({ notifications: [row({ kind: 'agent', agentId: 'ledger', title: '@ledger: Charged twice' })] });
    render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByText('poll')); });
    expect(screen.getByRole('status')).toHaveTextContent('Charged twice');
    expect(screen.getByRole('status')).not.toHaveTextContent('@ledger:');
    expect(screen.getByRole('button', { name: 'Dismiss Charged twice' })).toBeInTheDocument();
  });

  it('draws three and folds the rest, marking only what it drew', async () => {
    vi.mocked(api.notifications).mockResolvedValue({
      notifications: [1, 2, 3, 4, 5].map((n) => row({ id: `n${n}`, title: `Thing ${n}`, kind: n === 1 ? 'failure' : 'recap', createdAt: `2026-09-25T10:0${9 - n}:00.000Z` })),
    });
    const { result } = renderHook(() => useToastQueue(true));
    await act(async () => { result.current.refresh(); });
    render(<NotificationToasts queue={result.current.queue} agents={[]} navigate={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual([
      expect.stringContaining('Thing 1'), expect.stringContaining('Thing 2'), expect.stringContaining('Thing 3'),
    ]);
    expect(screen.getAllByRole('status')[0]).toHaveAttribute('data-tone', 'critical');
    expect(screen.getByText('and 2 more')).toBeInTheDocument();
    expect(vi.mocked(api.notificationSeen).mock.calls.map(([id]) => id)).toEqual(['n1', 'n2', 'n3']);

    await act(async () => { result.current.dismiss('n1'); });
    expect(vi.mocked(api.notificationSeen).mock.calls.map(([id]) => id)).toEqual(['n1', 'n2', 'n3', 'n4']);
  });
});

describe('where the toasts stand', () => {
  it('stands over the corner button when it is drawn, over the dock when it is open, in the corner otherwise', () => {
    expect(toastPlacement(false, false)).toBe('corner');
    expect(toastPlacement(true, false)).toBe('above-button');
    expect(toastPlacement(true, true)).toBe('above-dock');
  });

  it('carries the placement on the stack that holds the toasts', () => {
    const { container, rerender } = render(
      <ToastStack placement={toastPlacement(true, false)}>
        <NotificationToasts queue={[row({})]} agents={[]} navigate={vi.fn()} onDismiss={vi.fn()} />
      </ToastStack>,
    );
    const stack = container.querySelector('.wb-toast-stack');
    expect(stack).toHaveAttribute('data-placement', 'above-button');
    expect(stack).toContainElement(screen.getByRole('status'));
    rerender(
      <ToastStack placement={toastPlacement(true, true)}>
        <NotificationToasts queue={[row({})]} agents={[]} navigate={vi.fn()} onDismiss={vi.fn()} />
      </ToastStack>,
    );
    expect(container.querySelector('.wb-toast-stack')).toHaveAttribute('data-placement', 'above-dock');
  });
});

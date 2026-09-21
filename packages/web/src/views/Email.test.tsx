/**
 * Settings → Email: the two lists, and what the page sends when a button is
 * tapped.
 *
 * What is pinned here is the distinction the section exists to make. An applied
 * rule is deciding and offers one way out; a proposed one is deciding nothing
 * and offers two. Getting that backwards would be the page telling the owner
 * that something is off when it is on, so it is asserted rather than eyeballed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type EmailPoliciesView, type EmailPolicy } from '../api';
import { Email, subFor } from './Email';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: {
      emailPolicies: vi.fn(),
      keepEmailPolicy: vi.fn(),
      revokeEmailPolicy: vi.fn(),
      setEmailPolicy: vi.fn(),
    },
  };
});

function policy(over: Partial<EmailPolicy> = {}): EmailPolicy {
  return {
    id: 'p1',
    scope: 'sender',
    matcher: 'news@shop.test',
    action: 'ignore',
    params: {},
    origin: 'learned',
    proposed: false,
    learnedFrom: 3,
    runsSaved: 12,
    decisions: 12,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    ...over,
  };
}

const VIEW: EmailPoliciesView = {
  applied: [policy()],
  proposed: [
    policy({ id: 'p2', matcher: 'maybe@shop.test', action: 'notify', proposed: true, runsSaved: 0 }),
  ],
};

describe('Settings → Email → Policies', () => {
  beforeEach(() => {
    vi.mocked(api.emailPolicies).mockResolvedValue(VIEW);
    vi.mocked(api.keepEmailPolicy).mockResolvedValue(VIEW);
    vi.mocked(api.revokeEmailPolicy).mockResolvedValue(VIEW);
  });

  it('lists each rule with its sender, action, origin and the runs it saved', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('news@shop.test')).toBeInTheDocument());

    expect(screen.getByText('ignore')).toBeInTheDocument();
    expect(screen.getAllByText(/learned from your mail/)).toHaveLength(2);
    expect(screen.getByText(/12 runs saved/)).toBeInTheDocument();
    // And the section's headline count.
    expect(screen.getByText(/saved 12 triage runs/)).toBeInTheDocument();
  });

  it('offers Revoke on an applied rule, and both Keep and Revoke on a proposal', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('maybe@shop.test')).toBeInTheDocument());

    const applied = screen.getByText('news@shop.test').closest('.ui-list-row') as HTMLElement;
    expect(within(applied).queryByRole('button', { name: 'Keep' })).toBeNull();
    expect(within(applied).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    const proposal = screen.getByText('maybe@shop.test').closest('.ui-list-row') as HTMLElement;
    expect(within(proposal).getByRole('button', { name: 'Keep' })).toBeInTheDocument();
    expect(within(proposal).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('keeps a proposal by its id, and revokes by its id', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('maybe@shop.test')).toBeInTheDocument());

    const proposal = screen.getByText('maybe@shop.test').closest('.ui-list-row') as HTMLElement;
    fireEvent.click(within(proposal).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(api.keepEmailPolicy).toHaveBeenCalledWith('p2'));

    const applied = screen.getByText('news@shop.test').closest('.ui-list-row') as HTMLElement;
    fireEvent.click(within(applied).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.revokeEmailPolicy).toHaveBeenCalledWith('p1'));
  });

  it('says so plainly when nothing has been decided or proposed', async () => {
    vi.mocked(api.emailPolicies).mockResolvedValue({ applied: [], proposed: [] });
    render(<Email embedded />);
    await waitFor(() =>
      expect(screen.getByText(/No policies are deciding anything yet/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/three verdicts running/)).toBeInTheDocument();
  });

  it('shows the failure rather than pretending the tap worked', async () => {
    vi.mocked(api.revokeEmailPolicy).mockRejectedValue(new Error('That policy is no longer there.'));
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('news@shop.test')).toBeInTheDocument());
    const applied = screen.getByText('news@shop.test').closest('.ui-list-row') as HTMLElement;
    fireEvent.click(within(applied).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(screen.getByText('That policy is no longer there.')).toBeInTheDocument(),
    );
  });
});

describe('the line under a rule', () => {
  it('never claims a proposal has done anything', () => {
    expect(subFor(policy({ proposed: true, runsSaved: 0 }))).toContain('deciding nothing yet');
  });

  it('says zero rather than nothing when a rule has not fired', () => {
    expect(subFor(policy({ runsSaved: 0 }))).toContain('no runs saved yet');
  });

  it('names who decided it', () => {
    expect(subFor(policy({ origin: 'owner', learnedFrom: 0 }))).toContain('you decided it');
    expect(subFor(policy({ origin: 'owner', learnedFrom: 0 }))).not.toContain('verdicts');
  });
});

/**
 * The controls on an approval card.
 *
 * What is being tested is one sentence: the owner can pick among what the
 * action declared, the default is what happens if they do not, and the picked
 * value travels with the decision. The options are never typed and never
 * invented by the page — every one of them came from the stored action.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type ApprovalRow } from '../../api';
import { ApprovalCard, useDecide } from './ApprovalCard';
import { Envelope } from '../../canvas/views/Envelope';

vi.mock('../../api', async (load) => ({
  ...(await load<typeof import('../../api')>()),
  api: { decide: vi.fn(), approval: vi.fn() },
}));

const CHOICE = {
  key: 'from',
  label: 'Send as',
  options: ['owner@work.test', 'legal@work.test'],
  default: 'owner@work.test',
};

const ACTION = {
  id: 'a1',
  tool: 'email.send',
  toolVersion: '0.4.0',
  agentId: 'mailer',
  conversationId: null,
  jobId: null,
  preview: 'Send mail as owner@work.test',
  envelope: { from: 'owner@work.test' },
  canonicalArgs: { draftId: 'd1' },
  choices: [CHOICE],
  ownerChoices: null,
  argsHash: 'h',
  policyVersion: 2,
  state: 'pending',
  decidedBy: null,
  decidedVia: null,
  decidedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: new Date().toISOString(),
  outcome: null,
} as unknown as ApprovalRow;

/** The card as a page uses it: the shared decide hook behind the buttons. */
function Card({ action }: { action: ApprovalRow }): JSX.Element {
  const decide = useDecide(() => {});
  return (
    <ApprovalCard
      action={action}
      timezone="UTC"
      busy={false}
      onDecide={(id, decision, scope, choices) => void decide.decide(id, decision, scope, choices)}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.decide).mockResolvedValue({
    action: { ...(ACTION as object), state: 'succeeded' } as never,
    execution: { state: 'succeeded' },
  });
});

describe('owner choices on an approval card', () => {
  it('draws one select per declared choice, with the default preselected', async () => {
    render(<Card action={ACTION} />);
    const select = await screen.findByLabelText('Send as');
    expect(select).toHaveValue('owner@work.test');
    expect(
      [...(select as HTMLSelectElement).options].map((option) => option.value),
    ).toEqual(CHOICE.options);
  });

  it('sends the default when the owner touches nothing', async () => {
    render(<Card action={ACTION} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith('a1', 'approve', undefined, {
        from: 'owner@work.test',
      }),
    );
  });

  it('sends the option the owner picked', async () => {
    render(<Card action={ACTION} />);
    fireEvent.change(await screen.findByLabelText('Send as'), {
      target: { value: 'legal@work.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith('a1', 'approve', undefined, {
        from: 'legal@work.test',
      }),
    );
  });

  it('draws nothing, and sends nothing extra, when the action offered no choice', async () => {
    render(<Card action={{ ...ACTION, choices: [] }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(screen.queryByLabelText('Send as')).toBeNull();
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('a1', 'approve', undefined));
  });

  it('draws the same control on the canvas envelope, and the preview stays the tool’s text', async () => {
    vi.mocked(api.approval).mockResolvedValue(ACTION);
    render(<Envelope props={{ approvalId: 'a1' }} />);
    fireEvent.change(await screen.findByLabelText('Send as'), {
      target: { value: 'legal@work.test' },
    });
    // The preview is the tool's own sentence, and says nothing about the menu.
    expect(screen.getByText('Send mail as owner@work.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith('a1', 'approve', undefined, {
        from: 'legal@work.test',
      }),
    );
  });
});

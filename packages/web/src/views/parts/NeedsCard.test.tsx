/** One card for everything that needs the owner: the tone mark, the actions on the right, "Not now" only where there is a way out. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type ApprovalRow } from '../../api';
import { Button } from '../../ui';
import { NeedsCard } from './NeedsCard';
import { ApprovalCard } from './ApprovalCard';
import { AgentOffer } from './AgentOffer';

vi.mock('../../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api')>();
  return {
    ...original,
    api: { ...original.api, approvals: vi.fn(async () => ({ pending: [], recent: [] })), acceptPluginAgent: vi.fn() },
  };
});

beforeEach(() => vi.clearAllMocks());

const ACTION: ApprovalRow = {
  id: 'act-1', tool: 'mail.send', toolVersion: '1.0.0', agentId: 'concierge', conversationId: null, jobId: null, preview: 'To: bank', envelope: {}, canonicalArgs: {},
  argsHash: 'abcdef0123456789', policyVersion: 1, state: 'pending', decidedBy: null, decidedVia: null, decidedAt: null,
  expiresAt: '2026-10-06T13:00:00.000Z', createdAt: '2026-10-05T13:00:00.000Z', outcome: null,
};

function buttonsOf(article: HTMLElement): Array<[string | null, string | null]> {
  return Array.from(article.querySelectorAll('.needs-card-actions button, .needs-card-actions a')).map((b) => [b.textContent, b.getAttribute('data-variant')]);
}

describe('NeedsCard', () => {
  it('is an article named by its heading, on the kit card, with the tone on the mark only', () => {
    render(<NeedsCard tone="warning" title="Finish restoring" from="buddi" time="2m" />);
    const article = screen.getByRole('article', { name: 'Finish restoring' });
    expect(article).toHaveClass('ui-card');
    expect(article).not.toHaveAttribute('data-tone');
    expect(article.querySelector('.needs-card')).toHaveAttribute('data-tone', 'warning');
    expect(article.querySelector('.needs-card-mark')).toBeInTheDocument();
    expect(within(article).getByRole('heading', { level: 3 })).toHaveTextContent('Finish restoring');
    expect(article.querySelector('.needs-card-time')).toHaveTextContent('2m');
  });

  it('draws the kind\'s icon in the mark, a dot when it has none', () => {
    const { container, rerender } = render(<NeedsCard title="A" />);
    expect(container.querySelector('.needs-card-dot')).toBeInTheDocument();
    rerender(<NeedsCard title="A" icon="bulb" />);
    expect(container.querySelector('.needs-card-dot')).toBeNull();
    expect(container.querySelector('.needs-card-mark svg')).toBeInTheDocument();
  });

  it('puts "Not now" on the left as a ghost, and the actions on the right with the accent last', () => {
    const onDismiss = vi.fn();
    render(
      <NeedsCard
        title="Set up @mail"
        dismiss={{ onClick: onDismiss, hint: 'Hide this offer' }}
        actions={<><Button>Later</Button><Button variant="accent">Create @mail</Button></>}
      />,
    );
    const article = screen.getByRole('article', { name: 'Set up @mail' });
    const toolbar = article.querySelector('.needs-card-actions')!;
    expect(Array.from(toolbar.children).map((el) => el.className)).toEqual(['needs-card-out', 'needs-card-do']);
    expect(within(toolbar.children[0] as HTMLElement).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect((toolbar.children[1] as HTMLElement).lastElementChild).toHaveTextContent('Create @mail');
    expect(buttonsOf(article)).toEqual([['Not now', 'ghost'], ['Later', null], ['Create @mail', 'accent']]);
    fireEvent.click(within(article).getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalled();
    expect(article.querySelector('.ui-icon-btn')).toBeNull();
  });

  it('has no "Not now" without a way out, and a compact card is the same anatomy', () => {
    render(<NeedsCard compact title="A mail from the bank" href="#/x" onOpen={() => {}} actions={<Button variant="accent">Open</Button>} />);
    const article = screen.getByRole('article', { name: 'A mail from the bank' });
    expect(article).toHaveAttribute('data-density', 'compact');
    expect(within(article).queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument();
    expect(within(article).getByRole('link', { name: 'A mail from the bank' })).toHaveAttribute('href', '#/x');
  });
});

describe('the approval on the card', () => {
  it('decides only: no "Not now"; Reject is danger, Approve the one accent, last', () => {
    render(<ApprovalCard action={ACTION} timezone="UTC" busy={false} onDecide={vi.fn()} agentName="Concierge" />);
    const article = screen.getByRole('article', { name: 'mail.send' });
    expect(within(article).queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument();
    expect(buttonsOf(article)).toEqual([['Show envelope', 'ghost'], ['Reject', 'danger'], ['Approve', 'accent']]);
    expect(article).toHaveTextContent('Asked by Concierge');
    fireEvent.click(within(article).getByRole('button', { name: 'Show envelope' }));
    expect(within(article).getByRole('button', { name: 'Hide envelope' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('an agent to set up, on Home', () => {
  it('names the plugin, offers Create as the accent and "Not now" on the left', async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      render(<AgentOffer plugin="email" agent="mail-triage" handle="mail" label="Create @mail" text="Sorts your inbox." card={{ from: 'Mail' }} onDismiss={onDismiss} />);
    });
    const article = screen.getByRole('article', { name: 'Set up @mail' });
    expect(article).toHaveTextContent('Mail');
    expect(article).toHaveTextContent('Sorts your inbox.');
    expect(buttonsOf(article)).toEqual([['Not now', 'ghost'], ['Create @mail', 'accent']]);
    fireEvent.click(within(article).getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('ends on a ready card with Talk to @handle', async () => {
    vi.mocked(api.acceptPluginAgent).mockResolvedValue({ agent: { id: 'mail-triage', handle: 'mail', name: 'Mail' } } as never);
    await act(async () => {
      render(<AgentOffer plugin="email" agent="mail-triage" handle="mail" label="Create @mail" text="Sorts your inbox." card={{ from: 'Mail' }} />);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create @mail' }));
    await waitFor(() => expect(screen.getByRole('article', { name: '@mail is ready' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Talk to @mail' })).toHaveAttribute('href', '#/chat/mail-triage');
  });
});

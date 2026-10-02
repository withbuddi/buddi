/**
 * Alerts: decisions, not chores. Only the decisions are rows, in the owner's
 * line; the recap is one line with a preview; a group expands; every row has
 * its primary action, Not now and Stop telling me this; Clear all has Undo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Toast from '@radix-ui/react-toast';
import { api, type AlertGroup, type SentinelsView } from '../api';
import { Alerts, recapLabel } from './Alerts';
import { alertsNeedYou } from './Home';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: {
      sentinels: vi.fn(),
      snoozeAlerts: vi.fn(),
      muteAlert: vi.fn(),
      unmuteAlert: vi.fn(),
      actOnAlerts: vi.fn(),
      askAboutAlerts: vi.fn(),
    },
  };
});

const group = (over: Partial<AlertGroup>): AlertGroup => ({
  id: 'g',
  sentinelId: 'fin.watch',
  plugin: 'fin',
  kind: '',
  title: 'A thing happened.',
  line: null,
  urgent: true,
  since: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  agentId: 'ledger',
  keys: ['k'],
  items: [{ key: 'k', line: 'A thing happened.', subject: null, note: 'A thing happened.', firstSeenAt: new Date().toISOString() }],
  actions: [{ kind: 'ask', label: null }],
  stop: { scope: 'kind', label: 'A thing happened.' },
  snoozedUntil: null,
  resolvedAt: null,
  ...over,
});

const balances = group({
  id: 'fin.watch:stale-balance',
  kind: 'stale-balance',
  title: '3 balances not updated in 2+ weeks',
  keys: ['stale:A', 'stale:B', 'stale:C'],
  items: ['A', 'B', 'C'].map((n) => ({ key: `stale:${n}`, line: `${n} is old.`, subject: { id: n, label: n }, note: `${n}0.00 USD on 2026-09-14`, firstSeenAt: new Date().toISOString() })),
  actions: [
    { kind: 'fill', label: 'Update them', title: 'Update balances', fields: ['A', 'B', 'C'].map((n) => ({ key: `stale:${n}`, index: 0, label: n, type: 'number' as const, value: 10, hint: `${n}0.00 USD on 2026-09-14` })) },
    { kind: 'ask', label: null },
  ],
});

const draft = group({
  id: 'draft:1',
  plugin: 'email',
  title: 'Your reply to Ana about Lease has sat as a draft for 9 days.',
  keys: ['draft:1'],
  agentId: 'postie',
  actions: [
    { kind: 'open', label: 'Open draft', plugin: 'email', page: 'mail', item: 't-1' },
    { kind: 'run', label: 'Send', key: 'draft:1', index: 1 },
    { kind: 'run', label: 'Discard', key: 'draft:1', index: 2, tone: 'danger', confirm: 'Discard this draft?' },
  ],
  stop: { scope: 'subject', label: 'Ana: …' },
});

function view(over: Partial<SentinelsView['alerts']> = {}): SentinelsView {
  return {
    installed: [],
    runs: [],
    alerts: {
      open: [draft],
      snoozed: [],
      resolved: [],
      recap: { count: 12, missionId: 'recap', nextAt: null, groups: [balances] },
      mutes: [],
      ...over,
    },
  };
}

const agents = [{ id: 'ledger', name: 'Ledger' }, { id: 'postie', name: 'Postie' }] as never;
const user = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });
const page = (navigate = vi.fn()) =>
  render(
    <Toast.Provider>
      <Alerts timezone="UTC" agents={agents} navigate={navigate} />
      <Toast.Viewport />
    </Toast.Provider>,
  );

describe('Alerts', { timeout: 180_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.sentinels).mockResolvedValue(view());
    vi.mocked(api.snoozeAlerts).mockImplementation(async (keys) => ({ keys }));
    vi.mocked(api.muteAlert).mockResolvedValue({ id: 'm1', label: 'x' });
    vi.mocked(api.unmuteAlert).mockResolvedValue({ removed: true });
    vi.mocked(api.actOnAlerts).mockResolvedValue({ results: [{ key: 'draft:1', approvalId: 'a1' }] });
    vi.mocked(api.askAboutAlerts).mockResolvedValue({ agentId: 'postie', conversationId: 'c1', runId: 'r1' });
  });

  it('lists the decision in its owner line, with its actions, and counts the recap in one line', async () => {
    page();
    expect(await screen.findByText(draft.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(screen.getByTestId('recap-line')).toHaveTextContent('12 notes saved for the weekly recap');
    // The info notes are not rows; no severity pill is drawn.
    expect(screen.queryByText(balances.title)).not.toBeInTheDocument();
    expect(screen.queryByText('info')).not.toBeInTheDocument();
    expect(screen.queryByText('urgent')).not.toBeInTheDocument();
  });

  it('previews the recap by group, expands a group and fills its quick form', async () => {
    vi.mocked(api.actOnAlerts).mockResolvedValue({ results: [{ key: 'stale:A', result: {} }, { key: 'stale:C', result: {} }] });
    const u = user();
    page();
    await u.click(await screen.findByRole('button', { name: 'Preview' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText(balances.title)).toBeInTheDocument();
    await u.click(within(sheet).getByRole('button', { name: 'Show the 3' }));
    expect(within(sheet).getByText('A0.00 USD on 2026-09-14')).toBeInTheDocument();
    await u.click(within(sheet).getByRole('button', { name: 'Update them' }));
    const form = await screen.findByRole('dialog', { name: 'Update balances' });
    await u.type(within(form).getByLabelText('A'), '1200');
    await u.type(within(form).getByLabelText('C'), '42.5');
    await u.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.actOnAlerts).toHaveBeenCalledWith([
      { key: 'stale:A', action: 0, value: '1200' },
      { key: 'stale:C', action: 0, value: '42.5' },
    ]));
  });

  it('runs a gated action and says it waits for approval; asks first when the finding says so', async () => {
    const u = user();
    page();
    await u.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.actOnAlerts).toHaveBeenCalledWith([{ key: 'draft:1', action: 1 }]));
    expect(await screen.findByText('Waiting for your approval')).toBeInTheDocument();
  });

  it('opens the draft on the Mail page', async () => {
    const navigate = vi.fn();
    const u = user();
    page(navigate);
    await u.click(await screen.findByRole('button', { name: 'Open draft' }));
    expect(navigate).toHaveBeenCalledWith('#/p/email/mail/t-1');
  });

  it('Not now snoozes for a week, with Undo', async () => {
    const u = user();
    page();
    await u.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(api.snoozeAlerts).toHaveBeenCalledWith(['draft:1'], true, 7));
    await u.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.snoozeAlerts).toHaveBeenCalledWith(['draft:1'], false));
  });

  it('Stop telling me this silences the subject, with Undo', async () => {
    const u = user();
    page();
    await u.click(await screen.findByRole('button', { name: `More for ${draft.title}` }));
    await u.click(await screen.findByRole('menuitem', { name: /Stop telling me this/ }));
    await waitFor(() => expect(api.muteAlert).toHaveBeenCalledWith('draft:1', 'subject'));
    await u.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.unmuteAlert).toHaveBeenCalledWith('m1'));
  });

  it('Clear all snoozes everything listed for a week, and Undo wakes it', async () => {
    const second = group({ id: 'x', keys: ['x1', 'x2'], title: 'Two of a kind' });
    vi.mocked(api.sentinels).mockResolvedValue(view({ open: [draft, second] }));
    const u = user();
    page();
    await u.click(await screen.findByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(api.snoozeAlerts).toHaveBeenCalledWith(['draft:1', 'x1', 'x2'], true, 7));
    expect(await screen.findByText('Cleared 2 for a week')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.snoozeAlerts).toHaveBeenCalledWith(['draft:1', 'x1', 'x2'], false));
  });

  it('Ask goes to the agent that answers, in a new conversation', async () => {
    const navigate = vi.fn();
    vi.mocked(api.sentinels).mockResolvedValue(view({ open: [group({ title: 'Ask me' })] }));
    const u = user();
    page(navigate);
    await u.click(await screen.findByRole('button', { name: 'Ask Ledger' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/chat/postie/c1'));
  });

  it('says nothing needs a decision when nothing does', async () => {
    vi.mocked(api.sentinels).mockResolvedValue(view({ open: [] }));
    page();
    expect(await screen.findByText('Nothing needs a decision.')).toBeInTheDocument();
  });
});

describe('the recap line and Home', () => {
  it('names the day when the recap is this week', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(recapLabel('2026-10-02T17:00:00Z', 'UTC', now)).toBe('Friday’s recap');
    expect(recapLabel('2026-11-02T17:00:00Z', 'UTC', now)).toBe('the weekly recap');
    expect(recapLabel(null, 'UTC', now)).toBe('the weekly recap');
  });

  it('Home says the first decision in its owner line', () => {
    expect(alertsNeedYou(1, [{ title: 'Your reply has sat as a draft.', count: 1 }])).toBe('Your reply has sat as a draft.');
    expect(alertsNeedYou(3, [{ title: 'Your reply has sat as a draft.', count: 1 }])).toBe('Your reply has sat as a draft. And 2 more to decide on.');
  });
});

/**
 * Settings → Email: the mailboxes, and the standing decisions about their mail.
 *
 * Both halves of the section are exercised here because they are one component
 * and one render. Of the accounts half, two things are worth a test: the
 * prefill, because typing an address and having the hosts appear is the step
 * that otherwise sends someone to a search engine, and the payload, because the
 * password is the one field on this page that must go to exactly one place and
 * appear nowhere else. Of the policies half, what is pinned is the distinction
 * the panel exists to make: an applied rule is deciding and offers one way out;
 * a proposed one is deciding nothing and offers two. Getting that backwards
 * would be the page telling the owner that something is off when it is on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, api, type EmailPoliciesView, type EmailPolicy } from '../api';
import {
  Email,
  EMPTY_RULE,
  KEYCHAIN_LINE,
  confirmLine,
  hostsFor,
  ruleBodyOf,
  subFor,
  threadLabel,
} from './Email';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: {
      emailAccounts: vi.fn(),
      addEmailAccount: vi.fn(),
      removeEmailAccount: vi.fn(),
      emailPolicies: vi.fn(),
      keepEmailPolicy: vi.fn(),
      revokeEmailPolicy: vi.fn(),
      setEmailPolicy: vi.fn(),
      bulkEmailPolicies: vi.fn(),
      emailWatchers: vi.fn(),
      setEmailWatchers: vi.fn(),
    },
  };
});

const ACCOUNT = {
  id: '11111111-1111-4111-8111-111111111111',
  address: 'owner@work.test',
  displayName: 'Work',
  aliases: ['invoices@work.test'],
  imapHost: 'imap.work.test',
  imapPort: 993,
  smtpHost: 'smtp.work.test',
  smtpPort: 465,
  secretName: 'EMAIL_OWNER_WORK_TEST_3f2a9c41',
  enabled: true,
  addedVia: 'page' as const,
  lastSyncAt: '2026-09-21T09:00:00Z',
};

function policy(over: Partial<EmailPolicy> = {}): EmailPolicy {
  return {
    id: 'p1',
    accountId: null,
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

const THREAD = {
  id: '22222222-2222-4222-8222-222222222222',
  accountId: ACCOUNT.id,
  subject: 'The quote',
  state: 'waiting-on-me',
  participants: ['client@work.test', 'owner@work.test'],
  lastAt: '2026-09-20T09:00:00Z',
};

/** The watcher settings, as the page reads them. */
const WATCHERS = {
  waitingDays: 2,
  dateConfidence: 0.6,
  defaults: { waitingDays: 2, dateConfidence: 0.6 },
  limits: { waitingDays: { min: 1, max: 60 }, dateConfidence: { min: 0.1, max: 0.99 } },
};

const VIEW: EmailPoliciesView = {
  applied: [policy()],
  proposed: [
    policy({ id: 'p2', matcher: 'maybe@shop.test', action: 'notify', proposed: true, runsSaved: 0 }),
  ],
  threads: [THREAD],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.emailAccounts).mockResolvedValue({ accounts: [ACCOUNT] });
  vi.mocked(api.addEmailAccount).mockResolvedValue({ ...ACCOUNT, address: 'owner@gmail.com' });
  vi.mocked(api.emailPolicies).mockResolvedValue(VIEW);
  vi.mocked(api.keepEmailPolicy).mockResolvedValue(VIEW);
  vi.mocked(api.revokeEmailPolicy).mockResolvedValue(VIEW);
  vi.mocked(api.bulkEmailPolicies).mockResolvedValue({ ...VIEW, kept: 0, revoked: 0, missing: 0 });
  vi.mocked(api.emailWatchers).mockResolvedValue(WATCHERS);
  vi.mocked(api.setEmailWatchers).mockResolvedValue({ ...WATCHERS, waitingDays: 4 });
});

/** Open a drawer by the button on the right of its section header. */
async function openDrawer(name: 'Add an account' | 'Add a rule'): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name }));
  await screen.findByRole('dialog');
}

describe('Settings → Email → Accounts', () => {
  it('knows the common providers, and falls back to the domain for the rest', () => {
    expect(hostsFor('owner@gmail.com')).toEqual({
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
    });
    expect(hostsFor('OWNER@Hotmail.com')?.smtpHost).toBe('smtp.office365.com');
    expect(hostsFor('owner@example.test')).toMatchObject({
      imapHost: 'imap.example.test',
      smtpHost: 'smtp.example.test',
    });
    expect(hostsFor('owner')).toBeNull();
  });

  it('lists each mailbox with its host, its last sync and the name its password is kept under', async () => {
    render(<Email />);
    expect(await screen.findByText('owner@work.test')).toBeInTheDocument();
    expect(screen.getByText('imap.work.test:993 · smtp.work.test:465')).toBeInTheDocument();
    expect(screen.getByText('EMAIL_OWNER_WORK_TEST_3f2a9c41')).toBeInTheDocument();
    expect(screen.getByText('invoices@work.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    // The form is behind the button, and the sentence about the password with it.
    expect(screen.queryByText(KEYCHAIN_LINE)).toBeNull();
    await openDrawer('Add an account');
    expect(screen.getByText(KEYCHAIN_LINE)).toBeInTheDocument();
  });

  it('fills the hosts in from the address, and sends exactly what was typed', async () => {
    render(<Email />);
    await screen.findByText('owner@work.test');
    await openDrawer('Add an account');

    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'owner@gmail.com' } });
    expect(screen.getByLabelText('IMAP host')).toHaveValue('imap.gmail.com');
    expect(screen.getByLabelText('SMTP host')).toHaveValue('smtp.gmail.com');
    expect(screen.getByLabelText('SMTP port')).toHaveValue(465);

    fireEvent.change(screen.getByLabelText('Also receives as'), {
      target: { value: 'Hello@gmail.com, contact@gmail.com' },
    });
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'abcd efgh ijkl mnop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add the account' }));

    await waitFor(() => expect(api.addEmailAccount).toHaveBeenCalledTimes(1));
    expect(api.addEmailAccount).toHaveBeenCalledWith({
      address: 'owner@gmail.com',
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      password: 'abcd efgh ijkl mnop',
      displayName: null,
      aliases: ['hello@gmail.com', 'contact@gmail.com'],
    });
    // Saved, so the drawer is closed and the list is read again.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.emailAccounts).toHaveBeenCalledTimes(2);
    // The field is emptied once it is away: the page never holds a password it
    // no longer needs, and never shows one back.
    await openDrawer('Add an account');
    expect(screen.getByLabelText('App password')).toHaveValue('');
  });

  it('stops guessing hosts once one has been typed by hand', async () => {
    render(<Email />);
    await screen.findByText('owner@work.test');
    await openDrawer('Add an account');
    fireEvent.change(screen.getByLabelText('IMAP host'), { target: { value: 'mail.mine.test' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'owner@gmail.com' } });
    expect(screen.getByLabelText('IMAP host')).toHaveValue('mail.mine.test');
  });

  it('will not send an incomplete form', async () => {
    render(<Email />);
    await screen.findByText('owner@work.test');
    await openDrawer('Add an account');
    expect(screen.getByRole('button', { name: 'Add the account' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'owner@gmail.com' } });
    expect(screen.getByRole('button', { name: 'Add the account' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Add the account' })).toBeEnabled();
  });

  it('asks before removing a mailbox, and says what goes with it', async () => {
    vi.mocked(api.removeEmailAccount).mockResolvedValue({ removed: true, address: ACCOUNT.address, secretRemoved: true });
    render(<Email />);
    await screen.findByText('owner@work.test');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('alert')).toHaveTextContent('the password from your keychain');
    expect(api.removeEmailAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    await waitFor(() => expect(api.removeEmailAccount).toHaveBeenCalledWith(ACCOUNT.id));
  });
});

describe('Settings → Email → Policies', () => {
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

/*
 * A rule says which mailbox it is about.
 *
 * The route refuses one that names neither a mailbox nor all of them, and the
 * form is where that stops being a refusal and becomes a choice: pick the
 * mailbox, or tick "for every mailbox". Leaving the field blank is neither.
 */
describe('Settings → Email → Add a rule', () => {
  beforeEach(() => {
    vi.mocked(api.setEmailPolicy).mockResolvedValue(VIEW);
  });

  it('will not write a rule until a mailbox is chosen', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('news@shop.test')).toBeInTheDocument());
    await openDrawer('Add a rule');

    const add = screen.getByRole('button', { name: 'Add the rule' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Their address'), {
      target: { value: 'news@shop.test' },
    });
    // A matcher on its own is not enough: the mailbox is still unsaid.
    expect(add).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Which mailbox'), { target: { value: ACCOUNT.id } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(api.setEmailPolicy).toHaveBeenCalledTimes(1));
    expect(api.setEmailPolicy).toHaveBeenCalledWith({
      scope: 'sender',
      matcher: 'news@shop.test',
      action: 'ignore',
      accountId: ACCOUNT.id,
    });
  });

  it('writes an installation-wide rule only when "for every mailbox" is ticked', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('news@shop.test')).toBeInTheDocument());

    await openDrawer('Add a rule');

    fireEvent.change(screen.getByLabelText('Their address'), { target: { value: 'news@shop.test' } });
    fireEvent.click(screen.getByLabelText('For every mailbox'));
    expect(screen.getByLabelText('Which mailbox')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add the rule' }));
    await waitFor(() => expect(api.setEmailPolicy).toHaveBeenCalledTimes(1));
    expect(api.setEmailPolicy).toHaveBeenCalledWith({
      scope: 'sender',
      matcher: 'news@shop.test',
      action: 'ignore',
      allAccounts: true,
    });
  });

  it('asks for the sender when silencing a conversation, because the key is theirs to write', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('news@shop.test')).toBeInTheDocument());

    await openDrawer('Add a rule');

    expect(screen.queryByLabelText('From this address')).toBeNull();
    fireEvent.change(screen.getByLabelText('What the rule is about'), { target: { value: 'thread' } });
    expect(screen.getByLabelText('From this address')).toBeInTheDocument();
    // And not for an action that only ever starts a run.
    fireEvent.change(screen.getByLabelText('What happens'), { target: { value: 'notify' } });
    expect(screen.queryByLabelText('From this address')).toBeNull();
  });

  it('picks a conversation by its subject rather than asking for a Message-ID, filtered and labelled by mailbox', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('news@shop.test')).toBeInTheDocument());

    await openDrawer('Add a rule');

    fireEvent.change(screen.getByLabelText('What the rule is about'), { target: { value: 'thread' } });
    // No mailbox chosen yet: the picker offers nothing rather than every
    // account's conversations, and "for every mailbox" is off the table.
    const picker = screen.getByLabelText('Which conversation');
    expect(picker).toBeDisabled();
    expect(screen.getByLabelText('For every mailbox')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Which mailbox'), { target: { value: ACCOUNT.id } });
    await waitFor(() => expect(api.emailPolicies).toHaveBeenCalledWith(ACCOUNT.id));
    expect(picker).toBeEnabled();
    expect(
      within(picker).getByText(threadLabel(THREAD, new Map([[ACCOUNT.id, ACCOUNT.displayName!]]))),
    ).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: THREAD.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Add the rule' }));
    await waitFor(() => expect(api.setEmailPolicy).toHaveBeenCalledTimes(1));
    // The id, not the subject: it is what the gate matches. The mailbox came
    // along automatically, bound to the thread that was picked.
    expect(api.setEmailPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'thread', matcher: THREAD.id, accountId: ACCOUNT.id }),
    );
  });

  it('offers no conversations from a mailbox other than the one chosen', async () => {
    const otherAccount = { ...ACCOUNT, id: '33333333-3333-4333-8333-333333333333', address: 'owner@other.test', displayName: 'Other' };
    vi.mocked(api.emailAccounts).mockResolvedValue({ accounts: [ACCOUNT, otherAccount] });
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('news@shop.test')).toBeInTheDocument());

    await openDrawer('Add a rule');

    fireEvent.change(screen.getByLabelText('What the rule is about'), { target: { value: 'thread' } });
    fireEvent.change(screen.getByLabelText('Which mailbox'), { target: { value: otherAccount.id } });
    // THREAD belongs to ACCOUNT, not otherAccount.
    expect(screen.getByLabelText('Which conversation')).toHaveTextContent('Choose one…');
    expect(within(screen.getByLabelText('Which conversation')).queryByText(/The quote/)).toBeNull();
  });

  it('sends the mailbox as one of two things, never as an omission', () => {
    expect(ruleBodyOf({ ...EMPTY_RULE, matcher: 'a@b.test', accountId: 'acc-1' })).toEqual({
      scope: 'sender',
      matcher: 'a@b.test',
      action: 'ignore',
      accountId: 'acc-1',
    });
    expect(
      ruleBodyOf({ ...EMPTY_RULE, matcher: 'a@b.test', allAccounts: true, accountId: '' }),
    ).toEqual({ scope: 'sender', matcher: 'a@b.test', action: 'ignore', allAccounts: true });
    // The sender travels only where it means something.
    expect(
      ruleBodyOf({ ...EMPTY_RULE, scope: 'thread', matcher: '<r@x>', sender: 'Them <THEM@x.test>', accountId: 'acc-1' }),
    ).toMatchObject({ sender: 'them@x.test' });
    expect(
      ruleBodyOf({ ...EMPTY_RULE, matcher: 'a@b.test', sender: 'them@x.test', accountId: 'acc-1' }),
    ).not.toHaveProperty('sender');
  });
});

/*
 * Seventy-three proposals is the case this page has to survive.
 *
 * What is pinned here is that the selection is what travels — the exact ids
 * the owner ticked, in one request — and that "all" says how many that is
 * before it happens. A bulk action that sent a flag instead of ids, or that
 * asked "are you sure?" without the number, would be the page deciding for
 * the owner on a list they cannot see the end of.
 */
describe('Settings → Email → keeping and revoking in bulk', () => {
  const P1 = policy({ id: 'q1', matcher: 'one@shop.test', proposed: true, runsSaved: 0 });
  const P2 = policy({ id: 'q2', matcher: 'two@shop.test', proposed: true, runsSaved: 0 });
  const P3 = policy({ id: 'q3', matcher: 'three@shop.test', proposed: true, runsSaved: 0 });
  const MANY: EmailPoliciesView = {
    applied: [policy({ id: 'a1', matcher: 'kept@shop.test' })],
    proposed: [P1, P2, P3],
    threads: [],
  };

  beforeEach(() => {
    vi.mocked(api.emailPolicies).mockResolvedValue(MANY);
    vi.mocked(api.bulkEmailPolicies).mockResolvedValue({ ...MANY, kept: 0, revoked: 0, missing: 0 });
  });

  /** The panel one of the two lists is drawn in. */
  function panel(title: 'Applied' | 'Learned, proposed'): HTMLElement {
    return screen.getByText(title).closest('.ui-panel') as HTMLElement;
  }

  it('says in each header how many rules the list holds', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('one@shop.test')).toBeInTheDocument());
    expect(within(panel('Learned, proposed')).getByText('3 proposed')).toBeInTheDocument();
    expect(within(panel('Applied')).getByText('1 applied')).toBeInTheDocument();
  });

  it('keeps exactly the rows that were ticked', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('one@shop.test')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select one@shop.test'));
    fireEvent.click(screen.getByLabelText('Select three@shop.test'));
    fireEvent.click(within(panel('Learned, proposed')).getByRole('button', { name: 'Keep selected' }));

    await waitFor(() => expect(api.bulkEmailPolicies).toHaveBeenCalledTimes(1));
    expect(api.bulkEmailPolicies).toHaveBeenCalledWith('keep', ['q1', 'q3']);
    // And the lists are read again, from the server rather than from hope.
    await waitFor(() => expect(api.emailPolicies).toHaveBeenCalledTimes(2));
  });

  it('revokes exactly the rows that were ticked', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('two@shop.test')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select two@shop.test'));
    fireEvent.click(within(panel('Learned, proposed')).getByRole('button', { name: 'Revoke selected' }));

    await waitFor(() => expect(api.bulkEmailPolicies).toHaveBeenCalledWith('revoke', ['q2']));
  });

  it('offers nothing to do until something is ticked', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('one@shop.test')).toBeInTheDocument());
    const head = panel('Learned, proposed');
    expect(within(head).getByRole('button', { name: 'Keep selected' })).toBeDisabled();
    expect(within(head).getByRole('button', { name: 'Revoke selected' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Select one@shop.test'));
    expect(within(head).getByRole('button', { name: 'Keep selected' })).toBeEnabled();
  });

  it('ticks every row shown from the header box', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('one@shop.test')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select all proposed'));
    expect(screen.getByLabelText('Select two@shop.test')).toBeChecked();

    // And untick again: the box is the whole list, both ways.
    fireEvent.click(screen.getByLabelText('Select all proposed'));
    expect(screen.getByLabelText('Select two@shop.test')).not.toBeChecked();

    fireEvent.click(screen.getByLabelText('Select all proposed'));
    fireEvent.click(within(panel('Learned, proposed')).getByRole('button', { name: 'Keep selected' }));
    await waitFor(() => expect(api.bulkEmailPolicies).toHaveBeenCalledWith('keep', ['q1', 'q2', 'q3']));
  });

  it('asks once before keeping all of them, and names the count', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('one@shop.test')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Keep all (3)' }));
    expect(screen.getByText(confirmLine('keep', 3))).toBeInTheDocument();
    expect(screen.getByText(/3 rules\?/)).toBeInTheDocument();
    expect(api.bulkEmailPolicies).not.toHaveBeenCalled();

    // And it can be called off without touching anything.
    fireEvent.click(within(panel('Learned, proposed')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(confirmLine('keep', 3))).toBeNull();
    expect(api.bulkEmailPolicies).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep all (3)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep all (3)' }));
    await waitFor(() => expect(api.bulkEmailPolicies).toHaveBeenCalledWith('keep', ['q1', 'q2', 'q3']));
  });

  it('asks the same way before revoking all of them, on both lists', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('one@shop.test')).toBeInTheDocument());

    // The proposed list.
    fireEvent.click(within(panel('Learned, proposed')).getByRole('button', { name: 'Revoke all (3)' }));
    expect(screen.getByText(confirmLine('revoke', 3))).toBeInTheDocument();
    fireEvent.click(within(panel('Learned, proposed')).getByRole('button', { name: 'Revoke all (3)' }));
    await waitFor(() => expect(api.bulkEmailPolicies).toHaveBeenCalledWith('revoke', ['q1', 'q2', 'q3']));

    // And the applied one, which offers no Keep at all: it is already kept.
    const kept = panel('Applied');
    expect(within(kept).queryByRole('button', { name: /Keep/ })).toBeNull();
    fireEvent.click(within(kept).getByRole('button', { name: 'Revoke all (1)' }));
    expect(within(kept).getByText(confirmLine('revoke', 1))).toBeInTheDocument();
    // One rule, so the line is singular. A count is not a plural by default.
    expect(confirmLine('revoke', 1)).toContain('1 rule?');
    fireEvent.click(within(kept).getByRole('button', { name: 'Revoke all (1)' }));
    await waitFor(() => expect(api.bulkEmailPolicies).toHaveBeenCalledWith('revoke', ['a1']));
  });

  it('shows the failure rather than pretending the selection went through', async () => {
    vi.mocked(api.bulkEmailPolicies).mockRejectedValue(new Error('That policy is no longer there.'));
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('one@shop.test')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Select one@shop.test'));
    fireEvent.click(within(panel('Learned, proposed')).getByRole('button', { name: 'Keep selected' }));
    await waitFor(() =>
      expect(screen.getByText('That policy is no longer there.')).toBeInTheDocument(),
    );
  });

  it('has no bulk actions on a list with nothing in it', async () => {
    vi.mocked(api.emailPolicies).mockResolvedValue({ applied: [], proposed: [] });
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText(/three verdicts running/)).toBeInTheDocument());
    expect(screen.queryByLabelText('Select all proposed')).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep all/ })).toBeNull();
    expect(screen.getByText('0 proposed')).toBeInTheDocument();
  });
});

/*
 * The drawers.
 *
 * A form is behind a button and the page is a list of what exists. The one
 * thing that must not happen is the drawer eating what was typed into it: it
 * is the same state as before, held by the page, so a lid closed by mistake is
 * a lid, and only a reload throws the draft away.
 */
describe('Settings → Email → the drawers', () => {
  it('opens the account form, closes on Escape, and keeps the draft', async () => {
    render(<Email />);
    await screen.findByText('owner@work.test');
    await openDrawer('Add an account');

    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'owner@gmail.com' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openDrawer('Add an account');
    expect(screen.getByLabelText('Address')).toHaveValue('owner@gmail.com');
    expect(screen.getByLabelText('IMAP host')).toHaveValue('imap.gmail.com');
  });

  it('closes the account form on Close, and keeps the draft', async () => {
    render(<Email />);
    await screen.findByText('owner@work.test');
    await openDrawer('Add an account');

    fireEvent.change(screen.getByLabelText('Name for it'), { target: { value: 'Side project' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openDrawer('Add an account');
    expect(screen.getByLabelText('Name for it')).toHaveValue('Side project');
  });

  it('opens the rule form, closes on Escape, and keeps the draft', async () => {
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('news@shop.test')).toBeInTheDocument());
    await openDrawer('Add a rule');

    fireEvent.change(screen.getByLabelText('Their address'), { target: { value: 'half@typed.test' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openDrawer('Add a rule');
    expect(screen.getByLabelText('Their address')).toHaveValue('half@typed.test');
  });

  it('closes the rule drawer once the rule is written, and reads the list again', async () => {
    vi.mocked(api.setEmailPolicy).mockResolvedValue(VIEW);
    render(<Email embedded />);
    await waitFor(() => expect(screen.getByText('news@shop.test')).toBeInTheDocument());
    await openDrawer('Add a rule');

    fireEvent.change(screen.getByLabelText('Their address'), { target: { value: 'news@shop.test' } });
    fireEvent.click(screen.getByLabelText('For every mailbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Add the rule' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.emailPolicies).toHaveBeenCalledTimes(2);
    // Written and gone: the drawer opens empty next time.
    await openDrawer('Add a rule');
    expect(screen.getByLabelText('Their address')).toHaveValue('');
  });
});

describe('Settings → Email → Watchers', () => {
  it('shows the two settings the mail watchers read, with their defaults said out loud', async () => {
    render(<Email />);
    expect(await screen.findByText('Watchers')).toBeInTheDocument();
    const days = await screen.findByLabelText('Waiting longer than');
    const confidence = screen.getByLabelText('Date confidence');
    expect(days).toHaveValue(2);
    expect(confidence).toHaveValue(0.6);
    expect(screen.getByText(/2 by default; a week or more is always urgent/)).toBeInTheDocument();
    // Neither watcher ever sends anything, and the page says so.
    expect(screen.getByText(/Neither ever sends anything/)).toBeInTheDocument();
  });

  it('saves nothing until something is changed, then saves both together', async () => {
    render(<Email />);
    const save = (await screen.findAllByRole('button', { name: 'Save' }))[0]!;
    expect(save).toBeDisabled();

    fireEvent.change(await screen.findByLabelText('Waiting longer than'), { target: { value: '4' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(api.setEmailWatchers).toHaveBeenCalledWith({ waitingDays: 4, dateConfidence: 0.6 }),
    );
    expect(await screen.findByText(/Saved\. The watchers use it on their next run\./)).toBeInTheDocument();
  });

  it("says what the server refused, in the server's words", async () => {
    vi.mocked(api.setEmailWatchers).mockRejectedValue(
      new ApiError(400, 'The waiting window is a whole number of days between 1 and 60.'),
    );
    render(<Email />);
    fireEvent.change(await screen.findByLabelText('Date confidence'), { target: { value: '0.9' } });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Save' }))[0]!);
    expect(
      await screen.findByText('The waiting window is a whole number of days between 1 and 60.'),
    ).toBeInTheDocument();
  });
});

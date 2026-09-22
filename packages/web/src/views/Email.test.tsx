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
import { api, type EmailPoliciesView, type EmailPolicy } from '../api';
import { Email, EMPTY_RULE, KEYCHAIN_LINE, hostsFor, ruleBodyOf, subFor } from './Email';

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

const VIEW: EmailPoliciesView = {
  applied: [policy()],
  proposed: [
    policy({ id: 'p2', matcher: 'maybe@shop.test', action: 'notify', proposed: true, runsSaved: 0 }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.emailAccounts).mockResolvedValue({ accounts: [ACCOUNT] });
  vi.mocked(api.addEmailAccount).mockResolvedValue({ ...ACCOUNT, address: 'owner@gmail.com' });
  vi.mocked(api.emailPolicies).mockResolvedValue(VIEW);
  vi.mocked(api.keepEmailPolicy).mockResolvedValue(VIEW);
  vi.mocked(api.revokeEmailPolicy).mockResolvedValue(VIEW);
});

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
    expect(screen.getByText(KEYCHAIN_LINE)).toBeInTheDocument();
  });

  it('fills the hosts in from the address, and sends exactly what was typed', async () => {
    render(<Email />);
    await screen.findByText('owner@work.test');

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
    // The field is emptied once it is away: the page never holds a password it
    // no longer needs, and never shows one back.
    await waitFor(() => expect(screen.getByLabelText('App password')).toHaveValue(''));
  });

  it('stops guessing hosts once one has been typed by hand', async () => {
    render(<Email />);
    await screen.findByText('owner@work.test');
    fireEvent.change(screen.getByLabelText('IMAP host'), { target: { value: 'mail.mine.test' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'owner@gmail.com' } });
    expect(screen.getByLabelText('IMAP host')).toHaveValue('mail.mine.test');
  });

  it('will not send an incomplete form', async () => {
    render(<Email />);
    await screen.findByText('owner@work.test');
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

    expect(screen.queryByLabelText('From this address')).toBeNull();
    fireEvent.change(screen.getByLabelText('What the rule is about'), { target: { value: 'thread' } });
    expect(screen.getByLabelText('From this address')).toBeInTheDocument();
    // And not for an action that only ever starts a run.
    fireEvent.change(screen.getByLabelText('What happens'), { target: { value: 'notify' } });
    expect(screen.queryByLabelText('From this address')).toBeNull();
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

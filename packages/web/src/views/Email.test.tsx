/**
 * Settings → Email: what the form fills in for you, and what it sends.
 *
 * Two things are worth a test here. The prefill, because typing an address and
 * having the hosts appear is the step that otherwise sends someone to a search
 * engine. And the payload, because the password is the one field on this page
 * that must go to exactly one place and appear nowhere else.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import { Email, KEYCHAIN_LINE, hostsFor } from './Email';

vi.mock('../api', () => ({
  ApiError: class ApiError extends Error {},
  api: { emailAccounts: vi.fn(), addEmailAccount: vi.fn(), removeEmailAccount: vi.fn() },
}));

const ACCOUNT = {
  id: '11111111-1111-4111-8111-111111111111',
  address: 'owner@work.test',
  displayName: 'Work',
  aliases: ['invoices@work.test'],
  imapHost: 'imap.work.test',
  imapPort: 993,
  smtpHost: 'smtp.work.test',
  smtpPort: 465,
  secretName: 'EMAIL_OWNER_WORK_TEST',
  enabled: true,
  addedVia: 'page' as const,
  lastSyncAt: '2026-09-21T09:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.emailAccounts).mockResolvedValue({ accounts: [ACCOUNT] });
  vi.mocked(api.addEmailAccount).mockResolvedValue({ ...ACCOUNT, address: 'owner@gmail.com' });
});

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
  expect(screen.getByText('EMAIL_OWNER_WORK_TEST')).toBeInTheDocument();
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

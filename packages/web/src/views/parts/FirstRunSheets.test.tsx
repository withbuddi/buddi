/**
 * First run's three small sheets: a choice, the one field it needs, a quiet
 * line saying how it went, and the sheet closing by itself on success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, api } from '../../api';
import { BankSheet, CalendarSheet, MailboxSheet, SHEETS, nameForLink } from './FirstRunSheets';

vi.mock('../../api', async (load) => {
  const real = await load<typeof import('../../api')>();
  return { ...real, api: { ...real.api, pageQuery: vi.fn(), pageAct: vi.fn() } };
});

beforeEach(() => {
  vi.mocked(api.pageQuery).mockReset();
  vi.mocked(api.pageAct).mockReset();
});

const sheet = (name: string): Promise<HTMLElement> => screen.findByRole('dialog', { name });

describe('the mailbox sheet', () => {
  it('asks which mailbox, then only the address and app password, and closes once Mail Triage reads it', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ result: { added: true, address: 'amen@gmail.com' } });
    const onClose = vi.fn();
    const onAdded = vi.fn();
    render(<MailboxSheet onClose={onClose} onAdded={onAdded} />);
    const s = await sheet(SHEETS.mailbox.sheet);
    for (const name of ['Gmail', 'iCloud', 'Fastmail', 'Other']) expect(within(s).getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    fireEvent.click(within(s).getByRole('button', { name: /Gmail/ }));
    expect(within(s).getByRole('link', { name: SHEETS.mailbox.how.gmail.link })).toHaveAttribute('href', SHEETS.mailbox.how.gmail.href);
    expect(within(s).queryByText(SHEETS.mailbox.server)).not.toBeInTheDocument();
    const add = within(s).getByRole('button', { name: SHEETS.mailbox.submit });
    expect(add).toBeDisabled();
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.address), { target: { value: 'amen@gmail.com' } });
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.password), { target: { value: 'abcd efgh' } });
    fireEvent.click(add);
    expect(within(s).getByText(SHEETS.checking)).toBeInTheDocument();
    expect(await within(s).findByText(SHEETS.mailbox.reading)).toBeInTheDocument();
    expect(api.pageAct).toHaveBeenCalledWith('email', {
      tool: 'email.add_account',
      args: { address: 'amen@gmail.com', password: 'abcd efgh', imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
    });
    expect(onAdded).toHaveBeenCalledWith('amen@gmail.com');
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 4_000 });
  });

  it('says the server\'s refusal in one line and stays open to try again', async () => {
    vi.mocked(api.pageAct).mockRejectedValue(new ApiError(400, 'imap.mail.me.com would not let us in as amen@icloud.com.'));
    const onClose = vi.fn();
    render(<MailboxSheet onClose={onClose} onAdded={vi.fn()} />);
    const s = await sheet(SHEETS.mailbox.sheet);
    fireEvent.click(within(s).getByRole('button', { name: /iCloud/ }));
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.address), { target: { value: 'amen@icloud.com' } });
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.password), { target: { value: 'wrong' } });
    fireEvent.click(within(s).getByRole('button', { name: SHEETS.mailbox.submit }));
    expect(await within(s).findByRole('alert')).toHaveTextContent('would not let us in');
    expect(within(s).getByRole('button', { name: SHEETS.mailbox.submit })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps an Other mailbox\'s hosts under Server details, sent only when filled in', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ result: { added: true, address: 'me@example.org', triage: 'needs-agent' } });
    render(<MailboxSheet onClose={vi.fn()} onAdded={vi.fn()} />);
    const s = await sheet(SHEETS.mailbox.sheet);
    fireEvent.click(within(s).getByRole('button', { name: /Other/ }));
    expect(within(s).getByText(SHEETS.mailbox.server)).toBeInTheDocument();
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.address), { target: { value: 'me@example.org' } });
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.otherPassword), { target: { value: 'pw' } });
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.imapHost), { target: { value: 'mail.example.org' } });
    fireEvent.click(within(s).getByRole('button', { name: SHEETS.mailbox.submit }));
    expect(await within(s).findByText(SHEETS.mailbox.noTriage)).toBeInTheDocument();
    expect(api.pageAct).toHaveBeenCalledWith('email', { tool: 'email.add_account', args: { address: 'me@example.org', password: 'pw', imapHost: 'mail.example.org' } });
  });

  it('goes back to the choice', async () => {
    render(<MailboxSheet onClose={vi.fn()} onAdded={vi.fn()} />);
    const s = await sheet(SHEETS.mailbox.sheet);
    fireEvent.click(within(s).getByRole('button', { name: /Fastmail/ }));
    fireEvent.click(within(s).getByRole('button', { name: SHEETS.back }));
    expect(within(s).getByText(SHEETS.mailbox.which)).toBeInTheDocument();
  });
});

describe('the calendar sheet', () => {
  it('links a pasted private link, says what it found, and closes', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { googleAvailable: false, calendars: [{ id: 'icloud-calendar', name: 'iCloud calendar' }] } });
    vi.mocked(api.pageAct).mockResolvedValue({ result: { note: 'Linked iCloud calendar 2 (iCloud): 1 event read. The link is kept as a secret.' } });
    const onClose = vi.fn();
    const onLinked = vi.fn();
    render(<CalendarSheet onClose={onClose} onLinked={onLinked} />);
    const s = await sheet(SHEETS.calendar.sheet);
    expect(within(s).getByText(SHEETS.calendar.where)).toBeInTheDocument();
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalledWith('calendar', 'settings'));
    expect(within(s).queryByRole('button', { name: SHEETS.calendar.google })).not.toBeInTheDocument();
    fireEvent.change(within(s).getByLabelText(SHEETS.calendar.field), { target: { value: 'webcal://p01-caldav.icloud.com/published/2/x' } });
    fireEvent.click(within(s).getByRole('button', { name: SHEETS.calendar.submit }));
    expect(await within(s).findByText(SHEETS.calendar.events(1))).toBeInTheDocument();
    // Never a name already taken: calendar.add refuses those.
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.add', args: { name: 'iCloud calendar 2', link: 'webcal://p01-caldav.icloud.com/published/2/x' } });
    expect(onLinked).toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 4_000 });
  });

  it('says why a link did not read, and stays open', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { googleAvailable: false, calendars: [] } });
    vi.mocked(api.pageAct).mockRejectedValue(new ApiError(400, 'buddi could not read that calendar: 404.'));
    const onClose = vi.fn();
    render(<CalendarSheet onClose={onClose} onLinked={vi.fn()} />);
    const s = await sheet(SHEETS.calendar.sheet);
    fireEvent.change(within(s).getByLabelText(SHEETS.calendar.field), { target: { value: 'https://example.com/x.ics' } });
    fireEvent.click(within(s).getByRole('button', { name: SHEETS.calendar.submit }));
    expect(await within(s).findByRole('alert')).toHaveTextContent('could not read that calendar');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('puts Google\'s sign-in first, waits for Google, finishes, and counts the calendars', async () => {
    let signIn: { id: string; url: string; state: string; note: string; problem: string } = { id: 's1', url: 'https://accounts.google.com/o/x', state: 'waiting', note: '', problem: '' };
    let found = 0;
    vi.mocked(api.pageQuery).mockImplementation(async (_plugin: string, query: string) => {
      if (query === 'sign_in') return { data: { rows: [signIn] } } as never;
      return { data: { googleAvailable: true, calendars: Array.from({ length: found }, (_, i) => ({ id: `c${i}`, name: `C${i}` })) } } as never;
    });
    vi.mocked(api.pageAct).mockImplementation(async (_plugin, body) => {
      if (body.tool === 'calendar.google_finish') found = 3;
      return { result: { note: '' } };
    });
    const onClose = vi.fn();
    render(<CalendarSheet onClose={onClose} onLinked={vi.fn()} />);
    const s = await sheet(SHEETS.calendar.sheet);
    fireEvent.click(await within(s).findByRole('button', { name: SHEETS.calendar.google }));
    expect(await within(s).findByRole('link', { name: SHEETS.calendar.continue })).toHaveAttribute('href', 'https://accounts.google.com/o/x');
    expect(within(s).getByText(SHEETS.calendar.waiting)).toBeInTheDocument();
    signIn = { ...signIn, state: 'received' };
    expect(await within(s).findByText(SHEETS.calendar.found(3), {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_sign_in', args: {} });
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_finish', args: { id: 's1' } });
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 4_000 });
  });

  it('drops a Google sign-in still waiting when the sheet is closed', async () => {
    vi.mocked(api.pageQuery).mockImplementation(async (_plugin: string, query: string) =>
      (query === 'sign_in'
        ? { data: { rows: [{ id: 's2', url: 'https://accounts.google.com/o/y', state: 'waiting', note: '', problem: '' }] } }
        : { data: { googleAvailable: true, calendars: [] } }) as never,
    );
    vi.mocked(api.pageAct).mockResolvedValue({ result: { note: '' } });
    const onClose = vi.fn();
    render(<CalendarSheet onClose={onClose} onLinked={vi.fn()} />);
    const s = await sheet(SHEETS.calendar.sheet);
    fireEvent.click(await within(s).findByRole('button', { name: SHEETS.calendar.google }));
    await within(s).findByRole('link', { name: SHEETS.calendar.continue });
    fireEvent.click(within(s).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_cancel', args: { id: 's2' } });
  });

  it('names a pasted link after where it points', () => {
    expect(nameForLink('https://calendar.google.com/calendar/ical/x/basic.ics', [])).toBe('Google calendar');
    expect(nameForLink('webcal://p01-caldav.icloud.com/x', ['iCloud calendar', 'icloud calendar 2'])).toBe('iCloud calendar 3');
    expect(nameForLink('https://example.org/cal.ics', [])).toBe('My calendar');
  });
});

describe('the bank sheet', () => {
  it('says in one line what Finance needs, and closes on its one button', async () => {
    const onClose = vi.fn();
    const onUnderstood = vi.fn();
    render(<BankSheet onClose={onClose} onUnderstood={onUnderstood} />);
    const s = await sheet(SHEETS.bank.sheet);
    expect(within(s).getByText(SHEETS.bank.line)).toBeInTheDocument();
    fireEvent.click(within(s).getByRole('button', { name: SHEETS.bank.ok }));
    expect(onUnderstood).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

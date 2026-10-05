/**
 * First run's three small sheets: a choice, the one field it needs, a quiet
 * line saying how it went, and the sheet closing by itself on success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, api, chatApi } from '../../api';
import { BankSheet, CalendarSheet, MailboxSheet, SHEETS, SIGN_IN_PREPARE_MS, nameForLink } from './FirstRunSheets';

vi.mock('../../api', async (load) => {
  const real = await load<typeof import('../../api')>();
  return { ...real, api: { ...real.api, pageQuery: vi.fn(), pageAct: vi.fn(), acceptPluginAgent: vi.fn() }, chatApi: { ...real.chatApi, agents: vi.fn() } };
});

beforeEach(() => {
  vi.mocked(api.pageQuery).mockReset();
  vi.mocked(api.pageAct).mockReset();
  vi.mocked(api.acceptPluginAgent).mockReset();
  // A team without Mail Triage, as on a first run.
  vi.mocked(chatApi.agents).mockReset().mockResolvedValue({ agents: [] } as never);
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
    vi.mocked(api.acceptPluginAgent).mockResolvedValue({ agent: { id: 'mail-triage', handle: 'mail', name: 'Mail Triage' } });
    render(<MailboxSheet onClose={vi.fn()} onAdded={vi.fn()} />);
    const s = await sheet(SHEETS.mailbox.sheet);
    fireEvent.click(within(s).getByRole('button', { name: /Other/ }));
    expect(within(s).getByText(SHEETS.mailbox.server)).toBeInTheDocument();
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.address), { target: { value: 'me@example.org' } });
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.otherPassword), { target: { value: 'pw' } });
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.imapHost), { target: { value: 'mail.example.org' } });
    fireEvent.click(within(s).getByRole('button', { name: SHEETS.mailbox.submit }));
    expect(await within(s).findByText(SHEETS.mailbox.reading)).toBeInTheDocument();
    expect(api.pageAct).toHaveBeenCalledWith('email', { tool: 'email.add_account', args: { address: 'me@example.org', password: 'pw', imapHost: 'mail.example.org' } });
  });

  it('brings Mail Triage in with the first mailbox, on the same press, and says so', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ result: { added: true, address: 'amen@gmail.com', triage: 'needs-agent' } });
    vi.mocked(api.acceptPluginAgent).mockResolvedValue({ approvalId: 'a1', agent: { id: 'mail-triage', handle: 'mail', name: 'Mail Triage' } });
    const joined = vi.fn();
    window.addEventListener('buddi:agents-changed', joined);
    render(<MailboxSheet onClose={vi.fn()} onAdded={vi.fn()} />);
    const s = await sheet(SHEETS.mailbox.sheet);
    fireEvent.click(within(s).getByRole('button', { name: /Gmail/ }));
    // Said before the press: one Add it covers the mailbox and its teammate.
    expect(await within(s).findByText(SHEETS.mailbox.brings)).toBeInTheDocument();
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.address), { target: { value: 'amen@gmail.com' } });
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.password), { target: { value: 'abcd efgh' } });
    fireEvent.click(within(s).getByRole('button', { name: SHEETS.mailbox.submit }));
    expect(await within(s).findByText(SHEETS.mailbox.reading)).toBeInTheDocument();
    expect(api.acceptPluginAgent).toHaveBeenCalledWith('email', 'mail-triage');
    expect(joined).toHaveBeenCalled();
    window.removeEventListener('buddi:agents-changed', joined);
  });

  it('does not promise Mail Triage when it is already on the team, or when the team cannot be read', async () => {
    vi.mocked(chatApi.agents).mockResolvedValue({ agents: [{ id: 'mail-triage', handle: 'mail', name: 'Mail Triage', roles: [] }] } as never);
    const { unmount } = render(<MailboxSheet onClose={vi.fn()} onAdded={vi.fn()} />);
    let s = await sheet(SHEETS.mailbox.sheet);
    fireEvent.click(within(s).getByRole('button', { name: /Gmail/ }));
    await waitFor(() => expect(chatApi.agents).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(within(s).queryByText(SHEETS.mailbox.brings)).not.toBeInTheDocument();
    unmount();
    vi.mocked(chatApi.agents).mockRejectedValue(new Error('offline'));
    render(<MailboxSheet onClose={vi.fn()} onAdded={vi.fn()} />);
    s = await sheet(SHEETS.mailbox.sheet);
    fireEvent.click(within(s).getByRole('button', { name: /Gmail/ }));
    await act(async () => { await Promise.resolve(); });
    expect(within(s).queryByText(SHEETS.mailbox.brings)).not.toBeInTheDocument();
  });

  it('keeps the mailbox and says where Mail Triage waits when it could not be created', async () => {
    vi.mocked(api.pageAct).mockResolvedValue({ result: { added: true, address: 'amen@gmail.com', triage: 'needs-agent' } });
    vi.mocked(api.acceptPluginAgent).mockRejectedValue(new ApiError(409, 'Creating @mail did not finish (failed).'));
    const onAdded = vi.fn();
    render(<MailboxSheet onClose={vi.fn()} onAdded={onAdded} />);
    const s = await sheet(SHEETS.mailbox.sheet);
    fireEvent.click(within(s).getByRole('button', { name: /Gmail/ }));
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.address), { target: { value: 'amen@gmail.com' } });
    fireEvent.change(within(s).getByLabelText(SHEETS.mailbox.password), { target: { value: 'abcd efgh' } });
    fireEvent.click(within(s).getByRole('button', { name: SHEETS.mailbox.submit }));
    expect(await within(s).findByText(SHEETS.mailbox.noTriage('Creating @mail did not finish (failed).'))).toBeInTheDocument();
    expect(onAdded).toHaveBeenCalledWith('amen@gmail.com');
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

  /** The calendar plugin as the sheet sees it: each google_sign_in makes a new waiting sign-in with its own address. */
  function googlePlugin() {
    const plugin = { started: 0, found: 0, row: null as null | { id: string; url: string; state: string; note: string; problem: string }, failStart: false };
    vi.mocked(api.pageQuery).mockImplementation(async (_plugin: string, query: string) => {
      if (query === 'sign_in') return { data: { rows: plugin.row ? [plugin.row] : [] } } as never;
      return { data: { googleAvailable: true, calendars: Array.from({ length: plugin.found }, (_, i) => ({ id: `c${i}`, name: `C${i}` })) } } as never;
    });
    vi.mocked(api.pageAct).mockImplementation(async (_plugin, body) => {
      if (body.tool === 'calendar.google_sign_in') {
        if (plugin.failStart) throw new ApiError(500, 'Google is not set up on this buddi');
        plugin.started += 1;
        plugin.row = { id: `s${plugin.started}`, url: `https://accounts.google.com/o/${plugin.started}`, state: 'waiting', note: '', problem: '' };
      }
      if (body.tool === 'calendar.google_finish') plugin.found = 3;
      if (body.tool === 'calendar.google_cancel' && plugin.row?.id === (body.args as { id?: string }).id) plugin.row = null;
      return { result: { note: '' } };
    });
    return plugin;
  }

  it('prepares Google\'s sign-in when the sheet opens, so one press opens Google\'s page, then finishes and counts the calendars', async () => {
    const plugin = googlePlugin();
    const onClose = vi.fn();
    render(<CalendarSheet onClose={onClose} onLinked={vi.fn()} />);
    const s = await sheet(SHEETS.calendar.sheet);
    // Ready before any press: a link to the prepared address, opened in a new tab by the press itself.
    const link = await within(s).findByRole('link', { name: SHEETS.calendar.google });
    expect(link).toHaveAttribute('href', 'https://accounts.google.com/o/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.querySelector('[data-icon="external"]')).not.toBeNull();
    expect(plugin.started).toBe(1);
    fireEvent.click(link);
    expect(await within(s).findByText(SHEETS.calendar.waiting)).toBeInTheDocument();
    expect(within(s).queryByRole('link', { name: SHEETS.calendar.continue })).not.toBeInTheDocument();
    plugin.row = { ...plugin.row!, state: 'received' };
    expect(await within(s).findByText(SHEETS.calendar.found(3), {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_finish', args: { id: 's1' } });
    // The press opened the prepared sign-in; it never started another.
    expect(plugin.started).toBe(1);
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 4_000 });
  });

  it('prepares it again before the host\'s ten minutes run out, and not once it was pressed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const plugin = googlePlugin();
      render(<CalendarSheet onClose={vi.fn()} onLinked={vi.fn()} />);
      const s = await sheet(SHEETS.calendar.sheet);
      expect(await within(s).findByRole('link', { name: SHEETS.calendar.google })).toHaveAttribute('href', 'https://accounts.google.com/o/1');
      expect(SIGN_IN_PREPARE_MS).toBeLessThan(10 * 60_000);
      await act(async () => { await vi.advanceTimersByTimeAsync(SIGN_IN_PREPARE_MS); });
      await waitFor(() => expect(within(s).getByRole('link', { name: SHEETS.calendar.google })).toHaveAttribute('href', 'https://accounts.google.com/o/2'));
      fireEvent.click(within(s).getByRole('link', { name: SHEETS.calendar.google }));
      await act(async () => { await vi.advanceTimersByTimeAsync(SIGN_IN_PREPARE_MS * 2); });
      expect(plugin.started).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts it on the press when preparing failed, its link then the second step', async () => {
    const plugin = googlePlugin();
    plugin.failStart = true;
    render(<CalendarSheet onClose={vi.fn()} onLinked={vi.fn()} />);
    const s = await sheet(SHEETS.calendar.sheet);
    const button = await within(s).findByRole('button', { name: SHEETS.calendar.google });
    await waitFor(() => expect(button).toBeEnabled());
    plugin.failStart = false;
    fireEvent.click(button);
    expect(await within(s).findByRole('link', { name: SHEETS.calendar.continue })).toHaveAttribute('href', 'https://accounts.google.com/o/1');
  });

  it('drops a Google sign-in still waiting when the sheet is closed, and a prepared one never pressed', async () => {
    googlePlugin();
    const first = render(<CalendarSheet onClose={vi.fn()} onLinked={vi.fn()} />);
    let s = await sheet(SHEETS.calendar.sheet);
    await within(s).findByRole('link', { name: SHEETS.calendar.google });
    fireEvent.click(within(s).getByRole('button', { name: 'Close' }));
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_cancel', args: { id: 's1' } });
    first.unmount();

    const onClose = vi.fn();
    render(<CalendarSheet onClose={onClose} onLinked={vi.fn()} />);
    s = await sheet(SHEETS.calendar.sheet);
    fireEvent.click(await within(s).findByRole('link', { name: SHEETS.calendar.google }));
    await within(s).findByText(SHEETS.calendar.waiting);
    fireEvent.click(within(s).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_cancel', args: { id: 's2' } });
  });

  it('uses a Google sign-in already waiting instead of starting one, which would drop it', async () => {
    const plugin = googlePlugin();
    plugin.row = { id: 'theirs', url: 'https://accounts.google.com/o/theirs', state: 'waiting', note: '', problem: '' };
    render(<CalendarSheet onClose={vi.fn()} onLinked={vi.fn()} />);
    const s = await sheet(SHEETS.calendar.sheet);
    expect(await within(s).findByRole('link', { name: SHEETS.calendar.google })).toHaveAttribute('href', 'https://accounts.google.com/o/theirs');
    expect(plugin.started).toBe(0);
    expect(api.pageAct).not.toHaveBeenCalledWith('calendar', expect.objectContaining({ tool: 'calendar.google_sign_in' }));
  });

  it('drops the prepared sign-in when the sheet goes away without Close, and keeps a pressed one', async () => {
    googlePlugin();
    const first = render(<CalendarSheet onClose={vi.fn()} onLinked={vi.fn()} />);
    await within(await sheet(SHEETS.calendar.sheet)).findByRole('link', { name: SHEETS.calendar.google });
    first.unmount();
    expect(api.pageAct).toHaveBeenCalledWith('calendar', { tool: 'calendar.google_cancel', args: { id: 's1' } });

    vi.mocked(api.pageAct).mockClear();
    const second = render(<CalendarSheet onClose={vi.fn()} onLinked={vi.fn()} />);
    const s = await sheet(SHEETS.calendar.sheet);
    fireEvent.click(await within(s).findByRole('link', { name: SHEETS.calendar.google }));
    await within(s).findByText(SHEETS.calendar.waiting);
    second.unmount();
    expect(api.pageAct).not.toHaveBeenCalledWith('calendar', expect.objectContaining({ tool: 'calendar.google_cancel' }));
  });

  it('prepares it again when the tab comes back to the front after the prepared one got old', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = vi.spyOn(document, 'visibilityState', 'get');
    try {
      const plugin = googlePlugin();
      render(<CalendarSheet onClose={vi.fn()} onLinked={vi.fn()} />);
      const s = await sheet(SHEETS.calendar.sheet);
      expect(await within(s).findByRole('link', { name: SHEETS.calendar.google })).toHaveAttribute('href', 'https://accounts.google.com/o/1');
      // Back in front soon after: nothing to do.
      state.mockReturnValue('visible');
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(plugin.started).toBe(1);
      // A background tab's timer did not fire; the clock moved on all the same.
      vi.setSystemTime(Date.now() + SIGN_IN_PREPARE_MS + 1_000);
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await waitFor(() => expect(within(s).getByRole('link', { name: SHEETS.calendar.google })).toHaveAttribute('href', 'https://accounts.google.com/o/2'));
      expect(plugin.started).toBe(2);
    } finally {
      state.mockRestore();
      vi.useRealTimers();
    }
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

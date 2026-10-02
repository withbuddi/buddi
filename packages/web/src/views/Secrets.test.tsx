/**
 * Keys and secrets on the page: the groups and their rows in human words, the
 * read-only groups that link to where they are managed, a problem as one
 * sentence with its one fix, "not used by anything" with Remove, the row's
 * one ⋯ menu and the owner's writes it leads to — each a tool invoked as the
 * owner, never anything a model sees — and the value never shown again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, type SecretListingView, type SecretsView } from '../api';
import { Secrets } from './Secrets';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      secrets: vi.fn(),
      secretUses: vi.fn(async () => ({ uses: [] })),
      secretsAct: vi.fn(),
      providerAccounts: vi.fn(async () => ({
        vault: { kind: 'file', locked: false, advice: '' },
        accounts: [{ id: 'acct-claude', label: 'Claude', kind: 'anthropic', auth: 'api-key' }],
      })),
    },
  };
});

const MAILBOX_ID = '4f8d261b-e100-4c1a-9a51-6b2f0e7d9c11';
const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();
const binding = (kind: string, target: unknown, rule: 'every-time' | 'first-time' | 'pre-approved' = 'pre-approved') => ({
  kind,
  target,
  rule,
  firstApprovedAt: null,
  heldByPlugin: kind.endsWith('.account'),
});

const PNC: SecretListingView = {
  name: 'PNC password',
  totp: false,
  hasValue: true,
  bindings: [binding('browser.field', 'https://www.pnc.com', 'first-time')],
  lastUse: { at: ago(7200), kind: 'browser.field', target: 'https://www.pnc.com', agentId: 'finance', outcome: 'delivered', detail: null },
  usedBy: [],
  unused: false,
};
const GITHUB: SecretListingView = {
  name: 'GitHub token',
  totp: false,
  hasValue: true,
  bindings: [binding('http.header', { host: 'api.github.com', header: 'Authorization' })],
  lastUse: {
    at: ago(23),
    kind: 'http.header',
    target: { host: 'uploads.github.com', header: 'Authorization' },
    agentId: 'forge',
    outcome: 'refused',
    detail: '"GitHub token" is not bound to uploads.github.com.',
  },
  usedBy: [],
  unused: false,
};
const GMAIL: SecretListingView = {
  name: 'EMAIL_SAM_GMAIL_COM_b68f74ea',
  totp: false,
  hasValue: true,
  bindings: [binding('email.account', MAILBOX_ID)],
  lastUse: { at: ago(300), kind: 'email.account', target: MAILBOX_ID, agentId: null, outcome: 'held', detail: null },
  usedBy: [{ kind: 'mailbox', id: MAILBOX_ID, address: 'sam@gmail.com', provider: 'Gmail', auth: 'app-password', loginFailedAt: null }],
  unused: false,
};
const LEGACY: SecretListingView = {
  name: 'GMAIL_APP_PASSWORD',
  totp: false,
  hasValue: true,
  bindings: [binding('email.account', MAILBOX_ID)],
  lastUse: null,
  usedBy: [],
  unused: true,
};
const CALENDAR: SecretListingView = {
  name: 'Calendar link: Family',
  totp: false,
  hasValue: false,
  bindings: [binding('http.url', { plugin: 'calendar', host: 'p52-caldav.icloud.com' })],
  lastUse: null,
  usedBy: [],
  unused: false,
};
const CLAUDE: SecretListingView = {
  name: 'PROVIDER_ACCOUNT_5d0c7a4e_1b2c_4d3e_8f90_123456789abc',
  totp: false,
  hasValue: true,
  bindings: [binding('accounts.provider', 'acct-claude')],
  lastUse: { at: ago(60), kind: 'accounts.provider', target: 'acct-claude', agentId: null, outcome: 'delivered', detail: null },
  usedBy: [{ kind: 'model-account', id: 'acct-claude', label: 'Claude', auth: 'api-key' }],
  unused: false,
};

const VIEW: SecretsView = {
  secrets: [CALENDAR, CLAUDE, GITHUB, GMAIL, LEGACY, PNC],
  destinations: [
    { kind: 'browser.field', plugin: 'browser', maxRule: 'pre-approved' },
    { kind: 'browser.native.type', plugin: 'browser', maxRule: 'every-time' },
    { kind: 'http.header', plugin: 'http', maxRule: 'pre-approved' },
  ],
  ownKeys: ['TELEGRAM_BOT_TOKEN'],
};

const group = (name: string): HTMLElement => screen.getByRole('region', { name });

async function openPage(view: SecretsView = VIEW): Promise<void> {
  vi.mocked(api.secrets).mockResolvedValue(view);
  render(<Secrets embedded timezone="UTC" />);
  await screen.findByText('PNC password');
}

/** A row's ⋯ menu, opened the way Radix needs (a pointer press), and one of its items chosen. */
async function chooseFromMenu(title: string, item: string): Promise<void> {
  await userEvent.setup({ delay: null, pointerEventsCheck: 0 }).click(screen.getByLabelText(`More for ${title}`));
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(`^${item}`) }));
}

describe('the groups and their rows', { timeout: 180_000 }, () => {
  beforeEach(() => vi.clearAllMocks());

  it('sorts secrets into Your secrets, Mail, the plugin’s own group and Model accounts, in that order', async () => {
    await openPage();
    const headings = screen.getAllByRole('region').map((region) => within(region).getByRole('heading').textContent);
    expect(headings).toEqual(['Your secrets', 'Mail', 'Calendar links', 'Model accounts']);
    expect(within(group('Your secrets')).getByText('GitHub token')).toBeInTheDocument();
    expect(within(group('Mail')).getByText('Gmail app password')).toBeInTheDocument();
    expect(within(group('Calendar links')).getByText('Family')).toBeInTheDocument();
    expect(within(group('Model accounts')).getByText('Claude')).toBeInTheDocument();
  });

  it('draws no empty group, and one empty state when nothing is stored', async () => {
    await openPage({ ...VIEW, secrets: [PNC] });
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual(['Your secrets']);
    vi.mocked(api.secrets).mockResolvedValue({ ...VIEW, secrets: [] });
    render(<Secrets embedded timezone="UTC" />);
    expect(await screen.findByText('Nothing stored yet.')).toBeInTheDocument();
  });

  it('names each row in human words and never shows a stored name or an id in the row', async () => {
    await openPage();
    const panel = screen.getAllByRole('region');
    const text = panel.map((region) => region.textContent).join(' ');
    for (const internal of [GMAIL.name, LEGACY.name, CLAUDE.name, CALENDAR.name, MAILBOX_ID, 'acct-claude', 'email.account', 'accounts.provider', 'http.url', 'pre-approved']) {
      expect(text).not.toContain(internal);
    }
    expect(screen.getByText(/Used by the mailbox sam@gmail\.com · Last used 5 minutes ago/)).toBeInTheDocument();
    expect(screen.getByText(/Filled on pnc\.com · asks you the first time · Last used 2 hours ago/)).toBeInTheDocument();
    expect(screen.getByText(/Sent only to p52-caldav\.icloud\.com · Never used/)).toBeInTheDocument();
    expect(screen.getByText('Old mailbox password')).toBeInTheDocument();
    // A model account: its label, its provider beside it.
    expect(within(group('Model accounts')).getByText('Anthropic API')).toBeInTheDocument();
  });

  it('keeps model accounts read-only here: a link to where they are managed, no menu', async () => {
    await openPage();
    const models = group('Model accounts');
    expect(within(models).getByRole('link', { name: /Managed in Model accounts/ })).toHaveAttribute('href', '#/settings/accounts?account=acct-claude');
    expect(within(models).queryByLabelText(/More for/)).toBeNull();
    expect(within(models).queryByRole('button', { name: /Replace|Delete/ })).toBeNull();
  });

  it('says a problem as one sentence with its one fix, and nothing on a healthy row', async () => {
    await openPage();
    expect(screen.getByText(/Held back 2\d seconds ago: it was asked for at uploads\.github\.com, where it may not go\./)).toBeInTheDocument();
    expect(within(group('Your secrets')).getByRole('button', { name: 'Change where it may go' })).toBeInTheDocument();
    expect(within(group('Calendar links')).getByText('No value stored.')).toBeInTheDocument();
    expect(within(group('Calendar links')).getByRole('button', { name: 'Set a value' })).toBeInTheDocument();
    // A healthy row: no pill, no status line, no fix.
    expect(screen.queryByText('delivered')).toBeNull();
    expect(screen.queryByText('refused')).toBeNull();
  });

  it('sends a mailbox the server turned down to its Set password form on the Email page', async () => {
    const failing = { ...GMAIL, usedBy: [{ ...GMAIL.usedBy![0]!, loginFailedAt: ago(720) }] } as SecretListingView;
    await openPage({ ...VIEW, secrets: [failing, PNC] });
    expect(screen.getByText('Gmail turned it down at sign-in 12 minutes ago.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set password' })).toHaveAttribute('href', `#/settings/p.email.settings?account=${MAILBOX_ID}&set=password`);
  });

  it('marks a secret nothing uses any more, quietly, and removes it only when asked', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { deleted: true } });
    await openPage();
    expect(screen.getByText('Not used by anything — no mailbox uses it any more.')).toBeInTheDocument();
    expect(api.secretsAct).not.toHaveBeenCalled();
    fireEvent.click(within(group('Mail')).getByRole('button', { name: 'Remove…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Remove “Old mailbox password”?');
    expect(dialog).toHaveTextContent('Nothing uses it, so nothing stops working.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.secretsAct).toHaveBeenCalledWith('secrets.delete', { name: 'GMAIL_APP_PASSWORD' }));
  });

  it('folds buddi’s own keys under the panel', async () => {
    await openPage();
    expect(screen.getByText('buddi’s own keys · 1')).toBeInTheDocument();
  });
});

describe('the row’s menu and its writes', { timeout: 180_000 }, () => {
  beforeEach(() => vi.clearAllMocks());

  it('renames through the owner tool', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { renamed: true } });
    await openPage();
    await chooseFromMenu('PNC password', 'Rename');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'PNC site password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(api.secretsAct).toHaveBeenCalledWith('secrets.rename', { name: 'PNC password', to: 'PNC site password' }));
  });

  it('changes where it may go through secrets.rebind, the places in words', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { rebound: true } });
    await openPage();
    await chooseFromMenu('PNC password', 'Change where it may go');
    const kind = screen.getByLabelText('Kind of place');
    expect(within(kind).getByRole('option', { name: 'A field on a website' })).toBeInTheDocument();
    expect(screen.getByLabelText('The place')).toHaveValue('https://www.pnc.com');
    expect(screen.getByLabelText('Asks you')).toHaveValue('first-time');
    fireEvent.change(screen.getByLabelText('Asks you'), { target: { value: 'every-time' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.secretsAct).toHaveBeenCalledWith('secrets.rebind', {
        name: 'PNC password',
        bindings: [{ kind: 'browser.field', target: 'https://www.pnc.com', rule: 'every-time' }],
      }),
    );
  });

  it('replaces the value and keeps where it may go as it was', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { name: 'PNC password', found: [] } });
    await openPage();
    await chooseFromMenu('PNC password', 'Replace value');
    const value = screen.getByLabelText('New value');
    expect(value).toHaveAttribute('type', 'password');
    fireEvent.change(value, { target: { value: 'new-secret-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
    await waitFor(() =>
      expect(api.secretsAct).toHaveBeenCalledWith('secrets.put', {
        name: 'PNC password',
        value: 'new-secret-2',
        totp: false,
        bindings: [{ kind: 'browser.field', target: 'https://www.pnc.com', rule: 'first-time' }],
      }),
    );
    expect(await screen.findByText(/Saved “PNC password”/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('new-secret-2');
  });

  it('deletes only after the dialog that names what stops working', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { deleted: true } });
    await openPage();
    await chooseFromMenu('GitHub token', 'Delete');
    expect(api.secretsAct).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete “GitHub token”?');
    expect(dialog).toHaveTextContent('Agents can no longer send it to api.github.com.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.secretsAct).toHaveBeenCalledWith('secrets.delete', { name: 'GitHub token' }));
  });

  it('opens the usage history in words, with the ids and the stored name behind Details', async () => {
    vi.mocked(api.secretUses).mockResolvedValue({
      uses: [
        { at: ago(23), secret: 'GitHub token', kind: 'http.header', target: { host: 'uploads.github.com', header: 'Authorization' }, plugin: 'http', agent: 'forge', outcome: 'refused', detail: '"GitHub token" is not bound to uploads.github.com.' },
        { at: ago(260), secret: 'GitHub token', kind: 'http.header', target: { host: 'api.github.com', header: 'Authorization' }, plugin: 'http', agent: 'forge', outcome: 'delivered', detail: null },
      ],
    });
    await openPage();
    await chooseFromMenu('GitHub token', 'Usage history');
    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(api.secretUses).toHaveBeenCalledWith('GitHub token', 50));
    expect(await within(sheet).findByText('Held back — asked for at uploads.github.com, where it may not go')).toBeInTheDocument();
    expect(within(sheet).getByText('Sent to api.github.com')).toBeInTheDocument();
    const details = within(sheet).getByText('Details').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText(/http\.header api\.github\.com · Authorization · pre-approved/)).toBeInTheDocument();
  });

  it('opens a mailbox’s new password on the Email page, and offers no rename or rebind for it', async () => {
    await openPage();
    await userEvent.setup({ delay: null, pointerEventsCheck: 0 }).click(screen.getByLabelText('More for Gmail app password'));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items[0]).toMatch(/^Set a new password/);
    expect(items.join(' ')).not.toMatch(/Rename|Change where|Delete/);
  });

  it('opens Replace value for the secret a link names', async () => {
    vi.mocked(api.secrets).mockResolvedValue(VIEW);
    render(<Secrets embedded timezone="UTC" secret="PNC password" />);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Replace the value of “PNC password”');
  });

  it('shows a refused write beside the control that asked for it', async () => {
    vi.mocked(api.secretsAct).mockRejectedValue(new Error('That name is taken.'));
    await openPage();
    await chooseFromMenu('PNC password', 'Rename');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GitHub token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That name is taken.');
  });
});

describe('the phone', { timeout: 180_000 }, () => {
  beforeEach(() => vi.clearAllMocks());

  it('lays the ⋯ menu out as a sheet with the row’s name on top and Cancel under it', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('720px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      await openPage();
      fireEvent.click(screen.getByLabelText('More for PNC password'));
      const sheet = await screen.findByRole('dialog');
      expect(within(sheet).getByText('PNC password')).toBeInTheDocument();
      expect(within(sheet).getAllByRole('menuitem').map((item) => item.textContent?.replace(/Places, and.*$/, ''))).toEqual([
        'Replace value…',
        'Rename…',
        'Change where it may go…',
        'Usage history',
        'Delete…',
      ]);
      expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('the add form', { timeout: 180_000 }, () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes the value in a password field, starts a place at “the first time”, and sends the parsed places', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { name: 'Cour token', found: [] } });
    vi.mocked(api.secrets).mockResolvedValue(VIEW);
    render(<Secrets embedded timezone="UTC" adding />);
    const value = await screen.findByLabelText('Value');
    expect(value).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Asks you')).toHaveValue('first-time');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cour token' } });
    fireEvent.change(value, { target: { value: 'v-secret-1' } });
    fireEvent.change(screen.getByLabelText('Kind of place'), { target: { value: 'http.header' } });
    fireEvent.change(screen.getByLabelText('The place'), { target: { value: 'localhost:9200 Authorization' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() =>
      expect(api.secretsAct).toHaveBeenCalledWith('secrets.put', {
        name: 'Cour token',
        value: 'v-secret-1',
        totp: false,
        bindings: [{ kind: 'http.header', target: { host: 'localhost:9200', header: 'Authorization' }, rule: 'first-time' }],
      }),
    );
    expect(await screen.findByText(/Saved “Cour token”/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('v-secret-1');
  });

  it('offers only rules at most as loose as the destination allows', async () => {
    vi.mocked(api.secrets).mockResolvedValue(VIEW);
    render(<Secrets embedded timezone="UTC" adding />);
    fireEvent.change(await screen.findByLabelText('Kind of place'), { target: { value: 'browser.native.type' } });
    const rule = screen.getByLabelText('Asks you');
    expect(rule).toHaveValue('every-time');
    expect(within(rule).getAllByRole('option').map((option) => option.textContent)).toEqual(['Every time']);
  });

  it('reports where the value already sits, and scrubs it on one tap', async () => {
    vi.mocked(api.secretsAct)
      .mockResolvedValueOnce({ result: { name: 'Cour token', found: [{ place: 'events', count: 3 }, { place: 'memory notes', count: 1 }] } })
      .mockResolvedValueOnce({ result: { name: 'Cour token', scrubbed: [{ place: 'events', count: 3 }] } });
    vi.mocked(api.secrets).mockResolvedValue(VIEW);
    render(<Secrets embedded timezone="UTC" adding />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Cour token' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v-secret-1' } });
    fireEvent.change(screen.getByLabelText('The place'), { target: { value: 'https://localhost:8443' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(await screen.findByText(/already sits in 3 events and 1 memory note/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Scrub the history' }));
    await waitFor(() => expect(api.secretsAct).toHaveBeenCalledWith('secrets.scrub_history', { name: 'Cour token' }));
    expect(await screen.findByText(/Replaced with ‹secret:…› in 3 events/)).toBeInTheDocument();
  });

  it('refuses a place it cannot build, beside the save button', async () => {
    vi.mocked(api.secrets).mockResolvedValue(VIEW);
    render(<Secrets embedded timezone="UTC" adding />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Cour token' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v-secret-1' } });
    fireEvent.change(screen.getByLabelText('Kind of place'), { target: { value: 'http.header' } });
    fireEvent.change(screen.getByLabelText('The place'), { target: { value: 'localhost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/http.header needs both/);
    expect(api.secretsAct).not.toHaveBeenCalled();
  });
});

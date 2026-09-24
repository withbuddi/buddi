/**
 * Keys and secrets on the page: what a row shows, the add form's one password
 * field and the rule it may pick, the scrub a save offers, and the owner's
 * own writes — each a tool invoked as the owner, never anything a model sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type SecretsView } from '../api';
import { Secrets } from './Secrets';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: { ...original.api, secrets: vi.fn(), secretUses: vi.fn(), secretsAct: vi.fn() },
  };
});

const VIEW: SecretsView = {
  secrets: [
    {
      name: 'PNC password',
      totp: false,
      bindings: [
        { kind: 'browser.field', target: 'https://localhost:8443', rule: 'pre-approved', firstApprovedAt: '2026-09-23T10:00:00Z', heldByPlugin: false },
      ],
      lastUse: { at: '2026-09-24T08:00:00Z', kind: 'browser.field', target: 'https://localhost:8443', agentId: 'finance', outcome: 'delivered' },
    },
    {
      name: 'Mailbox',
      totp: false,
      bindings: [{ kind: 'mail.account', target: 'acct-1', rule: 'pre-approved', firstApprovedAt: null, heldByPlugin: true }],
      lastUse: { at: '2026-09-24T06:00:00Z', kind: 'mail.account', target: 'acct-1', agentId: 'mail', outcome: 'held' },
    },
    { name: 'Unused token', totp: false, bindings: [], lastUse: null },
  ],
  destinations: [
    { kind: 'browser.field', plugin: 'browser', maxRule: 'pre-approved' },
    { kind: 'browser.form.data', plugin: 'browser', maxRule: 'pre-approved' },
    { kind: 'browser.native.type', plugin: 'browser', maxRule: 'every-time' },
    { kind: 'http.header', plugin: 'core', maxRule: 'pre-approved' },
    { kind: 'mail.account', plugin: 'mail', maxRule: 'pre-approved' },
  ],
  ownKeys: ['SMTP_PASSWORD'],
};

async function openPage(): Promise<void> {
  render(<Secrets embedded timezone="UTC" />);
  await screen.findByText('PNC password');
}

async function openAddSheet(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Add a secret' }));
  await screen.findByLabelText('Value');
}

describe('the rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.secrets).mockResolvedValue(VIEW);
  });

  it('shows each secret with its bindings, its last use, and buddi’s own keys read-only', async () => {
    await openPage();
    expect(screen.getByText('https://localhost:8443')).toBeInTheDocument();
    expect(screen.getByText('acct-1')).toBeInTheDocument();
    expect(screen.getAllByText('pre-approved').length).toBeGreaterThan(0);
    expect(screen.getByText(/Last used .* by finance — browser\.field/)).toBeInTheDocument();
    expect(screen.getByText('SMTP_PASSWORD')).toBeInTheDocument();
    expect(screen.getByText(/cannot be bound or replaced here/)).toBeInTheDocument();
    // An account kind's one line, and a secret with no binding's one line.
    expect(screen.getByText(/holds the value for as long as its connection lives/)).toBeInTheDocument();
    expect(screen.getByText(/Stored, not usable until it has a binding/)).toBeInTheDocument();
    // And the row's own way back to its bindings, not a rebind.
    expect(screen.getByRole('button', { name: 'Add a binding' })).toBeInTheDocument();
  });

  it('fetches one secret’s use log when its row opens it', async () => {
    vi.mocked(api.secretUses).mockResolvedValue({
      uses: [
        { at: '2026-09-24T08:00:00Z', secret: 'PNC password', kind: 'browser.field', target: 'https://localhost:8443', plugin: 'browser', agent: 'finance', outcome: 'delivered', detail: 'filled the password field' },
      ],
    });
    await openPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Use log' })[0]!);
    await waitFor(() => expect(api.secretUses).toHaveBeenCalledWith('PNC password', 50));
    expect(await screen.findByText(/filled the password field/)).toBeInTheDocument();
    expect(screen.getAllByText('delivered').length).toBeGreaterThan(0);
  });

  it('renames, rebinds and deletes through the owner tools, each confirmed where it must be', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { renamed: true } });
    await openPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename' })[0]!);
    expect(screen.getByText('Rename “PNC password”')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'PNC site password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(api.secretsAct).toHaveBeenCalledWith('secrets.rename', { name: 'PNC password', to: 'PNC site password' }));

    vi.mocked(api.secretsAct).mockClear().mockResolvedValue({ result: { rebound: true } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Rebind' })[0]!);
    // The stored binding, back as the one text input takes it.
    expect(screen.getByLabelText('Target')).toHaveValue('https://localhost:8443');
    expect(screen.getByLabelText('Rule')).toHaveValue('pre-approved');
    fireEvent.click(screen.getByRole('button', { name: 'Save bindings' }));
    await waitFor(() =>
      expect(api.secretsAct).toHaveBeenCalledWith('secrets.rebind', {
        name: 'PNC password',
        bindings: [{ kind: 'browser.field', target: 'https://localhost:8443', rule: 'pre-approved' }],
      }),
    );

    vi.mocked(api.secretsAct).mockClear().mockResolvedValue({ result: { deleted: true } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    expect(api.secretsAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(api.secretsAct).toHaveBeenCalledWith('secrets.delete', { name: 'PNC password' }));
  });

  it('shows a refused write beside the control that asked for it', async () => {
    vi.mocked(api.secretsAct).mockRejectedValue(new Error('That name is taken.'));
    await openPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename' })[0]!);
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Mailbox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That name is taken.');
  });
});

describe('the add form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.secrets).mockResolvedValue(VIEW);
  });

  it('takes the value in a password field, defaults the rule to the kind’s loosest, and sends the parsed bindings', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { name: 'Cour token', found: [] } });
    await openPage();
    await openAddSheet();
    const value = screen.getByLabelText('Value');
    expect(value).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Kind')).toHaveValue('browser.field');
    expect(screen.getByLabelText('Rule')).toHaveValue('pre-approved');
    // The TOTP sentence sits on the setting, before the owner chooses it.
    expect(screen.getByText(/The seed and the code are one thing buddi holds/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cour token' } });
    fireEvent.change(value, { target: { value: 'v-secret-1' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'http.header' } });
    expect(screen.getByLabelText('Rule')).toHaveValue('pre-approved');
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'localhost:9200 Authorization' } });
    fireEvent.click(screen.getByLabelText('The code comes from this secret'));
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() =>
      expect(api.secretsAct).toHaveBeenCalledWith('secrets.put', {
        name: 'Cour token',
        value: 'v-secret-1',
        totp: true,
        bindings: [{ kind: 'http.header', target: { host: 'localhost:9200', header: 'Authorization' }, rule: 'pre-approved' }],
      }),
    );
    // Saved: the value is gone from the page, never rendered again.
    expect(await screen.findByText(/Saved “Cour token”/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Value')).toBeNull();
    expect(document.body.textContent).not.toContain('v-secret-1');
  });

  it('offers only rules at most as loose as the destination allows', async () => {
    await openPage();
    await openAddSheet();
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'browser.native.type' } });
    const rule = screen.getByLabelText('Rule');
    expect(rule).toHaveValue('every-time');
    expect(within(rule).getAllByRole('option').map((option) => option.textContent)).toEqual(['every time']);
  });

  it('reports where the value already sits, and scrubs it on one tap', async () => {
    vi.mocked(api.secretsAct)
      .mockResolvedValueOnce({ result: { name: 'Cour token', found: [{ place: 'events', count: 3 }, { place: 'memory notes', count: 1 }] } })
      .mockResolvedValueOnce({ result: { name: 'Cour token', scrubbed: [{ place: 'events', count: 3 }] } });
    await openPage();
    await openAddSheet();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cour token' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v-secret-1' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'https://localhost:8443' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(await screen.findByText(/already sits in 3 events and 1 memory note/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Scrub the history' }));
    await waitFor(() => expect(api.secretsAct).toHaveBeenCalledWith('secrets.scrub_history', { name: 'Cour token' }));
    expect(await screen.findByText(/Replaced with ‹secret:…› in 3 events/)).toBeInTheDocument();
  });

  it('refuses a binding it cannot build, beside the save button', async () => {
    await openPage();
    await openAddSheet();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cour token' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v-secret-1' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'http.header' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'localhost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/http.header needs both/);
    expect(api.secretsAct).not.toHaveBeenCalled();
  });

  it('lets a secret be saved with no binding, said as stored but unusable', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { name: 'Dormant', found: [] } });
    await openPage();
    await openAddSheet();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dormant' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v-secret-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(within(screen.getByRole('dialog')).getByText(/Stored, not usable until it has a binding/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() =>
      expect(api.secretsAct).toHaveBeenCalledWith('secrets.put', { name: 'Dormant', value: 'v-secret-2', totp: false, bindings: [] }),
    );
  });
});

describe('replacing the value', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.secrets).mockResolvedValue(VIEW);
  });

  it('is the only way a value changes, and keeps the bindings as they are', async () => {
    vi.mocked(api.secretsAct).mockResolvedValue({ result: { name: 'PNC password', found: [] } });
    await openPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Replace value' })[0]!);
    const value = screen.getByLabelText('New value');
    expect(value).toHaveAttribute('type', 'password');
    fireEvent.change(value, { target: { value: 'new-secret-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
    await waitFor(() =>
      expect(api.secretsAct).toHaveBeenCalledWith('secrets.put', {
        name: 'PNC password',
        value: 'new-secret-2',
        totp: false,
        bindings: [{ kind: 'browser.field', target: 'https://localhost:8443', rule: 'pre-approved' }],
      }),
    );
    expect(await screen.findByText(/Saved “PNC password”/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('new-secret-2');
  });
});
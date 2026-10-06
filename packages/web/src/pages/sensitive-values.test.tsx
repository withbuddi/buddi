/**
 * Sensitive values (host API 1.31): a query marks paths into its answer, the
 * page keeps its whole structure and masks only those values until the owner
 * presses Show amounts, once, for the page — and masks them again when the
 * window is left or five minutes pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { PluginPage } from './PluginPage';
import { AMOUNTS_SHOWN_MS, setAmountsShown } from '../reveal';
import { announcePluginDataChanged } from './usePages';
import type { PluginPageDescriptor } from './types';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: {
    pages: vi.fn(),
    pageQuery: vi.fn(),
    pageAct: vi.fn(),
    approval: vi.fn(),
    approvals: vi.fn(),
    decide: vi.fn(),
    acceptPluginAgent: vi.fn(),
  },
}));

const OVERVIEW = {
  netWorth: 48210.5,
  currency: 'EUR',
  accounts: [
    { id: 'a1', name: 'Checking', bank: 'N26', balance: '1,204.10' },
    { id: 'a2', name: 'Savings', bank: 'ING', balance: '47,006.40' },
  ],
  budget: { limit: 900 },
};

const money: PluginPageDescriptor = {
  plugin: 'finance',
  id: 'money',
  title: 'Money',
  place: 'rail',
  sensitivePaths: { overview: ['netWorth', 'accounts[].balance', 'budget.limit'] },
  body: [
    {
      kind: 'stats',
      title: 'Where you stand',
      query: { query: 'overview' },
      items: [
        { label: 'Net worth', value: { path: 'netWorth' }, unit: 'number' },
        { label: 'Currency', value: { path: 'currency' } },
      ],
    },
    {
      kind: 'list',
      title: 'Accounts',
      query: { query: 'overview' },
      rows: 'accounts',
      key: 'id',
      item: { title: { path: 'name' }, meta: [{ path: 'bank' }, { path: 'balance' }] },
      actions: [{ tool: 'finance.note', label: 'Note', args: { id: { row: 'id' }, balance: { row: 'balance' } } }],
    },
    {
      kind: 'table',
      title: 'Table',
      query: { query: 'overview' },
      rows: 'accounts',
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'balance', label: 'Balance' },
      ],
    },
    {
      kind: 'form',
      title: 'Budget',
      initial: { query: 'overview' },
      fields: [{ name: 'limit', label: 'Limit', type: 'number', from: 'budget.limit' }],
      submit: { tool: 'finance.budget', label: 'Save', args: { limit: { field: 'limit' } } },
    },
  ],
};

const draw = (): ReturnType<typeof render> => render(<PluginPage page={money} navigate={vi.fn()} timezone="UTC" siblings={[money]} />);

beforeEach(() => {
  vi.clearAllMocks();
  setAmountsShown(false);
  vi.mocked(api.pageQuery).mockImplementation((() => Promise.resolve({ data: OVERVIEW })) as typeof api.pageQuery);
  vi.mocked(api.pageAct).mockResolvedValue({ result: { ok: true } });
  vi.mocked(api.approvals).mockResolvedValue({ pending: [], recent: [] });
});

afterEach(() => {
  setAmountsShown(false);
  vi.useRealTimers();
});

describe('sensitive values', () => {
  it('masks each marked value and keeps every piece of structure around it', async () => {
    draw();
    expect((await screen.findAllByText('Checking')).length).toBe(2);
    // Structure: titles, labels, names, the bank beside each balance.
    for (const text of ['Where you stand', 'Net worth', 'Currency', 'EUR', 'Accounts', 'Savings', 'Table', 'Budget', 'Limit']) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(/N26/).length).toBeGreaterThan(0);
    // None of the figures, anywhere.
    const body = document.body.textContent ?? '';
    for (const figure of ['48,210', '48210', '1,204.10', '47,006.40']) expect(body).not.toContain(figure);
    // Each mask is one stable-width mark that says "hidden": the stat, two metas, two cells.
    const masks = screen.getAllByRole('img', { name: 'hidden' });
    expect(masks.length).toBe(5);
    for (const mask of masks) expect(mask).toHaveTextContent(/^••••$/);
    // Nothing is held back from the gateway: the read is plain, the mask is the page's.
    expect(screen.queryByText('Hidden until you show it.')).not.toBeInTheDocument();
  });

  it('a form that starts from a masked value cannot save it', async () => {
    draw();
    expect(await screen.findByText('Show amounts to change this.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('one Show amounts reveals the whole page, and a row action sends the real value even while masked', async () => {
    draw();
    const accounts = (await screen.findByRole('heading', { name: 'Accounts' })).closest('section') as HTMLElement;
    fireEvent.click(within(accounts).getAllByRole('button', { name: 'Note' })[0]!);
    await waitFor(() => expect(api.pageAct).toHaveBeenCalled());
    expect(vi.mocked(api.pageAct).mock.calls[0]![1]).toEqual({ tool: 'finance.note', args: { id: 'a1', balance: '1,204.10' } });

    const toggle = screen.getByRole('button', { name: 'Show amounts' });
    expect(screen.getAllByRole('button', { name: /amounts/ })).toHaveLength(1);
    fireEvent.click(toggle);
    expect(await screen.findByText(/48,?210/)).toBeInTheDocument();
    expect(screen.getAllByText(/1,204\.10/).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('img', { name: 'hidden' })).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Hide amounts' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('masks again when the window is left', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Show amounts' }));
    expect(await screen.findByText(/48,?210/)).toBeInTheDocument();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(window, new Event('blur'));
    await waitFor(() => expect(screen.queryByText(/48,?210/)).not.toBeInTheDocument());
    expect(screen.getAllByRole('img', { name: 'hidden' }).length).toBe(5);
    visibility.mockRestore();
  });

  it('masks again on switching to another app, though the browser is still on screen', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Show amounts' }));
    expect(await screen.findByText(/48,?210/)).toBeInTheDocument();
    // visibilityState stays 'visible': only the window lost focus.
    fireEvent(window, new Event('blur'));
    await waitFor(() => expect(screen.queryByText(/48,?210/)).not.toBeInTheDocument());
  });

  it('keeps listening for the leave while no plugin page is open', async () => {
    const first = draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Show amounts' }));
    expect(await screen.findByText(/48,?210/)).toBeInTheDocument();
    first.unmount();
    // On Home, say: nothing that reads the switch is mounted.
    fireEvent(window, new Event('blur'));
    draw();
    expect((await screen.findAllByText('Checking')).length).toBe(2);
    expect(screen.queryByText(/48,?210/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show amounts' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps what the owner typed across a reveal, a re-mask and a background refresh', async () => {
    const page: PluginPageDescriptor = {
      ...money,
      body: [{
        kind: 'form',
        title: 'Budget',
        initial: { query: 'overview' },
        fields: [
          { name: 'limit', label: 'Limit', type: 'number', from: 'budget.limit' },
          { name: 'note', label: 'Note', type: 'text' },
        ],
        submit: { tool: 'finance.budget', label: 'Save', args: { limit: { field: 'limit' }, note: { field: 'note' } } },
      }],
    };
    render(<PluginPage page={page} navigate={vi.fn()} timezone="UTC" siblings={[page]} />);
    const note = await screen.findByLabelText('Note');
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalled());
    fireEvent.change(note, { target: { value: 'groceries up' } });

    fireEvent.click(screen.getByRole('button', { name: 'Show amounts' }));
    await waitFor(() => expect(screen.getByLabelText('Limit')).toHaveValue(900));
    expect(screen.getByLabelText('Note')).toHaveValue('groceries up');

    // Hidden again: the figure leaves the field, the typing stays, Save waits.
    fireEvent(window, new Event('blur'));
    await waitFor(() => expect(screen.getByText('Show amounts to change this.')).toBeInTheDocument());
    expect(screen.getByLabelText('Note')).toHaveValue('groceries up');
    expect(document.body.textContent).not.toContain('900');
    expect((screen.getByLabelText('Limit') as HTMLInputElement).value).not.toBe('900');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    // The plugin's tools wrote: the page asks again, and the form keeps its edits.
    const calls = vi.mocked(api.pageQuery).mock.calls.length;
    announcePluginDataChanged('finance');
    await waitFor(() => expect(vi.mocked(api.pageQuery).mock.calls.length).toBeGreaterThan(calls), { timeout: 2000 });
    expect(screen.getByLabelText('Note')).toHaveValue('groceries up');

    fireEvent.click(screen.getByRole('button', { name: 'Show amounts' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.pageAct).toHaveBeenCalled());
    expect(vi.mocked(api.pageAct).mock.calls[0]![1]).toEqual({ tool: 'finance.budget', args: { limit: 900, note: 'groceries up' } });
  });

  it('a row action\'s sheet never sends the mask, and masks again what it showed', async () => {
    const page: PluginPageDescriptor = {
      ...money,
      body: [{
        kind: 'table',
        title: 'Table',
        query: { query: 'overview' },
        rows: 'accounts',
        columns: [{ key: 'name', label: 'Name' }],
        actions: [{
          tool: 'finance.correct',
          label: 'Correct',
          args: { id: { row: 'id' }, balance: { field: 'balance' } },
          form: { title: 'Correct', submit: 'Save', fields: [{ name: 'balance', label: 'Balance', type: 'text', from: 'balance' }] },
        }],
      }],
    };
    render(<PluginPage page={page} navigate={vi.fn()} timezone="UTC" siblings={[page]} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Correct' }))[0]!);
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByLabelText('Balance')).toHaveValue('••••');
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(sheet).getByText('Show amounts to change this.')).toBeInTheDocument();

    // The page behind the sheet is out of reach; the switch is the session's.
    act(() => setAmountsShown(true));
    await waitFor(() => expect(within(sheet).getByLabelText('Balance')).toHaveValue('1,204.10'));
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeEnabled();

    // Left the window with the sheet open: the figure it held is masked again.
    fireEvent(window, new Event('blur'));
    await waitFor(() => expect(within(sheet).getByLabelText('Balance')).toHaveValue('••••'));
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(api.pageAct).not.toHaveBeenCalled();
  });

  it('remembers the reveal for the session, and masks again after five minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Show amounts' }));
    expect(await screen.findByText(/48,?210/)).toBeInTheDocument();
    first.unmount();
    // Another visit in the same session: still shown.
    draw();
    expect(await screen.findByText(/48,?210/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(AMOUNTS_SHOWN_MS + 1);
    });
    await waitFor(() => expect(screen.queryByText(/48,?210/)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Show amounts' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('draws no Show amounts on a page that reads no sensitive value', async () => {
    const plain: PluginPageDescriptor = { ...money, sensitivePaths: { other: ['x'] } };
    render(<PluginPage page={plain} navigate={vi.fn()} timezone="UTC" siblings={[plain]} />);
    expect((await screen.findAllByText('Checking')).length).toBe(2);
    expect(screen.queryByRole('button', { name: 'Show amounts' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/1,204\.10/).length).toBeGreaterThan(0);
  });
});

describe('the Money page head and stat cards', () => {
  const TOTALS = {
    cards: [
      { id: 'cash', icon: 'money', label: 'Cash', value: '€1,204', line: 'in 2 accounts' },
      { id: 'worth', icon: 'chart', label: 'Net worth', value: '€48,210', line: 'everything, less what you owe' },
    ],
  };
  const totals: PluginPageDescriptor = {
    plugin: 'finance',
    id: 'money',
    title: 'Money',
    place: 'rail',
    sensitivePaths: { money_totals: ['cards[].value'] },
    actions: [{ kind: 'button', action: { tool: 'finance.add', label: 'Add' } }],
    body: [{ kind: 'tiles', query: { query: 'money_totals' }, items: 'cards', icon: { path: 'icon' }, value: 'value', label: 'label', lines: ['line'], layout: 'grid' }],
  };
  const drawTotals = (): ReturnType<typeof render> =>
    render(<PluginPage page={totals} navigate={vi.fn()} timezone="UTC" siblings={[totals]} />);

  beforeEach(() => {
    vi.mocked(api.pageQuery).mockImplementation((() => Promise.resolve({ data: TOTALS })) as typeof api.pageQuery);
  });

  it('draws Show amounts as a secondary button with an eye, first among the head actions, its label flipping with its state', async () => {
    drawTotals();
    const toggle = await screen.findByRole('button', { name: 'Show amounts' });
    expect(toggle).toHaveClass('ui-btn', 'pp-reveal');
    expect(toggle).not.toHaveAttribute('data-variant');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle.querySelector('svg[data-icon="eye"]')).toHaveAttribute('aria-hidden', 'true');
    const head = toggle.closest('.ui-page-actions') as HTMLElement;
    expect(head.firstElementChild).toBe(toggle);
    expect(within(head).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName('Hide amounts');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('reveals from the keyboard: Tab reaches it, Enter shows, Space hides', async () => {
    const user = userEvent.setup({ delay: null });
    drawTotals();
    const toggle = await screen.findByRole('button', { name: 'Show amounts' });
    await screen.findAllByText('Net worth');
    for (let i = 0; i < 20 && document.activeElement !== toggle; i++) await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('€48,210')).toBeInTheDocument();
    expect(toggle).toHaveAccessibleName('Hide amounts');
    await user.keyboard(' ');
    await waitFor(() => expect(screen.queryByText('€48,210')).not.toBeInTheDocument());
    expect(toggle).toHaveAccessibleName('Show amounts');
  });

  it('a masked stat card keeps its layout: icon, the mask on the value line, the label under it', async () => {
    drawTotals();
    await screen.findAllByText('Net worth');
    const card = document.querySelectorAll('.wb-tile')[1] as HTMLElement;
    // Read as one sentence, the mask says "hidden".
    expect(card.querySelector('.sr-only')).toHaveTextContent('Net worth, hidden, everything, less what you owe');
    const body = card.querySelector('.wb-tile-body') as HTMLElement;
    expect([...body.children].map((child) => child.className)).toEqual(['wb-tile-icon', 'wb-tile-value tnum', 'wb-tile-label', 'wb-tile-line']);
    expect(body.querySelector('.wb-tile-value')!.innerHTML).toBe(
      '<span class="pp-masked" role="img" aria-label="hidden">' +
        '<span class="pp-mask-dot">•</span>'.repeat(4) +
        '</span>',
    );
    expect(body.querySelector('.wb-tile-label')).toHaveTextContent('Net worth');
  });
});

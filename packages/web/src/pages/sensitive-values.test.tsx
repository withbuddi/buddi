/**
 * Sensitive values (host API 1.31): a query marks paths into its answer, the
 * page keeps its whole structure and masks only those values until the owner
 * presses Show amounts, once, for the page — and masks them again when the
 * window is left or five minutes pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api } from '../api';
import { PluginPage } from './PluginPage';
import { AMOUNTS_SHOWN_MS, setAmountsShown } from '../reveal';
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

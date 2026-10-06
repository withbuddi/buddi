/**
 * A plugin page reads again when its plugin's own tools write.
 *
 * The CFO records balances in chat; the Money page, open in another column,
 * still said "Start with one account". The attention stream now says
 * `pages.changed { plugin }` (roster.ts turns it into
 * `announcePluginDataChanged`), and an open page of that plugin asks its
 * queries again — once per burst, and never for another plugin's tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { api } from '../api';
import { PluginPage } from './PluginPage';
import { announcePluginDataChanged, PLUGIN_DATA_DEBOUNCE_MS } from './usePages';
import type { PluginPageDescriptor } from './types';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { pages: vi.fn(), pageQuery: vi.fn(), pageAct: vi.fn(), approval: vi.fn(), approvals: vi.fn(), decide: vi.fn() },
}));

const money: PluginPageDescriptor = {
  plugin: 'finance',
  id: 'money',
  title: 'Money',
  place: 'rail',
  body: [{ kind: 'stats', query: { query: 'money' }, items: [{ label: 'Accounts', value: { path: 'accounts' } }] }],
};

let accounts = 0;
beforeEach(() => {
  accounts = 0;
  vi.mocked(api.pageQuery).mockImplementation((async () => ({ data: { accounts } })) as never);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const flush = async (ms: number): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

describe('a plugin page when its plugin writes', () => {
  it('asks its queries again once per burst, and only for its own plugin', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PluginPage page={money} navigate={() => {}} timezone="UTC" siblings={[money]} />);
    expect(await screen.findByText('0')).toBeInTheDocument();
    expect(api.pageQuery).toHaveBeenCalledTimes(1);

    // Another plugin's tool: nothing to read.
    act(() => announcePluginDataChanged('email'));
    await flush(PLUGIN_DATA_DEBOUNCE_MS + 50);
    expect(api.pageQuery).toHaveBeenCalledTimes(1);

    // The CFO records two balances in a row: one re-read, after the burst.
    accounts = 2;
    act(() => announcePluginDataChanged('finance'));
    await flush(100);
    act(() => announcePluginDataChanged('finance'));
    await flush(PLUGIN_DATA_DEBOUNCE_MS - 100);
    expect(api.pageQuery).toHaveBeenCalledTimes(1);
    await flush(150);
    expect(api.pageQuery).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  it('asks nothing once the page is gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(<PluginPage page={money} navigate={() => {}} timezone="UTC" siblings={[money]} />);
    expect(await screen.findByText('0')).toBeInTheDocument();
    act(() => announcePluginDataChanged('finance'));
    view.unmount();
    await flush(PLUGIN_DATA_DEBOUNCE_MS + 50);
    expect(api.pageQuery).toHaveBeenCalledTimes(1);
  });
});

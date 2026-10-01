/** The lightbulb on Home and the Tips section it opens: the cards, their statuses, "Bring back" and the switch. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { api, type TipListRow } from '../../api';
import { TIPS_OPEN_KEY, TipsButton, TipsSection, useTips } from './TipsButton';

vi.mock('../../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      tips: vi.fn(),
      restoreTip: vi.fn(async () => ({ ok: true })),
      saveTipsSettings: vi.fn(async (enabled: boolean) => ({ enabled })),
    },
  };
});

const row = (id: string, status: TipListRow['status'], extra: Partial<TipListRow> = {}): TipListRow => ({
  id, text: `Tip ${id}.`, action: { label: `Do ${id}`, route: `#/${id}` }, status, ...extra,
});

const ROWS: TipListRow[] = [
  row('a', 'today', { holdsSince: '2026-09-20' }),
  row('b', 'holding'),
  row('c', 'quiet'),
  row('d', 'dismissed', { dismissedAt: '2026-09-25' }),
  row('e', 'shown', { shownAt: '2026-09-27' }),
];

function Harness({ navigate }: { navigate: (route: string) => void }): JSX.Element {
  const tips = useTips();
  return (
    <>
      <TipsButton tips={tips} />
      <TipsSection tips={tips} navigate={navigate} />
    </>
  );
}

async function mount(enabled = true, rows = ROWS, navigate = vi.fn()): Promise<void> {
  vi.mocked(api.tips).mockResolvedValue({ tips: rows, enabled });
  await act(async () => { render(<Harness navigate={navigate} />); });
}

const bulb = (): HTMLElement => screen.getByRole('button', { name: /^Tips/ });

async function openSheet(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(bulb()); });
  return screen.getByTestId('tips-section');
}

const rowOf = (section: HTMLElement, id: string): HTMLElement => section.querySelector(`[data-tip="${id}"]`) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('TipsButton', () => {
  it('is a quiet icon button called Tips, with no dot while Home shows the tip', async () => {
    await mount(true);
    const button = screen.getByRole('button', { name: 'Tips' });
    expect(button).toHaveAttribute('title', 'Tips');
    expect(screen.queryByTestId('tips-dot')).not.toBeInTheDocument();
  });

  it('wears a dot when a tip is due today and Home is not showing it', async () => {
    await mount(false);
    expect(screen.getByTestId('tips-dot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tips, one due today' })).toBeInTheDocument();
  });

  it('no dot when nothing is due', async () => {
    await mount(false, [row('b', 'holding')]);
    expect(screen.queryByTestId('tips-dot')).not.toBeInTheDocument();
  });

  it('toggles the section, shows pressed while open, and remembers it', async () => {
    await mount();
    expect(screen.queryByTestId('tips-section')).not.toBeInTheDocument();
    expect(bulb()).toHaveAttribute('aria-pressed', 'false');
    await openSheet();
    expect(bulb()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TIPS_OPEN_KEY)).toBe('1');
    await act(async () => { fireEvent.click(bulb()); });
    expect(screen.queryByTestId('tips-section')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TIPS_OPEN_KEY)).toBeNull();
  });

  it('opens already when it was left open, and Close shuts it', async () => {
    window.localStorage.setItem(TIPS_OPEN_KEY, '1');
    await mount();
    const section = screen.getByTestId('tips-section');
    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Close' })); });
    expect(screen.queryByTestId('tips-section')).not.toBeInTheDocument();
    expect(bulb()).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows every tip as a card with its status pill and action', async () => {
    const navigate = vi.fn();
    await mount(true, ROWS, navigate);
    const sheet = await openSheet();
    expect(within(sheet).getByText('Tips', { selector: 'h3' })).toBeInTheDocument();
    expect(sheet.querySelectorAll('.ui-card')).toHaveLength(5);
    expect(within(rowOf(sheet, 'a')).getByText('Due today')).toHaveAttribute('data-tone', 'accent');
    expect(within(rowOf(sheet, 'b')).getByText('Waiting')).toHaveAttribute('data-tone', 'muted');
    expect(within(rowOf(sheet, 'b')).getByText('Waiting')).toBeInTheDocument();
    expect(within(rowOf(sheet, 'c')).getByText('Not needed now')).toBeInTheDocument();
    expect(within(rowOf(sheet, 'd')).getByText('Dismissed')).toBeInTheDocument();
    expect(within(rowOf(sheet, 'e')).getByText('Shown on 27 Sep')).toBeInTheDocument();
    expect(within(sheet).getAllByRole('button', { name: 'Bring back' })).toHaveLength(1);
    expect(within(rowOf(sheet, 'd')).queryByRole('button', { name: 'Do d' })).not.toBeInTheDocument();
    fireEvent.click(within(rowOf(sheet, 'b')).getByRole('button', { name: 'Do b' }));
    expect(navigate).toHaveBeenCalledWith('#/b');
  });

  it('"Bring back" restores a dismissed tip and reloads the list', async () => {
    await mount();
    const sheet = await openSheet();
    const calls = vi.mocked(api.tips).mock.calls.length;
    vi.mocked(api.tips).mockResolvedValue({ tips: ROWS.map((r) => (r.id === 'd' ? row('d', 'holding') : r)), enabled: true });
    await act(async () => { fireEvent.click(within(rowOf(sheet, 'd')).getByRole('button', { name: 'Bring back' })); });
    expect(api.restoreTip).toHaveBeenCalledWith('d');
    expect(vi.mocked(api.tips).mock.calls.length).toBeGreaterThan(calls);
    expect(within(rowOf(screen.getByTestId('tips-section'), 'd')).getByText('Waiting')).toBeInTheDocument();
  });

  it('the switch reads while tips are off, and saves at once', async () => {
    await mount(false);
    const sheet = await openSheet();
    expect(within(sheet).getByText('Tip a.')).toBeInTheDocument();
    const box = within(sheet).getByRole('checkbox', { name: 'Tips on Home' });
    expect(box).not.toBeChecked();
    await act(async () => { fireEvent.click(box); });
    expect(api.saveTipsSettings).toHaveBeenCalledWith(true);
    expect(box).toBeChecked();
  });
});

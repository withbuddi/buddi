/** The lightbulb on Home and the Tips panel it opens: the stack, the dot, Close, the empty state, the preview. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { api, type TipView } from '../../api';
import { TIPS_OPEN_KEY, TIPS_SEEN_KEY, TipsButton, TipsSection, useTips } from './TipsButton';

vi.mock('../../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      tipQueue: vi.fn(),
      laterTip: vi.fn(async () => ({ ok: true })),
      dismissTip: vi.fn(async () => ({ ok: true })),
      dismissedTips: vi.fn(),
      restoreTip: vi.fn(async () => ({ ok: true })),
    },
  };
});

const tip = (id: string): TipView => ({ id, text: `Tip ${id}.`, action: { label: `Do ${id}`, route: `#/${id}` } });
const THREE = [tip('a'), tip('b'), tip('c')];

function Harness({ navigate, preview }: { navigate: (route: string) => void; preview?: string }): JSX.Element {
  const tips = useTips(preview);
  return (
    <>
      <TipsButton tips={tips} />
      <TipsSection tips={tips} navigate={navigate} />
    </>
  );
}

async function mount(tips: TipView[] = THREE, navigate = vi.fn(), preview?: string): Promise<void> {
  vi.mocked(api.tipQueue).mockResolvedValue({ tips, ...(preview ? { preview: true } : {}) });
  await act(async () => { render(<Harness navigate={navigate} preview={preview} />); });
}

const bulb = (): HTMLElement => screen.getByRole('button', { name: /^(Tips|A new tip)$/ });

async function openPanel(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(bulb()); });
  return screen.getByTestId('tips-section');
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('TipsButton', () => {
  it('is a quiet icon button called Tips with no dot when nothing is ready', async () => {
    await mount([]);
    expect(bulb()).toHaveAttribute('title', 'Tips');
    expect(bulb()).toHaveAccessibleName('Tips');
    expect(screen.queryByTestId('tips-dot')).not.toBeInTheDocument();
  });

  it('peeks while closed, so the gateway marks nothing shown', async () => {
    await mount();
    expect(api.tipQueue).toHaveBeenLastCalledWith(undefined, true);
    await openPanel();
    expect(api.tipQueue).toHaveBeenLastCalledWith(undefined, false);
  });

  it('wears a dot for an unseen tip, "A new tip", cleared when the panel opens', async () => {
    await mount();
    expect(screen.getByTestId('tips-dot')).toBeInTheDocument();
    expect(bulb()).toHaveAttribute('title', 'A new tip');
    await openPanel();
    expect(screen.queryByTestId('tips-dot')).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(TIPS_SEEN_KEY) ?? '[]')).toEqual(['a', 'b', 'c']);
    await act(async () => { fireEvent.click(bulb()); });
    expect(screen.queryByTestId('tips-dot')).not.toBeInTheDocument();
    expect(bulb()).toHaveAttribute('title', 'Tips');
  });

  it('a tip not seen before brings the dot back; one that left is forgotten', async () => {
    window.localStorage.setItem(TIPS_SEEN_KEY, JSON.stringify(['a', 'z']));
    await mount([tip('a'), tip('b')]);
    expect(screen.getByTestId('tips-dot')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(TIPS_SEEN_KEY) ?? '[]')).toEqual(['a']);
  });

  it('no dot when every ready tip was seen', async () => {
    window.localStorage.setItem(TIPS_SEEN_KEY, JSON.stringify(['a', 'b', 'c']));
    await mount();
    expect(screen.queryByTestId('tips-dot')).not.toBeInTheDocument();
  });

  it('opens the stack under the bulb, pressed while open, and remembers it', async () => {
    await mount();
    expect(screen.queryByTestId('tips-section')).not.toBeInTheDocument();
    expect(bulb()).toHaveAttribute('aria-pressed', 'false');
    const panel = await openPanel();
    expect(bulb()).toHaveAttribute('aria-pressed', 'true');
    expect(within(panel).getByText('Tips', { selector: 'h3' })).toBeInTheDocument();
    expect(within(panel).getByTestId('tip-stack')).toBeInTheDocument();
    expect(within(panel).getByText('Tip a.')).toBeInTheDocument();
    expect(within(panel).getByText('1 of 3')).toBeInTheDocument();
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TIPS_OPEN_KEY)).toBe('1');
    await act(async () => { fireEvent.click(bulb()); });
    expect(screen.queryByTestId('tips-section')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TIPS_OPEN_KEY)).toBeNull();
  });

  it('opens already when it was left open, and Close shuts it', async () => {
    window.localStorage.setItem(TIPS_OPEN_KEY, '1');
    await mount();
    const panel = screen.getByTestId('tips-section');
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Close' })); });
    expect(screen.queryByTestId('tips-section')).not.toBeInTheDocument();
    expect(bulb()).toHaveAttribute('aria-pressed', 'false');
  });

  it('the action on the front card navigates', async () => {
    const navigate = vi.fn();
    await mount(THREE, navigate);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Do a' }));
    expect(navigate).toHaveBeenCalledWith('#/a');
  });

  it('says there are none, with Close, when the stack is empty', async () => {
    await mount([]);
    const panel = await openPanel();
    expect(within(panel).getByText('No tips right now. New ones appear as you use buddi.')).toBeInTheDocument();
    expect(within(panel).queryByTestId('tip-stack')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Close' })); });
    expect(screen.queryByTestId('tips-section')).not.toBeInTheDocument();
  });

  it('says so when every tip that applies is turned off', async () => {
    vi.mocked(api.tipQueue).mockResolvedValue({ tips: [], dismissed: 2 });
    await act(async () => { render(<Harness navigate={vi.fn()} />); });
    const panel = await openPanel();
    expect(within(panel).getByText("You've turned off every tip that applies.")).toBeInTheDocument();
    expect(within(panel).queryByText(/No tips right now/)).not.toBeInTheDocument();
  });

  it('shows the dismissed tips from the empty stack and brings one back into the queue', async () => {
    vi.mocked(api.tipQueue).mockResolvedValue({ tips: [], dismissed: 2 });
    vi.mocked(api.dismissedTips).mockResolvedValue({ tips: [tip('a'), tip('b')] });
    await act(async () => { render(<Harness navigate={vi.fn()} />); });
    const panel = await openPanel();
    expect(within(panel).getByText('2 dismissed')).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Show' })); });
    const list = within(panel).getByTestId('tips-dismissed');
    expect(within(list).getByText('Tip a.')).toBeInTheDocument();
    expect(within(list).getAllByRole('button', { name: 'Bring back' })).toHaveLength(2);
    // The gateway forgets the dismissal; the queue is read again and the tip is back in the stack.
    vi.mocked(api.tipQueue).mockResolvedValue({ tips: [tip('a')], dismissed: 1 });
    await act(async () => { fireEvent.click(within(list).getAllByRole('button', { name: 'Bring back' })[0]!); });
    expect(api.restoreTip).toHaveBeenCalledWith('a');
    expect(within(panel).getByTestId('tip-stack')).toBeInTheDocument();
    expect(within(panel).getByText('Tip a.')).toBeInTheDocument();
  });

  it('a ?tip= preview opens the panel with that tip in front, remembering nothing', async () => {
    await mount([tip('make-group')], vi.fn(), 'make-group');
    expect(api.tipQueue).toHaveBeenCalledWith('make-group', expect.anything());
    const panel = screen.getByTestId('tips-section');
    expect(within(panel).getByText('Tip make-group.')).toBeInTheDocument();
    expect(screen.queryByTestId('tips-dot')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TIPS_OPEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(TIPS_SEEN_KEY)).toBeNull();
  });
});

/** Home's tips as a stack: the queue, the swipes, the keys, reduced motion, and nothing when empty. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { api } from '../../api';
import { TIP_FLY_MS, TipStack, previewTipOf, useTipQueue } from './TipStack';

vi.mock('../../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      tipQueue: vi.fn(),
      dismissTip: vi.fn(async () => ({ ok: true })),
      laterTip: vi.fn(async () => ({ ok: true })),
    },
  };
});

const TIPS = [
  { id: 'voice-note', text: 'You can talk to me instead of typing.', action: { label: 'Send a voice note', route: '#/chat' } },
  { id: 'make-group', text: 'Put them in a group.', action: { label: 'Make a group', route: '#/chat?group=new' } },
  { id: 'widgets', text: 'Pin the weather to Home.', action: { label: 'Add a widget', route: '#/?widgets=1' } },
];

function Harness({ navigate, preview }: { navigate: (route: string) => void; preview?: string }): JSX.Element | null {
  const queue = useTipQueue(preview);
  return (
    <>
      <span data-testid="shown">{String(queue.shown)}</span>
      <TipStack queue={queue} navigate={navigate} />
    </>
  );
}

// jsdom has no PointerEvent; a MouseEvent with a pointer id is all the stack reads.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
}

let reduce = false;
beforeEach(() => {
  vi.clearAllMocks();
  reduce = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function stack(tips = TIPS, navigate = vi.fn(), preview?: string): Promise<void> {
  vi.mocked(api.tipQueue).mockResolvedValue({ tips, ...(preview ? { preview: true } : {}) });
  await act(async () => { render(<Harness navigate={navigate} {...(preview ? { preview } : {})} />); });
}

/** Wait out the fly-off. */
async function flown(ms = TIP_FLY_MS + 40): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function frontCard(): HTMLElement {
  return document.querySelector('.tip-stack-card[data-depth="0"]') as HTMLElement;
}

function dragBy(dx: number): void {
  const card = frontCard();
  fireEvent.pointerDown(card, { pointerId: 1, clientX: 300, button: 0 });
  fireEvent.pointerMove(card, { pointerId: 1, clientX: 300 + dx / 2 });
  fireEvent.pointerMove(card, { pointerId: 1, clientX: 300 + dx });
  fireEvent.pointerUp(card, { pointerId: 1, clientX: 300 + dx });
}

describe('useTipQueue and the stack', () => {
  it('draws the front tip with its action, two behind it, and the count', async () => {
    const navigate = vi.fn();
    await stack(TIPS, navigate);
    expect(screen.getByRole('article', { name: TIPS[0]!.text })).toBeInTheDocument();
    expect(document.querySelectorAll('.tip-stack-card')).toHaveLength(3);
    // The ones behind are edges only: out of the reading order.
    expect(document.querySelector('.tip-stack-card[data-depth="1"]')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: TIPS[0]!.text })).getByText('A tip from buddi')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send a voice note' }));
    expect(navigate).toHaveBeenCalledWith('#/chat');
    expect(api.laterTip).not.toHaveBeenCalled();
    expect(api.dismissTip).not.toHaveBeenCalled();
  });

  it('a slide left is "Not now": the tip is put off and the next comes forward', async () => {
    await stack();
    dragBy(-200);
    // In flight: the next card is already in front.
    expect(document.querySelector('[data-leaving="later"]')).toHaveAttribute('data-tip', 'voice-note');
    expect(frontCard()).toHaveAttribute('data-tip', 'make-group');
    await flown();
    expect(api.laterTip).toHaveBeenCalledWith('voice-note');
    expect(api.dismissTip).not.toHaveBeenCalled();
    expect(screen.getByRole('article', { name: TIPS[1]!.text })).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('a slide right is "Not this again"', async () => {
    await stack();
    dragBy(200);
    await flown();
    expect(api.dismissTip).toHaveBeenCalledWith('voice-note');
    expect(api.laterTip).not.toHaveBeenCalled();
  });

  it('a short drag snaps back and decides nothing', async () => {
    await stack();
    dragBy(-40);
    await flown();
    expect(api.laterTip).not.toHaveBeenCalled();
    expect(api.dismissTip).not.toHaveBeenCalled();
    expect(frontCard()).toHaveAttribute('data-tip', 'voice-note');
    expect(frontCard().style.transform).toBe('');
  });

  it('the action button is a click, never the start of a drag', async () => {
    await stack();
    const button = screen.getByRole('button', { name: 'Send a voice note' });
    fireEvent.pointerDown(button, { pointerId: 1, clientX: 300, button: 0 });
    expect(frontCard()).not.toHaveAttribute('data-dragging');
  });

  it('keys: ← not now, → not this again, Enter the action', async () => {
    const navigate = vi.fn();
    await stack(TIPS, navigate);
    const group = screen.getByTestId('tip-stack');
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('#/chat');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    await flown();
    expect(api.laterTip).toHaveBeenCalledWith('voice-note');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    await flown();
    expect(api.dismissTip).toHaveBeenCalledWith('make-group');
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it('the buttons under the stack do the same', async () => {
    await stack();
    fireEvent.click(screen.getByRole('button', { name: /Not this again/ }));
    await flown();
    expect(api.dismissTip).toHaveBeenCalledWith('voice-note');
    fireEvent.click(screen.getByRole('button', { name: /Not now/ }));
    await flown();
    expect(api.laterTip).toHaveBeenCalledWith('make-group');
  });

  it('with reduced motion the card crossfades: no flight, no transform', async () => {
    reduce = true;
    await stack();
    expect(screen.getByTestId('tip-stack')).toHaveAttribute('data-motion', 'reduced');
    fireEvent.keyDown(screen.getByTestId('tip-stack'), { key: 'ArrowLeft' });
    const leaving = document.querySelector('[data-leaving="later"]') as HTMLElement;
    expect(leaving.style.transform).toBe('');
    await flown(200);
    expect(api.laterTip).toHaveBeenCalledWith('voice-note');
  });

  it('flies with a tilt in full motion', async () => {
    await stack();
    fireEvent.keyDown(screen.getByTestId('tip-stack'), { key: 'ArrowRight' });
    const leaving = document.querySelector('[data-leaving="dismiss"]') as HTMLElement;
    expect(leaving.style.transform).toMatch(/translateX\(\d.*rotate\(\d/);
  });

  it('draws nothing without tips', async () => {
    await stack([]);
    expect(screen.queryByTestId('tip-stack')).not.toBeInTheDocument();
    expect(screen.getByTestId('shown')).toHaveTextContent('false');
  });

  it('folds away after the last card, then is gone', async () => {
    await stack([TIPS[0]!]);
    expect(screen.getByTestId('shown')).toHaveTextContent('true');
    fireEvent.keyDown(screen.getByTestId('tip-stack'), { key: 'ArrowLeft' });
    await flown();
    expect(document.querySelector('.tip-stack-fold')).toHaveAttribute('data-empty', 'true');
    await flown(220);
    expect(screen.getByTestId('shown')).toHaveTextContent('false');
    expect(screen.queryByTestId('tip-stack')).not.toBeInTheDocument();
  });

  it('a preview stacks the tips and tells the gateway nothing', async () => {
    await stack(TIPS, vi.fn(), 'voice-note,make-group');
    expect(api.tipQueue).toHaveBeenCalledWith('voice-note,make-group', false);
    fireEvent.keyDown(screen.getByTestId('tip-stack'), { key: 'ArrowRight' });
    await flown();
    expect(api.dismissTip).not.toHaveBeenCalled();
  });
});

describe('previewTipOf', () => {
  it('reads one id or a few from Home’s hash', () => {
    expect(previewTipOf('#/?tip=make-group')).toBe('make-group');
    expect(previewTipOf('#/?tip=a,b,c')).toBe('a,b,c');
    expect(previewTipOf('#/?tip=a,,b')).toBeUndefined();
    expect(previewTipOf('#/')).toBeUndefined();
  });
});

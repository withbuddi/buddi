/**
 * The Blob: the still at once, the loop once the player and its JSON arrive.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob, forgetBlobCache } from './Blob';
import { MessageList } from '../chat/MessageList';

const player = vi.hoisted(() => {
  const animation = { pause: vi.fn(), play: vi.fn(), destroy: vi.fn() };
  let release: () => void = () => {};
  const gate = { ready: Promise.resolve() };
  return {
    animation,
    gate,
    hold(): void { gate.ready = new Promise<void>((resolve) => { release = resolve; }); },
    release: (): void => release(),
    loadAnimation: vi.fn((config: { container: Element }) => {
      config.container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
      return animation;
    }),
  };
});

// The dynamic import resolves only when the test says so.
vi.mock('lottie-web/build/player/lottie_light', async () => {
  await player.gate.ready;
  return { default: { loadAnimation: player.loadAnimation } };
});

function motion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: reduced && query.includes('reduce'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

const loop = JSON.stringify({ v: '5.7.0', fr: 30, ip: 0, op: 72, w: 512, h: 512, layers: [] });

beforeEach(() => {
  forgetBlobCache();
  player.loadAnimation.mockClear();
  player.animation.pause.mockClear();
  player.animation.play.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(loop, { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Blob', () => {
  it('draws the still first and swaps in the loop once the player resolves', async () => {
    motion(false);
    player.hold();
    render(<Blob state="working" size="xs" />);
    const box = screen.getByTestId('blob');
    expect(box.querySelector('img')?.getAttribute('src')).toBe('./mascot/core.png');
    expect(box.getAttribute('data-playing')).toBeNull();
    expect(player.loadAnimation).not.toHaveBeenCalled();

    await act(async () => { player.release(); });
    await waitFor(() => expect(box.getAttribute('data-playing')).toBe('true'));
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('svg')).not.toBeNull();
    expect(fetch).toHaveBeenCalledWith('./mascot/anim/core-working.json');
    expect(player.loadAnimation).toHaveBeenCalledWith(expect.objectContaining({ loop: true, renderer: 'svg' }));
  });

  it('pauses while the tab is hidden and plays again when it comes back', async () => {
    motion(false);
    render(<Blob state="idle" />);
    await waitFor(() => expect(screen.getByTestId('blob').getAttribute('data-playing')).toBe('true'));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(player.animation.pause).toHaveBeenCalled();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(player.animation.play).toHaveBeenCalled();
    hidden.mockRestore();
  });

  it('keeps the still under reduced motion and never fetches the player', async () => {
    motion(true);
    render(<Blob state="idle" />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId('blob').querySelector('img')).not.toBeNull();
    expect(player.loadAnimation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the still for a role with no loop, and when the loop is missing', async () => {
    motion(false);
    render(<Blob role="finance" state="working" />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId('blob').querySelector('img')?.getAttribute('src')).toBe('./mascot/finance.png');
    expect(fetch).not.toHaveBeenCalled();
    cleanup();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    render(<Blob state="working" />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId('blob').querySelector('img')).not.toBeNull();
    expect(player.loadAnimation).not.toHaveBeenCalled();
  });
});

describe('the working indicator', () => {
  it('shows the thinking Blob beside the line', () => {
    render(
      <Tooltip.Provider>
        <MessageList messages={[]} live={[]} now={0} onOpen={() => {}} working agentName="Playground" emptyHint="" />
      </Tooltip.Provider>,
    );
    const blob = screen.getByTestId('working').querySelector('[data-testid="blob"]');
    expect(blob?.getAttribute('data-state')).toBe('working');
    expect(screen.getByRole('status').textContent).toContain('Playground is working');
  });
});

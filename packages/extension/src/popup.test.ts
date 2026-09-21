/**
 * @vitest-environment jsdom
 *
 * The one piece of the popup with a rule of its own: copying the code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COPIED_FOR, wireCopy } from './popup.js';

let written: string[] = [];

beforeEach(() => {
  written = [];
  document.body.innerHTML = '<p id="code">482 913</p><button id="copy">Copy</button>';
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (text: string) => { written.push(text); }) },
  });
});

const wire = () => {
  const button = document.getElementById('copy') as HTMLButtonElement;
  wireCopy(button, () => document.getElementById('code')!.textContent ?? '');
  return button;
};

describe('copying the pairing code', () => {
  it('writes the code, says so, and takes it back after two seconds', async () => {
    vi.useFakeTimers();
    try {
      const button = wire();
      button.click();
      await vi.waitFor(() => expect(written).toEqual(['482 913']));
      expect(button.textContent).toBe('Copied');
      vi.advanceTimersByTime(COPIED_FOR - 1);
      expect(button.textContent).toBe('Copied');
      vi.advanceTimersByTime(1);
      expect(button.textContent).toBe('Copy');
    } finally { vi.useRealTimers(); }
  });

  it('writes text and never markup, and says nothing when the browser refuses', async () => {
    document.getElementById('code')!.textContent = '<img src=x onerror=alert(1)>';
    const button = wire();
    button.click();
    await vi.waitFor(() => expect(written).toEqual(['<img src=x onerror=alert(1)>']));
    expect(document.getElementById('code')!.querySelector('img')).toBeNull();

    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('not allowed'));
    button.textContent = 'Copy';
    button.click();
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2));
    expect(button.textContent).toBe('Copy');
  });
});

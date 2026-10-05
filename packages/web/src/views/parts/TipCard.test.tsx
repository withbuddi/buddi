/** The tip on Home: the sentence, the action, "Not now" and "Not this again", on the one "Needs you" card. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { api } from '../../api';
import { TipCard } from './TipCard';

vi.mock('../../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      currentTip: vi.fn(),
      dismissTip: vi.fn(async () => ({ ok: true })),
      laterTip: vi.fn(async () => ({ ok: true })),
    },
  };
});

const TIP = { id: 'voice-note', text: 'You can talk to me instead of typing.', action: { label: 'Send a voice note', route: '#/chat' } };

async function card(tip: typeof TIP | null, navigate = vi.fn()): Promise<void> {
  vi.mocked(api.currentTip).mockResolvedValue({ tip, enabled: tip !== null });
  await act(async () => { render(<TipCard navigate={navigate} />); });
}

beforeEach(() => vi.clearAllMocks());

describe('TipCard', () => {
  it('draws nothing without a tip', async () => {
    await card(null);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says the sentence, and the action goes where the tip points', async () => {
    const navigate = vi.fn();
    await card(TIP, navigate);
    expect(screen.getByText(TIP.text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send a voice note' }));
    expect(navigate).toHaveBeenCalledWith('#/chat');
    expect(api.dismissTip).not.toHaveBeenCalled();
  });

  it('"Not this again" dismisses it for good, and it leaves at once', async () => {
    await card(TIP);
    fireEvent.click(screen.getByRole('button', { name: 'Not this again' }));
    expect(api.dismissTip).toHaveBeenCalledWith('voice-note');
    expect(screen.queryByText(TIP.text)).not.toBeInTheDocument();
  });

  it('is a "Needs you" card: the sentence as its heading, both ways out as ghost buttons on the left, no ×', async () => {
    await card(TIP);
    const article = screen.getByRole('article', { name: TIP.text });
    const buttons = Array.from(article.querySelectorAll('button')).map((b) => [b.textContent, b.getAttribute('data-variant')]);
    expect(buttons).toEqual([['Not now', 'ghost'], ['Not this again', 'ghost'], ['Send a voice note', 'accent']]);
    expect(article.querySelector('.ui-icon-btn')).toBeNull();
  });

  it('"Not now" puts it off', async () => {
    await card(TIP);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(api.laterTip).toHaveBeenCalledWith('voice-note');
    expect(api.dismissTip).not.toHaveBeenCalled();
    expect(screen.queryByText(TIP.text)).not.toBeInTheDocument();
  });
});

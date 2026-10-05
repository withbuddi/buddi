/** A new agent's chat opens once with who it may ask and who may ask it: Adjust, a close, remembered by the gateway. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { api, type AgentIntro } from '../api';
import { NewAgentStrip, newAgentSentence } from './NewAgentStrip';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: { ...original.api, agentIntro: vi.fn(), dismissAgentIntro: vi.fn(async () => ({ ok: true })) },
  };
});

const DUE: AgentIntro = {
  show: true,
  id: 'scout',
  handle: 'scout',
  asks: 'everyone',
  askedBy: [
    { id: 'concierge', handle: 'buddi', name: 'Concierge', frontDesk: true },
    { id: 'art', handle: 'art', name: 'Art' },
  ],
};

beforeEach(() => vi.clearAllMocks());

async function mount(): Promise<ReturnType<typeof render>> {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => { view = render(<><NewAgentStrip agentId="scout" /><textarea aria-label="Message" /></>); });
  return view!;
}

describe('the new agent strip', () => {
  it('says both directions in one sentence, links Adjust to Setup → Team, and leaves the composer alone', async () => {
    vi.mocked(api.agentIntro).mockResolvedValue(DUE);
    await mount();
    const strip = screen.getByTestId('new-agent-strip');
    expect(strip).toHaveTextContent('New here. @scout may ask everyone, and can be asked by the front desk, @art.');
    expect(screen.getByRole('link', { name: 'Adjust' })).toHaveAttribute('href', '#/agents/scout/setup/team');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).not.toBeDisabled();
  });

  it('shows once: closed, it is gone and the gateway is told, so the next open has none', async () => {
    vi.mocked(api.agentIntro).mockResolvedValue(DUE);
    const first = await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })); });
    expect(screen.queryByTestId('new-agent-strip')).not.toBeInTheDocument();
    expect(api.dismissAgentIntro).toHaveBeenCalledWith('scout');
    first.unmount();
    // What the gateway answers after the dismissal.
    vi.mocked(api.agentIntro).mockResolvedValue({ show: false });
    await mount();
    expect(screen.queryByTestId('new-agent-strip')).not.toBeInTheDocument();
  });

  it('Adjust closes it too', async () => {
    vi.mocked(api.agentIntro).mockResolvedValue(DUE);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Adjust' })); });
    expect(api.dismissAgentIntro).toHaveBeenCalledWith('scout');
    expect(screen.queryByTestId('new-agent-strip')).not.toBeInTheDocument();
  });

  it('draws nothing for an agent that is not new', async () => {
    vi.mocked(api.agentIntro).mockResolvedValue({ show: false });
    await mount();
    expect(screen.queryByTestId('new-agent-strip')).not.toBeInTheDocument();
  });

  it('names a narrowed list, trails off after three, and says when nobody asks it', () => {
    const many = ['a', 'b', 'c', 'd'].map((h) => ({ id: h, handle: h, name: h }));
    expect(newAgentSentence({ ...DUE, asks: many, askedBy: [] })).toBe('New here. @scout may ask @a, @b, @c, …, and nobody asks it yet.');
    expect(newAgentSentence({ ...DUE, asks: [] })).toBe('New here. @scout asks nobody yet, and can be asked by the front desk, @art.');
  });
});

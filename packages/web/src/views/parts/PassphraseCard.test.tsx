/**
 * Home's passphrase card: there after the first backup, and still there on
 * every visit until "I saved it" is pressed; then gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api } from '../../api';
import { PASSPHRASE_CARD_LINE, PassphraseCard, usePassphraseNotice } from './PassphraseCard';

/** Home holds the read; the card draws it. */
function Held(): JSX.Element | null {
  return <PassphraseCard notice={usePassphraseNotice()} />;
}

vi.mock('../../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api')>();
  return { ...original, api: { ...original.api, passphraseNotice: vi.fn(), acknowledgePassphrase: vi.fn(), revealBackupPassphrase: vi.fn() } };
});

const PHRASE = 'able acid actor adult afraid agent';

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('PassphraseCard', () => {
  it('shows nothing before the first backup', async () => {
    vi.mocked(api.passphraseNotice).mockResolvedValue({ show: false });
    const { container } = render(<Held />);
    await vi.waitFor(() => expect(api.passphraseNotice).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the words with Copy and "I saved it", and comes back on the next visit while unacknowledged', async () => {
    vi.mocked(api.passphraseNotice).mockResolvedValue({ show: true, passphrase: PHRASE });
    render(<Held />);
    expect(await screen.findByText(PHRASE)).toBeInTheDocument();
    expect(screen.getByText(PASSPHRASE_CARD_LINE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    // The "Needs you" card: an article named by its heading, the accent last, no way out but "I saved it".
    const article = screen.getByRole('article', { name: 'Your backup passphrase' });
    expect(Array.from(article.querySelectorAll('.needs-card-actions button')).map((b) => b.textContent)).toEqual(['Copy', 'I saved it']);
    expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument();
    // Leaving Home without pressing it: the next visit shows it again.
    cleanup();
    render(<Held />);
    expect(await screen.findByText(PHRASE)).toBeInTheDocument();
    expect(api.acknowledgePassphrase).not.toHaveBeenCalled();
  });

  it('"I saved it" acknowledges, and the card goes', async () => {
    vi.mocked(api.passphraseNotice).mockResolvedValue({ show: true, passphrase: PHRASE });
    vi.mocked(api.acknowledgePassphrase).mockResolvedValue({ acknowledgedAt: '2026-10-04T10:00:00Z' });
    render(<Held />);
    fireEvent.click(await screen.findByRole('button', { name: 'I saved it' }));
    await vi.waitFor(() => expect(screen.queryByText(PHRASE)).not.toBeInTheDocument());
    expect(api.acknowledgePassphrase).toHaveBeenCalledTimes(1);
  });

  it('copies the words', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.mocked(api.passphraseNotice).mockResolvedValue({ show: true, passphrase: PHRASE });
    render(<Held />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(PHRASE);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('with a PIN set, asks for it and shows the words it reveals', async () => {
    vi.mocked(api.passphraseNotice).mockResolvedValue({ show: true, needsPin: true });
    vi.mocked(api.revealBackupPassphrase).mockResolvedValue({ passphrase: PHRASE });
    render(<Held />);
    const field = await screen.findByLabelText(/Your PIN/);
    expect(screen.queryByText(PHRASE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'I saved it' })).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the words' }));
    expect(await screen.findByText(PHRASE)).toBeInTheDocument();
    expect(api.revealBackupPassphrase).toHaveBeenCalledWith('2468');
    expect(screen.getByRole('button', { name: 'I saved it' })).toBeInTheDocument();
  });
});

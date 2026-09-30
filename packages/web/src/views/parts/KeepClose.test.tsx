/**
 * Installing the dashboard: Home's quiet line (only once the browser offered
 * an install), Settings → System's section, and the manifest behind both.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppInstallSection, KEEP_CLOSE_KEY, KeepClose, installHint, resetInstallPrompt } from './KeepClose';

vi.mock('../../api', () => ({ api: { session: vi.fn(async () => ({ platform: 'darwin' })) } }));

const PUBLIC = path.resolve(__dirname, '../../../public');

function standalone(matches: boolean): void {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === '(display-mode: standalone)' ? matches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function firePrompt(prompt = vi.fn(async () => undefined)): typeof prompt {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: typeof prompt; userChoice: Promise<{ outcome: string }> };
  event.prompt = prompt;
  event.userChoice = Promise.resolve({ outcome: 'accepted' });
  act(() => { window.dispatchEvent(event); });
  return prompt;
}

beforeEach(() => {
  window.localStorage.clear();
  standalone(false);
  resetInstallPrompt();
});
afterEach(() => resetInstallPrompt());

describe('the web app manifest', () => {
  it('is valid JSON with what an install needs, and its icons exist', () => {
    const manifest = JSON.parse(readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'buddi', short_name: 'buddi', start_url: '/#/', display: 'standalone' });
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) expect(existsSync(path.join(PUBLIC, icon.src))).toBe(true);
  });

  it('is linked from the page', () => {
    const html = readFileSync(path.resolve(PUBLIC, '../index.html'), 'utf8');
    expect(html).toMatch(/<link rel="manifest" href="\.\/manifest\.webmanifest"/);
  });
});

const LINE = 'Install buddi as an app, one click from your dock.';

describe('KeepClose', () => {
  it('says nothing until the browser offers an install: no hint, no command, no path', () => {
    const { container } = render(<KeepClose />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is one quiet line once the browser fired its prompt, and Install hands the prompt over', async () => {
    render(<KeepClose />);
    const prompt = firePrompt();
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.queryByText(/buddi dashboard/)).toBeNull();
    expect(screen.queryByText(/bookmark/)).toBeNull();
    // Not now, then Install: the primary action on the right.
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Not now', 'Install']);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(prompt).toHaveBeenCalledOnce();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByText(LINE)).toBeNull();
    expect(window.localStorage.getItem(KEEP_CLOSE_KEY)).not.toBeNull();
  });

  it('names each browser’s own install item', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(installHint(`${mac} Version/18.0 Safari/605.1.15`)).toMatch(/File → Add to Dock/);
    expect(installHint(`${mac} Chrome/130.0.0.0 Safari/537.36`)).toMatch(/install icon in the address bar/);
    expect(installHint(`${mac} Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0`)).toMatch(/Apps → Install/);
    expect(installHint('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBeNull();
  });

  it('is hidden inside the installed app', () => {
    standalone(true);
    render(<KeepClose />);
    firePrompt();
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it('stays dismissed', () => {
    const first = render(<KeepClose />);
    firePrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText(LINE)).toBeNull();
    expect(window.localStorage.getItem(KEEP_CLOSE_KEY)).not.toBeNull();
    first.unmount();
    render(<KeepClose />);
    expect(screen.queryByText(LINE)).toBeNull();
  });
});

describe('Settings → System: the dashboard as an app', () => {
  it('keeps the bookmark tip and, on this Mac, the double-click app', async () => {
    await act(async () => { render(<AppInstallSection />); });
    expect(screen.getByText('The dashboard as an app')).toBeInTheDocument();
    expect(screen.getByText(/bookmark it with/)).toBeInTheDocument();
    expect(screen.getByText('buddi dashboard --install-app')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install the app' })).toBeNull();
  });

  it('offers Install the app once the browser fired its prompt', async () => {
    await act(async () => { render(<AppInstallSection />); });
    const prompt = firePrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Install the app' }));
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('is not there inside the installed app', async () => {
    standalone(true);
    const { container } = render(<AppInstallSection />);
    expect(container).toBeEmptyDOMElement();
  });
});

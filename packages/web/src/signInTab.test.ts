import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSignInPage, openSignInTab, startSignIn } from './signInTab';

const fakeTab = () => ({ opener: {} as unknown, location: { href: '' }, close: vi.fn(), document: { title: '', body: { textContent: '' } } });

describe('signInTab', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens blank in the call, clears the opener, says what is coming, and goes only to a web page', () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const handle = openSignInTab();
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.document.body.textContent).toMatch(/Opening/);
    expect(handle.opened).toBe(true);
    expect(handle.go('javascript:alert(1)')).toBe(false);
    expect(tab.location.href).toBe('');
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(handle.opened).toBe(false);
  });

  it('startSignIn: open before the start, navigate after, close on failure or no address', async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    let answer!: (url: string) => void;
    const pending = startSignIn(() => new Promise<string>((resolve) => { answer = resolve; }), (url) => url);
    expect(open).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('');
    answer('https://provider.example/authorize?state=x');
    await expect(pending).resolves.toEqual({ result: 'https://provider.example/authorize?state=x', opened: true });
    expect(tab.location.href).toBe('https://provider.example/authorize?state=x');

    const failed = fakeTab();
    open.mockReturnValue(failed as unknown as Window);
    await expect(startSignIn(() => Promise.reject(new Error('no')), () => 'x')).rejects.toThrow('no');
    expect(failed.close).toHaveBeenCalledTimes(1);

    const empty = fakeTab();
    open.mockReturnValue(empty as unknown as Window);
    await expect(startSignIn(async () => ({}), () => undefined)).resolves.toEqual({ result: {}, opened: false });
    expect(empty.close).toHaveBeenCalledTimes(1);
  });

  it('a refused tab is false, never an error', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openSignInPage('https://provider.example/device')).toBe(false);
    await expect(startSignIn(async () => 'https://provider.example', (u) => u)).resolves.toEqual({ result: 'https://provider.example', opened: false });
  });
});

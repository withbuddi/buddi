import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSignInPage, openSignInTab, startSignIn } from './signInTab';

const fakeTab = () => ({ opener: {} as unknown, closed: false, location: { href: '' }, close: vi.fn(), document: { title: '', body: { textContent: '' } } });

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
    const pending = startSignIn(() => new Promise<string>((resolve) => { answer = resolve; }), (url) => url).done;
    expect(open).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('');
    answer('https://provider.example/authorize?state=x');
    await expect(pending).resolves.toEqual({ result: 'https://provider.example/authorize?state=x', opened: true, cancelled: false });
    expect(tab.location.href).toBe('https://provider.example/authorize?state=x');

    const failed = fakeTab();
    open.mockReturnValue(failed as unknown as Window);
    await expect(startSignIn(() => Promise.reject(new Error('no')), () => 'x').done).rejects.toThrow('no');
    expect(failed.close).toHaveBeenCalledTimes(1);

    const empty = fakeTab();
    open.mockReturnValue(empty as unknown as Window);
    await expect(startSignIn(async () => ({}), () => undefined).done).resolves.toEqual({ result: {}, opened: false, cancelled: false });
    expect(empty.close).toHaveBeenCalledTimes(1);
  });

  it('a refused tab is false, never an error', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openSignInPage('https://provider.example/device')).toBe(false);
    await expect(startSignIn(async () => 'https://provider.example', (u) => u).done).resolves.toEqual({ result: 'https://provider.example', opened: false, cancelled: false });
  });

  it('a sign-in cancelled before the start answers closes its tab, and the late answer goes nowhere', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    let answer!: (url: string) => void;
    const attempt = startSignIn(() => new Promise<string>((resolve) => { answer = resolve; }), (url) => url);
    attempt.cancel();
    expect(tab.close).toHaveBeenCalledTimes(1);
    answer('https://provider.example/authorize');
    await expect(attempt.done).resolves.toEqual({ result: 'https://provider.example/authorize', opened: false, cancelled: true });
    expect(tab.location.href).toBe('');
  });

  it('abandon closes a tab still blank, and leaves one already on the provider page', async () => {
    const blank = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(blank as unknown as Window);
    const waiting = startSignIn(() => new Promise<string>(() => {}), (url) => url);
    waiting.abandon();
    expect(blank.close).toHaveBeenCalledTimes(1);

    const pointed = fakeTab();
    open.mockReturnValue(pointed as unknown as Window);
    const answered = startSignIn(async () => 'https://provider.example/a', (url) => url);
    await answered.done;
    answered.abandon();
    expect(pointed.close).not.toHaveBeenCalled();
    expect(pointed.location.href).toBe('https://provider.example/a');
  });

  it('a tab the owner closed before the start answers is not called opened', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    let answer!: (url: string) => void;
    const attempt = startSignIn(() => new Promise<string>((resolve) => { answer = resolve; }), (url) => url);
    tab.closed = true;
    answer('https://provider.example/authorize');
    await expect(attempt.done).resolves.toMatchObject({ opened: false, cancelled: false });
    expect(tab.location.href).toBe('');
    const handle = openSignInTab();
    tab.closed = true;
    expect(handle.opened).toBe(false);
    expect(handle.go('https://provider.example')).toBe(false);
  });
});

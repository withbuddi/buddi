/** The page's half of CSRF: which cookie it echoes, and what a refused write says. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, STALE_COOKIES, csrfToken, get, post } from './api';

const port = Number(location.port) || (location.protocol === 'https:' ? 443 : 80);
const set: string[] = [];
function cookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/`;
  set.push(name);
}
afterEach(() => {
  for (const name of set.splice(0)) document.cookie = `${name}=; path=/; max-age=0`;
  vi.unstubAllGlobals();
});

describe('csrfToken', () => {
  it('takes the cookie named after this page`s port, whatever else is on the host', () => {
    cookie('buddi_csrf_9443', 'theirs');
    cookie(`buddi_csrf_${port}`, 'ours');
    cookie('buddi_csrf_4417', 'another');
    expect(csrfToken()).toBe('ours');
  });

  it('takes the only buddi cookie when none carries this port', () => {
    cookie('buddi_csrf_9443', 'only');
    expect(csrfToken()).toBe('only');
  });

  it('takes nothing rather than guess between two that are not ours', () => {
    cookie('buddi_csrf_9443', 'one');
    cookie('buddi_csrf_4417', 'two');
    expect(csrfToken()).toBe('');
  });
});

describe('a refused request', () => {
  const answer = (status: number, body = '') => vi.stubGlobal('fetch', vi.fn(async () => new Response(body === '' ? null : body, { status })));

  it('says what to do when a write meets a bare 403', async () => {
    answer(403);
    const error = await post('/agents/a/avatar').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toBe(STALE_COOKIES);
    expect(STALE_COOKIES).toBe("This page's sign-in no longer matches its cookies. Reload the page and try again.");
  });

  it('keeps the reason a 403 gives, and the status of anything else', async () => {
    answer(403, JSON.stringify({ error: 'Only from the computer buddi runs on.' }));
    expect(((await post('/tailscale').catch((e: unknown) => e)) as ApiError).message).toBe('Only from the computer buddi runs on.');
    answer(403);
    expect(((await get('/agents').catch((e: unknown) => e)) as ApiError).message).toBe('request failed (403)');
    answer(500);
    expect(((await post('/agents').catch((e: unknown) => e)) as ApiError).message).toBe('request failed (500)');
  });
});

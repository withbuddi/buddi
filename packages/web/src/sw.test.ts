import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(path.resolve(__dirname, '../public/sw.js'), 'utf8');
const ORIGIN = 'https://host.example:9443';

/** Loads sw.js in a sandbox and returns what a page load gets, for a given network answer. */
async function pageLoad(network: () => Promise<Response>): Promise<string> {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shell = new Response('the kept shell');
  const self = {
    location: { href: `${ORIGIN}/sw.js?v=test`, origin: ORIGIN },
    registration: { scope: `${ORIGIN}/` },
    addEventListener: (type: string, fn: (event: unknown) => void) => { handlers[type] = fn; },
  };
  const caches = { open: async () => ({ match: async () => shell.clone() }) };
  runInNewContext(SOURCE, { self, caches, fetch: network, URL, Response, Promise, setTimeout, clearTimeout });
  let answer: Promise<Response> | undefined;
  handlers.fetch!({
    request: { method: 'GET', mode: 'navigate', url: `${ORIGIN}/#/settings` },
    respondWith: (p: Promise<Response>) => { answer = p; },
  });
  return (await answer!).text();
}

describe('the service worker on a page load', () => {
  it('shows the kept shell when buddi refuses with an empty 429 or any server error, not the browser error page', async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(await pageLoad(async () => new Response(null, { status }))).toBe('the kept shell');
    }
  });

  it('passes a real answer through, and a sign-in refusal too', async () => {
    expect(await pageLoad(async () => new Response('the live page', { status: 200 }))).toBe('the live page');
    expect(await pageLoad(async () => new Response('link expired', { status: 401 }))).toBe('link expired');
  });

  it("passes the gateway's signed-out page through, never the kept shell", async () => {
    const page = '<!doctype html><title>Signed out · buddi</title><p>run <code>buddi dashboard</code></p>';
    expect(await pageLoad(async () => new Response(page, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))).toBe(page);
  });

  it('shows the kept shell when nothing answers at all', async () => {
    expect(await pageLoad(async () => { throw new TypeError('network'); })).toBe('the kept shell');
  });
});

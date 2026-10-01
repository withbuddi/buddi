/**
 * `buddi mcp`'s sign-in, against listeners that are not this installation's
 * gateway: a ticket is presented only after `/_buddi/ready` proved the token.
 */
import type { HttpTransport } from '@buddi/gateway';
import { describe, expect, it } from 'vitest';
import { GatewayClient, GatewayError } from './gateway-client.js';

const TOKEN = 'a-test-dashboard-token-long-enough';

/** A listener answering `/_buddi/ready` with `ready`, recording every path it was asked. */
function listener(ready: () => Response) {
  const paths: string[] = [];
  const transport: HttpTransport = async (url) => {
    const { pathname, search } = new URL(url);
    paths.push(pathname + search.replace(/=.*/, '='));
    if (pathname === '/_buddi/ready') return ready() as never;
    return new Response(null, { status: 401 }) as never;
  };
  return { paths, transport };
}

describe('buddi mcp sign-in', () => {
  const cases: Array<[string, () => Response]> = [
    ['404', () => new Response('not found', { status: 404 })],
    ['503', () => new Response(null, { status: 503 })],
    ['an HTML 200', () => new Response('<html>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['a JSON 200 without a proof', () => Response.json({ ok: true })],
    ['a JSON 200 that is not JSON', () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } })],
  ];
  for (const [what, ready] of cases) {
    it(`never presents a ticket to a listener answering the proof with ${what}`, async () => {
      const { paths, transport } = listener(ready);
      const client = new GatewayClient({ baseUrl: 'http://127.0.0.1:1', token: async () => TOKEN, transport });
      const failed = await client.get('/api/overview').catch((err: unknown) => err);
      expect(failed).toBeInstanceOf(GatewayError);
      expect((failed as Error).message).toMatch(/could not prove|not the one this command belongs to/);
      expect(paths.some((p) => p.startsWith('/?t='))).toBe(false);
    });
  }
});

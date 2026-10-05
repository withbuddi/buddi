import { expect, it } from 'vitest';
import { CODEX_CLIENT_VERSION } from './codex-direct.js';

/**
 * The ChatGPT backend filters `/codex/models` by the client version we name,
 * so a stale constant quietly hides new models from Add account. This asks
 * npm for the latest @openai/codex and fails when it is newer. Network only:
 * skipped on CI and when npm cannot be reached.
 */
const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

it('compares versions numerically', () => {
  expect(newer('0.161.0', '0.160.0')).toBe(true);
  expect(newer('0.160.0', '0.160.0')).toBe(false);
  expect(newer('0.99.9', '0.160.0')).toBe(false);
});

it.skipIf(!!process.env.CI)('CODEX_CLIENT_VERSION is not behind npm’s latest @openai/codex', async (ctx) => {
  let latest: string;
  try {
    const res = await fetch('https://registry.npmjs.org/@openai/codex/latest', { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return ctx.skip();
    latest = String(((await res.json()) as { version?: unknown }).version ?? '');
  } catch { return ctx.skip(); }
  if (!/^\d+\.\d+\.\d+/.test(latest)) return ctx.skip();
  expect(newer(latest, CODEX_CLIENT_VERSION),
    `@openai/codex ${latest} is out; bump CODEX_CLIENT_VERSION (${CODEX_CLIENT_VERSION}) in packages/runtime/src/codex-direct.ts so the ChatGPT model list includes its models`).toBe(false);
});

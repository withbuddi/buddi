/**
 * The doctor probes secrets the way the service reads them.
 *
 * After `buddi vault import-env`, `.env` holds `NAME=<vault>` — a marker, not a
 * value. A probe that read `process.env` raw would send the literal `<vault>`
 * to Telegram and to the models API and report a broken installation that
 * works. These tests pin the two halves of that: a seeded vault reaches the
 * probes, and a locked one stops them rather than letting the marker out.
 */
import { VAULT_PLACEHOLDER, createMemoryVault } from '@buddi/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProbes } from './doctor-probes.js';
import type { HttpTransport } from '@buddi/gateway';

const VAULT_TOKEN = '9999999:telegram-from-the-vault';
const VAULT_KEY = 'sk-ant-api03-from-the-vault';

/** `.env` exactly as `vault import-env` leaves it: names, markers, no values. */
const importedEnv = (): NodeJS.ProcessEnv => ({
  ANTHROPIC_API_KEY: VAULT_PLACEHOLDER,
  TELEGRAM_BOT_TOKEN: VAULT_PLACEHOLDER,
  BUDDI_TZ: 'Europe/Paris',
});

const seeded = createMemoryVault({
  seed: { ANTHROPIC_API_KEY: VAULT_KEY, TELEGRAM_BOT_TOKEN: VAULT_TOKEN },
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

/**
 * Record every request and answer it, so nothing leaves the machine.
 *
 * Injected rather than stubbed onto `globalThis`: the probes send on the repo's
 * one transport now (`node:https`, nothing pooled), and a test that stubbed
 * `fetch` would no longer intercept anything — it would reach the real network.
 * A `Response` satisfies `TransportResponse`, so the fake stays this short.
 */
function recordHttp(): { calls: Call[]; http: HttpTransport } {
  const calls: Call[] = [];
  const http: HttpTransport = async (url, init) => {
    calls.push({ url: String(url), headers: { ...(init.headers ?? {}) } });
    return new Response(JSON.stringify({ ok: true, result: { id: 7, username: 'buddi_bot' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, http };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createProbes with a vault', () => {
  it('probes with the vault value, never the .env placeholder', async () => {
    const { calls, http } = recordHttp();
    const env = importedEnv();
    const probes = createProbes(env, { vault: seeded, http });

    expect(await probes.botToken()).toMatchObject({ status: 'ok' });
    const telegram = calls.find((c) => c.url.includes('api.telegram.org'));
    expect(telegram?.url).toContain(VAULT_TOKEN);
    expect(telegram?.url).not.toContain(VAULT_PLACEHOLDER);

    expect(await probes.modelCredential()).toMatchObject({ status: 'ok' });
    const models = calls.find((c) => c.url.includes('/v1/models'));
    expect(models?.headers['x-api-key']).toBe(VAULT_KEY);

    await probes.close();
  });

  it("reports the vault row with each secret's origin, and no values", async () => {
    const { http } = recordHttp();
    const env = importedEnv();
    const row = await createProbes(env, { vault: seeded, http }).vault();
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('memory');
    expect(row.detail).toContain('from the vault: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN');
    expect(row.detail).not.toContain(VAULT_KEY);
    expect(row.detail).not.toContain(VAULT_TOKEN);
  });

  it('fails the vault row on a locked vault and probes nothing with the placeholder', async () => {
    const { calls, http } = recordHttp();
    const env = importedEnv();
    const probes = createProbes(env, { vault: createMemoryVault({ locked: true }), http });

    const row = await probes.vault();
    expect(row.status).toBe('fail');
    expect(row.detail).toMatch(/locked/);

    // Fail closed: the marker is never mistaken for a credential…
    expect(await probes.modelCredential()).toMatchObject({ status: 'fail' });
    expect(await probes.botToken()).toMatchObject({ status: 'warn' });
    // …and nothing was sent anywhere.
    expect(calls).toEqual([]);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();

    await probes.close();
  });
});

/**
 * `buddi dashboard` prints a one-time link and opens it — and never prints the
 * installation's token.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureWebToken, verifyTicket } from '@buddi/gateway';
import { describe, expect, it } from 'vitest';
import { OFF_HELP, runDashboard } from './dashboard-cmd.js';

const env = (): NodeJS.ProcessEnv => ({
  BUDDI_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'buddi-dash-')),
  BUDDI_VAULT: 'none',
  BUDDI_WEB_PORT: '4317',
});

describe('buddi dashboard', () => {
  it('prints the URL with a ticket that verifies against the token, and opens it', async () => {
    const e = env();
    const lines: string[] = [];
    const opened: string[] = [];
    const code = await runDashboard('open', {
      env: e,
      out: (line) => lines.push(line),
      launch: (url) => opened.push(url),
    });
    expect(code).toBe(0);

    const url = opened[0] as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:4317\/\?t=/);
    expect(lines[0]).toContain(url);

    const { token } = await ensureWebToken({ env: e, vault: undefined });
    const ticket = decodeURIComponent(new URL(url).searchParams.get('t') as string);
    expect(verifyTicket(token, ticket).ok).toBe(true);

    // The token itself is never printed.
    expect(lines.join('\n')).not.toContain(token);
  });

  it('prints only the ticket with --token', async () => {
    const e = env();
    const lines: string[] = [];
    await runDashboard('token', { env: e, out: (line) => lines.push(line), launch: () => {} });
    expect(lines).toHaveLength(1);
    const { token } = await ensureWebToken({ env: e, vault: undefined });
    expect(verifyTicket(token, lines[0] as string).ok).toBe(true);
  });

  it('mints a different ticket every time', async () => {
    const e = env();
    const first: string[] = [];
    const second: string[] = [];
    await runDashboard('token', { env: e, out: (l) => first.push(l), launch: () => {} });
    await runDashboard('token', { env: e, out: (l) => second.push(l), launch: () => {} });
    expect(first[0]).not.toBe(second[0]);
  });

  it('explains the off switch without touching anything', async () => {
    const lines: string[] = [];
    await runDashboard('off', { env: env(), out: (line) => lines.push(line), launch: () => {} });
    expect(lines[0]).toBe(OFF_HELP);
    expect(lines[0]).toContain('BUDDI_WEB=0');
  });
});

/**
 * `buddi dashboard` opens the dashboard. On the default loopback binding that
 * is the whole story — a plain URL, no token minted, nothing to expire — and on
 * a binding moved off loopback it prints a one-time ticket and never the token.
 */
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureWebToken, verifyTicket, webTokenExists } from '@buddi/gateway';
import { describe, expect, it } from 'vitest';
import {
  APP_BUNDLE_ID,
  buildInfoPlist,
  buildLauncherScript,
  dashboardAppPath,
  shellQuote,
} from './dashboard-app.js';
import { OFF_HELP, runDashboard } from './dashboard-cmd.js';
import { CLI_ENTRY } from './paths.js';

const env = (): NodeJS.ProcessEnv => ({
  BUDDI_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'buddi-dash-')),
  BUDDI_VAULT: 'none',
  BUDDI_WEB_PORT: '4317',
});

describe('buddi dashboard', () => {
  it('opens the bare URL on the default loopback binding, and touches no token', async () => {
    const e = env();
    const lines: string[] = [];
    const opened: string[] = [];
    const code = await runDashboard('open', {
      env: e,
      out: (line) => lines.push(line),
      launch: (url) => opened.push(url),
    });
    expect(code).toBe(0);

    // The bookmark URL: the same tomorrow as today, with nothing to spend.
    expect(opened).toEqual(['http://127.0.0.1:4317/']);
    expect(lines[0]).toContain(opened[0] as string);
    expect(lines.join('\n')).not.toContain('?t=');

    // Open means open: the command never had a reason to create the secret.
    expect(await webTokenExists({ env: e, vault: undefined })).toBeNull();
  });

  it('prints the URL with a ticket that verifies against the token, and opens it, off loopback', async () => {
    const e = { ...env(), BUDDI_WEB_HOST: '10.0.0.4' };
    const lines: string[] = [];
    const opened: string[] = [];
    const code = await runDashboard('open', {
      env: e,
      out: (line) => lines.push(line),
      launch: (url) => opened.push(url),
    });
    expect(code).toBe(0);

    const url = opened[0] as string;
    expect(url).toMatch(/^http:\/\/10\.0\.0\.4:4317\/\?t=/);
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

describe('the double-clickable app', () => {
  it('is a bundle whose whole program is `buddi dashboard`', () => {
    const script = buildLauncherScript({ nodePath: '/opt/node', cliEntry: '/repo/main.js' });
    expect(script.split('\n')[0]).toBe('#!/bin/sh');
    // Absolute paths — a GUI launch inherits almost no PATH.
    expect(script).toContain("exec '/opt/node' '/repo/main.js' dashboard");
    // It carries no secret of any kind: the ticket is minted by that command.
    expect(script).not.toMatch(/t=|token|BUDDI_WEB_TOKEN/i);

    const plist = buildInfoPlist();
    expect(plist).toContain(`<string>${APP_BUNDLE_ID}</string>`);
    expect(plist).toContain('<key>LSUIElement</key>');
    expect(plist).toContain('<string>buddi-dashboard</string>');
  });

  it('quotes a path that would otherwise break the shell', () => {
    // The POSIX idiom: close the quote, an escaped apostrophe, open it again.
    expect(shellQuote("/Users/o'brien/buddi/main.js")).toBe("'/Users/o'\\''brien/buddi/main.js'");
  });

  it('installs into ~/Applications and removes again', async () => {
    if (!existsSync(CLI_ENTRY)) return; // `pnpm -r build` has not run in this checkout.
    const home = mkdtempSync(path.join(tmpdir(), 'buddi-home-'));
    const lines: string[] = [];
    const out = (line: string): void => void lines.push(line);

    expect(await runDashboard('install-app', { env: env(), home, platform: 'darwin', out })).toBe(0);
    const bundle = dashboardAppPath(home);
    expect(bundle).toBe(path.join(home, 'Applications', 'Buddi Dashboard.app'));
    const exe = path.join(bundle, 'Contents', 'MacOS', 'buddi-dashboard');
    expect(existsSync(path.join(bundle, 'Contents', 'Info.plist'))).toBe(true);
    // Executable, and it runs the built CLI.
    expect(statSync(exe).mode & 0o111).toBeTruthy();
    expect(readFileSync(exe, 'utf8')).toContain('dashboard');

    // Idempotent, then gone.
    expect(await runDashboard('install-app', { env: env(), home, platform: 'darwin', out })).toBe(0);
    expect(await runDashboard('uninstall-app', { env: env(), home, platform: 'darwin', out })).toBe(
      0,
    );
    expect(existsSync(bundle)).toBe(false);
  });

  it('refuses politely where there are no app bundles', async () => {
    const lines: string[] = [];
    const code = await runDashboard('install-app', {
      env: env(),
      platform: 'linux',
      out: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join(' ')).toContain('macOS-only');
  });
});

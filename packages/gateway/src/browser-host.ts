/**
 * The browser plugin's one controller, as the composition root builds it.
 *
 * The plugin imports only `@buddi/core/plugin`, so what it cannot reach there
 * is handed in: its `dir` area (the same one `ctx.buddi.dir` is) and core's
 * address guard for Playwright mode's proxy. Every caller in the gateway goes
 * through here, so the first one to build the controller builds it whole.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { guardedLookup, pluginDir } from '@buddi/core';
import { hostBrowser, migrateSettings, readTelemetry, summarize, telemetryLines, type ExtensionBridge, type HostController, type TelemetrySummary } from '@buddi/tool-browser';
import { dataDir } from './web/config.js';
import { readExtensionRecord } from './web/extension.js';

export function browserHost(
  env: NodeJS.ProcessEnv = process.env,
  options: { extensionBridge?: () => ExtensionBridge } = {},
): HostController {
  return hostBrowser(pluginDir('browser', env), env, {
    ...options,
    lookup: (policy) => guardedLookup(undefined, policy),
  });
}

/**
 * What `buddi doctor` says about the browser, read from disk without the
 * running gateway: which routes the owner allows, and the last week of stops
 * by cause (docs/browser.md, "Telemetry"). Whether Chrome is connected right
 * now only the gateway knows, so the pairing's last-seen time stands in.
 */
export async function browserDoctor(env: NodeJS.ProcessEnv = process.env, days = 7): Promise<{ routes: string; lines: string[]; summary: TelemetrySummary; warn: boolean }> {
  const dir = path.join(dataDir(env), 'browser');
  const record = await readExtensionRecord(env).catch(() => undefined);
  let routes = 'own browser';
  let warn = false;
  try {
    const raw = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')) as unknown;
    const { settings } = migrateSettings(raw, { paired: record !== undefined });
    const parts = ['own browser'];
    if (settings.yourChrome) {
      parts.push(record ? `your Chrome (paired${record.lastSeenAt ? `, last seen ${record.lastSeenAt}` : ''})` : 'your Chrome (on, not paired)');
      if (!record) warn = true;
    }
    if (settings.yourApps !== 'off') parts.push(`your apps (${settings.yourApps}; served by the Computer plugin when installed)`);
    routes = parts.join(', ');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { routes = `settings will not read: ${err instanceof Error ? err.message : String(err)}`; warn = true; }
  }
  const summary = summarize(readTelemetry(path.join(dir, 'telemetry.jsonl')), Date.now(), days);
  return { routes, lines: telemetryLines(summary), summary, warn };
}

/**
 * `delegableSession` for delegation (docs/browser.md, "Delegates"): a
 * colleague asked from a conversation that has a browser session open may
 * use `browser.act` too; from anywhere else, nothing. The delegation tool
 * already asked for a live owner request at depth 0 before this is read.
 */
export function browserDelegable(
  browser: { status(scope?: { agentId?: string; conversationId?: string }): { session?: unknown } },
): (ctx: { agentId?: string; conversationId?: string }) => readonly string[] {
  return (ctx) => {
    if (!ctx.agentId || !ctx.conversationId) return [];
    try {
      return browser.status({ agentId: ctx.agentId, conversationId: ctx.conversationId }).session ? ['browser.act'] : [];
    } catch {
      return [];
    }
  };
}

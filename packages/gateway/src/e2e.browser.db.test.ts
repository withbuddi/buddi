/** Authenticated dashboard/Telegram input -> runtime -> shared browser service.
 * The real browser's actions are tested separately by the headed fixture suite. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, runMigrations, ensureOwner, completeOnboarding, ToolRegistry, type ToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { manifest as memory } from '@buddi/tool-memory';
import { BrowserService, createBrowserManifest, type BrowserDriver } from '@buddi/tool-browser';
import type { RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { loadGatewayCatalog } from './agents/catalog.js';
import { WebChat } from './web/chat.js';
import { startTelegram } from './telegram/main.js';
import type { TelegramApi } from './telegram/api.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const name = `buddi_browser_surfaces_${process.pid}`;
suite('browser authority across interactive surfaces', () => {
  let admin: Pool;
  let pool: Pool;
  let dir: string;
  beforeAll(async () => {
    admin = createPool(databaseUrl!);
    await admin.query(`create database ${name}`);
    const url = new URL(databaseUrl!); url.pathname = `/${name}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [memory]);
    await ensureOwner(pool, 'owner');
    await completeOnboarding(pool, 'fixture');
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-browser-surfaces-'));
    await mkdir(path.join(dir, 'fixture'));
    await writeFile(path.join(dir, 'fixture', 'agent.md'), '---\nid: fixture\nhandle: fixture\nname: Fixture\ndescription: Browser fixture\ndefault: true\nprovider: anthropic\nmodel: claude-sonnet-5\ntools: [browser.*]\nmaxTurns: 4\n---\nOnly carry out the owner task.\n');
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`drop database if exists ${name}`); await admin.end(); }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const setup = async () => {
    const driver: BrowserDriver = { start: vi.fn(async () => {}), perform: vi.fn(async () => {}),
      observe: vi.fn(async () => ({ id: 'o1', url: 'https://example.com/', title: 'Example', tree: '- heading "Example"', tabs: [], capturedAt: new Date().toISOString() })),
      screenshot: vi.fn(async () => undefined), close: vi.fn(async () => {}) };
    const browser = new BrowserService(driver); await browser.enable();
    const registry = new ToolRegistry(); registry.register(createBrowserManifest(browser));
    const env = { ANTHROPIC_API_KEY: 'fixture-unused', BUDDI_AGENTS_DIR: dir };
    const catalog = loadGatewayCatalog({ dir, registry, env });
    let step = 0;
    const provider: RuntimeProvider = { async complete(request) {
      if (++step === 1) return { content: [{ type: 'tool_use', id: 'b1', name: 'browser.act', input: { action: 'navigate', url: 'https://example.com/' } }], stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'fixture' };
      const result = request.messages.at(-1)?.content.find((b) => b.type === 'tool_result');
      expect(result).toMatchObject({ type: 'tool_result' });
      if (result?.type === 'tool_result') expect(result.is_error, result.content).not.toBe(true);
      return { content: [{ type: 'text', text: 'Fixture browser opened.' }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'fixture' };
    } };
    const ctx: ToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    return { driver, browser, registry, catalog, provider, ctx, env };
  };

  it('dashboard chat supplies owner provenance without a per-click approval', async () => {
    const fixture = await setup();
    try {
      const chat = new WebChat({ ...fixture, pool, now: () => new Date(), timezone: 'UTC', providerFor: () => fixture.provider });
      const sent = await chat.send({ agentId: 'fixture', text: 'Open example.com for me.' });
      expect(sent.ok).toBe(true);
      await chat.drain();
      expect(fixture.driver.perform).toHaveBeenCalledTimes(1);
      expect(fixture.browser.status().session).toMatchObject({ agentId: 'fixture', task: 'Open example.com for me.' });
      expect((await pool.query('select count(*)::int as n from core.actions')).rows[0].n).toBe(0);
    } finally { await fixture.browser.shutdown(); }
  });

  it('Telegram paired-owner input reaches the same browser tool path', async () => {
    const fixture = await setup();
    let delivered = false;
    const replies: string[] = [];
    const api = {
      getMe: async () => ({ id: 1, username: 'fixturebot' }),
      deleteMyCommands: async () => {}, setMyCommands: async () => {},
      getUpdates: async (_offset: unknown, signal?: AbortSignal) => {
        if (!delivered) { delivered = true; return [{ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), text: 'Open example.com from my phone.', from: { id: 4242, first_name: 'Owner' }, chat: { id: 4242, type: 'private' } } }]; }
        return new Promise<[]>((resolve) => { if (signal?.aborted) resolve([]); else signal?.addEventListener('abort', () => resolve([]), { once: true }); });
      },
      sendMessage: async (_chat: unknown, text: string) => { replies.push(text); return replies.length; },
      editMessageText: async (_chat: unknown, _id: unknown, text: string) => { replies.push(text); },
      sendChatAction: async () => {},
    };
    const telegram = await startTelegram({ ...fixture, pool, now: () => new Date(),
      env: { ...fixture.env, TELEGRAM_OWNER_USER_ID: '4242', TELEGRAM_OWNER_CHAT_ID: '4242' },
      api: api as unknown as TelegramApi, log: () => {} });
    try {
      await vi.waitFor(() => expect(replies.some((r) => r.includes('Fixture browser opened.'))).toBe(true), { timeout: 5000 });
      expect(fixture.driver.perform).toHaveBeenCalledTimes(1);
      expect(fixture.browser.status().session).toMatchObject({ agentId: 'fixture', task: 'Open example.com from my phone.' });
    } finally { await telegram.stop(); await fixture.browser.shutdown(); }
  });
});

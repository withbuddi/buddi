import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlaywrightDriver } from './driver.js';
import { PlaywrightHost } from './host.js';
import { BrowserManager } from './manager.js';
import { commandSchema } from './types.js';
import { DEFAULT_POLICY } from '@buddi/core/plugin';
import { ToolRegistry, createPluginHost, guardedLookup, hostBindingOf, type AgentDefinition, type ToolContext } from '@buddi/core/testing';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: ToolContext): ToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });
import { runAgent, type RuntimeProvider, type NeutralMessage } from '@buddi/runtime';
import { BrowserService } from './service.js';
import { createBrowserManifest } from './index.js';

const enabled = process.env.BUDDI_BROWSER_TEST === '1';
describe.skipIf(!enabled)('real host browser fixture (opt in with BUDDI_BROWSER_TEST=1)', () => {
  let server: Server;
  let driver: PlaywrightDriver;
  let dir: string;
  let url: string;
  let submissions = 0;
  let submitted = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-browser-fixture-'));
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/book' && req.method === 'POST') {
        submissions++;
        req.on('data', (chunk) => { submitted += String(chunk); });
        req.on('end', () => { res.writeHead(303, { Location: '/receipt', 'Set-Cookie': 'fixture_login=remembered; Max-Age=86400; Path=/; SameSite=Lax' }); res.end(); });
      } else if (req.url === '/receipt') res.end('<title>Booked</title><h1>Appointment confirmed</h1><p>Receipt FIXTURE-001</p>');
      else if (req.url === '/ambiguous') res.end('<button>Confirm</button><button>Confirm</button><a href="/receipt" target="_blank">New tab</a>');
      else if (req.url === '/references') res.end('<main><h1>References fixture</h1><p id="clock">Ticker 1</p><a id="first" href="/receipt">Repeated link</a><a id="second" href="/cookie">Repeated link</a><label for="password">Password</label><input type="password" id="password"></main>');
      else if (req.url === '/cookie') res.end(`<title>Saved login</title><p>${req.headers.cookie?.includes('fixture_login=remembered') ? 'Login remembered' : 'No login'}</p>`);
      else if (req.url === '/redirect-private') { res.writeHead(302, { Location: 'http://127.0.0.1:4317/' }); res.end(); }
      else res.end('<title>Appointment fixture</title><h1>Book an appointment</h1><form method="POST" action="/book"><label for="name">Your name</label><input id="name" name="name"><label for="time">Time</label><select id="time" name="time"><option>10:00</option><option>11:00</option></select><button>Book appointment</button></form><a href="/redirect-private">Private redirect</a>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;
    driver = new PlaywrightDriver({ profileDir: path.join(dir, 'profile'), headless: process.env.BUDDI_BROWSER_HEADED !== '1',
      policy: { ...DEFAULT_POLICY, ports: [port], blockedHostname: () => false,
        blocked: (address) => address === '127.0.0.1' ? null : 'Fixture only' },
      lookup: (policy) => guardedLookup(undefined, policy) });
    await driver.start();
  }, 30_000);
  afterAll(async () => {
    await driver?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('visibly navigates, fills, selects and submits exactly once; keeps login across restart', async () => {
    await driver.perform(commandSchema.parse({ action: 'navigate', url }));
    let page = await driver.observe();
    expect(page.tree).toContain('Your name');
    expect(await driver.screenshot()).toBeInstanceOf(Buffer);
    await driver.perform(commandSchema.parse({ action: 'fill', observation: page.id, target: { by: 'label', name: 'Your name' }, value: 'Fixture Owner' }));
    await expect(driver.perform(commandSchema.parse({ action: 'click', observation: page.id, target: { role: 'button', name: 'Book appointment' } }))).rejects.toThrow('Stale');
    page = await driver.observe();
    await driver.perform(commandSchema.parse({ action: 'select', observation: page.id, target: { by: 'label', name: 'Time' }, value: '11:00' }));
    page = await driver.observe();
    await driver.perform(commandSchema.parse({ action: 'click', observation: page.id, target: { role: 'button', name: 'Book appointment' } }));
    page = await driver.observe();
    expect(page.tree).toContain('FIXTURE-001');
    expect(submissions).toBe(1);
    expect(submitted).toContain('name=Fixture+Owner');
    expect(submitted).toContain('time=11%3A00');
    await driver.close();
    await driver.start();
    await driver.perform(commandSchema.parse({ action: 'navigate', url: `${url}/cookie` }));
    expect((await driver.observe()).tree).toContain('Login remembered');
  }, 30_000);

  it('refuses local control services and non-web URLs, including redirects', async () => {
    for (const target of ['http://127.0.0.1:4317/', 'file:///etc/passwd', 'javascript:alert(1)']) {
      await expect(driver.perform(commandSchema.parse({ action: 'navigate', url: target }))).rejects.toThrow();
    }
    await expect(driver.perform(commandSchema.parse({ action: 'navigate', url: `${url}/redirect-private` }))).rejects.toThrow();
  });

  it('completes a booking through the real agent loop, tool registry, authority and browser', async () => {
    // Independent session: the previous test deliberately left a blocked
    // redirect transitioning to Chromium's error page.
    await driver.close();
    submissions = 0;
    const service = new BrowserService(driver);
    await service.enable();
    const registry = new ToolRegistry(); registry.register(createBrowserManifest(service));
    const messages: NeutralMessage[] = [];
    const db = { async query(sql: string, params: any[] = []) {
      if (sql.includes('insert into core.messages')) messages.push({ role: params[1], content: JSON.parse(params[2]) });
      return { rows: sql.includes('select role, content from core.messages') ? [...messages] : [] };
    } };
    let turn = 0;
    let sawImage = false;
    const provider: RuntimeProvider = { async complete(request) {
      sawImage ||= request.messages.some((m) => m.content.some((b) => b.type === 'image'));
      const result = request.messages.at(-1)?.content.find((b) => b.type === 'tool_result');
      if (result?.type === 'tool_result' && result.is_error) throw new Error(`Fixture step ${turn}: ${result.content}`);
      const evidence = result?.type === 'tool_result' ? JSON.parse(result.content).observation : undefined;
      const steps = [
        { action: 'navigate', url },
        { action: 'fill', target: { by: 'label', name: 'Your name' }, value: 'Agent Fixture' },
        { action: 'select', target: { by: 'label', name: 'Time' }, value: '11:00' },
        { action: 'click', target: { role: 'button', name: 'Book appointment' } },
      ];
      const step = steps[turn++];
      if (!step) {
        expect(evidence.tree).toContain('FIXTURE-001');
        return { content: [{ type: 'text', text: 'Appointment confirmed: FIXTURE-001' }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'fixture' };
      }
      return { content: [{ type: 'tool_use', id: `call-${turn}`, name: 'browser.act', input: { ...step, ...(evidence ? { observation: evidence.id } : {}) } }], stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'fixture' };
    } };
    const agent: AgentDefinition = { id: 'fixture-agent', name: 'Fixture', tools: ['browser.act'], systemPrompt: 'Complete only the owner task.', maxTurns: 8,
      provider: { kind: 'anthropic', model: 'fixture', credential: { kind: 'api-key', env: 'UNUSED' } } };
    const ctx: ToolContext = hosted({ db: db as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC',
      ownerRequest: { id: 'fixture-owner-request', text: 'Book my fixture appointment for 11:00.', expiresAt: Date.now() + 60_000 } });
    try {
      const outcome = await runAgent({ agent, provider, registry, ctx, pool: db, conversationId: 'fixture-conversation', userMessage: ctx.ownerRequest!.text });
      expect(outcome.text).toContain('FIXTURE-001');
      expect(submissions).toBe(1);
      expect(sawImage).toBe(true);
      expect(service.status()).toMatchObject({ state: 'running', session: { agentId: 'fixture-agent', steps: 4 } });
      expect(JSON.stringify(messages)).not.toContain('"type":"image"');
      await service.control('stop');
      await expect(service.execute(commandSchema.parse({ action: 'navigate', url }), { ...ctx, agentId: agent.id, conversationId: 'fixture-conversation' })).rejects.toThrow('owner stopped');
    } finally { await service.shutdown(); }
  }, 30_000);

  it('refuses ambiguous targets, follows explicit popup selection and detects closed windows', async () => {
    await driver.start();
    await driver.perform(commandSchema.parse({ action: 'navigate', url: `${url}/ambiguous` }));
    let page = await driver.observe();
    await expect(driver.perform(commandSchema.parse({ action: 'click', observation: page.id, target: { role: 'button', name: 'Confirm' } }))).rejects.toThrow('ambiguous');
    page = await driver.observe();
    await driver.perform(commandSchema.parse({ action: 'click', observation: page.id, target: { role: 'link', name: 'New tab' } }));
    await vi.waitFor(async () => {
      page = await driver.observe();
      expect(page.tabs.some((t) => t.url.endsWith('/receipt'))).toBe(true);
    });
    const popup = page.tabs.find((t) => t.url.endsWith('/receipt'))!;
    await driver.perform(commandSchema.parse({ action: 'tab', tabId: popup.id }));
    expect((await driver.observe()).tree).toContain('FIXTURE-001');
    await driver.close();
    await expect(driver.observe()).rejects.toThrow('closed');
  }, 30_000);

  it('selects exact repeated links by ref despite unrelated page changes, but rejects changed elements', async () => {
    const adopted = vi.spyOn(driver, 'adopt');
    await driver.start();
    const hostPage = adopted.mock.calls.at(-1)![0];
    try {
      await driver.perform(commandSchema.parse({ action: 'navigate', url: `${url}/references` }));
      let observation = await driver.observe();
      const links = observation.targets!.filter((target) => target.name === 'Repeated link');
      expect(links).toHaveLength(2); expect(links[0]!.ref).not.toBe(links[1]!.ref);
      const chosen = links.find((target) => target.href?.endsWith('/receipt'))!;
      await hostPage.locator('#clock').evaluate((el) => { el.textContent = 'Ticker 2'; });
      await driver.perform(commandSchema.parse({ action: 'click', target: { ref: chosen.ref }, observation: observation.id }));
      expect((await driver.observe()).tree).toContain('FIXTURE-001');
      await driver.perform(commandSchema.parse({ action: 'navigate', url: `${url}/references` }));
      observation = await driver.observe();
      const changed = observation.targets!.find((target) => target.href?.endsWith('/receipt'))!;
      await hostPage.locator('#first').evaluate((el) => el.setAttribute('href', '/cookie'));
      await expect(driver.perform(commandSchema.parse({ action: 'click', target: { ref: changed.ref }, observation: observation.id }))).rejects.toThrow('changed');
      observation = await driver.observe();
      const password = observation.targets!.find((target) => target.name === 'Password')!;
      await expect(driver.perform(commandSchema.parse({ action: 'fill', value: 'not-a-real-password', target: { ref: password.ref }, observation: observation.id }))).rejects.toThrow('takeover');
    } finally { adopted.mockRestore(); await driver.close(); }
  }, 30_000);

  it('shares one host while keeping tabs, popups, screenshots and closure conversation-specific', async () => {
    const host = new PlaywrightHost(driver.options);
    const a = new PlaywrightDriver(driver.options, host);
    const b = new PlaywrightDriver(driver.options, host);
    const adoptedA = vi.spyOn(a, 'adopt'); const adoptedB = vi.spyOn(b, 'adopt');
    try {
      await Promise.all([a.start(), b.start()]);
      expect(adoptedA.mock.calls[0]![0].context()).toBe(adoptedB.mock.calls[0]![0].context());
      await Promise.all([
        a.perform(commandSchema.parse({ action: 'navigate', url: `${url}/ambiguous` })),
        b.perform(commandSchema.parse({ action: 'navigate', url: `${url}/cookie` })),
      ]);
      let oa = await a.observe(); const ob = await b.observe();
      expect(oa.tabs).toHaveLength(1); expect(ob.tabs).toHaveLength(1);
      await expect(a.perform(commandSchema.parse({ action: 'tab', tabId: ob.tabs[0]!.id }))).rejects.toThrow('this conversation');
      await a.perform(commandSchema.parse({ action: 'click', observation: oa.id, target: { ref: oa.targets!.find((t) => t.name === 'New tab')!.ref } }));
      await vi.waitFor(async () => { oa = await a.observe(); expect(oa.tabs).toHaveLength(2); });
      expect((await b.observe()).tabs).toHaveLength(1);
      expect((await b.observe()).tree).not.toContain('Appointment confirmed');
      await a.close();
      expect((await b.observe()).tree).toContain('Login remembered');
      expect(await b.screenshot()).toBeInstanceOf(Buffer);
    } finally { await Promise.all([a.close(), b.close()]); await host.close(); }
  }, 30_000);

  it('resumes on the human-chosen page while another agent continues in its own tab', async () => {
    const host = new PlaywrightHost(driver.options);
    const drivers: PlaywrightDriver[] = [];
    const pages: import('playwright').Page[] = [];
    const manager = new BrowserManager(() => {
      const child = new PlaywrightDriver(driver.options, host);
      vi.spyOn(child, 'adopt').mockImplementation((page) => { pages.push(page); PlaywrightDriver.prototype.adopt.call(child, page); });
      drivers.push(child); return child;
    }, { closeHost: () => host.close() });
    const ctx = (agentId: string): ToolContext => hosted({ db: {} as never, ownerId: 'owner', agentId, conversationId: agentId, now: () => new Date(), timezone: 'UTC',
      ownerRequest: { id: agentId, text: 'Read the fixture and leave it open', expiresAt: Date.now() + 60_000 } });
    try {
      await manager.enable();
      await manager.execute(commandSchema.parse({ action: 'navigate', url }), ctx('a'));
      await manager.execute(commandSchema.parse({ action: 'navigate', url: `${url}/cookie` }), ctx('b'));
      const id = manager.status({ agentId: 'a', conversationId: 'a' }).session!.id;
      await manager.control('takeover', id);
      await pages[0]!.goto(`${url}/references`); // The owner's manual navigation.
      await expect(manager.execute(commandSchema.parse({ action: 'observe' }), ctx('a'))).rejects.toThrow('human control');
      await manager.execute(commandSchema.parse({ action: 'observe' }), ctx('b'));
      await manager.control('resume', id);
      const resumed = await manager.execute(commandSchema.parse({ action: 'observe' }), { ...ctx('a'), ownerRequest: { ...ctx('a').ownerRequest!, id: 'a-resumed' } }) as { observation: import('./types.js').Observation };
      expect(resumed.observation.title).not.toBe('Appointment fixture');
      expect(resumed.observation.tree).toContain('References fixture');
      const target = resumed.observation.targets!.find((item) => item.href?.endsWith('/receipt'))!;
      const follow = await manager.execute(commandSchema.parse({ action: 'click', observation: resumed.observation.id, target: { ref: target.ref } }), { ...ctx('a'), ownerRequest: { ...ctx('a').ownerRequest!, id: 'a-resumed' } }) as { observation: import('./types.js').Observation };
      expect(follow.observation.tree).toContain('FIXTURE-001');
      await manager.control('release', id);
      expect(manager.status().sessions).toHaveLength(1);
      expect(manager.status().session?.agentId).toBe('b');
    } finally { await manager.shutdown(); }
  }, 30_000);
});

/*
 * How long the remote hand actually takes, measured rather than guessed.
 *
 * The whole path, with nothing faked between the dashboard's socket and a real
 * Chromium: the take-over POST the owner presses, the hand socket and its
 * hello, the first painted frame, the steady stream, and an input's round trip
 * — each of them again with 100 ms of latency on the dashboard's socket, which
 * is what a phone on a tailnet adds.
 *
 * Opt in, because it launches a browser and takes tens of seconds:
 *
 *     BUDDI_HAND_BENCH=1 pnpm --filter @buddi/gateway exec vitest run src/web/hand-latency.integration.test.ts
 */
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ToolRegistry, guardedLookup, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { BrowserManager, PlaywrightDriver, PlaywrightHost, commandSchema } from '@buddi/tool-browser';
import { DEFAULT_POLICY } from '@buddi/tool-web';
import { startWebServer, type WebServer } from './server.js';

const enabled = process.env.BUDDI_HAND_BENCH === '1';
const TOKEN = 'fixture-hand-latency-token';

/** A page that paints for a while, then stops, and moves a box under the pointer. */
const PAGE = `<!doctype html><title>Hand fixture</title>
<style>html,body{margin:0;height:100%;background:#123} #box{position:absolute;width:80px;height:80px;background:#e33;border-radius:8px}
#spin{position:absolute;right:8px;top:8px;color:#fff;font:16px monospace}</style>
<canvas id=bg width=1280 height=800></canvas><div id=box></div><div id=spin></div>
<script>
const c = document.getElementById('bg').getContext('2d');
let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 6000; i++) { c.fillStyle = 'rgb(' + (rnd()*255|0) + ',' + (rnd()*255|0) + ',' + (rnd()*255|0) + ')';
  c.fillRect(rnd()*1280, rnd()*800, 6 + rnd()*30, 6 + rnd()*30); }
const box = document.getElementById('box'), spin = document.getElementById('spin');
const t0 = Date.now();
function tick() { spin.textContent = 'f' + (Date.now() - t0); if (Date.now() - t0 < 20000) requestAnimationFrame(tick); }
requestAnimationFrame(tick);
addEventListener('mousemove', (e) => { box.style.left = e.clientX + 'px'; box.style.top = e.clientY + 'px'; });
</script>`;

interface Row { label: string; value: string }

/**
 * The link itself: a TCP relay that paces bytes and adds latency.
 *
 * Modelled here rather than in the dashboard's message handler on purpose. The
 * relay's whole defence against a slow link is the socket's own backpressure —
 * `bufferedAmount`, and the moment `send` says the bytes have gone — and a
 * delay applied after the bytes have already arrived would leave every one of
 * those signals saying the link is fine. This is the pipe, so they do not.
 */
function slowLink(port: number, delayMs: number, kbps: number): Promise<{ port: number; close: () => Promise<void> }> {
  const pace = (from: Socket, to: Socket): void => {
    let free = 0;
    from.on('data', (chunk: Buffer) => {
      const now = Date.now();
      const carry = kbps > 0 ? (chunk.length / (kbps * 1024)) * 1000 : 0;
      free = Math.max(free, now) + carry;
      const wait = Math.max(0, free - now);
      from.pause();
      // Read again once the pipe has carried this chunk, but hand it over one
      // latency later: a pipe is both a width and a length.
      setTimeout(() => from.resume(), wait);
      setTimeout(() => { if (!to.destroyed) to.write(chunk); }, wait + delayMs);
    });
    from.on('close', () => { setTimeout(() => to.destroy(), delayMs + 50); });
    from.on('error', () => to.destroy());
  };
  const server = createTcpServer((client) => {
    const upstream = tcpConnect(port, '127.0.0.1');
    pace(client, upstream);
    pace(upstream, client);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((done) => (server as TcpServer).close(() => done())),
  })));
}

/** A dashboard tab, on whatever link it was given. */
function dashboard(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers });
  socket.binaryType = 'nodebuffer';
  const text: Array<Record<string, unknown>> = [];
  /** Every picture the dashboard could draw, with the moment it could draw it. */
  const pictures: Array<{ at: number; bytes: number }> = [];
  let pending: Record<string, unknown> | undefined;
  const handle = (data: Buffer, isBinary: boolean): void => {
    if (isBinary) {
      // One binary message may be a whole frame (header + bytes) or the second
      // half of a metadata/bytes pair; both count as one drawable picture.
      pictures.push({ at: performance.now(), bytes: data.length });
      pending = undefined;
      return;
    }
    const message = JSON.parse(String(data)) as Record<string, unknown>;
    if (message.type === 'frame') { pending = message; return; }
    text.push(message);
  };
  socket.on('message', (data, isBinary) => handle(data as Buffer, isBinary));
  const open = new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  const send = (frame: unknown): void => { try { socket.send(JSON.stringify(frame)); } catch { /* closed */ } };
  const next = async (type: string, timeout = 20_000): Promise<Record<string, unknown>> => {
    const until = Date.now() + timeout;
    for (;;) {
      const found = text.find((f) => f.type === type);
      if (found) return found;
      if (Date.now() > until) throw new Error(`no ${type} arrived; saw ${JSON.stringify(text)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const waitPictures = async (count: number, timeout = 20_000): Promise<void> => {
    const until = Date.now() + timeout;
    while (pictures.length < count) {
      if (Date.now() > until) throw new Error(`only ${pictures.length} of ${count} pictures arrived`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { socket, text, pictures, open, send, next, waitPictures, pending: () => pending };
}

const ctx = (): CoreToolContext => ({ db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC',
  agentId: 'concierge', conversationId: 'c1', sessionTools: ['browser.act'],
  ownerRequest: { id: 'request-1', text: 'Sign in for me', expiresAt: Date.now() + 10 * 60_000 } });

describe.skipIf(!enabled)('remote hand latency, end to end', () => {
  let fixture: Server;
  let dir: string;
  let fixtureUrl: string;
  let host: PlaywrightHost;
  let manager: BrowserManager;
  let app: WebServer;
  let csrf = '';
  let cookie = '';
  let origin = '';
  const rows: Row[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-hand-latency-'));
    fixture = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // A page that never finishes loading: what an agent is often sitting on
      // when the owner gives up and presses Take over.
      if ((req.url ?? '/').startsWith('/slow')) { res.write('<!doctype html><title>Slow</title><h1>Loading</h1>'); return; }
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const port = (fixture.address() as AddressInfo).port;
    fixtureUrl = `http://127.0.0.1:${port}/`;
    const policy = { ...DEFAULT_POLICY, ports: [port], blockedHostname: () => false,
      blocked: (address: string) => (address === '127.0.0.1' ? null : 'Fixture only') };
    host = new PlaywrightHost({ profileDir: path.join(dir, 'profile'), headless: true, policy, lookup: (p) => guardedLookup(undefined, p) });
    manager = new BrowserManager(() => new PlaywrightDriver(host.options, host), { closeHost: () => host.close() });
    await manager.enable();

    app = await startWebServer({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
      registry: new ToolRegistry(), catalog: {} as AgentCatalog, ctx: { ownerId: 'owner' } as CoreToolContext,
      timezone: 'UTC', now: () => new Date(), config: { enabled: true, host: '127.0.0.1', port: 0 },
      openAccess: true, token: TOKEN, browser: manager, log: () => {} });
    origin = `http://127.0.0.1:${app.port}`;
    const res = await fetch(`${origin}/api/session`, { redirect: 'manual' });
    const pairs = res.headers.getSetCookie().map((line) => line.split(';')[0]!);
    csrf = pairs.find((p) => p.startsWith('buddi_csrf='))?.slice('buddi_csrf='.length) ?? '';
    cookie = pairs.join('; ');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await manager?.shutdown();
    await host?.close();
    await new Promise<void>((resolve) => fixture?.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
    if (rows.length) {
      const width = Math.max(...rows.map((r) => r.label.length));
      console.log(`\n| ${'measurement'.padEnd(width)} | value |\n| ${'-'.repeat(width)} | ----- |`);
      for (const row of rows) console.log(`| ${row.label.padEnd(width)} | ${row.value} |`);
      console.log('');
    }
  }, 120_000);

  it('measures a take-over pressed while the agent is mid-action', async () => {
    await manager.execute(commandSchema.parse({ action: 'observe' }), ctx()).catch(() => {});
    await manager.execute(commandSchema.parse({ action: 'navigate', url: fixtureUrl }), ctx());
    await manager.execute(commandSchema.parse({ action: 'observe' }), ctx());
    const sessionId = manager.status().session!.id;

    // The agent is on a page that will not finish loading.
    const working = manager.execute(commandSchema.parse({ action: 'navigate', url: `${fixtureUrl}slow` }), ctx()).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(manager.status().busy).toBe(true);

    // A plain read first, so the take-over's number is not really the cost of
    // talking to this process at all while a browser is loading.
    const idleAt = performance.now();
    await (await fetch(`${origin}/api/browser`, { headers: { Cookie: cookie, Origin: origin } })).json();
    rows.push({ label: '[busy] GET /api/browser (the harness floor)', value: `${(performance.now() - idleAt).toFixed(0)} ms` });

    const t0 = performance.now();
    const taken = await fetch(`${origin}/api/browser/takeover`, { method: 'POST',
      headers: { Cookie: cookie, 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }) });
    const body = await taken.json() as { hand?: boolean; handMessage?: string; page?: { url?: string } };
    rows.push({ label: '[busy] POST /api/browser/takeover', value: `${(performance.now() - t0).toFixed(0)} ms` });
    rows.push({ label: '[busy] a hand is offered', value: body.hand ? 'yes' : `no — ${body.handMessage ?? ''}` });
    // The whole point of the button: the page the agent was on is still there
    // and drivable, not closed to end the action.
    expect(body.handMessage ?? '', 'a hand must be offered during an action').toBe('');
    expect(body.hand).toBe(true);

    const t1 = performance.now();
    const hand = dashboard(`ws://127.0.0.1:${app.port}/api/browser/hand`, { Cookie: cookie, Origin: origin });
    await hand.open;
    hand.send({ type: 'hello', csrf, sessionId });
    const outcome = await Promise.race([
      hand.waitPictures(1, 10_000).then(() => `${(hand.pictures[0]!.at - t1).toFixed(0)} ms`),
      hand.next('refused', 10_000).then((f) => `refused: ${String(f.error)}`),
      hand.next('ended', 10_000).then((f) => `ended: ${String(f.error)}`),
    ]).catch((error: Error) => `nothing at all: ${error.message}`);
    rows.push({ label: '[busy] hand socket -> first frame drawn', value: outcome });
    expect(outcome).toMatch(/^\d+ ms$/);
    expect(hand.pictures[0]!.at - t1).toBeLessThan(2_000);

    // And it is the page the agent was on, not a fresh tab.
    const status = await (await fetch(`${origin}/api/browser`, { headers: { Cookie: cookie, Origin: origin } })).json() as { state?: string; page?: { url?: string } };
    expect(status.state).toBe('paused');
    hand.send({ type: 'bye' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    hand.socket.close();
    await working;
    await fetch(`${origin}/api/browser/resume`, { method: 'POST',
      headers: { Cookie: cookie, 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }) });
    // The same tab, on the same page: the take-over interrupted the action,
    // not the session.
    const after = await manager.execute(commandSchema.parse({ action: 'observe' }), ctx()) as { observation: { url: string } };
    rows.push({ label: '[busy] the page the agent was on', value: after.observation.url });
    expect(after.observation.url).toBe(`${fixtureUrl}slow`);
  }, 180_000);

  const links: Array<{ tag: string; delayMs: number; kbps: number }> = [
    { tag: 'local', delayMs: 0, kbps: 0 },
    { tag: '100ms', delayMs: 100, kbps: 0 },
    // A phone on a tailnet: a real one-way hop and a real downlink.
    { tag: 'phone', delayMs: 100, kbps: 1500 },
  ];
  for (const { tag, delayMs, kbps } of links) {
    it(`measures the path over the ${tag} link`, async () => {
      // An agent is on the page, exactly as it is when the owner takes over.
      await manager.execute(commandSchema.parse({ action: 'observe' }), ctx()).catch(() => {});
      await manager.execute(commandSchema.parse({ action: 'navigate', url: fixtureUrl }), ctx());
      await manager.execute(commandSchema.parse({ action: 'observe' }), ctx());
      const sessionId = manager.status().session!.id;

      // 1. The take-over POST, as the dashboard's button sends it.
      const t0 = performance.now();
      const taken = await fetch(`${origin}/api/browser/takeover`, { method: 'POST',
        headers: { Cookie: cookie, 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }) });
      const body = await taken.json() as { hand?: boolean; handMessage?: string };
      const postMs = performance.now() - t0;
      expect(body.hand, body.handMessage ?? 'no hand offered').toBe(true);
      rows.push({ label: `[${tag}] POST /api/browser/takeover`, value: `${postMs.toFixed(0)} ms` });

      // 2. The socket, its hello, and the first frame the owner can look at.
      const t1 = performance.now();
      const link = await slowLink(app.port, delayMs, kbps);
      const hand = dashboard(`ws://127.0.0.1:${link.port}/api/browser/hand`, { Cookie: cookie, Origin: origin });
      await hand.open;
      const openMs = performance.now() - t1;
      hand.send({ type: 'hello', csrf, sessionId });
      await hand.next('driving');
      const drivingMs = performance.now() - t1;
      await hand.waitPictures(1);
      const firstFrameMs = hand.pictures[0]!.at - t1;
      rows.push({ label: `[${tag}] socket open`, value: `${openMs.toFixed(0)} ms` });
      rows.push({ label: `[${tag}] hello -> driving`, value: `${drivingMs.toFixed(0)} ms` });
      rows.push({ label: `[${tag}] take over -> first frame drawn`, value: `${(postMs + firstFrameMs).toFixed(0)} ms` });

      // 3. The steady stream, while the fixture is still painting.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const stream = hand.pictures.slice(0, -1);
      const gaps: number[] = [];
      for (let i = 1; i < stream.length; i++) gaps.push(stream[i]!.at - stream[i - 1]!.at);
      const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
      rows.push({ label: `[${tag}] steady frame interval`, value: `${mean(gaps).toFixed(0)} ms (${gaps.length ? (1000 / mean(gaps)).toFixed(1) : '0'} fps)` });
      rows.push({ label: `[${tag}] frame size`, value: `${(mean(stream.map((p) => p.bytes)) / 1024).toFixed(0)} KB` });

      // 4. How far behind the picture is: the fixture paints for twenty
      // seconds, which is a short take-over, and then stops. Everything still
      // arriving after that is backlog, and the last of it is how stale the
      // owner's view had become by the time they stopped.
      await new Promise((resolve) => setTimeout(resolve, 20_500 - (performance.now() - t1)));
      const stoppedPaintingAt = performance.now();
      let quiet = -1;
      for (let i = 0; i < 600; i++) {
        if (hand.pictures.length === quiet) break;
        quiet = hand.pictures.length;
        await new Promise((r) => setTimeout(r, 250));
      }
      rows.push({ label: `[${tag}] picture backlog after painting stops`, value: `${(hand.pictures.at(-1)!.at - stoppedPaintingAt).toFixed(0)} ms` });
      const trips: number[] = [];
      for (let i = 0; i < 5; i++) {
        const before = hand.pictures.length;
        const sent = performance.now();
        hand.send({ type: 'input', input: { kind: 'mouse', type: 'mouseMoved', x: 200 + i * 90, y: 200 + i * 60, button: 'none', clickCount: 0, modifiers: 0 } });
        await hand.waitPictures(before + 1, 10_000);
        trips.push(hand.pictures[before]!.at - sent);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      trips.sort((a, b) => a - b);
      rows.push({ label: `[${tag}] input -> frame that shows it`, value: `${trips[Math.floor(trips.length / 2)]!.toFixed(0)} ms (median of ${trips.length})` });

      // 5. A burst of moves, as a finger dragging across the picture sends them.
      const burstStart = performance.now();
      const burstBefore = hand.pictures.length;
      for (let i = 0; i < 60; i++) hand.send({ type: 'input', input: { kind: 'mouse', type: 'mouseMoved', x: 100 + i * 8, y: 400, button: 'none', clickCount: 0, modifiers: 0 } });
      await hand.waitPictures(burstBefore + 1, 20_000);
      let settled = hand.pictures.length;
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 100)); if (hand.pictures.length === settled) break; settled = hand.pictures.length; }
      rows.push({ label: `[${tag}] 60-move drag settles`, value: `${(performance.now() - burstStart).toFixed(0)} ms` });

      hand.send({ type: 'bye' });
      await new Promise((resolve) => setTimeout(resolve, delayMs + 200));
      hand.socket.close();
      await link.close();
      await fetch(`${origin}/api/browser/resume`, { method: 'POST',
        headers: { Cookie: cookie, 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }) });
    }, 180_000);
  }
});

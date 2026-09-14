/**
 * `POST /api/agents/:id/engine`, over the wire.
 *
 * The engine controls edit a file rather than a row, so this suite needs no
 * database — which is the point of testing them here: the security properties
 * (session, CSRF, Origin) are the server's, and they must hold for a write that
 * happens to touch the filesystem exactly as they do for one that touches
 * postgres.
 *
 * What is asserted:
 *   - no session → 401, empty;
 *   - a write with no CSRF header, or from another Origin → 403, empty;
 *   - a good write edits the agent file, leaves the body alone, and answers
 *     with the updated agent and the restart note;
 *   - a cross-provider model is refused with the catalogue's own sentence.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolRegistry, loadGatewayCatalog } from '../agents/catalog.js';
import { mintTicket } from './token.js';
import { createWebApp } from './server.js';

const TOKEN = 'a-test-dashboard-token-long-enough';

const AGENT = [
  '---',
  'id: demo',
  'handle: demo',
  'name: Demo',
  'description: A demo agent',
  '# the engine',
  'provider: anthropic',
  'model: claude-sonnet-5',
  'tools: []',
  'maxTurns: 8',
  'default: true',
  '---',
  '',
  'You are a demo agent.',
  '',
  '---',
  '',
  'That rule is part of the persona.',
  '',
].join('\n');

describe('the engine endpoint', () => {
  let dir: string;
  let file: string;
  let catalog: AgentCatalog;
  let server: ReturnType<typeof createWebApp>;
  let base: string;

  const env = { ANTHROPIC_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'buddi-web-agents-'));
    mkdirSync(path.join(dir, 'agents', 'demo'), { recursive: true });
    file = path.join(dir, 'agents', 'demo', 'agent.md');
    writeFileSync(file, AGENT);
    catalog = loadGatewayCatalog({
      dir: path.join(dir, 'agents'),
      env,
      registry: createToolRegistry({}),
    });
    server = createWebApp({
      // The engine route touches neither the pool nor the registry.
      pool: {} as Pool,
      registry: new ToolRegistry(),
      catalog,
      ctx: { ownerId: 'owner' } as unknown as ToolContext,
      timezone: 'Europe/Paris',
      now: () => new Date('2026-09-14T09:00:00Z'),
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      env,
      log: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  /** Exchange a ticket for the session + csrf cookie pair. */
  const signIn = async (): Promise<{ cookie: string; csrf: string }> => {
    const res = await fetch(`${base}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const jar = new Map<string, string>();
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, value] = (pair as string).split('=');
      jar.set(name as string, value as string);
    }
    return {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      csrf: jar.get('buddi_csrf') as string,
    };
  };

  const post = (
    body: unknown,
    headers: Record<string, string>,
    id = 'demo',
  ): Promise<Response> =>
    fetch(`${base}/api/agents/${id}/engine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
    });

  it('refuses a write with no session at all', async () => {
    const res = await post({ model: 'claude-opus-5' }, { origin: base });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(readFileSync(file, 'utf8')).toBe(AGENT);
  });

  it('refuses a write without the CSRF header', async () => {
    const { cookie } = await signIn();
    const res = await post({ model: 'claude-opus-5' }, { cookie, origin: base });
    expect(res.status).toBe(403);
    expect(readFileSync(file, 'utf8')).toBe(AGENT);
  });

  it('refuses a write from another origin', async () => {
    const { cookie, csrf } = await signIn();
    const res = await post(
      { model: 'claude-opus-5' },
      { cookie, 'x-buddi-csrf': csrf, origin: 'http://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(readFileSync(file, 'utf8')).toBe(AGENT);
  });

  it('edits the agent file and answers with the updated agent', async () => {
    const { cookie, csrf } = await signIn();
    const res = await post(
      { model: 'claude-opus-5', maxTurns: 4 },
      { cookie, 'x-buddi-csrf': csrf, origin: base },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: { model: string; maxTurns: number; available: boolean; restartRequired: boolean };
      changed: string[];
      note: string;
    };
    expect(body.changed).toEqual(['model', 'maxTurns']);
    expect(body.agent.model).toBe('claude-opus-5');
    expect(body.agent.maxTurns).toBe(4);
    expect(body.agent.available).toBe(true);
    // The process still holds the catalog it loaded, and says so.
    expect(body.agent.restartRequired).toBe(true);
    expect(body.note).toContain('buddi service restart');

    const after = readFileSync(file, 'utf8');
    expect(after).toContain('model: claude-opus-5');
    expect(after).toContain('# the engine');
    expect(after).toContain('That rule is part of the persona.');
  });

  it('refuses a cross-provider model with the catalogue’s own sentence', async () => {
    const { cookie, csrf } = await signIn();
    const res = await post({ model: 'gpt-5' }, { cookie, 'x-buddi-csrf': csrf, origin: base });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('is a openai model');
    expect(body.error).toContain('never migrated for you');
    expect(readFileSync(file, 'utf8')).toBe(AGENT);
  });

  it('refuses a body that asks for nothing, and an unknown agent', async () => {
    const { cookie, csrf } = await signIn();
    const headers = { cookie, 'x-buddi-csrf': csrf, origin: base };
    expect((await post({}, headers)).status).toBe(400);
    expect((await post({ provider: 'azure' }, headers)).status).toBe(400);
    expect((await post({ model: 'claude-opus-5' }, headers, 'nobody')).status).toBe(404);
  });

  it('lists engines and the model catalogue alongside the agents', async () => {
    const { cookie } = await signIn();
    const res = await fetch(`${base}/api/agents`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: unknown[];
      engines: Array<{ handle: string; provider: string; available: boolean }>;
      providers: Array<{ kind: string; usable: boolean }>;
    };
    expect(body.agents).toHaveLength(1);
    expect(body.engines[0]).toMatchObject({ handle: 'demo', provider: 'anthropic', available: true });
    expect(body.providers.map((p) => p.kind)).toEqual(['anthropic', 'openai']);
    expect(body.providers.find((p) => p.kind === 'openai')?.usable).toBe(false);
  });
});

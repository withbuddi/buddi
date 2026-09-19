import { afterEach, expect, it, vi } from 'vitest';
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { startWebServer, type WebServer } from './server.js';
import type { ProviderSettings } from '../providers.js';
const servers: WebServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.close())); });
it('protects provider reads and credential writes with existing owner session, origin and CSRF checks', async () => {
  const manager = { view: vi.fn(() => ({ providers: [] })), credential: vi.fn(async () => ({ saved: true })), configure: vi.fn(), test: vi.fn() };
  const app = await startWebServer({ pool: {} as never, registry: new ToolRegistry(), catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'fixture', providerSettings: manager as unknown as ProviderSettings });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  expect((await fetch(`${origin}/api/providers`, { headers: { 'X-Forwarded-For': '100.64.0.2' } })).status).toBe(401);
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map(c => c.split(';')[0]!);
  const csrf = cookies.find(c => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  const headers = { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' };
  const url = `${origin}/api/providers/credentials/OPENAI_API_KEY/save`;
  const body = JSON.stringify({ value: 'fixture-secret' });
  for (const changed of [{ ...headers, 'X-Buddi-CSRF': '' }, { ...headers, Origin: 'https://untrusted.example' }]) {
    expect((await fetch(url, { method: 'POST', headers: changed, body })).status).toBe(403);
  }
  expect(manager.credential).not.toHaveBeenCalled();
  const saved = await fetch(url, { method: 'POST', headers, body });
  expect(saved.status).toBe(200); expect(saved.headers.get('cache-control')).toBe('no-store');
  expect(await saved.text()).not.toContain('fixture-secret');
  expect(manager.credential).toHaveBeenCalledWith('OPENAI_API_KEY', 'save', { value: 'fixture-secret' });
});

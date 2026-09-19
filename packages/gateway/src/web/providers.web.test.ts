import { afterEach, expect, it, vi } from 'vitest';
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { startWebServer, type WebServer } from './server.js';
import type { ProviderSettings } from '../providers.js';
import type { ProviderAccounts } from '../provider-accounts.js';
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

it('protects named account creation and assignments and retires global credential writes', async () => {
  const manager = { anthropicAction: vi.fn(async () => ({ completed: true })), models: vi.fn(async () => ({ models: [], truncated: false })), view: vi.fn(() => ({ accounts: [], bindings: [] })), refresh: vi.fn(), save: vi.fn(async () => ({ id: 'one' })), assign: vi.fn(async () => ({ changed: ['account'], note: 'Saved' })), test: vi.fn(), remove: vi.fn(), codexAction: vi.fn(async () => ({ state: 'pending' })) };
  const app = await startWebServer({ pool: {} as never, registry: new ToolRegistry(), catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'fixture', providerAccounts: manager as unknown as ProviderAccounts });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  expect((await fetch(`${origin}/api/provider-accounts`, { headers: { 'X-Forwarded-For': '100.64.0.2' } })).status).toBe(401);
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map(c => c.split(';')[0]!);
  const csrf = cookies.find(c => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  const headers = { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' };
  for (const route of ['/api/provider-accounts/one/anthropic/login', '/api/provider-accounts/one/anthropic/complete-login', '/api/provider-accounts/one/anthropic/cancel-login', '/api/provider-accounts/one/anthropic/logout', '/api/provider-accounts/one/models', '/api/provider-accounts/save', '/api/provider-accounts/one/remove', '/api/provider-accounts/one/test', '/api/agents/ledger/account', '/api/provider-accounts/one/login', '/api/provider-accounts/one/cancel-login', '/api/provider-accounts/one/logout']) {
    expect((await fetch(`${origin}${route}`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}${route}`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403);
  }
  expect(manager.save).not.toHaveBeenCalled(); expect(manager.assign).not.toHaveBeenCalled();
  expect(manager.codexAction).not.toHaveBeenCalled();
  expect(manager.models).not.toHaveBeenCalled();
  expect(manager.anthropicAction).not.toHaveBeenCalled();
  const completeBody = { revision: 2, attemptId: 'attempt', code: 'fixture-secret#state' };
  const completed = await fetch(`${origin}/api/provider-accounts/one/anthropic/complete-login`, { method: 'POST', headers, body: JSON.stringify(completeBody) });
  expect(completed.status).toBe(200); expect(completed.headers.get('cache-control')).toBe('no-store');
  expect(await completed.text()).not.toContain('fixture-secret');
  expect(manager.anthropicAction).toHaveBeenCalledWith('one', 'complete-login', completeBody, expect.any(String));
  await fetch(`${origin}/api/provider-accounts`, { headers });
  expect(manager.view).toHaveBeenCalledWith(expect.any(String));
  const models = await fetch(`${origin}/api/provider-accounts/one/models`, { method: 'POST', headers, body: JSON.stringify({ refresh: true }) });
  expect(models.status).toBe(200); expect(models.headers.get('cache-control')).toBe('no-store');
  expect(manager.models).toHaveBeenCalledWith('one', true);
  const login = await fetch(`${origin}/api/provider-accounts/one/login`, { method: 'POST', headers, body: JSON.stringify({ revision: 2 }) });
  expect(login.status).toBe(200);
  expect(login.headers.get('cache-control')).toBe('no-store');
  expect(manager.codexAction).toHaveBeenCalledWith('one', 'login', 2);
  const saved = await fetch(`${origin}/api/provider-accounts/save`, { method: 'POST', headers, body: JSON.stringify({ secret: 'fixture-secret' }) });
  expect(saved.status).toBe(200); expect(saved.headers.get('cache-control')).toBe('no-store');
  expect(await saved.text()).not.toContain('fixture-secret');
  const assigned = await fetch(`${origin}/api/agents/ledger/account`, { method: 'POST', headers, body: JSON.stringify({ accountId: 'one', model: 'gpt-5' }) });
  expect(assigned.status).toBe(200);
  expect(manager.assign).toHaveBeenCalledWith('ledger', { accountId: 'one', model: 'gpt-5' });
  expect((await fetch(`${origin}/api/providers/credentials/OPENAI_API_KEY/save`, { method: 'POST', headers, body: '{}' })).status).toBe(410);
});

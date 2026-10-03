import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import type { PluginManifest } from './tools.js';
import type { RouteProvider } from './routes.js';
import { HOST_API_VERSION } from './plugin/version.js';

const route: RouteProvider = {
  kind: 'apps', label: 'your apps', exclusive: true,
  health: () => ({ ok: true }),
  look: async () => ({ id: 'p', url: 'app://x', title: 'X', tree: '', tabs: [], capturedAt: '' }),
  do: async () => {},
};
const manifest = (routes: unknown[]): PluginManifest => ({ name: 'computer', version: '0.1.0', schema: 'computer', migrationsDir: '', tools: [], routes: routes as RouteProvider[] });

describe('route providers (host API 1.29)', () => {
  it('a plugin may provide the apps route; the registry hands it out with its plugin', async () => {
    expect(HOST_API_VERSION).toBe('1.29');
    const registry = new ToolRegistry();
    registry.register(manifest([route]));
    const [provided] = registry.routeProviders();
    expect(provided).toMatchObject({ kind: 'apps', label: 'your apps', exclusive: true, plugin: 'computer' });
    await expect(provided!.look('s')).resolves.toMatchObject({ title: 'X' });
    registry.unregister('computer');
    expect(registry.routeProviders()).toEqual([]);
  });
  it('refuses a route of another kind or without its handlers, naming the plugin', () => {
    expect(() => new ToolRegistry().register(manifest([{ ...route, kind: 'own' }]))).toThrow("plugin computer: a route's kind must be one of apps");
    expect(() => new ToolRegistry().register(manifest([{ ...route, look: undefined }]))).toThrow('plugin computer: a route needs a look handler');
  });
  it('waitsForOwner may decide per result, and ownBudget is read back', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'page', version: '1', schema: 'page', migrationsDir: '', tools: [
      { name: 'page.act', description: 'act', tier: 'auto', ownBudget: true, waitsForOwner: (output: { needsOwner?: unknown }) => output?.needsOwner !== undefined, input: (undefined as never), inputSchema: { type: 'object' }, execute: async () => ({}) } as never,
    ] });
    expect(registry.waitsForOwner('page.act', { needsOwner: {} })).toBe(true);
    expect(registry.waitsForOwner('page.act', { completed: true })).toBe(false);
    expect(registry.hasOwnBudget('page.act')).toBe(true);
  });
});

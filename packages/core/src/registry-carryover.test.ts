import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import type { CoreToolContext, PluginManifest, ToolContext } from './tools.js';

describe('a plugin\'s carry-over contributor', () => {
  it('is routed through the registry with the plugin\'s own host and the agent in context', async () => {
    let seen: ToolContext | undefined;
    const manifest: PluginManifest = {
      name: 'notes',
      version: '1.0.0',
      schema: 'notes',
      migrationsDir: '',
      tools: [],
      carryOver: {
        async lines(request, ctx) {
          seen = ctx;
          return [`agent ${request.agentId}, ${request.reason}`];
        },
      },
    };
    const registry = new ToolRegistry();
    registry.register(manifest);
    const contributors = registry.carryOvers();
    expect(contributors.map((c) => c.plugin)).toEqual(['notes']);
    const ctx = { db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC', agentId: 'dev' } as CoreToolContext;
    const lines = await contributors[0]!.lines({ agentId: 'dev', conversationId: 'c1', reason: 'idle' }, ctx);
    expect(lines).toEqual(['agent dev, idle']);
    expect(seen?.agentId).toBe('dev');
    expect(seen?.buddi?.version).toBeDefined();
  });

  it('is absent for a plugin without one', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'plain', version: '1.0.0', schema: 'plain', migrationsDir: '', tools: [] });
    expect(registry.carryOvers()).toEqual([]);
  });
});

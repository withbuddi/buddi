import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import type { PluginManifest, Tier, ToolContext } from './tools.js';

const ctx: ToolContext = {
  db: {} as ToolContext['db'],
  ownerId: 'owner-1',
  now: () => new Date('2026-01-01T00:00:00Z'),
  timezone: 'UTC',
};

function manifest(tier: Tier, execute = async (i: { n: number }) => i.n * 2): PluginManifest {
  return {
    name: 'demo',
    version: '0.0.1',
    schema: 'demo',
    migrationsDir: '/tmp/demo-migrations',
    tools: [
      {
        name: 'demo.double',
        description: 'Doubles a number.',
        tier,
        input: z.object({ n: z.number().int() }),
        execute: execute as never,
      },
    ],
  };
}

describe('ToolRegistry', () => {
  it('lists tool specs with a JSON schema for the model', () => {
    const r = new ToolRegistry();
    r.register(manifest('auto'));
    const [spec] = r.list();
    expect(spec?.name).toBe('demo.double');
    expect(spec?.tier).toBe('auto');
    expect(spec?.inputSchema).toMatchObject({
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    });
  });

  it('rejects duplicate plugins and colliding tool names', () => {
    const r = new ToolRegistry();
    r.register(manifest('auto'));
    expect(() => r.register(manifest('auto'))).toThrow(/already registered/);
    expect(() => r.register({ ...manifest('auto'), name: 'other' })).toThrow(/collision/);
  });

  it('executes an auto-tier tool', async () => {
    const r = new ToolRegistry();
    r.register(manifest('auto'));
    await expect(r.invoke('demo.double', { n: 21 }, ctx)).resolves.toEqual({
      ok: true,
      output: 42,
    });
  });

  it('refuses an unknown tool', async () => {
    const r = new ToolRegistry();
    r.register(manifest('auto'));
    const res = await r.invoke('demo.nope', {}, ctx);
    expect(res).toMatchObject({ ok: false, reason: 'unknown-tool' });
  });

  it('refuses invalid arguments before executing', async () => {
    const execute = vi.fn();
    const r = new ToolRegistry();
    r.register(manifest('auto', execute as never));
    const res = await r.invoke('demo.double', { n: 'twenty' }, ctx);
    expect(res).toMatchObject({ ok: false, reason: 'invalid-args' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['draft', 'gated', 'session'] as Tier[])(
    'refuses tier %s (approval machinery not built)',
    async (tier) => {
      const execute = vi.fn();
      const r = new ToolRegistry();
      r.register(manifest(tier, execute as never));
      const res = await r.invoke('demo.double', { n: 1 }, ctx);
      expect(res).toMatchObject({ ok: false, reason: 'tier-not-executable' });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('reports a throwing tool as tool-error', async () => {
    const r = new ToolRegistry();
    r.register(
      manifest('auto', async () => {
        throw new Error('upstream exploded');
      }),
    );
    const res = await r.invoke('demo.double', { n: 1 }, ctx);
    expect(res).toMatchObject({ ok: false, reason: 'tool-error', message: 'upstream exploded' });
  });
});

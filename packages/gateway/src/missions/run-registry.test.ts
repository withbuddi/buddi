/**
 * A mission run's registry, halted once the run needed the owner's Chrome:
 * every later call is answered unrun — an auto tool does not execute, and a
 * gated one records no approval of its own to outrank the Chrome ask. No
 * database: a halted call never reaches one.
 */
import type { CoreToolContext, PluginManifest } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CHROME_HALT, RunRegistry } from './execute.js';

describe('a halted run registry', () => {
  it('dispatches nothing after the halt, gated calls included', async () => {
    const ran: string[] = [];
    const manifest = {
      name: 'probe',
      version: '1.0.0',
      schema: 'probe',
      migrationsDir: '',
      tools: [
        { name: 'probe.read', description: 'Reads.', tier: 'auto', input: z.object({}).strict(), execute: async () => { ran.push('read'); return 'read'; } },
        { name: 'probe.send', description: 'Sends.', tier: 'gated', input: z.object({}).strict(), execute: async () => { ran.push('send'); return 'sent'; } },
      ],
    } as unknown as PluginManifest;
    const registry = new RunRegistry();
    registry.register(manifest);
    const ctx = { db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as CoreToolContext;
    expect(await registry.invoke('probe.read', {}, ctx)).toEqual({ ok: true, output: 'read' });

    registry.halt(CHROME_HALT);
    registry.halt('a second reason never replaces the first');
    expect(registry.halted).toBe(CHROME_HALT);
    for (const name of ['probe.read', 'probe.send']) {
      const outcome = await registry.invoke(name, {}, ctx);
      expect(outcome).toEqual({ ok: false, reason: 'tool-error', message: `not-executed: ${CHROME_HALT}` });
    }
    expect(ran).toEqual(['read']);
  });
});

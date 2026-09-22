import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createWiring } from './bootstrap.js';

it('rotates adapters for new runs and refuses removed credentials without invalidating old adapters', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-provider-cache-'));
  const env: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture', BUDDI_AGENTS_DIR: dir, ANTHROPIC_API_KEY: 'old-fixture' };
  const wiring = createWiring(env);
  try {
    const first = wiring.providerFor(wiring.catalog.defaultAgent());
    env.ANTHROPIC_API_KEY = 'new-fixture'; wiring.reloadProviders();
    const second = wiring.providerFor(wiring.catalog.defaultAgent());
    expect(second).not.toBe(first);
    expect(wiring.providerFor(wiring.catalog.defaultAgent())).toBe(second);
    delete env.ANTHROPIC_API_KEY; wiring.reloadProviders();
    expect(() => wiring.providerFor(wiring.catalog.defaultAgent())).toThrow('cannot run');
    expect(first.complete).toBeTypeOf('function');
  } finally { await wiring.pool.end(); await rm(dir, { recursive: true, force: true }); }
});

it('can boot the management UI without a default provider credential', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-provider-setup-'));
  const wiring = createWiring({ DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture', BUDDI_AGENTS_DIR: dir }, { allowMissingDefault: true });
  try { expect(wiring.catalog.defaultAgent().available).toBe(false); }
  finally { await wiring.pool.end(); await rm(dir, { recursive: true, force: true }); }
});

/**
 * `ToolContext.previewPort` is the number a plugin with `previews` builds its
 * own URLs from — a `tailscale serve` target, a line in a result. It is read
 * from the environment the preview listener publishes into, so it is a getter
 * rather than a value: the context object is built long before anything binds.
 */
it('carries the preview port the gateway published, and nothing when there is none', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-preview-port-'));
  const previous = process.env.BUDDI_PREVIEW_PORT;
  const wiring = createWiring({ DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture', BUDDI_AGENTS_DIR: dir }, { allowMissingDefault: true });
  try {
    delete process.env.BUDDI_PREVIEW_PORT;
    expect(wiring.ctx.previewPort).toBeUndefined();
    process.env.BUDDI_PREVIEW_PORT = '4318';
    expect(wiring.ctx.previewPort).toBe(4318);
    // Nonsense in the environment is no port at all, never a bad one.
    process.env.BUDDI_PREVIEW_PORT = 'soon';
    expect(wiring.ctx.previewPort).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.BUDDI_PREVIEW_PORT;
    else process.env.BUDDI_PREVIEW_PORT = previous;
    await wiring.pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});

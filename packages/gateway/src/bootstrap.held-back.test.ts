/**
 * One uninstalled plugin never stops the gateway.
 *
 * An agent granting `finance.*` on an installation without the finance plugin
 * used to throw out of `loadAgentCatalog`, which meant no catalog, which meant
 * `createWiring` threw and nothing started — not the dashboard the owner would
 * have installed the plugin from, and not `buddi doctor` either. docs/install.md
 * §7 says a plugin that fails to load never stops the gateway; this is the same
 * promise for a plugin that was never installed at all.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createWiring } from './bootstrap.js';

const agentMd = (id: string, handle: string, tools: string, extra = ''): string =>
  `---\nid: ${id}\nhandle: ${handle}\nname: ${handle}\ndescription: A test agent.\ntools: [${tools}]\n${extra}---\n\nYou are a test agent.\n`;

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
});

async function agentsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-held-back-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  for (const [id, text] of Object.entries(files)) {
    await mkdir(path.join(dir, id), { recursive: true });
    await writeFile(path.join(dir, id, 'agent.md'), text);
  }
  return dir;
}

it('builds the whole wiring with an agent granting a plugin that is not installed', async () => {
  const dir = await agentsDir({
    keeper: agentMd('keeper', 'keeper', 'memory.note', 'default: true\n'),
    credo: agentMd('credo', 'credo', 'finance.*, memory.note'),
  });
  const wiring = createWiring({
    DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
    BUDDI_AGENTS_DIR: dir,
    ANTHROPIC_API_KEY: 'sk-ant-fixture',
  });
  try {
    // The registry is built, and the catalog against it.
    expect(wiring.registry.list().length).toBeGreaterThan(0);
    const listed = wiring.catalog.list().map((a) => a.id);
    expect(listed).toContain('keeper');
    expect(listed).toContain('credo');

    // The held-back agent is listed, toolless and cannot run, with its reason.
    const credo = wiring.catalog.resolve('credo');
    expect(credo.tools).toEqual([]);
    expect(credo.heldBack).toMatchObject({ reason: 'missing-plugin', families: ['finance'] });
    expect(credo.available).toBe(false);
    expect(credo.unavailableReason).toContain('finance');

    // And the rest of the installation is completely unaffected.
    const keeper = wiring.catalog.resolve('keeper');
    expect(keeper.tools).toEqual(['memory.note']);
    expect(keeper.available).toBe(true);
    expect(wiring.catalog.defaultAgent().id).toBe('keeper');
  } finally {
    await wiring.pool.end();
  }
});

it('still refuses a grant no install could satisfy', async () => {
  // `memory` IS registered here, so `memory.teleport` is not a missing plugin:
  // it is a name that will never exist. That stays a load error.
  const dir = await agentsDir({
    keeper: agentMd('keeper', 'keeper', 'memory.teleport', 'default: true\n'),
  });
  expect(() =>
    createWiring({
      DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
      BUDDI_AGENTS_DIR: dir,
      ANTHROPIC_API_KEY: 'sk-ant-fixture',
    }),
  ).toThrow(/matches no registered tool/);
});

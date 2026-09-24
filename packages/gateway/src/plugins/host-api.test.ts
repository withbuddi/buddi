/**
 * The plugin host API at install and at load (docs/specs/plugin-host-api.md
 * §5, §7): `buddi.uses` is read off package.json and shown before anything is
 * imported, a manifest that says otherwise does not register, and a plugin
 * built for a newer host is refused at staging with both numbers.
 *
 * Every package here is a directory under a fresh temporary root.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadManifest, packageUses } from './load.js';
import { stagePlugin, StageRefusal } from './stage.js';
import { renderStagedUses } from '../plugins-cli.js';

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'buddi-host-api-'));
  env = {
    ...process.env,
    BUDDI_DATA_DIR: path.join(root, 'data'),
    BUDDI_AGENTS_DIR: path.join(root, 'agents'),
    BUDDI_SKILLS_DIR: path.join(root, 'skills'),
    BUDDI_PLUGINS_FILE: path.join(root, 'plugins.json'),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A built plugin directory: a package.json and an entry exporting a manifest. */
function pluginDir(opts: { buddi?: Record<string, unknown>; uses?: string[] }): string {
  const dir = path.join(root, `pkg-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'buddi-plugin-hostapi-fixture',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
      buddi: { name: 'hostapi-fixture', ...(opts.buddi ?? {}) },
    }),
  );
  writeFileSync(
    path.join(dir, 'index.js'),
    `export const manifest = ${JSON.stringify({
      name: 'hostapi-fixture',
      version: '1.0.0',
      schema: 'hostapi_fixture',
      migrationsDir: '',
      tools: [],
      ...(opts.uses === undefined ? {} : { uses: opts.uses }),
    })};\n`,
  );
  return dir;
}

describe('staging', () => {
  it('reads the areas a package uses off its package.json', async () => {
    const staged = await stagePlugin(pluginDir({ buddi: { uses: ['files', 'accounts'] } }), { env });
    expect(staged.uses).toEqual(['accounts', 'files']);
    expect(renderStagedUses(staged)).toEqual([
      'IN BUDDI, BEYOND ITSELF (2)',
      '  It uses a model account you pick.',
      '  It keeps files in your Files library.',
    ]);
  });

  it('refuses an area this buddi does not have', async () => {
    await expect(stagePlugin(pluginDir({ buddi: { uses: ['network'] } }), { env })).rejects.toThrow(
      /buddi\.uses names "network", which is not an area of this buddi/,
    );
  });

  it('refuses a plugin built for a newer host, with both numbers', async () => {
    const staging = stagePlugin(pluginDir({ buddi: { hostApi: '^1.9' } }), { env });
    await expect(staging).rejects.toBeInstanceOf(StageRefusal);
    await expect(stagePlugin(pluginDir({ buddi: { hostApi: '^1.9' } }), { env })).rejects.toThrow(
      /it was built for host API \^1\.9, and this buddi has 1\.0/,
    );
    await expect(stagePlugin(pluginDir({ buddi: { hostApi: '^1.0' } }), { env })).resolves.toMatchObject({
      buddi: { hostApi: '^1.0' },
    });
  });

  it('shows what an upgrade adds as a change', () => {
    expect(
      renderStagedUses({
        uses: ['http', 'files'],
        previous: { name: 'hostapi-fixture', version: '1.0.0' },
        previousUses: ['http', 'schedule'],
      }),
    ).toEqual([
      'IN BUDDI, BEYOND ITSELF (2)',
      '  It sends web requests.',
      '  It keeps files in your Files library.  (NEW in this version)',
      '  No longer: schedule (1.0.0 declared it).',
    ]);
  });
});

describe('loading', () => {
  it('registers a plugin whose manifest and package.json declare the same areas', async () => {
    const dir = pluginDir({ buddi: { uses: ['http'] }, uses: ['http'] });
    const loaded = await loadManifest(path.join(dir, 'index.js'), undefined, env);
    expect(loaded.ok).toBe(true);
    expect(packageUses(path.join(dir, 'index.js'))).toEqual({ ok: true, uses: ['http'] });
  });

  it('does not register a plugin whose manifest says more than its card showed', async () => {
    const dir = pluginDir({ buddi: { uses: ['http'] }, uses: ['http', 'files:library'] });
    const loaded = await loadManifest(path.join(dir, 'index.js'), undefined, env);
    expect(loaded).toEqual({
      ok: false,
      message:
        'plugin "hostapi-fixture" declares that it uses http, files:library in its manifest, and http in ' +
        "package.json's buddi.uses; the install card was drawn from the second, so the two must match",
    });
  });
});

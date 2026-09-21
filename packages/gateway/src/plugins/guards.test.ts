/**
 * The collision guards, and the thing that keeps them honest.
 *
 * Two plugins cannot share a name, because every tool name would collide; two
 * plugins cannot share a Postgres schema, because `db:migrate` would apply the
 * second one's migrations into the first one's tables. Both refusals lived on
 * hand-written lists, and a hand-written list of what a build ships is a list
 * that is wrong from the next plugin onwards: `web` shipped after both were
 * written, so an installed plugin could take the name `web` and the `web`
 * schema, and its migrations would have landed next to `web.fetches`.
 *
 * So the lists are gone — the guards derive from the registry this build
 * actually creates and from the per-run families the runs actually register —
 * and this suite is the net under that. Everything below asserts a *property*
 * ("every family this build ships is refused"), never a membership list, so
 * adding a plugin cannot leave the guard behind without a red test.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  builtInManifests,
  createToolRegistry,
  installedManifests,
} from '../agents/catalog.js';
import { builtInSchemas, InstallRefusal, planInstall } from './install.js';
import {
  adoptPlugins,
  builtInPluginNames,
  builtInToolNames,
  externalManifests,
  loadInstalledPlugins,
  manifestProblem,
  perRunManifests,
  resetAdoptedPlugins,
} from './load.js';

const GATEWAY_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = path.join(REPO_ROOT, 'packages', 'tools');

/** A plugin nobody ships, used to vary exactly one field at a time. */
function stranger(overrides: Partial<PluginManifest> = {}): Record<string, unknown> {
  return {
    name: 'a-third-party-plugin',
    version: '1.0.0',
    schema: 'a_third_party_plugin',
    tools: [],
    ...overrides,
  };
}

/** An installable package directory, built, in a temporary place. */
function packageDir(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-guard-'));
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'guard-fixture', version: '1.0.0', type: 'module', main: 'dist/index.js' }),
  );
  writeFileSync(
    path.join(dir, 'dist', 'index.js'),
    `export const manifest = ${JSON.stringify(manifest)};\n`,
  );
  return dir;
}

/** A record file and an agents tree of this test's own: the owner's is never read. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'buddi-guard-root-'));
  mkdirSync(path.join(root, 'agents'), { recursive: true });
  return {
    ...process.env,
    BUDDI_AGENTS_DIR: path.join(root, 'agents'),
    BUDDI_SKILLS_DIR: path.join(root, 'skills'),
    BUDDI_PLUGINS_FILE: path.join(root, 'plugins.json'),
  };
}

beforeEach(() => {
  resetAdoptedPlugins();
});

describe('a plugin may not take a built-in name', () => {
  it('refuses every family this build registers — the list is the registry', () => {
    for (const name of builtInPluginNames()) {
      expect(manifestProblem(stranger({ name })), `"${name}" was accepted`).toMatch(
        /already ships/,
      );
    }
  });

  it('refuses "web" by name — the plugin the hand-written list never learned about', () => {
    expect(builtInPluginNames().has('web')).toBe(true);
    expect(manifestProblem(stranger({ name: 'web', schema: 'somewhere_else' }))).toMatch(
      /"web" is the name of a plugin this build already ships/,
    );
  });

  it('still accepts a name nobody ships', () => {
    expect(manifestProblem(stranger())).toBeUndefined();
  });
});

describe('a plugin may not take a built-in schema', () => {
  it('reserves every schema a built-in plugin declares, plus core and public', () => {
    const reserved = builtInSchemas();
    expect(reserved.has('core')).toBe(true);
    expect(reserved.has('public')).toBe(true);
    for (const manifest of builtInManifests()) {
      expect(reserved.has(manifest.schema), `schema "${manifest.schema}" is unreserved`).toBe(true);
    }
  });

  it('refuses an install that claims the web schema under another name', async () => {
    const dir = packageDir(stranger({ name: 'not-web', schema: 'web' }));
    const refusal = await planInstall(dir, isolatedEnv()).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(InstallRefusal);
    expect((refusal as InstallRefusal).code).toBe('schema-taken');
    expect((refusal as InstallRefusal).message).toMatch(/Postgres schema "web"/);
  });

  it('refuses an install that claims a built-in name', async () => {
    const dir = packageDir(stranger({ name: 'web', schema: 'somewhere_else' }));
    const refusal = await planInstall(dir, isolatedEnv()).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(InstallRefusal);
    expect((refusal as InstallRefusal).code).toBe('not-a-plugin');
  });

  it('accepts a plugin that collides with nothing', async () => {
    const dir = packageDir(stranger());
    const plan = await planInstall(dir, isolatedEnv());
    expect(plan.manifest.name).toBe('a-third-party-plugin');
  });
});

describe('the per-run families', () => {
  /**
   * `mission`, `conversation` and `conversation-offers` are registered onto a
   * copy of the base registry, once per run, because each closes over that
   * run's sink. That put them outside the guard: the base registry would have
   * accepted a plugin called `mission`, and then every scheduled run and every
   * chat session would have thrown inside `registry.register` — an installation
   * that stops answering, hours after the install that broke it.
   */
  it('are refused by name, exactly like the registered ones', () => {
    for (const manifest of perRunManifests()) {
      expect(manifestProblem(stranger({ name: manifest.name })), `${manifest.name}`).toMatch(
        /already ships/,
      );
    }
  });

  it('are refused tool by tool, so an innocently named plugin cannot shadow one', () => {
    for (const manifest of perRunManifests()) {
      for (const tool of manifest.tools) {
        expect(
          manifestProblem(stranger({ tools: [{ name: tool.name }] as PluginManifest['tools'] })),
          tool.name,
        ).toMatch(/already answers to/);
      }
    }
  });

  it('reserves every tool name the base registry holds too', () => {
    const reserved = builtInToolNames();
    for (const manifest of builtInManifests()) {
      for (const tool of manifest.tools) expect(reserved.has(tool.name)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The anti-drift net
 * ------------------------------------------------------------------ */

describe('a new built-in plugin cannot slip past the guards', () => {
  /**
   * Every tool family in the gateway names itself in a `*_PLUGIN` constant.
   * Read them off disk and demand the guard knows each one: a family added
   * tomorrow — registered in the base registry or per run, it makes no
   * difference — fails here on the commit that adds it, not on the day
   * somebody installs a plugin with the same name.
   */
  it('knows every *_PLUGIN name declared in the gateway source', () => {
    const declared = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__fixtures__' || entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
        const source = readFileSync(full, 'utf8');
        for (const m of source.matchAll(/export const \w*_PLUGIN\s*=\s*'([^']+)'/g)) {
          declared.set(m[1] as string, path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(GATEWAY_SRC);

    expect(declared.size).toBeGreaterThan(5);
    const unguarded = [...declared].filter(([name]) => !builtInPluginNames().has(name));
    expect(
      unguarded,
      'a tool family this build ships is not refused to installed plugins — ' +
        'it must be registered where `builtInManifests` or `perRunManifests` can see it',
    ).toEqual([]);
  });

  /**
   * And every plugin package the gateway compiles in. This is the `web` case
   * exactly: a package under `packages/tools/`, compiled in, whose name and
   * schema the guards had never heard of — and whose schema `db:migrate`
   * walks.
   *
   * "Compiled in" is read off the gateway's own dependencies rather than off
   * the directory listing, because a package under `packages/tools/` is not
   * proof of it: a domain plugin is installed, not compiled in — `finance`
   * left this tree for its own repository and arrives the way the case below
   * arrives.
   */
  it('knows every plugin package the gateway depends on', async () => {
    const dirs = readdirSync(TOOLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs.length).toBeGreaterThan(0);
    const gatewayPkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'packages', 'gateway', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const compiledIn = new Set(Object.keys(gatewayPkg.dependencies ?? {}));
    const nameOf = (dir: string): string =>
      (JSON.parse(readFileSync(path.join(TOOLS_DIR, dir, 'package.json'), 'utf8')) as { name: string }).name;

    for (const dir of dirs.filter((d) => compiledIn.has(nameOf(d)))) {
      const entry = path.join(TOOLS_DIR, dir, 'dist', 'index.js');
      expect(existsSync(entry), `packages/tools/${dir} is not built — run \`pnpm -r build\``).toBe(
        true,
      );
      const mod = (await import(entry)) as { manifest?: PluginManifest; default?: PluginManifest };
      const manifest = mod.manifest ?? mod.default;
      expect(manifest, `packages/tools/${dir} exports no manifest`).toBeDefined();
      const plugin = manifest as PluginManifest;

      expect(
        builtInPluginNames().has(plugin.name),
        `the plugin "${plugin.name}" ships in this build but an installed plugin may still take its name`,
      ).toBe(true);
      expect(
        builtInSchemas().has(plugin.schema),
        `the plugin "${plugin.name}" owns the schema "${plugin.schema}" but an installed plugin may still claim it`,
      ).toBe(true);
      if ((plugin.migrationsDir ?? '').trim() !== '') {
        expect(
          installedManifests().map((m) => m.name),
          `"${plugin.name}" has migrations but is not in installedManifests(), so nothing migrates or backs it up`,
        ).toContain(plugin.name);
      }
    }
  });

  /**
   * And the other direction, which is the whole point of the change: finance
   * is not in this tree at all — it lives in the `buddi-plugins` repository —
   * so its name is free for an installed plugin, which is exactly what the
   * owner installs when they run `buddi plugins install <path>/finance`.
   */
  it('does not claim finance, which is installed rather than compiled in', () => {
    expect(builtInPluginNames().has('finance')).toBe(false);
    expect(builtInSchemas().has('finance')).toBe(false);
    const gatewayPkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'packages', 'gateway', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(gatewayPkg.dependencies ?? {})).not.toContain('@buddi/tool-finance');
  });

  /**
   * The root `pnpm db:migrate` reads its own plugin list, and it had the same
   * disease: it named four packages and web was the fifth. It walks the
   * directory now, and this says so.
   */
  it('leaves the root db:migrate script no list to fall behind', () => {
    const script = readFileSync(path.join(REPO_ROOT, 'scripts', 'migrate.mjs'), 'utf8');
    expect(script).toMatch(/readdir\(toolsDir/);
    expect(script).not.toMatch(/for \(const name of \[/);
  });
});

/**
 * A directory source, loaded exactly as the gateway loads one at start.
 *
 * Finance was the first plugin to make the whole trip: it used to be compiled
 * in, and an existing checkout's agents still grant `finance.*`. It is not in
 * this tree any more, so the trip is walked here with the fixture package this
 * repository ships for the purpose — the family arrives through
 * `externalManifests` rather than through the composition root, which is the
 * property that matters and is true of any installed plugin.
 */
describe('a plugin installed rather than compiled in', () => {
  it('loads from a directory source and registers its family', async () => {
    const env = isolatedEnv();
    const dir = path.join(GATEWAY_SRC, '__fixtures__', 'test-plugin');
    const entry = path.join(dir, 'index.js');
    expect(existsSync(entry)).toBe(true);
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string };
    writeFileSync(
      env.BUDDI_PLUGINS_FILE as string,
      JSON.stringify({
        version: 2,
        plugins: [
          {
            name: 'testplug',
            version: pkg.version,
            source: { kind: 'directory', path: dir },
            entry,
            installedAt: '2026-01-01T00:00:00.000Z',
            schema: 'buddi_fixture_testplug',
          },
        ],
      }),
    );

    const loaded = await loadInstalledPlugins(env);
    expect(loaded.problems).toEqual([]);
    expect(loaded.loaded.map((p) => p.manifest.name)).toEqual(['testplug']);

    adoptPlugins(env, loaded);
    expect(externalManifests(env).map((m) => m.name)).toContain('testplug');
    const registry = createToolRegistry(env);
    expect(registry.manifests().map((m) => m.name)).toContain('testplug');
    expect(registry.list().some((t) => t.name.startsWith('testplug.'))).toBe(true);
    // And the built-in set is still without it: the same process that loaded
    // it as a plugin does not also ship it.
    expect(builtInManifests(env).map((m) => m.name)).not.toContain('testplug');
  });
});

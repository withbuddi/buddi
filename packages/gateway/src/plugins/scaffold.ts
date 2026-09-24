/**
 * `buddi plugins init` — the scaffold.
 *
 * The ten-minute path in `docs/plugins.md` starts here. Everything this writes
 * is something a plugin author would otherwise have to copy out of the guide by
 * hand and get subtly wrong: the `buddi` field that ties a package name to a
 * manifest name, the peer on `@buddi/core` (never a normal dependency), the
 * absolute `migrationsDir` resolved from the *built* file, one tool at each of
 * the two tiers a plugin should ship, and a `buddi.md` whose `Schema:` and
 * `Hosts:` lines already agree with the manifest so the first install shows no
 * drift.
 *
 * It is a pure function of a name and a version — `scaffoldFiles` returns the
 * whole tree as text — and a small writer on top of it that refuses a directory
 * that already exists. Pure because the scaffold is the thing most worth
 * testing and least worth a temporary directory to test.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { InstallRefusal } from './refusals.js';

/** A plugin name: lowercase, digits, `-` and `_`, starting with a letter. */
export const SCAFFOLD_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * The scaffold refuses a scoped name and a name with a dot.
 *
 * `pluginDirKey` is wider — it is npm's charset, because it has to accept
 * whatever a published package is already called. A *new* plugin has no such
 * history, and every character this rule drops is one that cannot be a Postgres
 * schema: `@you/x` and `x.y` are not identifiers, and the schema is derived
 * from the name.
 */
export function assertScaffoldName(name: string): string {
  const trimmed = name.trim();
  if (!SCAFFOLD_NAME.test(trimmed) || trimmed.length > 60) {
    throw new InstallRefusal(
      'bad-name',
      `"${name}" is not a usable name for a new plugin. Start with a lowercase letter, then ` +
        'lowercase letters, digits, "-" or "_" — the name becomes a tool family, a directory and ' +
        'a Postgres schema, so nothing else is allowed.',
    );
  }
  return trimmed;
}

/** The Postgres schema a scaffolded plugin owns: its name, `-` folded to `_`. */
export function schemaFor(name: string): string {
  return name.replace(/-/g, '_');
}

export interface ScaffoldOptions {
  /** The plugin's manifest name, its tool family and (folded) its schema. */
  name: string;
  /** The version of `@buddi/core` this installation is running. */
  coreVersion: string;
  /**
   * An absolute path to the `@buddi/core` package of this installation, when
   * there is one on disk. Core is not published yet, so the scaffold satisfies
   * the peer with a `link:` devDependency pointing at it — exactly what the
   * finance plugin does. Omitted, the devDependency is the published range and
   * the README says to fix it up.
   */
  coreDir?: string;
}

/** Every file the scaffold writes, keyed by its path relative to the root. */
export function scaffoldFiles(opts: ScaffoldOptions): Record<string, string> {
  const name = assertScaffoldName(opts.name);
  const schema = schemaFor(name);
  const peer = `^${opts.coreVersion}`;
  const link = opts.coreDir === undefined ? peer : `link:${opts.coreDir}`;
  return {
    'package.json': packageJson(name, peer, link),
    'tsconfig.json': tsconfig(),
    'src/index.ts': indexTs(name, schema),
    'src/index.test.ts': testTs(name),
    [`migrations/001_${schema}.sql`]: migrationSql(name, schema),
    'buddi.md': buddiMd(name, schema),
    'README.md': readmeMd(name, schema, opts.coreDir),
    '.gitignore': 'node_modules/\ndist/\n',
  };
}

/** Write the scaffold. Refuses a directory that already exists. */
export function writeScaffold(dir: string, opts: ScaffoldOptions): string[] {
  if (existsSync(dir)) {
    throw new InstallRefusal(
      'directory-exists',
      `${dir} already exists. \`buddi plugins init\` never writes into a directory it did not ` +
        'create — pick another name, or pass --dir with a path that is not there yet.',
    );
  }
  const files = scaffoldFiles(opts);
  const written: string[] = [];
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
    written.push(relative);
  }
  return written.sort();
}

/* ------------------------------------------------------------------ *
 * The files
 * ------------------------------------------------------------------ */

function packageJson(name: string, peer: string, link: string): string {
  return `${JSON.stringify(
    {
      name: `buddi-plugin-${name}`,
      version: '0.1.0',
      description: `A buddi plugin: ${name}.`,
      keywords: ['buddi-plugin'],
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      buddi: { manifest: 'manifest', core: peer, uses: [], hostApi: '^1.0' },
      scripts: {
        build: 'tsc -p tsconfig.json',
        typecheck: 'tsc -p tsconfig.json --emitDeclarationOnly',
        test: 'vitest run',
      },
      dependencies: { pg: '^8.13.1', zod: '^3.24.1' },
      peerDependencies: { '@buddi/core': peer },
      devDependencies: {
        '@buddi/core': link,
        '@types/node': '^22.10.2',
        '@types/pg': '^8.11.10',
        typescript: '^5.6.3',
        vitest: '^2.1.8',
      },
      files: ['dist', 'migrations', 'buddi.md'],
    },
    null,
    2,
  )}\n`;
}

function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2023'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        declaration: true,
        sourceMap: true,
        rootDir: './src',
        outDir: './dist',
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
    null,
    2,
  )}\n`;
}

function indexTs(name: string, schema: string): string {
  return `/**
 * ${name} — a buddi plugin.
 *
 * The whole contract is \`PluginManifest\` in \`@buddi/core/plugin\`, and
 * everything a tool reaches beyond its arguments is on \`ctx.buddi\`. This file is
 * the smallest honest example of both: one tool at tier \`auto\` (a read of this
 * plugin's own schema, which runs inline the moment a model calls it) and one
 * at tier \`gated\` (it changes something the owner cannot get back, so the call
 * becomes an action the owner approves before \`execute\` is ever reached).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EffectDescription, PluginManifest, ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';

/**
 * Absolute, and resolved from the *built* file so it is right from \`dist\`.
 * \`fileURLToPath\`, never \`new URL(...).pathname\`: that form percent-encodes a
 * space, and a data directory called "owner data" then does not exist.
 */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/* ------------------------------------------------------------------ *
 * An \`auto\` tool: a read of this plugin's own schema.
 * ------------------------------------------------------------------ */

const listInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('How many notes to return, newest first. Defaults to 20, at most 100.'),
});

export interface Note {
  id: string;
  body: string;
  createdAt: string;
}

export const listNotes: ToolDefinition<z.infer<typeof listInput>, { notes: Note[] }> = {
  name: '${name}.list_notes',
  // Say *when* to use it, in the second person to the model.
  description:
    'List the notes this plugin has stored, newest first. Use it before answering anything that ' +
    'depends on what was written down here.',
  tier: 'auto',
  input: listInput,
  async execute(input, ctx) {
    // \`ctx.buddi\` is the host, bound to this plugin: core sets it on every
    // context it hands you. Reach the database, the clock and the rest there.
    const { rows } = await ctx.buddi!.db.query(
      \`select id::text as id, body, created_at from ${schema}.note order by created_at desc limit $1\`,
      [input.limit ?? 20],
    );
    return {
      notes: (rows as Array<{ id: string; body: string; created_at: Date }>).map((row) => ({
        id: row.id,
        body: row.body,
        createdAt: row.created_at.toISOString(),
      })),
    };
  },
};

/* ------------------------------------------------------------------ *
 * A \`gated\` tool: it destroys something, so the owner approves it first.
 * ------------------------------------------------------------------ */

const forgetInput = z.object({
  id: z.string().uuid().describe('The note to delete, from ${name}.list_notes.'),
});

export const forgetNote: ToolDefinition<z.infer<typeof forgetInput>, { deleted: boolean }> = {
  name: '${name}.forget_note',
  description: 'Delete one note for good. The owner is asked before anything is deleted.',
  tier: 'gated',
  input: forgetInput,
  /**
   * What will actually happen, the whole of it.
   *
   * Pure and read-only: it runs *before* any approval exists. The envelope is
   * what the ledger hashes, so anything that decides the effect belongs in it;
   * the preview is the short plain sentence the owner reads, rendered from the
   * envelope and never from anything a model wrote.
   */
  async describe(input, ctx): Promise<EffectDescription> {
    const { rows } = await ctx.buddi!.db.query(\`select body from ${schema}.note where id = $1\`, [input.id]);
    const body = (rows[0] as { body: string } | undefined)?.body;
    return {
      envelope: { tool: '${name}.forget_note', id: input.id, body: body ?? null },
      preview:
        body === undefined
          ? \`Delete note \${input.id}, which is not there any more.\`
          : \`Delete this note for good: "\${body.slice(0, 120)}"\`,
    };
  },
  async execute(input, ctx) {
    // Only \`executeApproved\` ever calls a gated \`execute\`, and it sets
    // \`actionId\`. Absent, something is calling this outside the approval
    // machinery: fail closed rather than guess.
    const actionId = ctx.actionId?.trim();
    if (!actionId) {
      throw new Error('${name}.forget_note: no approved action id in the tool context; refusing');
    }
    // One atomic statement, so a replay of the same action cannot act twice.
    const { rowCount } = await ctx.buddi!.db.query(\`delete from ${schema}.note where id = $1\`, [input.id]);
    return { deleted: (rowCount ?? 0) > 0 };
  },
};

/* ------------------------------------------------------------------ *
 * A source, when you want work to start with no agent in the loop.
 * ------------------------------------------------------------------ *
 *
 * A source polls on a period and originates runs. Uncomment it, add
 * \`sources: [poll]\` to the manifest, and read §2.2 of docs/plugins.md first: a
 * first-contact cursor starts at *now*, the cursor advances in the same
 * transaction as the rows it stands for, and \`dedupKey\` is stable for the life
 * of that row.
 *
 * import type { Source } from '@buddi/core/plugin';
 *
 * export const poll: Source = {
 *   id: '${name}.poll',
 *   description: 'Looks for new work every ten minutes.',
 *   every: 600,
 *   async poll(ctx) {
 *     ctx.buddi!.log('nothing to do');
 *   },
 * };
 */

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

export const manifest: PluginManifest = {
  name: '${name}',
  // Bumping this voids every standing approval for this plugin's tools.
  version: '0.1.0',
  schema: '${schema}',
  migrationsDir: MIGRATIONS_DIR,
  tools: [listNotes, forgetNote],
  // One line, shown before anybody installs you.
  description: 'Keeps short notes, and deletes one when the owner says so.',
  // Every host you intend to reach, and why. Documentation, not a sandbox —
  // and it is compared with your buddi.md at install.
  network: [],
  // The areas of \`ctx.buddi\` you reach beyond your own schema, directory and
  // approvals: \`http\`, \`files\`, \`accounts\`, ... Repeated as \`buddi.uses\` in
  // package.json, because the install card is drawn before this file is
  // imported; the two must match. This plugin reaches nothing else.
  uses: [],
};

export default manifest;
`;
}

function testTs(name: string): string {
  return `/**
 * The manifest, through core's own validation.
 *
 * \`ToolRegistry.register\` is what runs at startup: it derives a JSON Schema
 * from every zod input and refuses one no provider would accept, it refuses a
 * tool name that collides, and it parses every view descriptor. Registering
 * the manifest here is therefore the cheapest possible proof that this plugin
 * will load — and it needs no database.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core';
import { manifest } from './index.js';

describe('${name} manifest', () => {
  it('registers in a tool registry', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.has('${name}.list_notes')).toBe(true);
  });

  it('namespaces every tool to the plugin', () => {
    for (const tool of manifest.tools) {
      expect(tool.name.startsWith(\`\${manifest.name}.\`)).toBe(true);
    }
  });

  it('declares an executable tier, and describes every gated tool', () => {
    for (const tool of manifest.tools) {
      expect(['auto', 'gated', 'session']).toContain(tool.tier);
      if (tool.tier === 'gated') expect(typeof tool.describe).toBe('function');
    }
  });

  it('refuses a gated execute with no approved action id', async () => {
    const gated = manifest.tools.find((tool) => tool.tier === 'gated');
    expect(gated).toBeDefined();
    await expect(
      gated!.execute(
        { id: '00000000-0000-4000-8000-000000000000' },
        { db: null as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' },
      ),
    ).rejects.toThrow(/action id/);
  });
});
`;
}

function migrationSql(name: string, schema: string): string {
  return `-- ${name}: the first migration.
--
-- Applied with \`set local search_path to ${schema}, public\`, so table names here
-- are unqualified and this file cannot reach another plugin's tables by
-- accident. Files run in filename order, are tracked by (schema, filename), and
-- are NEVER re-run and never rolled back: add 002_*.sql, never edit this one.
create table if not exists note (
  id uuid primary key default gen_random_uuid(),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists note_created_at_idx on note (created_at desc);
`;
}

function buddiMd(name: string, schema: string): string {
  return `# ${name}

What this plugin is, in the owner's own words. This file is what a person reads
*before* anything of yours is imported, so write it for them and keep it true:
it is compared with your manifest at install, and every difference costs the
owner a second approval.

Say what it stores, what runs on a timer, and what leaves the machine.

Schema: ${schema}
Hosts: none
`;
}

function readmeMd(name: string, schema: string, coreDir: string | undefined): string {
  const core =
    coreDir === undefined
      ? 'Point the `@buddi/core` devDependency at a published version, or at a buddi\ncheckout: `"@buddi/core": "link:/path/to/buddi/packages/core"`.'
      : `The \`@buddi/core\` devDependency is a \`link:\` at the installation this was
scaffolded from (\`${coreDir}\`). That checkout must be built (\`pnpm -r build\`)
before this compiles: the link points at the package, and its types and entry
point are in its \`dist\`. When core is published the devDependency becomes the
published range and nothing else changes — the peer range is already the
contract.`;
  return `# buddi-plugin-${name}

A [buddi](https://github.com/amenophis1er/buddi) plugin. It exports a
\`PluginManifest\` and depends on \`@buddi/core\` as a **peer**, never as a normal
dependency: a plugin carrying its own copy of core would register its tools into
a registry nobody reads.

## Build it

\`\`\`sh
pnpm install
pnpm build      # tsc → dist/
pnpm test       # the manifest, through core's own validation
\`\`\`

${core}

## Install it

\`\`\`sh
pnpm build
buddi plugins install .          # stages it and prints what it claims; imports nothing
buddi plugins install . --yes    # approves it, imports it, applies its migrations
buddi service restart            # plugins are registered at start
\`\`\`

Then \`buddi plugins list\`, and grant \`${name}.*\` to an agent on the dashboard's
Plugins page (or in the agent's own \`tools:\` line).

While you are working on it, \`buddi plugins dev .\` watches \`dist\` and tells you
— or the service — to restart when the build changes.

## What is here

| | |
| --- | --- |
| \`src/index.ts\` | the manifest: one \`auto\` tool, one \`gated\` tool with \`describe\`, a source stub |
| \`migrations/001_${schema}.sql\` | the Postgres schema this plugin owns |
| \`buddi.md\` | what the owner reads before anything is imported |

The guide is \`docs/plugins.md\` in the buddi repository. Read it before you ship:
the tiers, the effect envelope and what a gated \`execute\` owes the owner are all
decided there.
`;
}

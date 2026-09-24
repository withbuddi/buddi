/**
 * The reference chapter of `docs/plugins.md`, checked against the types.
 *
 * A hand-written field reference is worth having — it says what each field is
 * *for*, which a `.d.ts` never will — and it rots the first time somebody adds
 * a field. So this test reads the interfaces out of the source with the
 * TypeScript compiler API, reads the tables out of the guide, and fails naming
 * the field that is in one and not the other. Adding a field to the plugin
 * contract is therefore a two-file change, deliberately: the type, and the line
 * that tells a stranger what it means.
 *
 * It is a *repository* test. The guide ships in the buddi repository rather
 * than in this package, so when the file is not there — a consumer running this
 * package's tests out of a tarball — the suite skips rather than fails.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PLUGIN_USES, PLUGIN_USE_WORDS } from './plugin/uses.js';
import { HOST_API_VERSION } from './plugin/version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(here, '..', '..', '..', 'docs', 'plugins.md');

/**
 * Every interface the reference documents, and the file it is declared in.
 *
 * The map is the list of things a plugin author has to be told about. A type
 * that is not here is not in the contract's surface — `SentinelFindingRow` is
 * core's own row shape, not something a manifest ever holds.
 */
export const DOCUMENTED: Record<string, string> = {
  PluginManifest: 'tools.ts',
  ToolDefinition: 'tools.ts',
  EffectDescription: 'tools.ts',
  ToolContext: 'tools.ts',
  GroupContext: 'tools.ts',
  Source: 'tools.ts',
  SourceContext: 'tools.ts',
  SuggestedMission: 'tools.ts',
  SuggestedSkill: 'tools.ts',
  SuggestedAgent: 'tools.ts',
  NetworkUse: 'tools.ts',
  PreviewProvider: 'tools.ts',
  MetricDefinition: 'metrics.ts',
  Sentinel: path.join('sentinels', 'types.ts'),
  SentinelContext: path.join('sentinels', 'types.ts'),
  Finding: path.join('sentinels', 'types.ts'),
  ViewDescriptor: 'views.ts',
  PageDescriptor: 'pages.ts',
  PageQuery: 'pages.ts',
  ...Object.fromEntries(
    [
      'BuddiHost',
      'OwnerArea',
      'ClockArea',
      'DbArea',
      'DirArea',
      'ApprovalsArea',
      'PagesArea',
      'HttpArea',
      'AccountsArea',
      'FilesArea',
      'MemoryArea',
      'ProposalsArea',
      'ScheduleArea',
      'SecretsArea',
    ].map((name) => [name, path.join('host', 'types.ts')]),
  ),
};

/**
 * The host's tables (§9b) carry one more column: the `ctx.buddi` version that
 * introduced each member (docs/specs/plugin-host-api.md §7). Every row must
 * name one, and none may be newer than the host this build is.
 */
export const HOST_DOCUMENTED = Object.keys(DOCUMENTED).filter((name) => DOCUMENTED[name] === path.join('host', 'types.ts'));

/** The "Since" cell of every row in one host table, by field. */
export function sinceColumn(markdown: string, name: string): Map<string, string> {
  const heading = new RegExp(`^#{2,4} \`${name}\`\\s*$`, 'm');
  const start = heading.exec(markdown);
  const since = new Map<string, string>();
  if (start === null) return since;
  const after = markdown.slice(start.index + start[0].length);
  const end = /^#{1,4} /m.exec(after);
  const section = end === null ? after : after.slice(0, end.index);
  for (const line of section.split('\n')) {
    const cells = line.replace(/\\\|/g, '\u0001').split('|').map((cell) => cell.trim());
    const field = /^`([A-Za-z_][A-Za-z0-9_]*)`/.exec(cells[1] ?? '');
    if (field === null || cells.length < 7) continue;
    since.set(field[1] as string, cells[4] ?? '');
  }
  return since;
}

/**
 * What core runs a plugin's functions on, and the context the plugin is typed
 * against. The fields the first has and the second does not are the ones a
 * plugin reaches through `ctx.buddi` instead (docs/specs/plugin-host-api.md
 * §3): the guide may name them only as the host's.
 */
export const CORE_CONTEXTS: ReadonlyArray<{ core: string; plugin: string; file: string }> = [
  { core: 'CoreToolContext', plugin: 'ToolContext', file: 'tools.ts' },
  { core: 'CoreSourceContext', plugin: 'SourceContext', file: 'tools.ts' },
  { core: 'CoreSentinelContext', plugin: 'SentinelContext', file: path.join('sentinels', 'types.ts') },
];

/** The rows of §1.3's table: each `uses` name and the line the owner reads for it. */
export function usesTable(markdown: string): Map<string, string> | undefined {
  const header = /^\| `uses` \| The owner reads \|\s*$/m.exec(markdown);
  if (header === null) return undefined;
  const rows = new Map<string, string>();
  const after = markdown.slice(header.index + header[0].length).split('\n').slice(1);
  for (const line of after) {
    if (!line.startsWith('|')) {
      if (rows.size > 0 || line.trim() !== '') break;
      continue;
    }
    const cells = line.split('|').map((cell) => cell.trim());
    const name = /^`([^`]+)`$/.exec(cells[1] ?? '');
    if (name === null) continue;
    rows.set(name[1] as string, cells[2] ?? '');
  }
  return rows;
}

/**
 * Every place the guide names a field the plugin's context no longer has as if
 * it were one: `ctx.<field>` anywhere, or `<field>` declared inside a code
 * block's `interface ToolContext` (or `SourceContext`, `SentinelContext`).
 */
export function removedFieldMentions(markdown: string, removed: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const lines = markdown.split('\n');
  lines.forEach((line, i) => {
    for (const match of line.matchAll(/\bctx\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (removed.has(match[1] as string)) found.push(`line ${i + 1}: ctx.${match[1]}`);
    }
  });
  const declaration = /interface (ToolContext|SourceContext|SentinelContext) \{([\s\S]*?)\n\}/g;
  for (const match of markdown.matchAll(declaration)) {
    const line = markdown.slice(0, match.index).split('\n').length;
    for (const member of (match[2] as string).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*[:(]/gm)) {
      if (removed.has(member[1] as string)) found.push(`line ${line}: ${match[1]}.${member[1]}`);
    }
  }
  return found;
}

/** One member of an interface: its name, and whether the type marks it optional. */
export interface Member {
  name: string;
  optional: boolean;
  /** The declared type, as written: `OwnerArea`, `PluginUse[]`. */
  type?: string;
}

/** Read the members of the named interfaces out of one source file. */
export function membersOf(file: string, wanted: ReadonlySet<string>): Map<string, Member[]> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const found = new Map<string, Member[]>();
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    const name = statement.name.text;
    if (!wanted.has(name)) continue;
    const members: Member[] = [];
    for (const member of statement.members) {
      // Property signatures and method signatures both: `execute(…)` and
      // `describe?(…)` are as much part of the contract as `name: string`.
      if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
      if (member.name === undefined || !ts.isIdentifier(member.name)) continue;
      members.push({
        name: member.name.text,
        optional: member.questionToken !== undefined,
        ...(member.type === undefined ? {} : { type: member.type.getText(source) }),
      });
    }
    found.set(name, members);
  }
  return found;
}

/**
 * The fields one `#### \`Name\`` table in the guide documents.
 *
 * The table's first column is the field in backticks; the third says `yes` or
 * `no`. Nothing clever: a row that does not look like a row is skipped, so the
 * prose between the tables cannot break the parse.
 */
export function tableFields(markdown: string, name: string): Map<string, boolean> | undefined {
  const heading = new RegExp(`^#{2,4} \`${name}\`\\s*$`, 'm');
  const start = heading.exec(markdown);
  if (start === null) return undefined;
  const after = markdown.slice(start.index + start[0].length);
  const end = /^#{1,4} /m.exec(after);
  const section = end === null ? after : after.slice(0, end.index);
  const fields = new Map<string, boolean>();
  for (const line of section.split('\n')) {
    // A type column often *is* a union, so `\|` is an escaped pipe and not a
    // cell boundary. Hide it before splitting, or every union type shifts the
    // columns and the field reads as undocumented.
    const cells = line.replace(/\\\|/g, '\u0001').split('|').map((cell) => cell.trim());
    // `| `name` | type | yes | one line |` splits to ['', …4 cells…, ''].
    if (cells.length < 6) continue;
    const field = /^`([A-Za-z_][A-Za-z0-9_]*)`/.exec(cells[1] ?? '');
    if (field === null) continue;
    const required = (cells[3] ?? '').toLowerCase();
    if (required !== 'yes' && required !== 'no') continue;
    fields.set(field[1] as string, required === 'yes');
  }
  return fields;
}

const present = existsSync(DOC);
const suite = present ? describe : describe.skip;

suite('docs/plugins.md — the plugin contract reference', () => {
  const markdown = present ? readFileSync(DOC, 'utf8') : '';
  const wanted = new Set(Object.keys(DOCUMENTED));
  const byInterface = new Map<string, Member[]>();
  for (const file of new Set(Object.values(DOCUMENTED))) {
    for (const [name, members] of membersOf(path.join(here, file), wanted)) {
      byInterface.set(name, members);
    }
  }

  it('finds every documented interface in the source', () => {
    expect([...wanted].filter((name) => !byInterface.has(name))).toEqual([]);
  });

  it('documents every area the host has, and none it does not', () => {
    // An area is a member of `BuddiHost` whose type is an `…Area`. Each one
    // needs a table of its own methods, and a table for an area the host no
    // longer has is a promise the type does not keep.
    const areas = (byInterface.get('BuddiHost') ?? [])
      .map((m) => m.type ?? '')
      .filter((type) => /^[A-Z][A-Za-z]*Area$/.test(type));
    expect(areas.length).toBeGreaterThan(0);
    const documentedAreas = HOST_DOCUMENTED.filter((name) => name !== 'BuddiHost');
    expect({
      undocumented: areas.filter((area) => !documentedAreas.includes(area)),
      notAnArea: documentedAreas.filter((area) => !areas.includes(area)),
    }).toEqual({ undocumented: [], notAnArea: [] });
    for (const area of areas) expect(tableFields(markdown, area), area).toBeDefined();
  });

  it("lists exactly the manifest's uses, in the owner's words", () => {
    const manifest = byInterface.get('PluginManifest') ?? [];
    // The manifest's field is typed on the list the table is checked against.
    expect(manifest.find((m) => m.name === 'uses')?.type).toBe('PluginUse[]');
    const table = usesTable(markdown);
    if (table === undefined) throw new Error('no `uses` table in the guide');
    expect([...table.keys()]).toEqual([...PLUGIN_USES]);
    const wrong = PLUGIN_USES.filter((use) => table.get(use) !== PLUGIN_USE_WORDS[use]).map(
      (use) => `${use}: "${table.get(use)}" is not "${PLUGIN_USE_WORDS[use]}"`,
    );
    expect(wrong).toEqual([]);
  });

  it('names no field the context no longer has as current', () => {
    const contexts = new Map<string, Member[]>();
    for (const file of new Set(CORE_CONTEXTS.map((c) => c.file))) {
      const names = new Set(CORE_CONTEXTS.flatMap((c) => [c.core, c.plugin]));
      for (const [name, members] of membersOf(path.join(here, file), names)) contexts.set(name, members);
    }
    const removed = new Set<string>();
    for (const { core, plugin } of CORE_CONTEXTS) {
      const kept = new Set((contexts.get(plugin) ?? []).map((m) => m.name));
      for (const member of contexts.get(core) ?? []) if (!kept.has(member.name)) removed.add(member.name);
    }
    // The pool, the owner, the clock and the rest moved under `ctx.buddi`; if
    // this is empty the Core contexts were not found, not the guide clean.
    expect([...removed]).toEqual(expect.arrayContaining(['db', 'ownerId', 'now', 'timezone', 'agentForRole']));
    expect(removedFieldMentions(markdown, removed)).toEqual([]);
  });

  for (const name of Object.keys(DOCUMENTED)) {
    describe(name, () => {
      it('has a table in the reference', () => {
        expect(tableFields(markdown, name)).toBeDefined();
      });

      it('documents exactly the fields the type declares', () => {
        const documented = tableFields(markdown, name);
        if (documented === undefined) throw new Error(`no table for ${name}`);
        const declared = byInterface.get(name) ?? [];
        const missing = declared.filter((m) => !documented.has(m.name)).map((m) => m.name);
        const extra = [...documented.keys()].filter(
          (field) => !declared.some((m) => m.name === field),
        );
        // Named rather than counted: the point of this test is the sentence it
        // prints when somebody adds a field and forgets the guide.
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      });

      it('says required or not the way the type does', () => {
        const documented = tableFields(markdown, name);
        if (documented === undefined) throw new Error(`no table for ${name}`);
        const wrong = (byInterface.get(name) ?? [])
          .filter((m) => documented.get(m.name) === m.optional)
          .map((m) => `${m.name} is ${m.optional ? 'optional' : 'required'} in the type`);
        expect(wrong).toEqual([]);
      });

      if (HOST_DOCUMENTED.includes(name)) {
        it('says since which host version each member exists', () => {
          const since = sinceColumn(markdown, name);
          const [haveMajor, haveMinor] = HOST_API_VERSION.split('.').map(Number) as [number, number];
          const wrong = (byInterface.get(name) ?? [])
            .map((m) => [m.name, since.get(m.name) ?? ''] as const)
            .filter(([, version]) => {
              const match = /^(\d+)\.(\d+)$/.exec(version);
              if (match === null) return true;
              const major = Number(match[1]);
              const minor = Number(match[2]);
              return major > haveMajor || (major === haveMajor && minor > haveMinor);
            })
            .map(([field, version]) => `${field}: "${version}"`);
          expect(wrong).toEqual([]);
        });
      }
    });
  }
});

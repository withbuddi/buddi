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
  Sentinel: path.join('sentinels', 'types.ts'),
  SentinelContext: path.join('sentinels', 'types.ts'),
  Finding: path.join('sentinels', 'types.ts'),
  ViewDescriptor: 'views.ts',
};

/** One member of an interface: its name, and whether the type marks it optional. */
export interface Member {
  name: string;
  optional: boolean;
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
      members.push({ name: member.name.text, optional: member.questionToken !== undefined });
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
    });
  }
});

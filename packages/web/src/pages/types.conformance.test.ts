/**
 * The conformance table, checked against the two files it claims to cover.
 *
 * `types.conformance.ts` compares each named type of the page contract by its
 * keys, at `tsc` time. What the compiler cannot say is whether the *list* is
 * complete: a type added to `packages/core/src/pages.ts` and forgotten in the
 * browser's copy would simply never be compared, and the pair would look green
 * while drifting.
 *
 * So this reads both sources, takes the names each exports, and fails when one
 * is in neither the checked list nor the "deliberately not mirrored" one.
 * Adding a type to the contract is therefore a three-file change, on purpose:
 * the type, its mirror, and the line that says which it is.
 *
 * A repository test: when core's sources are not on disk — a consumer running
 * this package out of a tarball — it skips rather than fails.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CHECKED_TYPES, NOT_MIRRORED, WEB_TYPES } from './types.conformance';

const here = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(here, '..', '..', '..', 'core', 'src', 'pages.ts');
const WEB = path.join(here, 'types.ts');

/** Every interface and type alias a file exports, by name. */
function exportedTypes(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
    const exported = ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) names.push(statement.name.text);
  }
  return names.sort();
}

const present = existsSync(CORE);
const suite = present ? describe : describe.skip;

suite('the page contract, in two files', () => {
  it('compares every type core declares, or says why not', () => {
    const declared = exportedTypes(CORE);
    const accounted = new Set<string>([...CHECKED_TYPES, ...Object.keys(NOT_MIRRORED)]);
    // Named rather than counted: the point is the sentence it prints when
    // somebody adds a type and forgets the browser's copy.
    expect(declared.filter((name) => !accounted.has(name))).toEqual([]);
  });

  it('accounts for every type the browser declares', () => {
    const declared = exportedTypes(WEB);
    const checked = new Set<string>(CHECKED_TYPES);
    const own = new Set(Object.keys(WEB_TYPES));
    // `export type { ColumnMap, Tone, Unit, ValueRef }` re-exports the canvas
    // contract rather than declaring anything, so it is not in this list.
    expect(declared.filter((name) => !checked.has(name) && !own.has(name))).toEqual([]);
  });

  it('claims nothing it does not compare', () => {
    // Every name in the table is a type one of the files actually declares:
    // a renamed type must not leave a line behind pointing at nothing.
    const core = new Set(exportedTypes(CORE));
    expect([...CHECKED_TYPES, ...Object.keys(NOT_MIRRORED)].filter((name) => !core.has(name))).toEqual([]);
    const web = new Set(exportedTypes(WEB));
    expect(Object.keys(WEB_TYPES).filter((name) => !web.has(name))).toEqual([]);
  });
});

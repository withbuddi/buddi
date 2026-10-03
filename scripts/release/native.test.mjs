import { assert, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER_IN_PACKAGE, helperInPack, INSTALLED_HELPER, STAGED_HELPER, stageNativeHelper } from './native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the packaged path is the one the runtime spawns and the build script writes', async () => {
  const computer = await readFile(path.join(root, 'packages/tools/browser/src/computer.ts'), 'utf8');
  assert.match(computer, new RegExp(`new URL\\('\\.\\./${HELPER_IN_PACKAGE.replaceAll('/', '\\/')}', import\\.meta\\.url\\)`));
  const build = await readFile(path.join(root, 'packages/tools/browser/scripts/build-native.mjs'), 'utf8');
  assert.ok(build.includes(`'${HELPER_IN_PACKAGE}'`), 'build-native.mjs writes dist/native/buddi-computer');
  const pkg = JSON.parse(await readFile(path.join(root, 'packages/tools/browser/package.json'), 'utf8'));
  assert.ok(pkg.files.includes('dist'), 'dist (and so dist/native) is in the files the release copies');
  assert.strictEqual(STAGED_HELPER, `packages/tools/browser/${HELPER_IN_PACKAGE}`);
  assert.strictEqual(INSTALLED_HELPER, `node_modules/@buddi/tool-browser/${HELPER_IN_PACKAGE}`);
});

test('a release refuses a stage without the helper; a local pack goes on without it', async () => {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'buddi-native-'));
  try {
    await expect(stageNativeHelper(stage, { require: true })).rejects.toThrow(/is missing: a release ships the macOS computer helper/);
    assert.strictEqual(await stageNativeHelper(stage, { require: false }), false);
    const file = path.join(stage, STAGED_HELPER);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'binary', { mode: 0o644 }); // as an artifact download leaves it
    assert.strictEqual(await stageNativeHelper(stage, { require: true }), true);
    assert.strictEqual((await stat(file)).mode & 0o777, 0o755);
  } finally { await rm(stage, { recursive: true, force: true }); }
});

test('the pack check wants the helper at the installed path, executable', () => {
  assert.strictEqual(helperInPack([{ path: INSTALLED_HELPER, mode: 0o755 }]), true);
  assert.strictEqual(helperInPack([{ path: INSTALLED_HELPER, mode: 0o644 }]), false);
  assert.strictEqual(helperInPack([{ path: STAGED_HELPER, mode: 0o755 }]), false);
  assert.strictEqual(helperInPack([]), false);
});

/** Where the installation lives: only buddi's own workspace is a checkout, never any pnpm monorepo above the module. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, isRepoRoot } from './paths.js';

function workspace(name: string, withCli = true): string {
  const root = mkdtempSync(path.join(tmpdir(), 'buddi-ws-'));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true }));
  if (withCli) {
    mkdirSync(path.join(root, 'packages', 'cli'), { recursive: true });
    writeFileSync(path.join(root, 'packages', 'cli', 'package.json'), '{}');
  }
  return root;
}

describe('the repo root', () => {
  it('is buddi\'s workspace', () => {
    expect(isRepoRoot(workspace('buddi'))).toBe(true);
  });

  it('is not someone else\'s pnpm monorepo, nor a manifest without buddi\'s packages', () => {
    expect(isRepoRoot(workspace('acme-monorepo'))).toBe(false);
    expect(isRepoRoot(workspace('buddi', false))).toBe(false);
  });

  it('npx @withbuddi/buddi inside a foreign monorepo finds no checkout above it', () => {
    const foreign = workspace('acme-monorepo');
    const moduleDir = path.join(foreign, 'node_modules', '@withbuddi', 'buddi', 'packages', 'cli', 'dist');
    mkdirSync(moduleDir, { recursive: true });
    // The walk passes the foreign root by and falls back: REPO_FOUND is false, so mode.ts says packaged.
    expect(isRepoRoot(findRepoRoot(moduleDir))).toBe(false);
    // buddi's own checkout is still found from its dist.
    const own = workspace('buddi');
    const dist = path.join(own, 'packages', 'cli', 'dist');
    mkdirSync(dist, { recursive: true });
    expect(findRepoRoot(dist)).toBe(own);
  });
});

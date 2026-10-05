/**
 * What `buddi doctor` reads about the running gateway's pages: written by the
 * gateway, read back only while the process that wrote it is alive.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pagesStateFile, readPagesState, writePagesState } from './pages-state.js';

const dirs: string[] = [];
const envIn = (): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-pages-state-'));
  dirs.push(dir);
  return { BUDDI_DATA_DIR: dir };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the pages the running gateway serves', () => {
  it('writes each plugin with a page once, sorted, and reads it back', () => {
    const env = envIn();
    const registry = { pages: () => [{ plugin: 'weather' }, { plugin: 'calendar' }, { plugin: 'calendar' }] };
    writePagesState(env, registry, new Date('2026-10-04T12:00:00Z'));
    expect(readPagesState(env)).toEqual({ pid: process.pid, at: '2026-10-04T12:00:00.000Z', plugins: ['calendar', 'weather'] });
  });

  it('says nothing when no gateway wrote it, or the one that did is gone', () => {
    const env = envIn();
    expect(readPagesState(env)).toBeUndefined();
    writePagesState(env, { pages: () => [{ plugin: 'weather' }] });
    const file = pagesStateFile(env);
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: '2026-10-04T12:00:00Z', plugins: ['weather'] }));
    expect(readPagesState(env)).toBeUndefined();
  });
});

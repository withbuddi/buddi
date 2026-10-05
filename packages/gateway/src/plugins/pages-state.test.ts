/**
 * What `buddi doctor` reads about the running gateway's pages: written by the
 * gateway, read back only while the process that wrote it is alive.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pagesStateFile, processStartedAt, readPagesState, writePagesState } from './pages-state.js';

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
    const read = { now: new Date('2026-10-04T12:05:00Z'), startedAt: () => new Date('2026-10-04T11:00:00Z') };
    expect(readPagesState(env, read)).toEqual({ pid: process.pid, at: '2026-10-04T12:00:00.000Z', plugins: ['calendar', 'weather'] });
  });

  it('says nothing when no gateway wrote it, or the one that did is gone', () => {
    const env = envIn();
    expect(readPagesState(env)).toBeUndefined();
    writePagesState(env, { pages: () => [{ plugin: 'weather' }] });
    const file = pagesStateFile(env);
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: '2026-10-04T12:00:00Z', plugins: ['weather'] }));
    expect(readPagesState(env)).toBeUndefined();
  });

  it('does not trust a pid somebody else holds now, a file over a day old, or one written before its pid started', () => {
    const env = envIn();
    const file = pagesStateFile(env);
    writePagesState(env, { pages: () => [{ plugin: 'weather' }] }, new Date());
    // pid 1 is alive and not ours: EPERM is a reused number, not our gateway.
    writeFileSync(file, JSON.stringify({ pid: 1, at: new Date().toISOString(), plugins: ['weather'] }));
    // (Run as root, pid 1 is signalable and this case says nothing.)
    if (process.getuid?.() !== 0) expect(readPagesState(env, { startedAt: () => new Date(0) })).toBeUndefined();
    // Our own live pid, but the file is from the day before yesterday.
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: old.toISOString(), plugins: ['weather'] }));
    expect(readPagesState(env, { startedAt: () => new Date(0) })).toBeUndefined();
    // Fresh, but written before the process with this pid began: a leftover.
    const at = new Date();
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: at.toISOString(), plugins: ['weather'] }));
    expect(readPagesState(env, { startedAt: () => new Date(at.getTime() + 60_000) })).toBeUndefined();
    // Written after it started: believed.
    expect(readPagesState(env, { startedAt: () => new Date(at.getTime() - 60_000) })?.plugins).toEqual(['weather']);
    // And `ps` really can say when this process started.
    expect(processStartedAt(process.pid)?.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

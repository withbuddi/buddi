/**
 * The gist: the one line, out of a call's arguments, that tells a row of
 * "Shed · Write" from the next one. Read by shape — the tools here are made
 * up, which is the point: no plugin needs to be installed for a row to say
 * which file and which command.
 */
import { describe, expect, it } from 'vitest';
import { GIST_MAX, gistFor } from './gist';

describe('the gist of a tool call', () => {
  it('names the file a write, an edit or a read went to', () => {
    expect(gistFor('shed.write', { path: 'src/app.ts', content: 'export {}' })).toBe('src/app.ts');
    expect(gistFor('shed.edit', { path: 'README.md', old: 'a', new: 'b' })).toBe('README.md');
    expect(gistFor('shed.read', { path: 'package.json', from: 1 })).toBe('package.json');
  });

  it('names the command a run ran, and a started process by its name too', () => {
    expect(gistFor('shed.run', { command: 'pnpm test', cwd: 'web' })).toBe('pnpm test');
    expect(gistFor('shed.start', { name: 'dev', command: 'pnpm dev', port: 5173 })).toBe('dev: pnpm dev');
  });

  it('prefers what a search looked for over where it looked', () => {
    expect(gistFor('shed.search', { query: 'TODO', path: 'src', glob: '*.ts' })).toBe('TODO');
    expect(gistFor('shed.list', { path: 'src', depth: 2 })).toBe('src');
    expect(gistFor('shed.fetch', { url: 'http://localhost:8080/health', retries: 2 })).toBe('http://localhost:8080/health');
    expect(gistFor('shed.workspace', { dir: '/Users/me/code/site' })).toBe('/Users/me/code/site');
  });

  it('says an action with what it was about', () => {
    expect(gistFor('shed.git', { action: 'status' })).toBe('status');
    expect(gistFor('shed.git', { action: 'commit', message: 'fix the thing' })).toBe('commit · fix the thing');
    expect(gistFor('shed.git', { action: 'branch', task: 'dark mode' })).toBe('branch · dark mode');
  });

  it('falls back to the only string argument there is', () => {
    expect(gistFor('shed.lookup', { name: 'rake', count: 3 })).toBe('rake');
    // Two strings and no subject field: no way to know which one matters.
    expect(gistFor('shed.lookup', { name: 'rake', colour: 'red' })).toBeNull();
  });

  it('never draws an object, and has nothing to say about a call with no arguments', () => {
    expect(gistFor('shed.lookup', { filter: { name: 'rake' } })).toBeNull();
    expect(gistFor('shed.write', { path: { nested: true } })).toBeNull();
    expect(gistFor('shed.list', {})).toBeNull();
    expect(gistFor('shed.lookup', null)).toBeNull();
    expect(gistFor('shed.lookup', 'a string')).toBeNull();
    expect(gistFor('shed.run', { command: '   ' })).toBeNull();
  });

  it('keeps to one line, and cuts a long one with an ellipsis', () => {
    expect(gistFor('shed.run', { command: 'pnpm\n  test --run' })).toBe('pnpm test --run');
    const long = gistFor('shed.write', { path: `src/${'a'.repeat(200)}.ts` });
    expect(long).toHaveLength(GIST_MAX);
    expect(long?.endsWith('…')).toBe(true);
  });
});

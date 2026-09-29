/**
 * `/api/plugins/folders`: the owner's home and what is under it, never a
 * step outside, hidden folders only when asked for by name.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginFoldersRoute, type FoldersView } from './folders.js';

let root: string;
let home: string;
let outside: string;

const ask = (p?: string) =>
  pluginFoldersRoute({ HOME: home }, new URL(`http://x/api/plugins/folders${p === undefined ? '' : `?path=${encodeURIComponent(p)}`}`));

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'buddi-folders-')));
  home = path.join(root, 'home');
  outside = path.join(root, 'elsewhere');
  mkdirSync(path.join(home, 'code', 'buddi-plugin-garden'), { recursive: true });
  writeFileSync(path.join(home, 'code', 'buddi-plugin-garden', 'package.json'), '{}');
  mkdirSync(path.join(home, 'code', 'notes'));
  mkdirSync(path.join(home, 'Documents'));
  mkdirSync(path.join(home, '.config', 'thing'), { recursive: true });
  writeFileSync(path.join(home, 'readme.txt'), 'a file, not a folder');
  mkdirSync(outside);
  symlinkSync(outside, path.join(home, 'out-link'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('GET /api/plugins/folders', () => {
  it('starts at the home directory, folders only, hidden ones and links out left out', () => {
    const reply = ask();
    expect(reply.status).toBe(200);
    const view = reply.body as FoldersView;
    expect(view.path).toBe(home);
    expect(view.parent).toBeNull();
    expect(view.folders.map((f) => f.name)).toEqual(['code', 'Documents']);
  });

  it('goes down a level, says which folders hold a package.json, and the way back up', () => {
    const view = ask(path.join(home, 'code')).body as FoldersView;
    expect(view.parent).toBe(home);
    expect(view.folders).toEqual([
      { name: 'buddi-plugin-garden', path: path.join(home, 'code', 'buddi-plugin-garden'), plugin: true },
      { name: 'notes', path: path.join(home, 'code', 'notes'), plugin: false },
    ]);
  });

  it('answers a hidden folder named explicitly', () => {
    const reply = ask(path.join(home, '.config'));
    expect(reply.status).toBe(200);
    expect((reply.body as FoldersView).folders.map((f) => f.name)).toEqual(['thing']);
  });

  it('refuses a path outside the home directory, however it is spelled', () => {
    expect(ask(outside).status).toBe(403);
    expect(ask(path.join(home, '..', 'elsewhere')).status).toBe(403);
    expect(ask(path.join(home, 'out-link')).status).toBe(403);
    expect(ask('/').status).toBe(403);
    expect((ask(outside).body as { error: string }).error).toBe('Only folders inside your home directory are listed here.');
  });

  it('refuses a relative path, a file and a folder that is not there', () => {
    expect(ask('code').status).toBe(400);
    expect(ask(path.join(home, 'readme.txt')).status).toBe(400);
    expect(ask(path.join(home, 'nope')).status).toBe(404);
  });
});

/**
 * Files as rows (docs/files.md): `/api/files/:id` — the editor's read, the
 * owner's save and Restore as new versions, delete and undelete — and the
 * store under them: one file per row of core.files, its versions appended,
 * one lock per file, blobs shared and unlinked only when nothing names them.
 *
 * The first test is the owner's own flow end to end: buddi writes a packing
 * list, he edits it on the Canvas, buddi adds a section over his edit, and it
 * is one tab, one Files row, three versions.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A rename that fails once, on demand: the write-through after the commit.
const control = vi.hoisted(() => ({ failRename: false }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      // Only the write-through's rename into the workspace (its staged copy is `.<name>.buddi-<uuid>`), not a blob's.
      if (control.failRename && String(from).split(/[\\/]/).pop()!.includes('.buddi-')) { control.failRename = false; throw new Error('the disk is full'); }
      return real.rename(from, to);
    },
  };
});
import pg from 'pg';
import {
  CORE_MIGRATIONS_DIR, CORE_SCHEMA, FileChangedError, FileGoneError, ToolRegistry, createPool, deleteFile, ensureOwner, getFile,
  isTextFile, migrate, purgeDeletedArtifacts, saveArtifact, saveDocument, saveOwnerVersion, saveVersion, storagePathFor,
  type AgentCatalog, type CoreToolContext,
} from '@buddi/core';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { confinedMarkPath, enterWorkspace, hostWorkspaceDir } from '@buddi/tool-host';
import { ownerEditLine, systemContext } from '../system-context.js';
import { readChatTranscript } from './chat.js';
import { testDatabaseUrl } from '@buddi/core/testing';
import { createApiToken } from './api-tokens.js';
import { startWebServer, type WebServer } from './server.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_file_content_test_${process.pid}`;

const emptyCatalog = (): AgentCatalog =>
  ({ get: () => undefined, byHandle: () => undefined, list: () => [], agentsWithRole: () => [], defaultAgent: () => undefined, resolve: () => undefined }) as unknown as AgentCatalog;

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

suite('files as rows', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let base: string;
  let dir: string;
  let token: string;
  let env: Record<string, string | undefined>;
  let conversationId: string;
  let previousDataDir: string | undefined;
  const registry = new ToolRegistry();

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    conversationId = await conversation();
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-file-content-'));
    // The agent's tools read the data dir from the process, as the running gateway does.
    previousDataDir = process.env.BUDDI_DATA_DIR;
    process.env.BUDDI_DATA_DIR = dir;
    env = { ...process.env, BUDDI_DATA_DIR: dir };
    registry.register(artifactsManifest);
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    web = await startWebServer({
      pool, registry, catalog: emptyCatalog(), ctx, timezone: 'UTC', now: () => new Date(), env,
      config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'a-test-dashboard-token-long-enough', openAccess: false, log: () => {},
    });
    base = `http://127.0.0.1:${web.port}`;
    token = (await createApiToken(pool, { name: 'script', via: 'cli' })).token;
  }, 60_000);

  afterAll(async () => {
    await web?.close();
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (previousDataDir === undefined) delete process.env.BUDDI_DATA_DIR;
    else process.env.BUDDI_DATA_DIR = previousDataDir;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function conversation(): Promise<string> {
    return (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id as string;
  }

  const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const read = (id: string): Promise<Response> => fetch(`${base}/api/files/${id}/content`, { headers: auth() });
  const view = async (id: string): Promise<{ file: { id: string; name: string; createdBy: string }; current: { version: number; artifactId: string }; versions: Array<{ id: string; version: number; createdBy: string; restoredFrom: number | null; filename: string; sha256: string }> }> =>
    (await fetch(`${base}/api/files/${id}`, { headers: auth() })).json() as never;
  const save = (id: string, body: unknown): Promise<Response> => fetch(`${base}/api/files/${id}/versions`, json(body));
  const list = async (q: string): Promise<Array<{ id: string; fileId: string; version: number; versions: number; filename: string }>> =>
    ((await (await fetch(`${base}/api/artifacts?q=${encodeURIComponent(q)}`, { headers: auth() })).json()) as { entries: never[] }).entries;
  /** A file as a plugin or a surface saves one: returns its file id. */
  const file = async (text: string | Buffer, filename: string, mime = 'text/markdown', conversation: string | null = conversationId, createdBy = 'scout'): Promise<string> =>
    (await saveArtifact(pool, { bytes: Buffer.isBuffer(text) ? text : Buffer.from(text), mime, filename, createdBy, conversationId: conversation }, env)).fileId;
  const blob = async (text: string): Promise<boolean> => {
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(path.join(dir, 'artifacts'), { recursive: true }).catch(() => [] as string[]);
    return names.some((name) => String(name).includes(sha(text)));
  };
  const agent = (conversation: string): CoreToolContext => ({ db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC', agentId: 'scout', conversationId: conversation });
  const call = async (name: string, args: unknown, conversation: string): Promise<any> => {
    const result = await registry.invoke(name, args, agent(conversation));
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };
  /** A command's output in scout's workspace, captured as host.exec captures it. */
  const captured = async (name: string, text: string, conversation = conversationId, who = 'scout'): Promise<{ fileId: string; artifactId: string; onDisk: string }> => {
    const data = await realpath(dir);
    const onDisk = path.join(hostWorkspaceDir(data, 'owner', who, conversation), name);
    await mkdir(path.dirname(onDisk), { recursive: true });
    await writeFile(onDisk, text);
    const row = await saveArtifact(pool, {
      bytes: Buffer.from(text), mime: 'text/markdown', filename: path.basename(name), createdBy: who, conversationId: conversation,
      source: { surface: 'host', chatId: conversation }, originPath: path.relative(data, onDisk),
    }, env);
    return { fileId: row.fileId, artifactId: row.id, onDisk };
  };

  describe('the owner’s flow: buddi writes, he edits, buddi adds a section over his edit', () => {
    const PACKING = '# Montreal weekend packing list\n\n## Clothes\n- Socks\n- A warm coat\n';
    const MINE = '# Montreal weekend packing list\n\n## Clothes\n- Socks\n- A warm coat\n- Gloves (mine)\n';

    /** Steps 2–4, the same whichever way the list was written. */
    const editThenAddASection = async (conversation: string, first: { fileId: string; artifactId: string }, results: Array<{ id: string; name: string; output: unknown }>): Promise<void> => {
      // 2. He edits it on the Canvas and saves: a new version, his.
      const opened = (await (await read(first.fileId)).json()) as { version: number; text: string };
      expect(opened).toMatchObject({ version: 1, text: PACKING });
      const saved = await save(first.fileId, { base: 1, text: MINE });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ fileId: first.fileId, version: 2, createdBy: 'owner', created: true });

      // The next turn says the newest version is his, and how to build on it.
      const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
      const told = await systemContext(ctx, { agentId: 'scout', tools: ['artifacts.text', 'artifacts.write', 'host.exec'], conversationId: conversation });
      expect(told.prompt).toContain('is the owner\'s (v2, saved');
      expect(told.prompt).toContain(`readVersion: 2`);

      // 3. Asked to add a section, buddi writes without reading first: refused.
      const section = '\n## Toiletries\n- Toothbrush\n';
      const blind = await registry.invoke('artifacts.write', { title: 'Montreal weekend packing list', format: 'markdown', content: PACKING + section, fileId: first.fileId }, agent(conversation));
      expect(blind.ok).toBe(false);
      // It reads the owner's version, keeps his edit, and writes v3.
      const current = await call('artifacts.text', { id: first.artifactId }, conversation);
      // The version it named was v1; the text tool says which file, and that version.
      expect(current).toMatchObject({ fileId: first.fileId, version: 1 });
      const newest = await call('artifacts.text', { id: (await view(first.fileId)).current.artifactId }, conversation);
      expect(newest).toMatchObject({ fileId: first.fileId, version: 2 });
      expect(newest.text.trim()).toBe(MINE.trim());
      const v3 = await call('artifacts.write', { title: 'Montreal weekend packing list', format: 'markdown', content: `${newest.text.trim()}\n${section}`, fileId: first.fileId, readVersion: 2 }, conversation);
      expect(v3).toMatchObject({ fileId: first.fileId, version: 3 });
      results.push({ id: 'w3', name: 'artifacts.write', output: v3 });

      // 4. One file, three versions, the owner's edit kept in the newest.
      expect((await (await read(first.fileId)).json()) as { version: number; text: string }).toMatchObject({ version: 3, text: MINE + section });
      const page = await view(first.fileId);
      expect(page.versions.map((v) => [v.version, v.createdBy])).toEqual([[3, 'scout'], [2, 'owner'], [1, 'scout']]);
      // No version mark in any stored name.
      expect(new Set(page.versions.map((v) => v.filename)).size).toBe(1);
      expect(page.versions[0]!.filename).not.toMatch(/\(v\d+\)/);
      const rows = (await list('packing')).filter((entry) => entry.fileId === first.fileId);
      expect(rows).toEqual([expect.objectContaining({ fileId: first.fileId, version: 3, versions: 3 })]);

      // One canvas tab: every call that made it names the same file.
      for (const [index, result] of results.entries()) {
        await pool.query('insert into core.messages (conversation_id, role, content) values ($1, $2, $3), ($1, $4, $5)', [
          conversation, 'assistant', JSON.stringify([{ type: 'tool_use', id: `${result.id}-${index}`, name: result.name, input: {} }]),
          'user', JSON.stringify([{ type: 'tool_result', tool_use_id: `${result.id}-${index}`, content: JSON.stringify(result.output) }]),
        ]);
      }
      const transcript = await readChatTranscript(pool, conversation, new Date(), undefined, (tool) => tool === 'artifacts.write' || tool === 'host.exec');
      const made = transcript!.messages.flatMap((m) => m.blocks)
        .flatMap((b) => (b.type === 'tool_result' ? b.files ?? [] : []));
      expect(made.length).toBe(results.length);
      expect(new Set(made.map((f) => f.fileId))).toEqual(new Set([first.fileId]));
    };

    it('through artifacts.write', async () => {
      const here = await conversation();
      const v1 = await call('artifacts.write', { title: 'Montreal weekend packing list', format: 'markdown', content: PACKING }, here);
      expect(v1).toMatchObject({ filename: 'Montreal weekend packing list.md', version: 1 });
      await editThenAddASection(here, { fileId: v1.fileId, artifactId: v1.artifactId }, [{ id: 'w1', name: 'artifacts.write', output: v1 }]);
    });

    it('through a command’s output (cat > packing-list.md)', async () => {
      const here = await conversation();
      const out = await captured('packing-list.md', PACKING, here);
      const result = { artifacts: [{ id: out.artifactId, filename: 'packing-list.md', mime: 'text/markdown' }] };
      await editThenAddASection(here, out, [{ id: 'x1', name: 'host.exec', output: result }]);
      // His save reached the workspace copy; buddi's v3 by fileId did not touch it.
      expect(await readFile(out.onDisk, 'utf8')).toBe(MINE);
      expect((await view(out.fileId)).file.name).toBe('packing-list.md');
    });
  });

  it('reads a text file’s current version whole, with the version a save names', async () => {
    const id = await file('# Plan\n\nOne\n', 'Plan.md');
    const res = await read(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fileId: id, version: 1, text: '# Plan\n\nOne\n', sha256: sha('# Plan\n\nOne\n'), sizeBytes: 12, editable: true, truncated: false, createdBy: 'scout' });
  });

  it('saves a new version over the one opened, and refuses a save over an older one with the version that won', async () => {
    const id = await file('alpha\n', 'notes.txt', 'text/plain');
    const first = await save(id, { base: 1, text: 'alpha\nbeta\n' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ version: 2, sha256: sha('alpha\nbeta\n'), sizeBytes: 11, created: true });
    // A second tab still on v1: refused, one shape.
    const stale = await save(id, { base: 1, text: 'alpha\ngamma\n' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ conflict: 'newer', error: 'This file changed since you opened it: v2 is newer.', current: { fileId: id, version: 2, createdBy: 'owner' } });
    // Nothing was rewritten: v1 is still there, as it was.
    expect((await view(id)).versions.map((v) => [v.version, v.sha256])).toEqual([[2, sha('alpha\nbeta\n')], [1, sha('alpha\n')]]);
  });

  it('lets one of two saves at once win, and stores no bytes for the loser', async () => {
    const id = await file('race\n', 'race.txt', 'text/plain');
    const answers = await Promise.all([save(id, { base: 1, text: 'race one\n' }), save(id, { base: 1, text: 'race two\n' })]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 409]);
    const won = (await (await read(id)).json()) as { text: string };
    expect(await blob(won.text)).toBe(true);
    expect(await blob(won.text === 'race one\n' ? 'race two\n' : 'race one\n')).toBe(false);
  });

  it('shows text that is not UTF-8, and never saves over it from the editor', async () => {
    const latin1 = Buffer.from('caf\xe9\n', 'latin1');
    const id = await file(latin1, 'menu.txt', 'text/plain');
    expect(await (await read(id)).json()).toMatchObject({ editable: false, note: 'encoding' });
    expect((await save(id, { base: 1, text: 'café\n' })).status).toBe(415);
  });

  it('refuses what is not text, ids that look like paths, and bad bodies', async () => {
    const png = await file('not really a png', 'a.png', 'image/png', null);
    expect((await read(png)).status).toBe(415);
    expect((await save(png, { base: 1, text: 'x' })).status).toBe(415);
    expect((await read('11111111-1111-4111-8111-111111111111')).status).toBe(404);
    expect((await save('11111111-1111-4111-8111-111111111111', { base: 1, text: 'x' })).status).toBe(404);
    for (const probe of ['..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fhosts', 'not-an-id']) {
      expect([404, 405]).toContain((await read(probe)).status);
      expect([404, 405]).toContain((await save(probe, { base: 1, text: 'x' })).status);
    }
    const id = await file('a\n', 'b.txt', 'text/plain');
    expect((await save(id, { text: 'b' })).status).toBe(400);
    expect((await save(id, { base: 'sha', text: 'b' })).status).toBe(400);
    expect((await save(id, { base: 1, text: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
  });

  it('classifies text with one rule, the editor’s and the server’s', async () => {
    // What the editor once opened and the server refused with 415.
    for (const [mime, name] of [['application/yaml', 'config.yaml'], ['application/x-sh', 'run.sh'], ['application/octet-stream', 'tool.mjs'], ['application/octet-stream', 'lib.cjs'], ['application/octet-stream', 'setup.zsh']] as const) {
      expect(isTextFile(mime, name)).toBe(true);
      const id = await file('echo hi\n', name, mime, null);
      expect((await read(id)).status).toBe(200);
    }
    expect(isTextFile('text/plain', 'sheet.xlsx')).toBe(false);
  });

  it('downloads a version under its file’s name with the version mark, which no stored name carries', async () => {
    const id = await file('# Report\n', 'Report.md');
    await save(id, { base: 1, text: '# Report, mine\n' });
    const v2 = (await view(id)).current.artifactId;
    const res = await fetch(`${base}/api/artifacts/${v2}/download`, { headers: auth() });
    expect(res.headers.get('content-disposition')).toContain(encodeURIComponent('Report (v2).md'));
    expect((await view(id)).versions.every((v) => v.filename === 'Report.md')).toBe(true);
  });

  describe('Restore', () => {
    it('copies the version’s bytes — never its preview — even past 1 MiB or not UTF-8', async () => {
      // Codex P1: Restore saved the preview text: a big file lost its end, Latin-1 its characters.
      const big = Buffer.concat([Buffer.from('caf\xe9 ', 'latin1'), Buffer.alloc(1024 * 1024 + 10, 0x61)]);
      const id = await file(big, 'big.txt', 'text/plain');
      await saveVersion(pool, { id, bytes: Buffer.from('small, by buddi\n'), createdBy: 'scout' }, env);
      const res = await save(id, { base: 2, from: 1 });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ version: 3, createdBy: 'owner', sha256: sha(big) });
      const page = await view(id);
      expect(page.versions[0]).toMatchObject({ version: 3, restoredFrom: 1, sha256: sha(big) });
    });

    it('restores an older capture to its workspace, though the bytes repeat an earlier version', async () => {
      // Codex P2: the capture's dedup key made a Restore a 23505 and a 409 forever.
      const one = await captured('restore/trip.md', '# Trip one\n');
      const two = await captured('restore/trip.md', '# Trip two\n');
      expect(two.fileId).toBe(one.fileId);
      const res = await save(one.fileId, { base: 2, from: 1 });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ version: 3, workspace: { updated: true } });
      expect(await readFile(one.onDisk, 'utf8')).toBe('# Trip one\n');
      // A deleted version's bytes do not block one either.
      await fetch(`${base}/api/files/${one.fileId}/versions/1`, { method: 'DELETE', headers: auth() });
      expect((await save(one.fileId, { base: 3, from: 2 })).status).toBe(200);
      expect((await save(one.fileId, { base: 4, from: 3 })).status).toBe(200);
    });

    it('is refused like a save when a newer version was saved meanwhile', async () => {
      const id = await file('# A\n', 'restore-race.md');
      await saveVersion(pool, { id, bytes: Buffer.from('# B\n'), createdBy: 'scout' }, env);
      await saveVersion(pool, { id, bytes: Buffer.from('# C\n'), createdBy: 'scout' }, env);
      const res = await save(id, { base: 2, from: 1 });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ conflict: 'newer', current: { version: 3 } });
    });
  });

  describe('a command’s output', () => {
    it('writes the owner’s save back to the workspace it came from', async () => {
      const { fileId, onDisk } = await captured('packing.md', '# Packing\n\n- Socks\n');
      const res = await save(fileId, { base: 1, text: '# Packing\n\n- Socks\n- Mine\n' });
      expect(res.status).toBe(200);
      expect(await readFile(onDisk, 'utf8')).toBe('# Packing\n\n- Socks\n- Mine\n');
    });

    it('refuses when the workspace copy changed since, with what it holds, until he overwrites it', async () => {
      const { fileId, onDisk } = await captured('trip.md', '# Trip\n');
      await writeFile(onDisk, '# Trip\n\n## Toiletries\n');
      const stale = await save(fileId, { base: 1, text: '# Trip\n\nMine\n' });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ conflict: 'workspace', workspaceText: '# Trip\n\n## Toiletries\n', current: { fileId, version: 1 } });
      expect(await readFile(onDisk, 'utf8')).toBe('# Trip\n\n## Toiletries\n');
      const forced = await save(fileId, { base: 1, text: '# Trip\n\nMine\n', overwriteWorkspace: true });
      expect(forced.status).toBe(200);
      expect(await readFile(onDisk, 'utf8')).toBe('# Trip\n\nMine\n');
    });

    it('never writes through a linked folder, or a linked workspace', async () => {
      const data = await realpath(dir);
      const outside = await mkdtemp(path.join(tmpdir(), 'buddi-outside-'));
      await writeFile(path.join(outside, 'f.md'), '# Outside\n');
      const workspace = hostWorkspaceDir(data, 'owner', 'scout', conversationId);
      await mkdir(workspace, { recursive: true });
      await symlink(outside, path.join(workspace, 'sub'));
      const viaParent = await saveArtifact(pool, {
        bytes: Buffer.from('# Outside\n'), mime: 'text/markdown', filename: 'f.md', createdBy: 'scout', conversationId,
        source: { surface: 'host', chatId: conversationId }, originPath: path.relative(data, path.join(workspace, 'sub', 'f.md')),
      }, env);
      const one = await save(viaParent.fileId, { base: 1, text: '# Escaped\n' });
      expect(one.status).toBe(200);
      expect(await one.json()).toMatchObject({ workspace: { updated: false }, note: expect.stringMatching(/^Saved in Files; the workspace copy couldn’t be updated/) });
      const linked = hostWorkspaceDir(data, 'owner', 'linker', conversationId);
      await mkdir(path.dirname(linked), { recursive: true });
      await symlink(outside, linked);
      const viaRoot = await saveArtifact(pool, {
        bytes: Buffer.from('# Outside\n'), mime: 'text/markdown', filename: 'f.md', createdBy: 'linker', conversationId,
        source: { surface: 'host', chatId: conversationId }, originPath: path.relative(data, path.join(linked, 'f.md')),
      }, env);
      expect(await (await save(viaRoot.fileId, { base: 1, text: '# Escaped\n' })).json()).toMatchObject({ workspace: { updated: false } });
      expect(await readFile(path.join(outside, 'f.md'), 'utf8')).toBe('# Outside\n');
      await rm(outside, { recursive: true, force: true });
    });

    it('refuses while a command runs in any conversation, and saves once it is done', async () => {
      // Codex P1: a command in another conversation may have its cwd in this workspace.
      const { fileId, onDisk } = await captured('busy.md', '# Busy\n');
      const leave = await enterWorkspace();
      const refused = await save(fileId, { base: 1, text: '# Mine\n' });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ conflict: 'busy', error: expect.stringMatching(/running a command/) });
      leave();
      expect((await save(fileId, { base: 1, text: '# Mine\n' })).status).toBe(200);
      expect(await readFile(onDisk, 'utf8')).toBe('# Mine\n');
    });

    it('reports a copy it could not update after the save, and saving the same text again writes it', async () => {
      const { fileId, onDisk } = await captured('full.md', '# Full\n');
      control.failRename = true;
      const partial = await save(fileId, { base: 1, text: '# Mine\n' });
      expect(partial.status).toBe(200);
      expect(await partial.json()).toMatchObject({ version: 2, workspace: { updated: false, reason: 'the disk is full' }, note: 'Saved in Files; the workspace copy couldn’t be updated: the disk is full.' });
      expect(await readFile(onDisk, 'utf8')).toBe('# Full\n');
      const again = await save(fileId, { base: 2, text: '# Mine\n' });
      expect(await again.json()).toMatchObject({ version: 2, created: false, workspace: { updated: true } });
      expect(await readFile(onDisk, 'utf8')).toBe('# Mine\n');
    });

    it('says when the workspace copy is gone, and saves in Files only', async () => {
      const { fileId, onDisk } = await captured('gone.md', '# Gone\n');
      await rm(onDisk);
      expect(await (await save(fileId, { base: 1, text: '# Mine\n' })).json())
        .toMatchObject({ workspace: { updated: false, reason: 'the workspace copy is gone; saved in Files only' } });
    });

    it('finishes a write-through on a pool of one connection', async () => {
      const { fileId, onDisk } = await captured('one-connection.md', '# One\n');
      const url = new URL(databaseUrl as string);
      url.pathname = `/${TEST_DB}`;
      const single = new pg.Pool({ connectionString: url.toString(), max: 1 });
      try {
        const done = saveOwnerVersion(single, {
          fileId, bytes: Buffer.from('# Two\n'), base: 1,
          workspace: async () => ({ kind: 'write', commit: () => writeFile(onDisk, '# Two\n'), abort: async () => {} }),
        }, env);
        const result = await Promise.race([done, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5_000))]);
        expect(result).toMatchObject({ ok: true, workspace: { updated: true } });
        expect((await getFile(pool, fileId))!.originSha256).toBe(sha('# Two\n'));
      } finally {
        await single.end();
      }
    });

    it('keeps two paths with one name as two files, and the same path captured again as one', async () => {
      const left = await captured('left/paired.md', '# Same\n');
      const right = await captured('right/paired.md', '# Same\n');
      expect(left.fileId).not.toBe(right.fileId);
      const again = await captured('left/paired.md', '# Left, again\n');
      expect(again.fileId).toBe(left.fileId);
      expect((await list('paired')).map((entry) => entry.versions).sort()).toEqual([1, 2]);
      expect((await save(right.fileId, { base: 1, text: '# Right\n' })).status).toBe(200);
      expect(await readFile(right.onDisk, 'utf8')).toBe('# Right\n');
      expect(await readFile(left.onDisk, 'utf8')).toBe('# Left, again\n');
    });

    it('continues by fileId whoever writes, keeping the workspace it belongs to', async () => {
      // Codex P2: writing a capture as another author started a new file and moved its workspace.
      const out = await captured('cont/packing.md', '# Packing\n');
      const next = await saveVersion(pool, { id: out.fileId, bytes: Buffer.from('# Packing\n\n## Toiletries\n'), createdBy: 'ledger' }, env).catch((err: unknown) => err);
      // Another agent wrote over scout's newest without reading it: refused.
      expect(next).toBeInstanceOf(FileChangedError);
      const read2 = await saveVersion(pool, { id: out.fileId, bytes: Buffer.from('# Packing\n\n## Toiletries\n'), createdBy: 'ledger', readVersion: 1 }, env);
      expect(read2).toMatchObject({ row: { fileId: out.fileId, version: 2, createdBy: 'ledger' } });
      const file = (await getFile(pool, out.fileId))!;
      expect(file).toMatchObject({ createdBy: 'scout', origin: 'capture' });
      expect(file.originSha256).toBe(sha('# Packing\n'));
      // The owner's save still writes back to scout's workspace copy.
      const saved = await save(out.fileId, { base: 2, text: '# Packing\n\n## Toiletries\n- Mine\n' });
      expect(await saved.json()).toMatchObject({ workspace: { updated: true } });
      expect(await readFile(out.onDisk, 'utf8')).toBe('# Packing\n\n## Toiletries\n- Mine\n');
    });

    it('continues an owner upload outside any conversation by fileId', async () => {
      const id = await file('# Mine\n', 'mine.md', 'text/markdown', null, 'owner');
      const v2 = await saveVersion(pool, { id, bytes: Buffer.from('# Mine, tidied\n'), createdBy: 'scout', readVersion: 1 }, env);
      expect(v2.row).toMatchObject({ fileId: id, version: 2 });
      expect((await getFile(pool, id))!.createdBy).toBe('owner');
    });

    it('never writes outside the workspace of the agent and conversation that made the file', async () => {
      const { fileId, onDisk } = await captured('elsewhere.md', '# Elsewhere\n', conversationId, 'ledger');
      // The file says scout made it, but the copy is in ledger's workspace.
      await pool.query(`update core.files set created_by = 'scout' where id = $1`, [fileId]);
      expect((await save(fileId, { base: 1, text: '# Changed\n' })).status).toBe(200);
      expect(await readFile(onDisk, 'utf8')).toBe('# Elsewhere\n');
    });
  });

  describe('one lock per file', () => {
    it('makes two writes of one title at once one file', async () => {
      // Codex P2: the first write used a lock of its own, so two could both find no file.
      const here = await conversation();
      const write = (text: string) => saveDocument(pool, { conversationId: here, name: 'Plan.md', mime: 'text/markdown', bytes: Buffer.from(text), createdBy: 'scout' }, env);
      const [a, b] = await Promise.all([write('# One\n'), write('# Two\n')]);
      expect(a.file.id).toBe(b.file.id);
      expect([a.row.version, b.row.version].sort()).toEqual([1, 2]);
    });

    it('never lets an agent’s write and the owner’s save both win', async () => {
      for (let round = 0; round < 8; round += 1) {
        const here = await conversation();
        const first = await saveDocument(pool, { conversationId: here, name: 'Race.md', mime: 'text/markdown', bytes: Buffer.from('# v1\n'), createdBy: 'scout' }, env);
        const [owner, agentWrite] = await Promise.allSettled([
          saveOwnerVersion(pool, { fileId: first.file.id, bytes: Buffer.from('# mine\n'), base: 1 }, env),
          saveDocument(pool, { conversationId: here, name: 'Race.md', mime: 'text/markdown', bytes: Buffer.from('# theirs\n'), createdBy: 'scout' }, env),
        ]);
        const ownerWon = owner.status === 'fulfilled' && owner.value.ok;
        const agentWon = agentWrite.status === 'fulfilled';
        expect(ownerWon !== agentWon).toBe(true);
        if (!agentWon) expect((agentWrite as PromiseRejectedResult).reason).toBeInstanceOf(FileChangedError);
      }
    });

    it('never leaves a live version in a deleted file, however a write and a delete interleave', async () => {
      // Codex P2: the whole-file delete took no lock, so a version could land after it.
      for (let round = 0; round < 8; round += 1) {
        const id = await file(`# round ${round}\n`, `deleting-${round}.md`);
        const [, written] = await Promise.allSettled([
          deleteFile(pool, id),
          saveVersion(pool, { id, bytes: Buffer.from(`# round ${round}, again\n`), createdBy: 'scout' }, env),
        ]);
        if (written.status === 'rejected') expect(written.reason).toBeInstanceOf(FileGoneError);
        const { rows } = await pool.query('select count(*)::int as live from core.artifacts where file_id = $1 and deleted_at is null', [id]);
        expect((await getFile(pool, id))!.deletedAt).not.toBeNull();
        expect(rows[0].live).toBe(0);
      }
    });
  });

  it('deletes a version (the one before is the newest again), the whole file, and undoes each', async () => {
    const id = await file('# One\n', 'deleting.md');
    await saveVersion(pool, { id, bytes: Buffer.from('# Two\n'), createdBy: 'scout' }, env);
    await saveVersion(pool, { id, bytes: Buffer.from('# Three\n'), createdBy: 'scout' }, env);
    const remove = (suffix = '') => fetch(`${base}/api/files/${id}${suffix}`, { method: 'DELETE', headers: auth() });
    const undo = (body: unknown) => fetch(`${base}/api/files/${id}/undelete`, json(body));

    expect(await (await remove('/versions/3')).json()).toEqual({ fileId: id, version: 3, fileDeleted: false });
    expect((await view(id)).current.version).toBe(2);
    expect(await (await remove()).json()).toEqual({ fileId: id });
    expect((await read(id)).status).toBe(404);
    expect(await (await read(id)).json()).toMatchObject({ deleted: true });
    expect((await list('deleting')).filter((e) => e.fileId === id)).toEqual([]);
    expect((await remove()).status).toBe(404);

    // The file comes back with what it had when deleted; v3, deleted before, stays deleted.
    expect((await undo({})).status).toBe(200);
    expect((await view(id)).versions.map((v) => v.version)).toEqual([2, 1]);
    expect((await undo({ version: 3 })).status).toBe(200);
    expect((await view(id)).current.version).toBe(3);
    // A version written after a deleted one gets the next number, never a deleted one's.
    await remove('/versions/3');
    expect((await saveVersion(pool, { id, bytes: Buffer.from('# Four\n'), createdBy: 'scout' }, env)).row.version).toBe(4);
  });

  it('keeps an editor’s text as a new file of the owner’s, through the create path', async () => {
    const here = await conversation();
    const res = await fetch(`${base}/api/files`, json({ name: 'Draft.md', mime: 'text/markdown', text: '# Draft, mine\n', conversationId: here }));
    expect(res.status).toBe(200);
    const made = (await res.json()) as { fileId: string; version: number; filename: string };
    expect(made).toMatchObject({ version: 1, filename: 'Draft.md' });
    expect(await (await read(made.fileId)).json()).toMatchObject({ text: '# Draft, mine\n', createdBy: 'owner' });
    expect((await list('Draft')).some((e) => e.fileId === made.fileId)).toBe(true);
    expect((await fetch(`${base}/api/files`, json({ name: 'a.png', mime: 'image/png', text: 'x' }))).status).toBe(415);
  });

  it('makes a new file every time, even of bytes another file holds, and lists one made with no conversation', async () => {
    // Codex P2: the same text twice returned the first file; one with no conversation was not in Files.
    const here = await conversation();
    const made = async (body: unknown) => (await (await fetch(`${base}/api/files`, json(body))).json()) as { fileId: string; artifactId: string; filename: string };
    const a = await made({ name: 'Twin.md', mime: 'text/markdown', text: '# Twin\n', conversationId: here });
    const b = await made({ name: 'Other twin.md', mime: 'text/markdown', text: '# Twin\n', conversationId: here });
    expect(b.fileId).not.toBe(a.fileId);
    expect(b.filename).toBe('Other twin.md');
    const loose = await made({ name: 'Loose.md', mime: 'text/markdown', text: '# Loose\n' });
    expect((await list('Loose')).map((e) => e.fileId)).toContain(loose.fileId);
  });

  it('serves the Files page from the file: its entry, an older version on request, and a version’s id names its file', async () => {
    const id = await file('# Page one\n', 'page.md');
    await saveVersion(pool, { id, bytes: Buffer.from('# Page two\n'), createdBy: 'scout' }, env);
    const newest = (await (await fetch(`${base}/api/files/${id}`, { headers: auth() })).json()) as { entry: { version: number }; available: boolean; versions: Array<{ id: string }> };
    expect(newest).toMatchObject({ entry: { version: 2 }, available: true });
    const older = (await (await fetch(`${base}/api/files/${id}?version=1`, { headers: auth() })).json()) as { entry: { version: number } };
    expect(older.entry.version).toBe(1);
    const byVersionId = (await (await fetch(`${base}/api/files/${newest.versions[1]!.id}`, { headers: auth() })).json()) as { file: { id: string } };
    expect(byVersionId.file.id).toBe(id);
    expect((await fetch(`${base}/api/files/${id}?version=9`, { headers: auth() })).status).toBe(404);
  });

  it('serves an Office file’s bytes to the page’s previewer, inline and sandboxed, up to 20 MB', async () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const bytes = Buffer.from('PK\u0003\u0004 a small docx');
    const row = await saveArtifact(pool, { bytes, mime: DOCX, filename: 'Letter.docx', createdBy: 'scout', conversationId }, env);
    const res = await fetch(`${base}/api/artifacts/${row.id}/preview`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    // By name when the type was not given.
    const unnamed = await saveArtifact(pool, { bytes: Buffer.from('PK deck'), mime: 'application/octet-stream', filename: 'Deck.pptx', createdBy: 'scout', conversationId }, env);
    expect((await fetch(`${base}/api/artifacts/${unnamed.id}/preview`, { headers: auth() })).status).toBe(200);
    // Past the cap: Download only.
    await pool.query(`update core.artifacts set size_bytes = $2 where id = $1`, [row.id, 21 * 1024 * 1024]);
    expect((await fetch(`${base}/api/artifacts/${row.id}/preview`, { headers: auth() })).status).toBe(413);
    // A legacy .doc is still download only.
    const legacy = await saveArtifact(pool, { bytes: Buffer.from('old'), mime: 'application/msword', filename: 'Old.doc', createdBy: 'scout', conversationId }, env);
    expect((await fetch(`${base}/api/artifacts/${legacy.id}/preview`, { headers: auth() })).status).toBe(415);
  });

  it('opens a file past 1 MiB read-only, its start only', async () => {
    const big = 'line\n'.repeat(250_000);
    const id = await file(big, 'big.log', 'text/plain');
    const body = (await (await read(id)).json()) as { text: string; editable: boolean; truncated: boolean };
    expect(body).toMatchObject({ editable: false, truncated: true });
    expect(body.text.length).toBe(1024 * 1024);
  });

  it('tells the canvas which calls made which file, and which only read one', async () => {
    const here = await conversation();
    const made = await saveArtifact(pool, { bytes: Buffer.from('# Notes\n'), mime: 'text/markdown', filename: 'Notes.md', createdBy: 'scout', conversationId: here }, env);
    const turn = (id: string, name: string, output: unknown): Array<[string, unknown]> => [
      ['assistant', [{ type: 'tool_use', id, name, input: {} }]],
      ['user', [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(output) }]],
    ];
    for (const [role, content] of [
      ...turn('w1', 'artifacts.write', { artifactId: made.id, fileId: made.fileId, filename: 'Notes.md', mime: 'text/markdown' }),
      ...turn('l1', 'artifacts.list', { artifacts: [{ id: made.id, filename: 'Notes.md', mime: 'text/markdown' }], count: 1 }),
      ...turn('t1', 'artifacts.text', { id: made.id, fileId: made.fileId, version: 1, text: '# Notes\n' }),
      ...turn('d1', 'artifacts.compose', { dryRun: true, kind: 'docx', sizeBytes: 9000, render: { kind: 'docx' }, note: 'Nothing was saved' }),
      ...turn('g1', 'artifacts.compose', { guide: 'docx', text: '# Composing a Word document' }),
      ['assistant', [{ type: 'tool_use', id: 'f1', name: 'artifacts.compose', input: {} }]],
      ['user', [{ type: 'tool_result', tool_use_id: 'f1', content: 'program_error: SyntaxError: Illegal return statement', is_error: true }]],
      ['assistant', [{ type: 'tool_use', id: 'f2', name: 'artifacts.list', input: {} }]],
      ['user', [{ type: 'tool_result', tool_use_id: 'f2', content: 'no such folder', is_error: true }]],
    ] as Array<[string, unknown]>) await pool.query('insert into core.messages (conversation_id, role, content) values ($1, $2, $3)', [here, role, JSON.stringify(content)]);
    await saveVersion(pool, { id: made.fileId, bytes: Buffer.from('# Notes, two\n'), createdBy: 'scout' }, env);
    await pool.query('update core.artifacts set deleted_at = now() where id = $1', [made.id]);
    const transcript = await readChatTranscript(pool, here, new Date(), undefined, (tool) => tool === 'artifacts.write' || tool === 'artifacts.compose');
    const results = transcript!.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_result') as Array<{ toolUseId: string; files?: unknown[]; readsFile?: true; rowOnly?: true }>;
    const by = (id: string) => results.find((block) => block.toolUseId === id)!;
    // The version was deleted since; the file was not, and the tab keeps its id.
    expect(by('w1').files).toEqual([{ artifactId: made.id, fileId: made.fileId, version: 1, filename: 'Notes.md', mime: 'text/markdown', deleted: true, fileDeleted: false }]);
    expect(by('l1').files).toEqual([]);
    expect(by('t1').readsFile).toBe(true);
    // A document tool that saved nothing — a dry run, a guide — is the agent checking its work: its row, no tab.
    expect(by('d1').rowOnly).toBe(true);
    expect(by('g1').rowOnly).toBe(true);
    expect(by('w1').rowOnly).toBeUndefined();
    // So is a failed run it is about to fix; another tool's failure keeps its tab.
    expect(by('f1').rowOnly).toBe(true);
    expect(by('f2').rowOnly).toBeUndefined();
  });

  describe('the turn note', () => {
    it('says the newest version is the owner’s until the agent writes again, and names a synced workspace copy', async () => {
      const here = await conversation();
      const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
      const synced = await captured('out/synced.md', '# Synced\n', here);
      expect((await save(synced.fileId, { base: 1, text: '# Synced\n\nBy the owner\n' })).status).toBe(200);
      const told = await systemContext(ctx, { agentId: 'scout', tools: ['host.exec'], conversationId: here });
      expect(told.prompt).toContain("Your workspace copy at out/synced.md already holds it");
      // Said again on the next turn: still true.
      expect((await systemContext(ctx, { agentId: 'scout', tools: ['host.exec'], conversationId: here })).prompt).toContain('out/synced.md');
      // Once the agent writes, it is not.
      await saveVersion(pool, { id: synced.fileId, bytes: Buffer.from('# Synced\n\nBy the owner\n\nAnd buddi\n'), createdBy: 'scout', readVersion: 2 }, env);
      expect((await systemContext(ctx, { agentId: 'scout', tools: ['host.exec'], conversationId: here })).prompt).not.toContain('synced.md');

      const failed = await captured('out/failed.md', '# Failed\n', here);
      control.failRename = true;
      await save(failed.fileId, { base: 1, text: '# Failed, mine\n' });
      const stale = await systemContext(ctx, { agentId: 'scout', tools: ['host.exec'], conversationId: here });
      expect(stale.prompt).toContain("The newest version of failed.md is the owner's (v2, saved");
      expect(stale.prompt).toContain('you cannot read files in Files; ask the owner what changed');
    });

    it('words the note by the tools the agent holds, and never uses pronouns', () => {
      const note = { fileId: '22222222-2222-4222-8222-222222222222', name: 'List.md', version: 2, artifactId: '11111111-1111-4111-8111-111111111111', savedAt: '2026-10-13T09:00:00.000Z', yours: 1 };
      expect(ownerEditLine(note, 'UTC', ['artifacts.text', 'artifacts.write'])).toContain('artifacts.write { fileId: "22222222-2222-4222-8222-222222222222", readVersion: 2 }');
      expect(ownerEditLine(note, 'UTC', ['artifacts.text'])).not.toContain('artifacts.write');
      expect(ownerEditLine(note, 'UTC', [])).toMatch(/you cannot read files in Files; ask the owner what changed/);
      expect(ownerEditLine(note, 'UTC', [])).not.toMatch(/\b(he|his|him)\b/);
      expect(ownerEditLine(note, 'UTC', [])).toContain('you last wrote v1');
    });
  });

  describe('a sandboxed workspace', () => {
    it('gets the owner’s save in Files only, and the agent is told its copy is out of date', async () => {
      // Codex P1: a process a sandboxed run left behind could swap a folder under the save's checks.
      const here = await conversation();
      const out = await captured('out/confined.md', '# Confined\n', here);
      const data = await realpath(dir);
      const mark = confinedMarkPath(data, 'owner', 'scout', here);
      await mkdir(path.dirname(mark), { recursive: true });
      await writeFile(mark, 'now\n');
      const res = await save(out.fileId, { base: 1, text: '# Confined, mine\n' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ version: 2, workspace: { updated: false, reason: expect.stringMatching(/ran sandboxed scripts/) } });
      expect(await readFile(out.onDisk, 'utf8')).toBe('# Confined\n');
      const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
      const told = await systemContext(ctx, { agentId: 'scout', tools: ['artifacts.text', 'artifacts.write', 'host.exec'], conversationId: here });
      expect(told.prompt).toContain('Your earlier copies (any in your workspace too) are out of date');
      expect(told.prompt).not.toContain('already holds it');
    });

    it('writes through where only unconfined commands ran', async () => {
      const here = await conversation();
      const out = await captured('out/free.md', '# Free\n', here);
      expect(await (await save(out.fileId, { base: 1, text: '# Free, mine\n' })).json()).toMatchObject({ workspace: { updated: true } });
      expect(await readFile(out.onDisk, 'utf8')).toBe('# Free, mine\n');
    });
  });

  describe('the store under races and failures', () => {
    it('rewrites a blob a cut-short write left, rather than trusting its path', async () => {
      // Codex P1: a partial blob was reused because its path existed.
      const bytes = Buffer.from('# Whole bytes, every one of them\n');
      const relative = storagePathFor(sha(bytes), 'text/markdown', 'whole.md', new Date());
      await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      await writeFile(path.join(dir, relative), bytes.subarray(0, 7));
      const row = await saveArtifact(pool, { bytes, mime: 'text/markdown', filename: 'whole.md', createdBy: 'scout', conversationId }, env);
      expect(row.storagePath).toBe(relative);
      expect((await readFile(path.join(dir, relative))).equals(bytes)).toBe(true);
      // Same size, wrong bytes: checked by hash too.
      const other = Buffer.from('# Whole bytes, every one of them\n'.replace('W', 'X'));
      const otherPath = storagePathFor(sha(Buffer.from('# Same size, other bytes here.  \n')), 'text/markdown', 'x.md', new Date());
      await writeFile(path.join(dir, otherPath), other);
      const second = await saveArtifact(pool, { bytes: Buffer.from('# Same size, other bytes here.  \n'), mime: 'text/markdown', filename: 'x.md', createdBy: 'scout', conversationId }, env);
      expect(await readFile(path.join(dir, second.storagePath), 'utf8')).toBe('# Same size, other bytes here.  \n');
    });

    it('captures into a new file when the file it found was deleted while it waited', async () => {
      // Codex P2: a capture appended to a file deleted under it.
      const here = await conversation();
      const first = await captured('out/race.md', '# One\n', here);
      const holder = await pool.connect();
      try {
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`buddi.file:${first.fileId}`]);
        await holder.query('update core.files set deleted_at = now() where id = $1', [first.fileId]);
        await holder.query('update core.artifacts set deleted_at = now() where file_id = $1', [first.fileId]);
        const again = captured('out/race.md', '# Two\n', here);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await holder.query('commit');
        expect((await again).fileId).not.toBe(first.fileId);
      } finally {
        holder.release();
      }
      const { rows } = await pool.query('select count(*)::int as live from core.artifacts where file_id = $1 and deleted_at is null', [first.fileId]);
      expect(rows[0].live).toBe(0);
    });

    it('makes a new file of a re-sent upload whose file was deleted while it waited', async () => {
      // Codex P2: the dedup brought a version back inside a deleted file.
      const source = { surface: 'telegram', chatId: 'race-chat' };
      const first = await saveArtifact(pool, { bytes: Buffer.from('statement'), mime: 'application/pdf', filename: 's.pdf', createdBy: 'owner', source }, env);
      const holder = await pool.connect();
      let again: Awaited<ReturnType<typeof saveArtifact>>;
      try {
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`buddi.file:${first.fileId}`]);
        await holder.query('update core.files set deleted_at = now() where id = $1', [first.fileId]);
        await holder.query('update core.artifacts set deleted_at = now() where file_id = $1', [first.fileId]);
        const pending = saveArtifact(pool, { bytes: Buffer.from('statement'), mime: 'application/pdf', filename: 's.pdf', createdBy: 'owner', source }, env);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await holder.query('commit');
        again = await pending;
      } finally {
        holder.release();
      }
      expect(again.fileId).not.toBe(first.fileId);
      expect((await getFile(pool, first.fileId))!.deletedAt).not.toBeNull();
      expect((await pool.query('select deleted_at from core.artifacts where id = $1', [first.id])).rows[0].deleted_at).not.toBeNull();
    });

    it('never gives a purged version’s number to a new one', async () => {
      // Codex P2: v3 deleted, purged, and the next save was v3 again.
      const id = await file('# n1\n', 'numbers.md');
      await saveVersion(pool, { id, bytes: Buffer.from('# n2\n'), createdBy: 'scout' }, env);
      await saveVersion(pool, { id, bytes: Buffer.from('# n3\n'), createdBy: 'scout' }, env);
      await pool.query('update core.artifacts set deleted_at = $2 where file_id = $1 and version = 3', [id, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)]);
      await purgeDeletedArtifacts(pool, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), env);
      expect((await pool.query('select max(version)::int as top from core.artifacts where file_id = $1', [id])).rows[0].top).toBe(2);
      // An editor still holding v3 as its base is refused, not taken for the new v3.
      expect((await saveVersion(pool, { id, bytes: Buffer.from('# n4\n'), createdBy: 'scout' }, env)).row.version).toBe(4);
      expect((await save(id, { base: 3, text: '# stale\n' })).status).toBe(409);
    });

    it('stops telling the agent once it has read the owner’s newest version', async () => {
      const here = await conversation();
      const v1 = await call('artifacts.write', { title: 'Read me', format: 'markdown', content: '# Read me\n' }, here);
      expect((await save(v1.fileId, { base: 1, text: '# Read me, mine\n' })).status).toBe(200);
      const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
      const tools = ['artifacts.text', 'artifacts.write'];
      expect((await systemContext(ctx, { agentId: 'scout', tools, conversationId: here })).prompt).toContain('The newest version of Read me.md');
      // Reading the older version does not count.
      await call('artifacts.text', { id: v1.artifactId }, here);
      expect((await systemContext(ctx, { agentId: 'scout', tools, conversationId: here })).prompt).toContain('The newest version of Read me.md');
      await call('artifacts.text', { id: (await view(v1.fileId)).current.artifactId }, here);
      expect((await systemContext(ctx, { agentId: 'scout', tools, conversationId: here })).prompt).not.toContain('Read me.md');
    });
  });

  describe('the purge', () => {
    it('removes a version deleted a month ago, and keeps bytes another version still stores', async () => {
      const a = await saveArtifact(pool, { bytes: Buffer.from('# Shared bytes\n'), mime: 'text/markdown', filename: 'shared.md', createdBy: 'scout', conversationId }, env);
      const b = await saveArtifact(pool, { bytes: Buffer.from('# Shared bytes\n'), mime: 'text/markdown', filename: 'shared.md', createdBy: 'owner', source: { surface: 'telegram', chatId: '42' } }, env);
      expect(b.fileId).not.toBe(a.fileId);
      expect(b.storagePath).toBe(a.storagePath);
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      const month = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await pool.query('update core.artifacts set deleted_at = $2 where id = $1', [a.id, old]);
      expect((await purgeDeletedArtifacts(pool, month, env)).rows).toBeGreaterThanOrEqual(1);
      expect((await pool.query('select 1 from core.artifacts where id = $1', [a.id])).rows).toHaveLength(0);
      // Its file went with its last version.
      expect(await getFile(pool, a.fileId)).toBeNull();
      expect(await stat(path.join(dir, b.storagePath)).then(() => true, () => false)).toBe(true);
      await pool.query('update core.artifacts set deleted_at = $2 where id = $1', [b.id, old]);
      expect((await purgeDeletedArtifacts(pool, month, env)).blobs).toBeGreaterThanOrEqual(1);
      expect(await stat(path.join(dir, b.storagePath)).then(() => true, () => false)).toBe(false);
    });

    it('keeps a blob a save adopts while the purge is deciding', async () => {
      // Codex P1: between the purge's reference check and its unlink, a save could adopt the path.
      const gone = await saveArtifact(pool, { bytes: Buffer.from('# Adopted\n'), mime: 'text/markdown', filename: 'adopted.md', createdBy: 'scout', conversationId: null }, env);
      await pool.query('update core.artifacts set deleted_at = $2 where id = $1', [gone.id, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)]);
      const writer = await pool.connect();
      try {
        // A save holding the blob's lock, as the store's writers do, with its row not committed yet.
        await writer.query('begin');
        await writer.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`buddi.blob:${gone.storagePath}`]);
        const purge = purgeDeletedArtifacts(pool, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), env);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await stat(path.join(dir, gone.storagePath)).then(() => true, () => false)).toBe(true);
        await writer.query(
          `insert into core.artifacts (kind, mime, filename, size_bytes, sha256, storage_path, created_by)
           values ('document', 'text/markdown', 'adopted.md', $1, $2, $3, 'scout')`,
          [gone.sizeBytes, gone.sha256, gone.storagePath],
        );
        await writer.query('commit');
        await purge;
      } finally {
        writer.release();
      }
      expect(await stat(path.join(dir, gone.storagePath)).then(() => true, () => false)).toBe(true);
    });
  });
});

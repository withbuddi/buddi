/**
 * GET and PUT /api/artifacts/:id/content — the canvas editor's routes. A save
 * names the version it edited; a stale one is a 409 with the version that
 * won, whether the bytes changed or the agent wrote a newer version under the
 * same name. Nothing in a request is a path: what is written lands under the
 * data dir, at the place its hash gives.
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
      if (control.failRename) { control.failRename = false; throw new Error('the disk is full'); }
      return real.rename(from, to);
    },
  };
});
import pg from 'pg';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, ensureOwner, getArtifact, migrate, OwnerEditedError, purgeDeletedArtifacts, replaceArtifactContent, saveArtifact, saveArtifactVersion, saveNextVersionOf, ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { enterWorkspace, hostWorkspaceDir, hostWorkspaceKey } from '@buddi/tool-host';
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

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

suite('file content routes', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let base: string;
  let dir: string;
  let token: string;
  let env: Record<string, string | undefined>;
  let conversationId: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    conversationId = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id;
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-file-content-'));
    env = { ...process.env, BUDDI_DATA_DIR: dir };
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    web = await startWebServer({
      pool, registry: new ToolRegistry(), catalog: emptyCatalog(), ctx, timezone: 'UTC', now: () => new Date(), env,
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
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const read = (id: string): Promise<Response> =>
    fetch(`${base}/api/artifacts/${id}/content`, { headers: { authorization: `Bearer ${token}` } });
  const save = (id: string, body: unknown): Promise<Response> =>
    fetch(`${base}/api/artifacts/${id}/content`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const file = async (text: string | Buffer, filename: string, mime = 'text/markdown', conversation: string | null = conversationId, createdBy = 'scout'): Promise<string> =>
    (await saveArtifact(pool, { bytes: Buffer.isBuffer(text) ? text : Buffer.from(text), mime, filename, createdBy, conversationId: conversation }, env)).id;
  const blob = (text: string): Promise<boolean> => stat(path.join(dir, 'artifacts')).then(async () => {
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(path.join(dir, 'artifacts'), { recursive: true });
    return names.some((name) => String(name).includes(sha(text)));
  });

  it('reads a text file whole, with the hash a save names', async () => {
    const id = await file('# Plan\n\nOne\n', 'Plan.md');
    const res = await read(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '# Plan\n\nOne\n', sha256: sha('# Plan\n\nOne\n'), sizeBytes: 12, editable: true, truncated: false });
  });

  it('saves over the version opened, and refuses a save against an older one with the version that won', async () => {
    const id = await file('alpha\n', 'notes.txt', 'text/plain');
    const first = await save(id, { text: 'alpha\nbeta\n', base: sha('alpha\n') });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ sha256: sha('alpha\nbeta\n'), sizeBytes: 11 });
    expect(await (await read(id)).json()).toMatchObject({ text: 'alpha\nbeta\n' });

    // A second tab still holding "alpha": stale.
    const stale = await save(id, { text: 'alpha\ngamma\n', base: sha('alpha\n') });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ current: { artifactId: id, sha256: sha('alpha\nbeta\n'), filename: 'notes.txt' } });
    expect(await (await read(id)).json()).toMatchObject({ text: 'alpha\nbeta\n' });
  });

  it('is stale when the agent wrote a newer version under the same name', async () => {
    const v1 = await file('# Report\n\nDraft\n', 'Report.md');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const v2 = await file('# Report\n\nFinal\n', 'Report (v2).md');
    const res = await save(v1, { text: '# Report\n\nMine\n', base: sha('# Report\n\nDraft\n') });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ current: { artifactId: v2, sha256: sha('# Report\n\nFinal\n') } });
    // Keeping his own then saves onto the newest.
    expect((await save(v2, { text: '# Report\n\nMine\n', base: sha('# Report\n\nFinal\n') })).status).toBe(200);
  });

  it('does not chain a same-named file another agent wrote', async () => {
    const mine = await file('# Notes\n\nA\n', 'Notes.md');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await file('# Notes\n\nOther\n', 'Notes (v2).md', 'text/markdown', conversationId, 'ledger');
    await file('a,b\r\n', 'Notes.csv', 'text/csv');
    expect((await save(mine, { text: '# Notes\n\nB\n', base: sha('# Notes\n\nA\n') })).status).toBe(200);
  });

  it('lets one of two saves at once win, and leaves no bytes behind for the loser', async () => {
    const id = await file('race\n', 'race.txt', 'text/plain');
    const answers = await Promise.all([
      save(id, { text: 'race one\n', base: sha('race\n') }),
      save(id, { text: 'race two\n', base: sha('race\n') }),
    ]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 409]);
    const won = (await (await read(id)).json()) as { text: string };
    const lost = won.text === 'race one\n' ? 'race two\n' : 'race one\n';
    expect(await blob(won.text)).toBe(true);
    expect(await blob(lost)).toBe(false);
  });

  it('shows text that is not UTF-8, and never saves over it', async () => {
    const latin1 = Buffer.from('caf\xe9\n', 'latin1');
    const id = await file(latin1, 'menu.txt', 'text/plain');
    expect(await (await read(id)).json()).toMatchObject({ editable: false, note: 'encoding' });
    const res = await save(id, { text: 'café\n', base: createHash('sha256').update(latin1).digest('hex') });
    expect(res.status).toBe(415);
  });

  it('writes only under the data dir, at the place the hash gives', async () => {
    const id = await file('x = 1\n', 'calc.py', 'text/x-python');
    expect((await save(id, { text: 'x = 2\n', base: sha('x = 1\n') })).status).toBe(200);
    const row = await getArtifact(pool, id);
    expect(row!.storagePath).toMatch(new RegExp(`^artifacts/\\d{4}/\\d{2}/${sha('x = 2\n')}\\.`));
    expect(await readFile(path.join(dir, row!.storagePath), 'utf8')).toBe('x = 2\n');
  });

  it('refuses what is not a text file in Files, and anything that looks like a path', async () => {
    const png = await file('not really a png', 'a.png', 'image/png', null);
    expect((await read(png)).status).toBe(415);
    expect((await save(png, { text: 'x', base: sha('not really a png') })).status).toBe(415);
    expect((await read('11111111-1111-4111-8111-111111111111')).status).toBe(404);
    expect((await save('11111111-1111-4111-8111-111111111111', { text: 'x', base: sha('x') })).status).toBe(404);
    for (const probe of ['..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fhosts', 'not-an-id']) {
      expect((await read(probe)).status).toBe(404);
      expect([404, 405]).toContain((await save(probe, { text: 'x', base: sha('x') })).status);
    }
    const id = await file('a\n', 'b.txt', 'text/plain');
    expect((await save(id, { text: 'b' })).status).toBe(400);
    expect((await save(id, { text: 'x'.repeat(1024 * 1024 + 1), base: sha('a\n') })).status).toBe(413);
  });

  describe('a command’s output', () => {
    const captured = async (name: string, text: string, agent = 'scout'): Promise<{ id: string; onDisk: string }> => {
      const data = await realpath(dir);
      const workspace = hostWorkspaceDir(data, 'owner', agent, conversationId);
      await mkdir(workspace, { recursive: true });
      const onDisk = path.join(workspace, name);
      await mkdir(path.dirname(onDisk), { recursive: true });
      await writeFile(onDisk, text);
      const row = await saveArtifact(pool, {
        bytes: Buffer.from(text), mime: 'text/markdown', filename: name, createdBy: agent, conversationId,
        source: { surface: 'host', chatId: conversationId }, originPath: path.relative(data, onDisk),
      }, env);
      return { id: row.id, onDisk };
    };

    it('writes the owner’s save back to the workspace it came from', async () => {
      const { id, onDisk } = await captured('packing.md', '# Packing\n\n- Socks\n');
      const res = await save(id, { text: '# Packing\n\n- Socks\n- By buddi\n', base: sha('# Packing\n\n- Socks\n') });
      expect(res.status).toBe(200);
      expect(await readFile(onDisk, 'utf8')).toBe('# Packing\n\n- Socks\n- By buddi\n');
    });

    it('refuses when the workspace copy changed since, with what it holds, until he overwrites it', async () => {
      const { id, onDisk } = await captured('trip.md', '# Trip\n');
      await writeFile(onDisk, '# Trip\n\n## Toiletries\n');
      const stale = await save(id, { text: '# Trip\n\nMine\n', base: sha('# Trip\n') });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ workspaceText: '# Trip\n\n## Toiletries\n', current: { artifactId: id } });
      expect(await readFile(onDisk, 'utf8')).toBe('# Trip\n\n## Toiletries\n');
      expect((await (await read(id)).json() as { text: string }).text).toBe('# Trip\n');

      const forced = await save(id, { text: '# Trip\n\nMine\n', base: sha('# Trip\n'), overwriteWorkspace: true });
      expect(forced.status).toBe(200);
      expect(await readFile(onDisk, 'utf8')).toBe('# Trip\n\nMine\n');
    });

    it('never writes through a linked folder, or a linked workspace', async () => {
      const data = await realpath(dir);
      const outside = await mkdtemp(path.join(tmpdir(), 'buddi-outside-'));
      await writeFile(path.join(outside, 'f.md'), '# Outside\n');
      // A folder in the workspace that is a link out of it.
      const workspace = hostWorkspaceDir(data, 'owner', 'scout', conversationId);
      await mkdir(workspace, { recursive: true });
      await symlink(outside, path.join(workspace, 'sub'));
      const viaParent = await saveArtifact(pool, {
        bytes: Buffer.from('# Outside\n'), mime: 'text/markdown', filename: 'f.md', createdBy: 'scout', conversationId,
        source: { surface: 'host', chatId: conversationId }, originPath: path.relative(data, path.join(workspace, 'sub', 'f.md')),
      }, env);
      const one = await save(viaParent.id, { text: '# Escaped\n', base: sha('# Outside\n') });
      expect(one.status).toBe(200);
      expect(await one.json()).toMatchObject({ workspace: { updated: false }, note: expect.stringMatching(/^Saved in Files; the workspace copy couldn’t be updated/) });
      // The whole workspace a link.
      const linked = hostWorkspaceDir(data, 'owner', 'linker', conversationId);
      await mkdir(path.dirname(linked), { recursive: true });
      await symlink(outside, linked);
      const viaRoot = await saveArtifact(pool, {
        bytes: Buffer.from('# Outside\n'), mime: 'text/markdown', filename: 'f.md', createdBy: 'linker', conversationId,
        source: { surface: 'host', chatId: conversationId }, originPath: path.relative(data, path.join(linked, 'f.md')),
      }, env);
      expect(await (await save(viaRoot.id, { text: '# Escaped\n', base: sha('# Outside\n') })).json()).toMatchObject({ workspace: { updated: false } });
      expect(await readFile(path.join(outside, 'f.md'), 'utf8')).toBe('# Outside\n');
      await rm(outside, { recursive: true, force: true });
    });

    it('refuses while a command runs in the workspace, and saves once it is done', async () => {
      const { id, onDisk } = await captured('busy.md', '# Busy\n');
      const leave = await enterWorkspace(hostWorkspaceKey('owner', 'scout', conversationId));
      const refused = await save(id, { text: '# Mine\n', base: sha('# Busy\n') });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ busy: true, error: expect.stringMatching(/running a command/) });
      leave();
      expect((await save(id, { text: '# Mine\n', base: sha('# Busy\n') })).status).toBe(200);
      expect(await readFile(onDisk, 'utf8')).toBe('# Mine\n');
    });

    it('reports a copy it could not update after the save, and saving again writes it', async () => {
      const { id, onDisk } = await captured('full.md', '# Full\n');
      control.failRename = true;
      const partial = await save(id, { text: '# Mine\n', base: sha('# Full\n') });
      expect(partial.status).toBe(200);
      expect(await partial.json()).toMatchObject({ workspace: { updated: false, reason: 'the disk is full' }, note: 'Saved in Files; the workspace copy couldn’t be updated: the disk is full.' });
      expect((await (await read(id)).json() as { text: string }).text).toBe('# Mine\n');
      expect(await readFile(onDisk, 'utf8')).toBe('# Full\n');
      const again = await save(id, { text: '# Mine\n', base: sha('# Mine\n') });
      expect(await again.json()).toMatchObject({ workspace: { updated: true } });
      expect(await readFile(onDisk, 'utf8')).toBe('# Mine\n');
    });

    it('does not take a newer output of another path with the same name for a newer version', async () => {
      const a = await captured('one/notes.md', '# One\n');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await captured('two/notes.md', '# Two\n');
      expect((await save(a.id, { text: '# One, mine\n', base: sha('# One\n') })).status).toBe(200);
      expect(await readFile(a.onDisk, 'utf8')).toBe('# One, mine\n');
      // The same path captured again is the newer version.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const again = await captured('one/notes.md', '# One, by buddi\n');
      const stale = await save(a.id, { text: '# One, mine again\n', base: sha('# One, mine\n') });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ current: { artifactId: again.id } });
    });

    it('says when the workspace copy is gone, and saves in Files only', async () => {
      const { id, onDisk } = await captured('gone.md', '# Gone\n');
      await rm(onDisk);
      expect(await (await save(id, { text: '# Mine\n', base: sha('# Gone\n') })).json())
        .toMatchObject({ workspace: { updated: false, reason: 'the workspace copy is gone; saved in Files only' } });
    });

    it('finishes a write-through on a pool of one connection', async () => {
      const { id, onDisk } = await captured('one-connection.md', '# One\n');
      const url = new URL(databaseUrl as string);
      url.pathname = `/${TEST_DB}`;
      const single = new pg.Pool({ connectionString: url.toString(), max: 1 });
      try {
        const done = replaceArtifactContent(single, {
          id, bytes: Buffer.from('# Two\n'), expectedSha256: sha('# One\n'),
          workspace: async () => ({ kind: 'write', commit: () => writeFile(onDisk, '# Two\n'), abort: async () => {} }),
        }, env);
        const result = await Promise.race([done, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5_000))]);
        expect(result).toMatchObject({ ok: true, workspace: { updated: true } });
        const { rows } = await pool.query('select origin_sha256 from core.artifacts where id = $1', [id]);
        expect(rows[0].origin_sha256).toBe(sha('# Two\n'));
      } finally {
        await single.end();
      }
    });

    it('lists one row per file in Files, with its versions; two paths with one name stay two files', async () => {
      // An output captured before paths were recorded, then the same file's later captures.
      const legacy = await saveArtifact(pool, {
        bytes: Buffer.from('# Trip v1\n'), mime: 'text/markdown', filename: 'grouped.md', createdBy: 'scout', conversationId,
        source: { surface: 'host', chatId: conversationId },
      }, env);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await captured('here/grouped.md', '# Trip v2\n');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newest = await captured('here/grouped.md', '# Trip v3\n');
      const list = async (q: string, flat = false) => ((await (await fetch(`${base}/api/artifacts?q=${q}${flat ? '&flat=1' : ''}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { entries: Array<{ id: string; versions: number }> }).entries;
      expect(await list('grouped')).toEqual([expect.objectContaining({ id: newest.id, versions: 3 })]);
      expect(await list('grouped', true)).toHaveLength(3);
      // Two outputs with one name, from two paths: two files.
      await captured('left/paired.md', '# Left\n');
      await captured('right/paired.md', '# Right\n');
      expect((await list('paired')).map((entry) => entry.versions)).toEqual([1, 1]);

      // The file page lists them, newest first, with the owner's save marked.
      expect((await save(newest.id, { text: '# Trip v3, mine\n', base: sha('# Trip v3\n') })).status).toBe(200);
      const page = (await (await fetch(`${base}/api/artifacts/${legacy.id}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { versions: Array<{ id: string; editedAt: string | null; sha256: string }> };
      expect(page.versions.map((version) => version.id)).toEqual([newest.id, expect.any(String), legacy.id]);
      expect(page.versions[0]!.editedAt).not.toBeNull();
      expect(page.versions[0]!.sha256).toBe(sha('# Trip v3, mine\n'));
      expect(page.versions[2]!.editedAt).toBeNull();
    });

    it('tells the agent its workspace copy has the owner’s edits when the save was written back, and that it is stale when not', async () => {
      const other = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id as string;
      const data = await realpath(dir);
      const capture = async (name: string, text: string): Promise<string> => {
        const workspace = hostWorkspaceDir(data, 'owner', 'scout', other);
        const onDisk = path.join(workspace, 'out', name);
        await mkdir(path.dirname(onDisk), { recursive: true });
        await writeFile(onDisk, text);
        return (await saveArtifact(pool, {
          bytes: Buffer.from(text), mime: 'text/markdown', filename: name, createdBy: 'scout', conversationId: other,
          source: { surface: 'host', chatId: other }, originPath: path.relative(data, onDisk),
        }, env)).id;
      };
      const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
      const synced = await capture('synced.md', '# Synced\n');
      expect((await save(synced, { text: '# Synced\n\nUpdated by the owner\n', base: sha('# Synced\n') })).status).toBe(200);
      const told = await systemContext(ctx, { agentId: 'scout', tools: ['host.exec'], conversationId: other });
      expect(told.prompt).toContain("Your workspace copy at out/synced.md already has the owner's edits");
      expect(told.prompt).not.toContain('out of date');

      const failed = await capture('failed.md', '# Failed\n');
      control.failRename = true;
      expect(await (await save(failed, { text: '# Failed, mine\n', base: sha('# Failed\n') })).json()).toMatchObject({ workspace: { updated: false } });
      const stale = await systemContext(ctx, { agentId: 'scout', tools: ['host.exec'], conversationId: other });
      expect(stale.prompt).toContain('The owner edited failed.md at');
      expect(stale.prompt).toContain('Your earlier copy (including any copy in your workspace) is out of date. You cannot read files in Files; ask the owner what changed');
    });

    it('continues a command’s output by id, keeping its name and workspace path, and the owner’s save still writes back', async () => {
      const capture = await captured('cont/packing.md', '# Packing\n');
      const next = await saveNextVersionOf(pool, { of: capture.id, bytes: Buffer.from('# Packing\n\n## Toiletries\n'), createdBy: 'scout' }, env);
      // Its name, as the capture had it.
      expect(next.row.filename).toBe((await getArtifact(pool, capture.id))!.filename);
      const { rows } = await pool.query('select origin_path, origin_sha256 from core.artifacts where id = $1', [next.row.id]);
      expect(rows[0].origin_path).toMatch(/cont\/packing\.md$/);
      // The workspace copy was not written: it still holds the capture.
      expect(rows[0].origin_sha256).toBe(sha('# Packing\n'));
      expect(await readFile(capture.onDisk, 'utf8')).toBe('# Packing\n');
      // The owner's save of the new version writes it back over that copy.
      const saved = await save(next.row.id, { text: '# Packing\n\n## Toiletries\n- Mine\n', base: sha('# Packing\n\n## Toiletries\n') });
      expect(await saved.json()).toMatchObject({ workspace: { updated: true } });
      expect(await readFile(capture.onDisk, 'utf8')).toBe('# Packing\n\n## Toiletries\n- Mine\n');
    });

    it('joins a document whose name only differs in case, spaces or hyphens to the command’s file, in Files too', async () => {
      const capture = await captured('trip/montreal-weekend-list.md', '# List\n');
      const doc = await saveArtifact(pool, { bytes: Buffer.from('# List, doc\n'), mime: 'text/markdown', filename: 'Montreal Weekend List.md', createdBy: 'scout', conversationId }, env);
      const v2 = await saveArtifact(pool, { bytes: Buffer.from('# List, doc v2\n'), mime: 'text/markdown', filename: 'Montreal Weekend List (v2).md', createdBy: 'scout', conversationId }, env);
      const listed = ((await (await fetch(`${base}/api/artifacts?q=montreal`, { headers: { authorization: `Bearer ${token}` } })).json()) as { entries: Array<{ id: string; versions: number }> }).entries;
      expect(listed).toEqual([expect.objectContaining({ id: v2.id, versions: 3 })]);
      expect(doc.id).not.toBe(capture.id);
    });

    it('tells the canvas which calls made which file, and which only read one', async () => {
      const other = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id as string;
      const file = await saveArtifact(pool, { bytes: Buffer.from('# Notes\n'), mime: 'text/markdown', filename: 'Notes.md', createdBy: 'scout', conversationId: other }, env);
      const turn = (id: string, name: string, output: unknown): Array<[string, unknown]> => [
        ['assistant', [{ type: 'tool_use', id, name, input: {} }]],
        ['user', [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(output) }]],
      ];
      for (const [role, content] of [
        ...turn('w1', 'artifacts.write', { artifactId: file.id, filename: 'Notes.md', mime: 'text/markdown' }),
        ...turn('l1', 'artifacts.list', { artifacts: [{ id: file.id, filename: 'Notes.md', mime: 'text/markdown' }], count: 1 }),
        ...turn('t1', 'artifacts.text', { id: file.id, sha256: sha('# Notes\n'), text: '# Notes\n' }),
      ]) await pool.query('insert into core.messages (conversation_id, role, content) values ($1, $2, $3)', [other, role, JSON.stringify(content)]);
      const transcript = await readChatTranscript(pool, other, new Date(), undefined, (tool) => tool === 'artifacts.write');
      const results = transcript!.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_result') as Array<{ toolUseId: string; files?: Array<{ artifactId: string; chain: string }>; readsFile?: true }>;
      const by = (id: string) => results.find((block) => block.toolUseId === id)!;
      expect(by('w1').files).toEqual([expect.objectContaining({ artifactId: file.id, chain: expect.stringContaining('notes.md') })]);
      expect(by('l1').files).toEqual([]);
      expect(by('t1').readsFile).toBe(true);
    });

    it('deletes a version (the one before is the newest again), the whole file, and undoes it', async () => {
      await captured('del/deleting.md', '# One\n');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const two = await captured('del/deleting.md', '# Two\n');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const three = await captured('del/deleting.md', '# Three\n');
      const auth = { authorization: `Bearer ${token}` };
      const list = async () => ((await (await fetch(`${base}/api/artifacts?q=deleting`, { headers: auth })).json()) as { entries: Array<{ id: string; versions: number }> }).entries;
      const remove = (id: string, scope: string) => fetch(`${base}/api/artifacts/${id}?scope=${scope}`, { method: 'DELETE', headers: auth });

      expect(await (await remove(three.id, 'version')).json()).toEqual({ deleted: [three.id] });
      expect(await list()).toEqual([expect.objectContaining({ id: two.id, versions: 2 })]);
      const whole = (await (await remove(two.id, 'file')).json()) as { deleted: string[] };
      expect(whole.deleted).toHaveLength(2);
      expect(await list()).toEqual([]);
      expect((await remove(two.id, 'file')).status).toBe(404);
      expect((await remove(two.id, 'everything')).status).toBe(400);
      // The workspace copy is never touched.
      expect(await readFile(three.onDisk, 'utf8')).toBe('# Three\n');

      const undo = await fetch(`${base}/api/artifacts/restore`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ids: whole.deleted }) });
      expect(((await undo.json()) as { restored: string[] }).restored.sort()).toEqual([...whole.deleted].sort());
      expect(await list()).toEqual([expect.objectContaining({ id: two.id, versions: 2 })]);
    });

    it('keeps the same bytes from two outputs as two files, each written to its own path', async () => {
      const a = await captured('a/same.md', '# Same\n');
      const b = await captured('b/same.md', '# Same\n');
      expect(a.id).not.toBe(b.id);
      expect((await save(b.id, { text: '# B\n', base: sha('# Same\n') })).status).toBe(200);
      expect(await readFile(b.onDisk, 'utf8')).toBe('# B\n');
      expect(await readFile(a.onDisk, 'utf8')).toBe('# Same\n');
    });

    it('never writes outside the workspace of the agent and conversation that made it', async () => {
      const { id, onDisk } = await captured('elsewhere.md', '# Elsewhere\n', 'ledger');
      // The row says scout made it, but the copy is in ledger's workspace.
      await pool.query(`update core.artifacts set created_by = 'scout' where id = $1`, [id]);
      expect((await save(id, { text: '# Changed\n', base: sha('# Elsewhere\n') })).status).toBe(200);
      expect(await readFile(onDisk, 'utf8')).toBe('# Elsewhere\n');
    });
  });

  it('tells the agent of an owner edit once, on its next turn', async () => {
    const other = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id as string;
    const id = await file('# List\n', 'List.md', 'text/markdown', other);
    expect((await save(id, { text: '# List\n\n- Mine\n', base: sha('# List\n') })).status).toBe(200);
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    const first = await systemContext(ctx, { agentId: 'scout', tools: ['artifacts.text', 'artifacts.write'], conversationId: other });
    expect(first.prompt).toMatch(new RegExp(`The owner edited List\\.md at [^.]+\\. Your earlier copy \\(including any copy in your workspace\\) is out of date\\. Read the current text with artifacts\\.text \\{ id: "${id}" \\}, then save changes with artifacts\\.write \\{ fileId: "${id}" \\}, passing readVersion = the sha256 artifacts\\.text returned\\. Don't ask the owner to paste it\\.`));
    const next = await systemContext(ctx, { agentId: 'scout', tools: ['artifacts.text', 'artifacts.write'], conversationId: other });
    expect(next.prompt).not.toContain('The owner edited');
  });

  it('words the note by the tools the agent holds', () => {
    const edit = { artifactId: '11111111-1111-4111-8111-111111111111', filename: 'List.md', editedAt: '2026-10-13T09:00:00.000Z' };
    expect(ownerEditLine(edit, 'UTC', ['artifacts.text'])).toContain('artifacts.text { id: "11111111-1111-4111-8111-111111111111" }, before you change anything');
    expect(ownerEditLine(edit, 'UTC', ['artifacts.text'])).not.toContain('artifacts.write');
    expect(ownerEditLine(edit, 'UTC', [])).toMatch(/You cannot read files in Files; ask the owner what changed/);
    expect(ownerEditLine(edit, 'UTC', [])).not.toMatch(/\b(he|his|him)\b/);
    expect(ownerEditLine(edit, 'UTC', [])).not.toContain('artifacts.');
  });

  it('continues a command’s file as the next document version, over the owner’s edit once read', async () => {
    const other = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id as string;
    // Captured before outputs remembered their workspace path.
    const captured = await saveArtifact(pool, {
      bytes: Buffer.from('# Packing\n'), mime: 'text/markdown', filename: 'montreal-weekend-packing-list.md', createdBy: 'scout',
      conversationId: other, source: { surface: 'host', chatId: other },
    }, env);
    expect((await save(captured.id, { text: '# Packing\n\n- By buddi\n', base: sha('# Packing\n') })).status).toBe(200);
    const next = { bytes: Buffer.from('# Packing\n\n- By buddi\n\n## Toiletries\n'), mime: 'text/markdown', createdBy: 'scout', conversationId: other, base: 'montreal-weekend-packing-list', ext: 'md' };
    await expect(saveArtifactVersion(pool, next, env)).rejects.toBeInstanceOf(OwnerEditedError);
    const v2 = await saveArtifactVersion(pool, { ...next, readVersion: sha('# Packing\n\n- By buddi\n') }, env);
    expect(v2.version).toBe(2);
    expect(v2.row.filename).toBe('montreal-weekend-packing-list (v2).md');
    // And the owner's next save of the captured one is stale: v2 is the file now.
    const stale = await save(captured.id, { text: '# Old\n', base: sha('# Packing\n\n- By buddi\n') });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ current: { artifactId: v2.row.id } });
  });

  it('refuses a document write over an owner edit the writer did not read', async () => {
    const other = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id as string;
    const v1 = await saveArtifactVersion(pool, { bytes: Buffer.from('# Plan\n'), mime: 'text/markdown', createdBy: 'scout', conversationId: other, base: 'Plan', ext: 'md' }, env);
    expect((await save(v1.row.id, { text: '# Plan\n\nMine\n', base: sha('# Plan\n') })).status).toBe(200);
    const again = { bytes: Buffer.from('# Plan\n\nTheirs\n'), mime: 'text/markdown', createdBy: 'scout', conversationId: other, base: 'Plan', ext: 'md' };
    await expect(saveArtifactVersion(pool, again, env)).rejects.toBeInstanceOf(OwnerEditedError);
    // The id is not enough, nor the hash of what was there before his edit.
    await expect(saveArtifactVersion(pool, { ...again, readVersion: sha('# Plan\n') }, env)).rejects.toBeInstanceOf(OwnerEditedError);
    const v2 = await saveArtifactVersion(pool, { ...again, readVersion: sha('# Plan\n\nMine\n') }, env);
    expect(v2.version).toBe(2);
  });

  it('purges a file deleted a month ago, and keeps bytes another file still stores', async () => {
    const a = await saveArtifact(pool, { bytes: Buffer.from('# Shared bytes\n'), mime: 'text/markdown', filename: 'shared.md', createdBy: 'scout', conversationId }, env);
    const b = await saveArtifact(pool, { bytes: Buffer.from('# Shared bytes\n'), mime: 'text/markdown', filename: 'shared.md', createdBy: 'owner', source: { surface: 'telegram', chatId: '42' } }, env);
    expect(b.id).not.toBe(a.id);
    expect(b.storagePath).toBe(a.storagePath);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await pool.query('update core.artifacts set deleted_at = $2 where id = $1', [a.id, old]);
    const first = await purgeDeletedArtifacts(pool, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), env);
    expect(first.rows).toBeGreaterThanOrEqual(1);
    expect((await pool.query('select 1 from core.artifacts where id = $1', [a.id])).rows).toHaveLength(0);
    expect(await stat(path.join(dir, b.storagePath)).then(() => true, () => false)).toBe(true);
    // Deleted yesterday: kept, and so are its bytes.
    await pool.query('update core.artifacts set deleted_at = now() - interval \'1 day\' where id = $1', [b.id]);
    await purgeDeletedArtifacts(pool, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), env);
    expect((await pool.query('select 1 from core.artifacts where id = $1', [b.id])).rows).toHaveLength(1);
    await pool.query('update core.artifacts set deleted_at = $2 where id = $1', [b.id, old]);
    const second = await purgeDeletedArtifacts(pool, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), env);
    expect(second.blobs).toBeGreaterThanOrEqual(1);
    expect(await stat(path.join(dir, b.storagePath)).then(() => true, () => false)).toBe(false);
  });

  it('keeps an editor’s text as a new file of the owner’s after its file was deleted', async () => {
    const id = await file('# Draft\n', 'Draft.md');
    await pool.query('update core.artifacts set deleted_at = now() where id = $1', [id]);
    const res = await fetch(`${base}/api/artifacts/${id}/copy`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: '# Draft, mine\n' }),
    });
    expect(res.status).toBe(200);
    const made = (await res.json()) as { artifactId: string; filename: string };
    expect(made.filename).toBe('Draft.md');
    expect(await (await read(made.artifactId)).json()).toMatchObject({ text: '# Draft, mine\n' });
    const { rows } = await pool.query('select created_by, deleted_at from core.artifacts where id = $1', [made.artifactId]);
    expect(rows[0]).toMatchObject({ created_by: 'owner', deleted_at: null });
  });

  it('opens a file past 1 MiB read-only, its start only', async () => {
    const big = 'line\n'.repeat(250_000);
    const id = await file(big, 'big.log', 'text/plain');
    const body = (await (await read(id)).json()) as { text: string; editable: boolean; truncated: boolean };
    expect(body.editable).toBe(false);
    expect(body.truncated).toBe(true);
    expect(body.text.length).toBe(1024 * 1024);
  });
});

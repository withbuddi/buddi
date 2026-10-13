/**
 * The artifact tools against a real database. Skipped unless DATABASE_URL is
 * set; when it runs it creates a throwaway database and a throwaway data dir,
 * and never touches the owner's own.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, migrateCore, saveArtifact } from '@buddi/core/testing';
import type { CoreToolContext } from '@buddi/core/testing';
import { manifest } from '../index.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_artifact_tools_test_${process.pid}`;

suite('artifacts tools (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let previousDataDir: string | undefined;
  const registry = new ToolRegistry();

  let conversationId = '';
  const ctx = (conversation?: string): CoreToolContext => ({
    db: pool,
    ownerId: 'test',
    now: () => new Date('2026-09-13T12:00:00Z'),
    timezone: 'UTC',
    agentId: 'finance-advisor',
    ...(conversation ? { conversationId: conversation } : {}),
    // The gateway passes its exporter; here a stand-in that says what it was given.
    convertDocument: async (source, to) => { converted.push({ to, mime: source.mime, filename: source.filename }); return Buffer.from(`${to}:${source.bytes.toString('utf8')}`); },
  });
  const converted: Array<{ to: string; mime: string; filename: string }> = [];

  const call = async (name: string, args: unknown, conversation?: string): Promise<any> => {
    const result = await registry.invoke(name, args, ctx(conversation));
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  let textId = '';
  let imageId = '';

  beforeAll(async () => {
    registry.register(manifest);
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    pool = createPool((databaseUrl as string).replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`));
    await migrateCore(pool);

    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-artifact-tools-'));
    // The tools read the data dir from the ambient environment, the same way
    // the running process does; the test points it somewhere disposable.
    previousDataDir = process.env.BUDDI_DATA_DIR;
    process.env.BUDDI_DATA_DIR = dataDir;

    const statement = await saveArtifact(pool, {
      bytes: Buffer.from('BUDDI TEST STATEMENT\n\n\nClosing balance 987.65\n', 'utf8'),
      mime: 'text/plain',
      filename: 'august.txt',
      caption: 'august statement',
      createdBy: 'owner',
      source: { surface: 'telegram', chatId: '42' },
    });
    textId = statement.id;

    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(300, 16);
    png.writeUInt32BE(200, 20);
    const photo = await saveArtifact(pool, {
      bytes: png,
      mime: 'image/png',
      filename: 'receipt.png',
      createdBy: 'owner',
    });
    imageId = photo.id;
    const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('finance-advisor') returning id`);
    conversationId = String(rows[0].id);
  }, 60_000); // a fresh schema plus fixtures: under the whole gate's load the default 10 s was flaky

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (previousDataDir === undefined) delete process.env.BUDDI_DATA_DIR;
    else process.env.BUDDI_DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('registers four auto-tier tools and no migrations', () => {
    expect(manifest.migrationsDir).toBe('');
    const specs = registry.list().filter((s) => s.name.startsWith('artifacts.'));
    expect(specs.map((s) => s.name)).toEqual([
      'artifacts.list',
      'artifacts.describe',
      'artifacts.text',
      'artifacts.write',
    ]);
    expect(specs.every((s) => s.tier === 'auto')).toBe(true);
  });

  it('lists metadata only — never the bytes', async () => {
    const out = await call('artifacts.list', { limit: 10 });
    expect(out.count).toBeGreaterThanOrEqual(2);
    const first = out.artifacts[0];
    expect(Object.keys(first).sort()).toEqual(
      ['caption', 'createdAt', 'fileId', 'filename', 'id', 'kind', 'mime', 'sizeBytes', 'version'].sort(),
    );
    const images = await call('artifacts.list', { kind: 'image' });
    expect(images.artifacts.map((a: any) => a.id)).toEqual([imageId]);
  });

  it('describes a text artifact with its extracted text', async () => {
    const out = await call('artifacts.describe', { id: textId });
    expect(out.filename).toBe('august.txt');
    expect(out.caption).toBe('august statement');
    expect(out.text).toBe('BUDDI TEST STATEMENT\n\nClosing balance 987.65');
    expect(out.truncated).toBe(false);
  });

  it('describes an image with its pixel size and no text', async () => {
    const out = await call('artifacts.describe', { id: imageId });
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
    expect(out.text).toBeUndefined();
    expect(out.note).toMatch(/shown to you directly/);
  });

  it('returns the full text, and refuses a type it cannot read', async () => {
    const out = await call('artifacts.text', { id: textId });
    expect(out.text).toContain('Closing balance 987.65');
    expect(out.truncated).toBe(false);
    expect(out.chars).toBe(out.text.length);

    const refused = await registry.invoke('artifacts.text', { id: imageId }, ctx());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/image\/png/);
  });

  it('caps a long file at 16 KB and says how much there was and where it goes instead', async () => {
    const rows = Array.from({ length: 900 }, (_, i) => `2026-09-${String((i % 28) + 1).padStart(2, '0')},Card payment ${i},-${(i * 1.37).toFixed(2)}`);
    const csv = await saveArtifact(pool, {
      bytes: Buffer.from(`Date,Description,Amount\n${rows.join('\n')}\n`, 'utf8'),
      mime: 'text/csv', filename: 'transactions.csv', createdBy: 'owner',
    });
    const out = await call('artifacts.text', { id: csv.id });
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(out.text.endsWith('\n')).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.note).toMatch(/^1[56] KB of 3\d KB; use artifacts\.describe or the plugin's import tool\./);
    // Asking for more than the cap still gets the cap.
    const more = await call('artifacts.text', { id: csv.id, maxChars: 100_000 });
    expect(Buffer.byteLength(more.text, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    // A short read stays whole, with no note.
    const short = await call('artifacts.text', { id: textId });
    expect(short.note).toBeUndefined();
  });

  it('tells agents a statement goes to the plugin’s import tool, not into the reply', () => {
    const tool = manifest.tools.find((t) => t.name === 'artifacts.text')!;
    expect(tool.description).toMatch(/import tool/);
    expect(tool.description).toMatch(/Never paste a file's contents into your reply/);
  });

  it('refuses an unknown id with something the model can act on', async () => {
    const missing = await registry.invoke(
      'artifacts.describe',
      { id: '11111111-1111-4111-8111-111111111111' },
      ctx(),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/artifacts.list/);
  });

  it('refuses an id that is not a uuid before touching the database', async () => {
    const bad = await registry.invoke('artifacts.describe', { id: 'august.pdf' }, ctx());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid-args');
  });

  describe('artifacts.write', () => {
    it('saves a Markdown document into Files, credited to the agent and its conversation', async () => {
      const out = await call('artifacts.write', { title: 'Heat pumps compared', format: 'markdown', content: '# Heat pumps\n\nThree models.', folder: 'Home' }, conversationId);
      expect(out).toMatchObject({ filename: 'Heat pumps compared.md', version: 1, mime: 'text/markdown', folder: 'Home', format: 'markdown' });
      expect(out.note).toMatch(/PDF or Word/);
      const { rows } = await pool.query('select created_by, conversation_id, caption, storage_path from core.artifacts where id = $1', [out.artifactId]);
      expect(rows[0]).toMatchObject({ created_by: 'finance-advisor', conversation_id: conversationId, caption: 'Home' });
      expect(rows[0].storage_path).toMatch(/^artifacts\/\d{4}\/\d{2}\/[0-9a-f]{64}\.md$/);
      const read = await call('artifacts.text', { id: out.artifactId });
      expect(read.text).toContain('Three models.');
    });

    it('writing the same title again in the conversation makes a new version, keeping the first', async () => {
      const second = await call('artifacts.write', { title: 'Heat pumps compared', format: 'markdown', content: '# Heat pumps\n\nFour models now.' }, conversationId);
      expect(second).toMatchObject({ filename: 'Heat pumps compared.md', version: 2 });
      const third = await call('artifacts.write', { title: 'heat pumps compared', format: 'markdown', content: 'Five.' }, conversationId);
      // A title differing only in case continues the file under its own name; no name carries a version.
      expect(third).toMatchObject({ filename: 'Heat pumps compared.md', version: 3, fileId: second.fileId });
      const { rows } = await pool.query(`select count(*)::int as n from core.artifacts where conversation_id = $1 and deleted_at is null`, [conversationId]);
      expect(rows[0].n).toBe(3);
      // Another conversation starts its own count.
      const elsewhere = await call('artifacts.write', { title: 'Heat pumps compared', format: 'markdown', content: 'Elsewhere.' });
      expect(elsewhere.version).toBe(1);
    });

    it('the same bytes again are not a silent copy: it says nothing new was saved', async () => {
      const again = await call('artifacts.write', { title: 'Heat pumps compared', format: 'markdown', content: 'Five.' }, conversationId);
      expect(again.unchanged).toBe(true);
      expect(again.filename).toBe('Heat pumps compared.md');
      expect(again.version).toBe(3);
    });

    it('the same title in another conversation is a file of its own', async () => {
      const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('finance-advisor') returning id`);
      const other = String(rows[0].id);
      const out = await call('artifacts.write', { title: 'Heat pumps compared', format: 'markdown', content: '# Heat pumps\n\nThree models.' }, other);
      expect(out).toMatchObject({ version: 1 });
      expect(out.unchanged).toBeUndefined();
    });

    it('counts versions over the whole conversation, not the newest 100 files', async () => {
      const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('finance-advisor') returning id`);
      const conv = String(rows[0].id);
      expect((await call('artifacts.write', { title: 'Old report', format: 'markdown', content: 'one' }, conv)).version).toBe(1);
      expect((await call('artifacts.write', { title: 'Old report', format: 'markdown', content: 'two' }, conv)).version).toBe(2);
      // 120 newer files push the report out of any page of the library.
      for (let i = 0; i < 120; i++) {
        await saveArtifact(pool, { bytes: Buffer.from(`note ${i}`), mime: 'text/plain', filename: `n${i}.txt`, createdBy: 'owner', conversationId: conv });
      }
      const third = await call('artifacts.write', { title: 'Old report', format: 'markdown', content: 'three' }, conv);
      expect(third).toMatchObject({ filename: 'Old report.md', version: 3 });
    });

    it('two writes at once get two versions', async () => {
      const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('finance-advisor') returning id`);
      const conv = String(rows[0].id);
      const outs = await Promise.all(
        Array.from({ length: 6 }, (_, i) => call('artifacts.write', { title: 'Race', format: 'markdown', content: `draft ${i}` }, conv)),
      );
      expect(outs.map((o) => o.version).sort()).toEqual([1, 2, 3, 4, 5, 6]);
      // One file, six versions.
      expect(new Set(outs.map((o) => o.fileId)).size).toBe(1);
    });

    it('writes the next version of a file named by fileId, keeping a command output’s name and workspace', async () => {
      const capture = await saveArtifact(pool, {
        bytes: Buffer.from('# Packing\n'), mime: 'text/markdown', filename: 'montreal-weekend-packing-list.md', createdBy: 'finance-advisor',
        conversationId, source: { surface: 'host', chatId: conversationId }, originPath: 'host/workspaces/x/out/montreal-weekend-packing-list.md',
      });
      const out = await call('artifacts.write', { title: 'Something else', format: 'markdown', content: '# Packing\n\n## Toiletries\n', fileId: capture.fileId }, conversationId);
      expect(out).toMatchObject({ filename: 'montreal-weekend-packing-list.md', fileId: capture.fileId, version: 2 });
      const { rows } = await pool.query('select origin_path from core.files where id = $1', [capture.fileId]);
      expect(rows[0].origin_path).toBe('host/workspaces/x/out/montreal-weekend-packing-list.md');
      // A version's id names its file too.
      expect((await call('artifacts.write', { title: 'x', format: 'markdown', content: '# Packing, three\n', fileId: capture.id }, conversationId)).version).toBe(3);
      // Without fileId, the file's own name (any case) is the same file.
      const joined = await call('artifacts.write', { title: 'Montreal-Weekend-Packing-List', format: 'markdown', content: '# Packing, four\n' }, conversationId);
      expect(joined).toMatchObject({ fileId: capture.fileId, version: 4 });
    });

    it('a title that differs by more than case is a new file', async () => {
      const first = await call('artifacts.write', { title: 'Road Trip Plan', format: 'markdown', content: '# One\n' }, conversationId);
      const second = await call('artifacts.write', { title: 'road-trip-plan', format: 'markdown', content: '# Two\n' }, conversationId);
      expect(first.filename).toBe('Road Trip Plan.md');
      expect(second).toMatchObject({ filename: 'road-trip-plan.md', version: 1 });
      expect(second.fileId).not.toBe(first.fileId);
    });

    it('refuses a write over the owner’s newest version until it was read', async () => {
      const first = await call('artifacts.write', { title: 'Shopping', format: 'markdown', content: '# Shopping\n' }, conversationId);
      await pool.query(
        `insert into core.artifacts (kind, mime, filename, size_bytes, sha256, storage_path, created_by, conversation_id, file_id, version)
         select kind, mime, filename, size_bytes, sha256, storage_path, 'owner', conversation_id, file_id, 2 from core.artifacts where id = $1`,
        [first.artifactId],
      );
      const refused = await registry.invoke('artifacts.write', { title: 'Shopping', format: 'markdown', content: '# Shopping\n- Milk\n' }, ctx(conversationId));
      expect(refused.ok).toBe(false);
      expect(refused.ok ? '' : refused.message).toMatch(/newest version of Shopping\.md \(v2\) is by the owner.*readVersion 2/);
      const stale = await registry.invoke('artifacts.write', { title: 'Shopping', format: 'markdown', content: '# Shopping\n- Milk\n', readVersion: 1 }, ctx(conversationId));
      expect(stale.ok).toBe(false);
      const ok = await call('artifacts.write', { title: 'Shopping', format: 'markdown', content: '# Shopping\n- Milk\n', readVersion: 2 }, conversationId);
      expect(ok.version).toBe(3);
    });

    it('stores a JSON table as CSV', async () => {
      const out = await call('artifacts.write', { title: 'Budget', format: 'json', content: JSON.stringify([{ Item: 'Rent', Amount: 1200 }, { Item: 'Food, misc', Amount: 400 }]) }, conversationId);
      expect(out).toMatchObject({ filename: 'Budget.csv', mime: 'text/csv' });
      const read = await call('artifacts.text', { id: out.artifactId });
      expect(read.text.split(/\r?\n/)).toEqual(['Item,Amount', 'Rent,1200', '"Food, misc",400']);
    });

    it('a title cannot reach outside the store', async () => {
      const out = await call('artifacts.write', { title: '../../../etc/passwd', format: 'csv', content: 'a,b\n1,2' }, conversationId);
      expect(out.filename).toBe('etc-passwd.csv');
      const { rows } = await pool.query('select storage_path from core.artifacts where id = $1', [out.artifactId]);
      expect(rows[0].storage_path).not.toContain('..');
    });

    describe('onto an Office file', () => {
      const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      const office = (mime: string, filename: string, createdBy: string): Promise<{ id: string; fileId: string }> => saveArtifact(pool, {
        bytes: Buffer.from(`${filename} ${createdBy} ${Math.random()}`), mime, filename, createdBy, conversationId,
        source: { surface: createdBy === 'owner' ? 'web' : 'files', chatId: conversationId },
      });

      it('rebuilds a .docx buddi made from Markdown, as its next version, and says the formatting was not kept', async () => {
        const made = await office(DOCX, 'Plan.docx', 'writer');
        converted.length = 0;
        const out = await call('artifacts.write', { title: 'x', format: 'markdown', content: '# Plan\n', fileId: made.fileId, readVersion: 1 }, conversationId);
        expect(out).toMatchObject({ fileId: made.fileId, version: 2, filename: 'Plan.docx', mime: DOCX, rebuilt: true });
        expect(out.note).toMatch(/formatting was not preserved from v1/);
        expect(converted).toEqual([{ to: 'docx', mime: 'text/markdown', filename: 'Plan.md' }]);
        const { rows } = await pool.query(`select mime from core.files where id = $1`, [made.fileId]);
        expect(rows[0].mime).toBe(DOCX);
      });

      it('rebuilds a .xlsx from a table, and refuses Markdown for it', async () => {
        const made = await office(XLSX, 'Budget.xlsx', 'writer');
        const out = await call('artifacts.write', { title: 'x', format: 'csv', content: 'a,b\n1,2', fileId: made.fileId, readVersion: 1 }, conversationId);
        expect(out).toMatchObject({ version: 2, rebuilt: true });
        const wrong = await registry.invoke('artifacts.write', { title: 'x', format: 'markdown', content: '# no', fileId: made.fileId }, ctx(conversationId));
        expect(wrong.ok ? '' : wrong.message).toMatch(/spreadsheet: write it as a table/);
      });

      it('refuses the owner’s own .docx until he agreed, telling the agent to ask him first', async () => {
        const upload = await office(DOCX, 'Contract.docx', 'owner');
        const refused = await registry.invoke('artifacts.write', { title: 'x', format: 'markdown', content: '# Contract\n', fileId: upload.fileId, readVersion: 1 }, ctx(conversationId));
        expect(refused.ok).toBe(false);
        expect(refused.ok ? '' : refused.message).toMatch(/owner's own Word document.*Ask the owner first.*confirmedRebuild: true/);
        const { rows } = await pool.query(`select count(*)::int as n from core.artifacts where file_id = $1`, [upload.fileId]);
        expect(rows[0].n).toBe(1);
        const agreed = await call('artifacts.write', { title: 'x', format: 'markdown', content: '# Contract\n', fileId: upload.fileId, readVersion: 1, confirmedRebuild: true }, conversationId);
        expect(agreed).toMatchObject({ version: 2, rebuilt: true });
      });

      it('never writes a presentation', async () => {
        const deck = await office(PPTX, 'Deck.pptx', 'writer');
        const refused = await registry.invoke('artifacts.write', { title: 'x', format: 'markdown', content: '# Deck', fileId: deck.fileId, confirmedRebuild: true }, ctx(conversationId));
        expect(refused.ok ? '' : refused.message).toMatch(/presentation; agents can read it/);
      });
    });

    it('refuses bad input before writing anything', async () => {
      const big = await registry.invoke('artifacts.write', { title: 'Big', format: 'markdown', content: 'x'.repeat(600_000) }, ctx(conversationId));
      expect(big.ok).toBe(false);
      if (!big.ok) expect(big.reason).toBe('invalid-args');
      const badFormat = await registry.invoke('artifacts.write', { title: 'A', format: 'docx', content: 'x' }, ctx(conversationId));
      expect(badFormat.ok).toBe(false);
      const badTable = await registry.invoke('artifacts.write', { title: 'A', format: 'json', content: '{"a":1}' }, ctx(conversationId));
      expect(badTable.ok).toBe(false);
      if (!badTable.ok) expect(badTable.message).toMatch(/array of objects/);
      const extra = await registry.invoke('artifacts.write', { title: 'A', format: 'markdown', content: 'x', path: '/etc' }, ctx(conversationId));
      expect(extra.ok).toBe(false);
    });
  });
});

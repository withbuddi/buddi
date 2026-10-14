/**
 * `artifacts.compose` and `artifacts.view` against a real database and a
 * real confined child Node. Skipped unless DATABASE_URL is set (and the
 * compose half where this computer cannot confine a program); when it runs
 * it creates a throwaway database and data dir.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Pool } from 'pg';
import pngjs from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, composeSourceOf, createPool, decideApproval, executeApproved, migrateCore, officePackageProblem, saveArtifact, saveOwnerVersion, testDatabaseUrl } from '@buddi/core/testing';
import type { CoreToolContext } from '@buddi/core/testing';
import { composeAvailability, manifest } from '@buddi/tool-artifacts';
import { confinementArea } from '@buddi/tool-host';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
// The OS sandbox the gateway hands every plugin; without one compose does not run, and that half is skipped.
const confinement = confinementArea();
const composing = composeAvailability({ confinement: confinement.kind }).available ? describe : describe.skip;
const GUIDES = path.join(path.dirname(createRequire(import.meta.url).resolve('@buddi/tool-artifacts')), '..', 'guides');
const TEST_DB = `buddi_compose_test_${process.pid}`;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** The guide's own programs: what an agent is told to start from must run. */
async function guideBlocks(name: 'docx' | 'pptx'): Promise<string[]> {
  const text = await readFile(path.join(GUIDES, `${name}.md`), 'utf8');
  return [...text.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!);
}
async function guideProgram(name: 'docx' | 'pptx'): Promise<string> {
  return (await guideBlocks(name)).find((b) => b.includes('defineSlideMaster') || b.includes('styles:'))!;
}

suite('artifacts.compose and artifacts.view (postgres)', { timeout: 180_000 }, () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let previousDataDir: string | undefined;
  let conversationId = '';
  const registry = new ToolRegistry();
  const ctx = (): CoreToolContext => ({
    db: pool, ownerId: 'test', now: () => new Date('2026-10-13T12:00:00Z'), timezone: 'UTC',
    agentId: 'writer', conversationId, confinement,
    convertDocument: async (source, to) => Buffer.from(`${to}:${source.bytes.toString('utf8')}`),
  });
  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await registry.invoke(name, args, ctx());
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };
  const refusal = async (name: string, args: unknown): Promise<string> => {
    const result = await registry.invoke(name, args, ctx());
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.message;
  };
  const versions = async (fileId: string): Promise<number> =>
    Number((await pool.query(`select count(*)::int as n from core.artifacts where file_id = $1`, [fileId])).rows[0].n);

  beforeAll(async () => {
    registry.register(manifest);
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    pool = createPool((databaseUrl as string).replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`));
    await migrateCore(pool);
    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-compose-tools-'));
    previousDataDir = process.env.BUDDI_DATA_DIR;
    process.env.BUDDI_DATA_DIR = dataDir;
    const { rows } = await pool.query(`insert into core.conversations (agent_id) values ('writer') returning id`);
    conversationId = String(rows[0].id);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (previousDataDir === undefined) delete process.env.BUDDI_DATA_DIR;
    else process.env.BUDDI_DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('hands out its guides', async () => {
    for (const guide of ['docx', 'pptx', 'layout']) {
      const out = await call('artifacts.compose', { guide });
      expect(out.text.split('\n').length).toBeGreaterThan(60);
    }
  });

  composing('composing', () => {
    let letter: { fileId: string; artifactId: string } = { fileId: '', artifactId: '' };

    it('makes a Word document from a program, versioned by fileId, its program kept beside each version', async () => {
      const program = await guideProgram('docx');
      const v1 = await call('artifacts.compose', { kind: 'docx', program, title: 'Offer for the kitchen' });
      expect(v1).toMatchObject({ version: 1, filename: 'Offer for the kitchen.docx', mime: DOCX });
      letter = v1;
      const row = (await pool.query(`select storage_path from core.artifacts where id = $1`, [v1.artifactId])).rows[0];
      expect(officePackageProblem(await readFile(path.join(dataDir, row.storage_path)), 'docx')).toBeNull();
      expect(v1.render).toMatchObject({ kind: 'docx', page: { name: 'A4', orientation: 'portrait' }, header: true, footer: true });
      expect(v1.render.fonts).toEqual(['Calibri']);
      expect(v1.render.outline[0]).toEqual({ level: 1, text: 'Offer for the kitchen renovation' });
      expect(v1.render.pages.estimated).toBe(1);

      const edited = program.replace('Here is what we propose.', 'Here is what we propose, in two parts.');
      const v2 = await call('artifacts.compose', { kind: 'docx', program: edited, fileId: v1.fileId });
      expect(v2).toMatchObject({ fileId: v1.fileId, version: 2, filename: 'Offer for the kitchen.docx' });
      const source = await call('artifacts.compose', { fileId: v1.fileId, source: true });
      expect(source).toMatchObject({ version: 2, kind: 'docx', library: 'docx', program: edited });
      expect((await call('artifacts.compose', { fileId: v1.artifactId, source: true })).program).toBe(program);
      const { rows } = await pool.query(`select library_version, node_version from core.compose_sources where artifact_id = $1`, [v2.artifactId]);
      expect(rows[0].library_version).toMatch(/^\d+\.\d+\.\d+/);
      expect(rows[0].node_version).toBe(process.versions.node);
      // The canvas and Files mark each version.
      const listed = (await pool.query(`select a.version, exists (select 1 from core.compose_sources s where s.artifact_id = a.id) as composed from core.artifacts a where a.file_id = $1 order by a.version`, [v1.fileId])).rows;
      expect(listed).toEqual([{ version: 1, composed: true }, { version: 2, composed: true }]);
    });

    it('stores nothing on a dry run', async () => {
      const before = Number((await pool.query(`select count(*)::int as n from core.artifacts`)).rows[0].n);
      const out = await call('artifacts.compose', { kind: 'docx', program: await guideProgram('docx'), title: 'Draft only', dryRun: true });
      expect(out).toMatchObject({ dryRun: true, kind: 'docx' });
      expect(out.render.kind).toBe('docx');
      expect(out.artifactId).toBeUndefined();
      expect(Number((await pool.query(`select count(*)::int as n from core.artifacts`)).rows[0].n)).toBe(before);
      expect((await pool.query(`select 1 from core.files where name = 'Draft only.docx'`)).rows).toEqual([]);
    });

    it('makes a deck, and warns about text that spills out of its box', async () => {
      const deck = await call('artifacts.compose', { kind: 'pptx', program: await guideProgram('pptx'), title: 'Quarterly review' });
      expect(deck).toMatchObject({ version: 1, filename: 'Quarterly review.pptx', mime: PPTX });
      expect(deck.render).toMatchObject({ kind: 'pptx', slide: { name: '16:9' } });
      expect(deck.render.slides.map((s: any) => s.title)).toEqual(['Quarterly review', 'Revenue grew 12% on repeat customers']);
      expect(deck.render.warnings).toEqual([]);
      const crowded = `import PptxGenJS from 'pptxgenjs';
        export default async () => { const p = new PptxGenJS(); p.layout = 'LAYOUT_WIDE';
          const s = p.addSlide(); s.addText('${'A long sentence that will not fit. '.repeat(20)}', { x: 1, y: 1, w: 4, h: 0.6, fontSize: 24 });
          s.addText('Off the edge', { x: 12, y: 1, w: 3, h: 1 });
          return p.write({ outputType: 'nodebuffer' }); };`;
      const out = await call('artifacts.compose', { kind: 'pptx', program: crowded, fileId: deck.fileId });
      expect(out.version).toBe(2);
      expect(out.render.warnings.join('\n')).toMatch(/slide 1: "A long sentence.*likely overflows its box/);
      expect(out.render.warnings.join('\n')).toMatch(/slide 1: "Off the edge" reaches past the slide's edge/);
    });

    it('gives a broken program back to the agent to fix, and stores nothing', async () => {
      const before = await versions(letter.fileId);
      const message = await refusal('artifacts.compose', { kind: 'docx', program: `import { Document } from 'docx';\nexport default async () => {\n  return missing.call();\n};\n`, fileId: letter.fileId });
      expect(message).toMatch(/^program_error: ReferenceError: missing is not defined\n {2}at default \(?program\.mjs:3:\d+/);
      expect(message).toMatch(/artifacts\.write format docx/);
      expect(message).not.toMatch(/\/Users\/|\/home\/|node_modules/);
      // The conversation's first failed run brings the guide, with the shared layout one; the next does not.
      expect(message).toContain('# Composing a Word document');
      expect(message).toContain('# Type, colour and space');
      expect(await refusal('artifacts.compose', { kind: 'docx', program: 'export default async () => { throw new Error("again"); };', fileId: letter.fileId })).not.toContain('# Composing a Word document');
      expect(await refusal('artifacts.compose', { kind: 'docx', program: `export default async () => Buffer.from('not a zip');`, fileId: letter.fileId })).toMatch(/^not_a_package:/);
      expect(await refusal('artifacts.compose', { kind: 'pptx', program: await guideProgram('pptx'), fileId: letter.fileId })).toMatch(/not a \.pptx; a write never changes a file's format/);
      expect(await versions(letter.fileId)).toBe(before);
    });

    it('keeps the program through a Restore', async () => {
      const restored = await saveOwnerVersion(pool, { fileId: letter.fileId, bytes: await bytesOf(letter.artifactId), base: 2, restoredFrom: 1 });
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.row.version).toBe(3);
      const source = await composeSourceOf(pool, restored.row.id);
      expect(source?.program).toBe(await guideProgram('docx'));
      // A restored composed version is composed: the agent edits it freely, having read it.
      const v4 = await call('artifacts.compose', { kind: 'docx', program: source!.program.replace('Offer for', 'Our offer for'), fileId: letter.fileId, readVersion: 3 });
      expect(v4.version).toBe(4);
    });

    it('composes over the owner’s own edit only once he approved it on a card, bound to the version and the program', async () => {
      // The owner saved it in Word: his version, no program.
      const saved = await saveOwnerVersion(pool, { fileId: letter.fileId, bytes: Buffer.concat([await bytesOf(letter.artifactId), Buffer.from(' ')]), base: 4 });
      expect(saved.ok && saved.row.version).toBe(5);
      const program = (await call('artifacts.compose', { fileId: letter.artifactId, source: true })).program;
      expect(await refusal('artifacts.compose', { kind: 'docx', program, fileId: letter.fileId, readVersion: 5 }))
        .toMatch(/v5 of Offer for the kitchen\.docx is the owner's own version.*artifacts\.text.*confirmedRebuild: true — buddi then asks him on a card/);
      expect(await refusal('artifacts.compose', { fileId: letter.fileId, source: true })).toMatch(/v5 of Offer for the kitchen\.docx was not made by a program/);
      // The model saying it asked is not the owner's yes: it raises a card, and nothing is written yet.
      const asked = await registry.invoke('artifacts.compose', { kind: 'docx', program, fileId: letter.fileId, readVersion: 5, confirmedRebuild: true }, ctx());
      expect(asked).toMatchObject({ ok: false, reason: 'approval-required' });
      if (asked.ok || asked.reason !== 'approval-required') return;
      expect(asked.preview).toBe("Rebuild Offer for the kitchen.docx? Your edits in v5 would be replaced by buddi's program; formatting rebuilt.");
      expect(await versions(letter.fileId)).toBe(5);
      // A rejected card writes nothing.
      const rejected = await registry.invoke('artifacts.compose', { kind: 'docx', program: `${program}\n// another`, fileId: letter.fileId, readVersion: 5, confirmedRebuild: true }, ctx());
      if (!rejected.ok && rejected.reason === 'approval-required') {
        await decideApproval(pool, { actionId: rejected.actionId, decision: 'rejected', by: 'owner', via: 'web', now: ctx().now() });
        expect((await executeApproved(pool, { actionId: rejected.actionId, registry, ctx: ctx(), worker: 'w', now: ctx().now() })).ok).toBe(false);
      }
      expect(await versions(letter.fileId)).toBe(5);
      // His yes: the action runs, as itself, and the version is written.
      await decideApproval(pool, { actionId: asked.actionId, decision: 'approved', by: 'owner', via: 'web', now: ctx().now() });
      const done = await executeApproved(pool, { actionId: asked.actionId, registry, ctx: ctx(), worker: 'w', now: ctx().now() });
      expect(done).toMatchObject({ ok: true });
      expect(await versions(letter.fileId)).toBe(6);
      // Markdown onto a composed file: edit the program instead, unless the owner asked for the rebuild.
      expect(await refusal('artifacts.write', { title: 'x', format: 'markdown', content: '# Offer', fileId: letter.fileId }))
        .toMatch(/was composed by a program: change it by editing its program \(artifacts\.compose \{ fileId, source: true \}/);
      const rebuilt = await call('artifacts.write', { title: 'x', format: 'markdown', content: '# Offer', fileId: letter.fileId, confirmedRebuild: true });
      expect(rebuilt).toMatchObject({ version: 7, rebuilt: true });
    });

    it('a card approved for one version does not write over a newer one', async () => {
      const saved = await saveOwnerVersion(pool, { fileId: letter.fileId, bytes: Buffer.from('his v8'), base: 7 });
      expect(saved.ok && saved.row.version).toBe(8);
      const program = await guideProgram('docx');
      const asked = await registry.invoke('artifacts.compose', { kind: 'docx', program, fileId: letter.fileId, readVersion: 8, confirmedRebuild: true }, ctx());
      if (asked.ok || asked.reason !== 'approval-required') throw new Error('expected a card');
      await decideApproval(pool, { actionId: asked.actionId, decision: 'approved', by: 'owner', via: 'web', now: ctx().now() });
      // He saves again before it runs.
      await saveOwnerVersion(pool, { fileId: letter.fileId, bytes: Buffer.from('his v9'), base: 8 });
      const done = await executeApproved(pool, { actionId: asked.actionId, registry, ctx: ctx(), worker: 'w', now: ctx().now() });
      expect(done.ok).toBe(false);
      expect(await versions(letter.fileId)).toBe(9);
    });

    it('runs the docx guide’s letter as it is', async () => {
      const letterProgram = (await guideBlocks('docx')).find((b) => b.includes('Dear Mr Berg'))!;
      const out = await call('artifacts.compose', { kind: 'docx', program: letterProgram, title: 'Letter to Northwind', dryRun: true });
      expect(out.render).toMatchObject({ kind: 'docx', page: { name: 'A4' }, pages: { estimated: 1 } });
      expect(out.render.text).toContain('Dear Mr Berg');
    });
  });

  it('shows the agent a picture, made smaller, once, beside the result', async () => {
    const image = new pngjs.PNG({ width: 3000, height: 2000 });
    for (let i = 0; i < image.data.length; i += 4) image.data.set([(i / 4) % 256, 120, 200, 255], i);
    const photo = await saveArtifact(pool, { bytes: pngjs.PNG.sync.write(image), mime: 'image/png', filename: 'kitchen.png', createdBy: 'owner', conversationId });
    const out = await call('artifacts.view', { fileId: photo.fileId });
    expect(out).toMatchObject({ id: photo.id, fileId: photo.fileId, width: 3000, height: 2000, shown: { mime: 'image/jpeg', width: 1568, height: 1045 } });
    expect(out.shown.sizeBytes).toBeLessThanOrEqual(1024 * 1024);
    const picture = await registry.image('artifacts.view', out, ctx());
    expect(picture?.mime).toBe('image/jpeg');
    expect(Buffer.from(picture!.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // Taken once: a later call does not send it again.
    expect(await registry.image('artifacts.view', out, ctx())).toBeUndefined();
    // A decompression bomb — a tiny PNG claiming one pixel that unpacks to 64 MB — is read in a worker, refused, and shown as nothing.
    const { crc32, deflateSync } = await import('node:zlib');
    const chunk = (type: string, body: Buffer): Buffer => {
      const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1');
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0);
      return Buffer.concat([head, body, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
    const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
    const bombed = await saveArtifact(pool, { bytes: bomb, mime: 'image/png', filename: 'bomb.png', createdBy: 'owner', conversationId });
    const seen = await call('artifacts.view', { fileId: bombed.fileId });
    expect(seen).toMatchObject({ shown: null, note: expect.stringMatching(/cannot be shown: That PNG unpacks to more than its size says/) });
    expect(await registry.image('artifacts.view', seen, ctx())).toBeUndefined();
    expect(await refusal('artifacts.view', { fileId: (await saveArtifact(pool, { bytes: Buffer.from('notes'), mime: 'text/plain', filename: 'n.txt', createdBy: 'owner' })).id }))
      .toMatch(/not a picture/);
  });

  async function bytesOf(artifactId: string): Promise<Buffer> {
    const row = (await pool.query(`select storage_path from core.artifacts where id = $1`, [artifactId])).rows[0];
    return readFile(path.join(dataDir, row.storage_path));
  }
});

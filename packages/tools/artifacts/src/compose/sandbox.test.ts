/**
 * The compose sandbox, for real: a child Node under the permission model
 * (and this computer's OS confinement, where it has one). Each test hands
 * it a program that tries one thing it must not do, and reads what came
 * back. No database.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { officePackageProblem } from '@buddi/core/plugin';
import { composeAvailability, runCompose, scrubPaths } from './sandbox.js';

const here = composeAvailability();
/** This computer's layers, and — where Node denies the network itself — the Node layer alone, as on Windows. */
const layers = !here.available ? [] : [
  { name: here.confinement ? `Node and ${here.confinement}` : 'Node only', availability: here },
  ...(here.confinement && here.networkDenied ? [{ name: 'Node only', availability: { ...here, confinement: null } }] : []),
];

describe.each(layers)('the compose sandbox ($name)', { timeout: 120_000 }, ({ availability }) => {
  let root: string;
  let secret: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'buddi-compose-'));
    // A file outside the work folder that a program must not read.
    secret = path.join(root, 'secret.txt');
    await writeFile(secret, 'the owner’s secret');
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  const run = (program: string, extra: Partial<Parameters<typeof runCompose>[0]> = {}) =>
    runCompose({ kind: 'docx', program, attachments: [], root: path.join(root, 'runs'), availability, ...extra });

  it('runs a docx program and a pptx program, and returns whole packages', async () => {
    const docx = await run(`
      import { Document, Packer, Paragraph, TextRun } from 'docx';
      export default async () => Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('Hello')] })] }] }));
    `);
    expect(docx.ok).toBe(true);
    if (docx.ok) expect(officePackageProblem(docx.bytes, 'docx')).toBeNull();
    const pptx = await run(`
      import PptxGenJS from 'pptxgenjs';
      export default async () => { const p = new PptxGenJS(); p.addSlide().addText('Hi', { x: 1, y: 1, w: 4, h: 1 }); return p.write({ outputType: 'nodebuffer' }); };
    `, { kind: 'pptx' });
    expect(pptx.ok).toBe(true);
    if (pptx.ok) expect(officePackageProblem(pptx.bytes, 'pptx')).toBeNull();
    // Each run's folder is gone afterwards.
    expect((await readdir(path.join(root, 'runs'))).length).toBe(0);
  });

  it('denies writing a file, even in its own folder', async () => {
    const out = await run(`import { writeFileSync } from 'node:fs'; export default async () => { writeFileSync('x.txt', 'x'); return Buffer.from('no'); };`);
    expect(out).toMatchObject({ ok: false, code: 'forbidden' });
    if (!out.ok) expect(out.message).toMatch(/tried to write a file/);
  });

  it('denies reading outside the work folder and the libraries', async () => {
    const out = await run(`import { readFileSync } from 'node:fs'; export default async () => readFileSync(${JSON.stringify(secret)});`);
    expect(out).toMatchObject({ ok: false, code: 'forbidden' });
    if (!out.ok) {
      expect(out.message).toMatch(/read a file outside its library/);
      expect(out.message).not.toContain(root);
    }
    const etc = await run(`import { readFileSync } from 'node:fs'; export default async () => readFileSync('/etc/hosts');`);
    expect(etc).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('denies the network', async () => {
    const out = await run(`export default async () => { const r = await fetch('https://example.com'); return Buffer.from(await r.text()); };`);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(['forbidden', 'program_error']).toContain(out.code);
    if (!out.ok && here.networkDenied) expect(out.code).toBe('forbidden');
    const socket = await run(`import net from 'node:net'; export default () => new Promise((resolve, reject) => { const s = net.connect(80, '1.1.1.1'); s.on('error', reject); s.on('connect', () => resolve(Buffer.from('connected'))); });`);
    expect(socket.ok).toBe(false);
  });

  it('denies child processes, workers and eval', async () => {
    const spawned = await run(`import { execSync } from 'node:child_process'; export default async () => execSync('echo hi');`);
    expect(spawned).toMatchObject({ ok: false, code: 'forbidden' });
    if (!spawned.ok) expect(spawned.message).toMatch(/start another process/);
    const worker = await run(`import { Worker } from 'node:worker_threads'; export default async () => { new Worker('1', { eval: true }); return Buffer.from('x'); };`);
    expect(worker).toMatchObject({ ok: false, code: 'forbidden' });
    const evaluated = await run(`export default async () => Buffer.from(String(eval('1 + 1')));`);
    expect(evaluated).toMatchObject({ ok: false, code: 'forbidden' });
    if (!evaluated.ok) expect(evaluated.message).toMatch(/evaluate code from a string/);
    const fn = await run(`export default async () => Buffer.from(String(new Function('return 2')()));`);
    expect(fn).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('refuses any package but its library', async () => {
    const out = await run(`import pako from 'pako'; export default async () => Buffer.from('x');`);
    expect(out).toMatchObject({ ok: false, code: 'program_error' });
    if (!out.ok) expect(out.message).toMatch(/can import only docx or pptxgenjs/);
  });

  it('stops a program at the deadline', async () => {
    const out = await run(`export default async () => { for (;;) {} };`, { limits: { timeoutMs: 2_000 } });
    expect(out).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('stops a program past its heap', async () => {
    const out = await run(`export default async () => { const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); };`, { limits: { heapMb: 64 } });
    expect(out).toMatchObject({ ok: false, code: 'memory' });
  });

  it('refuses output past 20 MB', async () => {
    const out = await run(`export default async () => Buffer.alloc(21 * 1024 * 1024, 1);`);
    expect(out).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('says where a program failed, in its own lines, without buddi’s paths', async () => {
    const out = await run(`import { Document } from 'docx';\n\nexport default async () => {\n  const doc = new Document({ sections: [] });\n  return doc.notAFunction();\n};\n`);
    expect(out).toMatchObject({ ok: false, code: 'program_error' });
    if (!out.ok) {
      expect(out.message).toMatch(/notAFunction is not a function/);
      expect(out.message).toMatch(/program\.mjs:5:\d+/);
      expect(out.message).not.toMatch(/\/Users\/|\/home\/|node_modules/);
    }
    const syntax = await run(`export default async () => {\n  return (;\n};\n`);
    expect(syntax).toMatchObject({ ok: false, code: 'program_error' });
    if (!syntax.ok) expect(syntax.message).toMatch(/SyntaxError/);
    const shape = await run(`import { Document } from 'docx'; export default async () => new Document({ sections: [] });`);
    if (!shape.ok) expect(shape.message).toMatch(/Packer\.toBuffer/);
  });

  it('keeps the console and hands the program its attachments', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const out = await run(`
      import { Document, ImageRun, Packer, Paragraph } from 'docx';
      export default async (ctx) => {
        console.log('files', ctx.files.length, ctx.files[0].type, ctx.files[0].width);
        const image = ctx.file('photo.png');
        return Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new ImageRun({ type: image.type, data: image.bytes, transformation: { width: 10, height: 10 } })] })] }] }));
      };
    `, { attachments: [{ fileId: '00000000-0000-4000-8000-000000000001', name: 'photo.png', mime: 'image/png', type: 'png', width: 1, height: 1, bytes: png }] });
    expect(out.ok).toBe(true);
    expect(out.console.stdout).toMatch(/files 1 png 1/);
  });
});

describe('compose availability', () => {
  it('refuses with no OS confinement and a Node that cannot deny the network', () => {
    const off = composeAvailability({ platform: 'linux', nodeVersion: '24.4.0', confinement: null });
    expect(off.available).toBe(false);
    expect(off.reason).toMatch(/no sandbox to keep a program off the network.*bubblewrap/);
  });
  it('runs with the Node layer alone where Node denies the network (Windows on Node 26)', () => {
    const windows = composeAvailability({ platform: 'win32', nodeVersion: '26.11.1', confinement: null });
    expect(windows).toMatchObject({ available: true, networkDenied: true, confinement: null });
    expect(windows.detail).toMatch(/permission model only/);
  });
  it('runs on an older Node inside an OS sandbox, and never below 22.15', () => {
    expect(composeAvailability({ platform: 'darwin', nodeVersion: '22.23.3', confinement: 'macos-sandbox' }).available).toBe(true);
    expect(composeAvailability({ platform: 'darwin', nodeVersion: '22.12.0', confinement: 'macos-sandbox' }).reason).toMatch(/Node 22\.15 or newer/);
  });
  it('refuses a run when compose is off, before anything starts', async () => {
    const off = composeAvailability({ platform: 'linux', nodeVersion: '24.4.0', confinement: null });
    const out = await runCompose({ kind: 'docx', program: 'export default async () => Buffer.from("x")', attachments: [], root: path.join(tmpdir(), 'never-made'), availability: off });
    expect(out).toMatchObject({ ok: false, code: 'unavailable' });
  });
  it('scrubs buddi’s paths out of what a program said', () => {
    expect(scrubPaths('at /Users/amen/buddi/node_modules/docx/x.js and C:\\buddi\\x', '/w')).toBe('at <buddi> and <buddi>');
  });
});

/**
 * A compose program as buddi runs it: Node's permission model and the
 * runner's built-in allowlist (the artifacts plugin) inside this computer's
 * OS sandbox (the host plugin's, handed to every plugin as
 * `ctx.buddi.confinement`). Each test hands it a program that tries one
 * thing it must not do, and reads what came back. Skipped where the
 * computer has no OS sandbox: compose does not run there at all.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { officePackageProblem } from '@buddi/core';
import { composeAvailability, runCompose } from '@buddi/tool-artifacts';
import { confinementArea } from '@buddi/tool-host';

const area = confinementArea();
const availability = composeAvailability({ confinement: area.kind });

describe.skipIf(!availability.available)(`a compose program inside ${area.kind ?? 'no OS sandbox'}`, { timeout: 180_000 }, () => {
  let root: string;
  let secret: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'buddi-compose-os-'));
    // A file outside the work folder that a program must not read.
    secret = path.join(root, 'secret.txt');
    await writeFile(secret, 'the owner’s secret');
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  const run = (program: string, extra: Partial<Parameters<typeof runCompose>[0]> = {}) =>
    runCompose({ kind: 'docx', program, attachments: [], root: path.join(root, 'runs'), availability, confine: (work, opts) => area.argv(work, opts), ...extra });
  const refused = async (program: string): Promise<{ code: string; message: string }> => {
    const out = await run(program);
    expect(out.ok, program).toBe(false);
    return out.ok ? { code: '', message: '' } : { code: out.code, message: out.message };
  };

  it('runs a docx program and a pptx program to whole packages, and leaves no folder behind', async () => {
    const docx = await run(`
      import { Document, Packer, Paragraph, TextRun } from 'docx';
      export default async () => Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('Hello')] })] }] }));
    `);
    expect(docx.ok && officePackageProblem(docx.bytes, 'docx')).toBeNull();
    const pptx = await run(`
      import PptxGenJS from 'pptxgenjs';
      export default async () => { const p = new PptxGenJS(); p.addSlide().addText('Hi', { x: 1, y: 1, w: 4, h: 1 }); return p.write({ outputType: 'nodebuffer' }); };
    `, { kind: 'pptx' });
    expect(pptx.ok && officePackageProblem(pptx.bytes, 'pptx')).toBeNull();
    expect((await readdir(path.join(root, 'runs'))).length).toBe(0);
  });

  it('refuses the built-ins that reach outside: fs, net, child_process, worker_threads, vm, sqlite, inspector, module', async () => {
    for (const name of ['fs', 'net', 'child_process', 'worker_threads', 'vm', 'sqlite', 'inspector', 'module', 'https', 'dns']) {
      const out = await refused(`import x from 'node:${name}'; export default async () => Buffer.from(String(x));`);
      expect(out, name).toMatchObject({ code: 'forbidden' });
      expect(out.message, name).toContain(`load node:${name}`);
    }
    // A require() through a library-style createRequire is the same hook; and a bare name too.
    expect((await refused(`import fs from 'fs'; export default async () => fs.readFileSync('/etc/hosts');`)).code).toBe('forbidden');
  });

  it('takes away what reaches around the resolver: getBuiltinModule, binding, dlopen, report, fetch', async () => {
    const out = await run(`export default async () => Buffer.from(JSON.stringify([typeof process.getBuiltinModule, typeof process.binding, typeof process.dlopen, typeof process.report, typeof fetch, typeof WebSocket]));`);
    // A Buffer that is not a package still comes back; read what it said.
    expect(out.ok).toBe(true);
    if (out.ok) expect(JSON.parse(out.bytes.toString('utf8'))).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    expect((await refused(`export default async () => process.getBuiltinModule('node:sqlite');`)).code).toBe('program_error');
  });

  it('denies reading outside the work folder and the libraries, writing anywhere, and the network', async () => {
    // Even with fs taken away, the OS sandbox and the permission model hold: a library's own fs is refused too.
    const read = await refused(`import { createRequire } from 'node:module'; export default async () => createRequire(import.meta.url)('fs').readFileSync(${JSON.stringify(secret)});`);
    expect(read.code).toBe('forbidden');
    expect(read.message).not.toContain(root);
    expect((await refused(`import P from 'pptxgenjs'; export default async () => { const p = new P(); await p.writeFile({ fileName: 'x.pptx' }); return Buffer.from('x'); };`)).code).toBe('program_error');
  });

  it('denies child processes, workers and eval', async () => {
    expect((await refused(`export default async () => Buffer.from(String(eval('1 + 1')));`))).toMatchObject({ code: 'forbidden', message: expect.stringMatching(/evaluate code from a string/) });
    expect((await refused(`export default async () => Buffer.from(String(new Function('return 2')()));`)).code).toBe('forbidden');
  });

  it('cannot signal its parent — buddi — or anyone else', async () => {
    const out = await run(`export default async () => { const tried = []; for (const sig of ['SIGKILL', 'SIGUSR1', 0]) { try { process.kill(process.ppid, sig); tried.push('sent'); } catch (e) { tried.push(e.code); } } return Buffer.from(JSON.stringify(tried)); };`);
    expect(out.ok).toBe(true);
    if (out.ok) expect(JSON.parse(out.bytes.toString('utf8'))).toEqual(['EPERM', 'EPERM', 'EPERM']);
  });

  it('loads no code from a data: URL, which would be eval by another name', async () => {
    const out = await refused(`export default async () => { const m = await import('data:text/javascript,export default 41 + 1'); return Buffer.from(String(m.default)); };`);
    expect(out).toMatchObject({ code: 'forbidden', message: expect.stringMatching(/load code from somewhere other than its library/) });
  });

  it('never sees the plan that names buddi’s install paths', async () => {
    const out = await run(`export default async () => { try { await import('./plan.json', { with: { type: 'json' } }); return Buffer.from('read'); } catch (e) { return Buffer.from(String(e.code ?? e.name)); } };`);
    expect(out.ok).toBe(true);
    // There is no plan file: it came on fd 4, which the runner read and closed.
    if (out.ok) expect(out.bytes.toString('utf8')).toBe('ERR_MODULE_NOT_FOUND');
  });

  it('refuses any package but its library', async () => {
    const out = await refused(`import pako from 'pako'; export default async () => Buffer.from('x');`);
    expect(out).toMatchObject({ code: 'program_error', message: expect.stringMatching(/can import only docx or pptxgenjs/) });
  });

  it('stops a program at the deadline', async () => {
    const out = await run(`export default async () => { for (;;) {} };`, { limits: { timeoutMs: 2_000 } });
    expect(out).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('stops a program past its heap', async () => {
    const out = await run(`export default async () => { const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); };`, { limits: { heapMb: 64 } });
    expect(out).toMatchObject({ ok: false, code: 'memory' });
  });

  it('kills a program whose Buffers pass the memory cap, which the heap limit does not count', async () => {
    const out = await run(`export default async () => { const keep = []; for (let i = 0; i < 40; i++) { keep.push(Buffer.alloc(32 * 1024 * 1024, i)); await new Promise((r) => setTimeout(r, 20)); } return Buffer.from('x'); };`, { limits: { rssMb: 256 } });
    expect(out).toMatchObject({ ok: false, code: 'memory' });
    if (!out.ok) expect(out.message).toMatch(/more than 256 MB of memory/);
  });

  it('refuses output past 20 MB', async () => {
    expect(await run(`export default async () => Buffer.alloc(21 * 1024 * 1024, 1);`)).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('says where a program failed, in its own lines, without buddi’s paths', async () => {
    const out = await refused(`import { Document } from 'docx';\n\nexport default async () => {\n  const doc = new Document({ sections: [] });\n  return doc.notAFunction();\n};\n`);
    expect(out.code).toBe('program_error');
    expect(out.message).toMatch(/notAFunction is not a function/);
    expect(out.message).toMatch(/program\.mjs:5:\d+/);
    expect(out.message).not.toMatch(/\/Users\/|\/home\/|node_modules/);
    expect((await refused(`export default async () => {\n  return (;\n};\n`)).message).toMatch(/SyntaxError/);
    expect((await refused(`import { Document } from 'docx'; export default async () => new Document({ sections: [] });`)).message).toMatch(/Packer\.toBuffer/);
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

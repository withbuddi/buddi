/**
 * A compose program under both layers, as the gateway runs it: Node's
 * permission model (the artifacts plugin) inside this computer's OS sandbox
 * (the host plugin's, handed to every plugin as `ctx.buddi.confinement`).
 * Skipped where the computer has no OS sandbox; the Node layer alone is
 * tested in the artifacts package.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { officePackageProblem } from '@buddi/core';
import { composeAvailability, runCompose } from '@buddi/tool-artifacts';
import { confinementArea } from '@buddi/tool-host';

const area = confinementArea();
const availability = composeAvailability({ confinement: area.kind });

describe.skipIf(area.kind === null || !availability.available)(`a compose program inside ${area.kind ?? 'no OS sandbox'}`, { timeout: 120_000 }, () => {
  let root: string;
  let secret: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'buddi-compose-os-'));
    secret = path.join(root, 'secret.txt');
    await writeFile(secret, 'the owner’s secret');
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  const run = (program: string, kind: 'docx' | 'pptx' = 'docx') =>
    runCompose({ kind, program, attachments: [], root: path.join(root, 'runs'), availability, confine: (work, opts) => area.argv(work, opts) });

  it('runs a docx and a pptx program to whole packages', async () => {
    const docx = await run(`import { Document, Packer, Paragraph } from 'docx'; export default async () => Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Hi')] }] }));`);
    expect(docx.ok && officePackageProblem(docx.bytes, 'docx')).toBeNull();
    const pptx = await run(`import P from 'pptxgenjs'; export default async () => { const p = new P(); p.addSlide().addText('Hi', { x: 1, y: 1, w: 3, h: 1 }); return p.write({ outputType: 'nodebuffer' }); };`, 'pptx');
    expect(pptx.ok && officePackageProblem(pptx.bytes, 'pptx')).toBeNull();
  });

  it('denies writes, reads outside, the network, processes and eval', async () => {
    const tries = [
      `import { writeFileSync } from 'node:fs'; export default async () => { writeFileSync('x', 'x'); return Buffer.from('x'); };`,
      `import { readFileSync } from 'node:fs'; export default async () => readFileSync(${JSON.stringify(secret)});`,
      `export default async () => Buffer.from(await (await fetch('https://example.com')).text());`,
      `import { execSync } from 'node:child_process'; export default async () => execSync('id');`,
      `export default async () => Buffer.from(String(eval('1')));`,
    ];
    for (const program of tries) {
      const out = await run(program);
      expect(out.ok, program).toBe(false);
      if (!out.ok) expect(['forbidden', 'program_error'], program).toContain(out.code);
    }
  });
});

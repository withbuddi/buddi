/**
 * What decides whether compose runs, and what buddi accepts back from a
 * program, without running one: the sandbox itself is exercised by the
 * gateway's `compose-sandbox.test.ts`, inside the OS layer the host plugin
 * hands in.
 */
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { COMPOSE_BUILTINS, composeAvailability, nodeFloorProblem, readFrame, runCompose, scrubPaths } from './sandbox.js';

const frame = (type: string, payload: Buffer | string, length?: number): Buffer => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeUInt32BE(length ?? body.length, 1);
  return Buffer.concat([head, body]);
};

describe('compose availability', () => {
  it('needs an OS sandbox everywhere, Windows included', () => {
    const windows = composeAvailability({ platform: 'win32', nodeVersion: '26.11.1', confinement: null });
    expect(windows.available).toBe(false);
    expect(windows.reason).toMatch(/need an OS sandbox.*Windows support is planned/);
    expect(composeAvailability({ platform: 'linux', nodeVersion: '26.11.1', confinement: null }).reason).toMatch(/install bubblewrap/);
    expect(composeAvailability({ platform: 'darwin', nodeVersion: '26.11.1', confinement: 'macos-sandbox' })).toMatchObject({ available: true, networkDenied: true });
    expect(composeAvailability({ platform: 'linux', nodeVersion: '24.21.0', confinement: 'bwrap' })).toMatchObject({ available: true, networkDenied: false });
  });
  it('needs a Node with the July 2026 permission-model fixes', () => {
    expect(nodeFloorProblem('26.11.1')).toBeNull();
    expect(nodeFloorProblem('26.5.1')).toBeNull();
    expect(nodeFloorProblem('26.5.0')).toMatch(/Node 26\.5\.1 or newer on the 26\.x line/);
    expect(nodeFloorProblem('24.18.0')).toMatch(/24\.18\.1/);
    expect(nodeFloorProblem('22.23.2')).toBeNull();
    expect(nodeFloorProblem('25.9.0')).toMatch(/maintained Node/);
    expect(nodeFloorProblem('27.1.0')).toBeNull();
    expect(composeAvailability({ platform: 'darwin', nodeVersion: '26.4.0', confinement: 'macos-sandbox' }).available).toBe(false);
  });
  it('refuses a run when compose is off, before anything starts', async () => {
    const off = composeAvailability({ platform: 'win32', nodeVersion: '26.11.1', confinement: null });
    const out = await runCompose({ kind: 'docx', program: 'export default async () => Buffer.from("x")', attachments: [], root: path.join(tmpdir(), 'never-made'), availability: off, confine: () => [] });
    expect(out).toMatchObject({ ok: false, code: 'unavailable' });
  });
  it('lets a program load only built-ins without I/O', () => {
    expect([...COMPOSE_BUILTINS]).toEqual(['buffer', 'events', 'path', 'stream', 'string_decoder', 'url', 'util']);
  });
});

describe('what fd 3 carries', () => {
  it('takes one whole B frame as the file, and one E frame of short strings as the error', () => {
    expect(readFrame(frame('B', 'PK..'))).toEqual({ kind: 'bytes', bytes: Buffer.from('PK..') });
    expect(readFrame(frame('E', JSON.stringify({ name: 'TypeError', message: 'x', shape: true })))).toEqual({ kind: 'error', error: { name: 'TypeError', message: 'x', shape: true } });
    expect(readFrame(Buffer.alloc(0))).toEqual({ kind: 'none' });
  });
  it('turns every forged frame into invalid, never a throw', () => {
    const forged = [
      frame('E', 'null'),
      frame('E', '[1,2]'),
      frame('E', '"text"'),
      frame('E', '{not json'),
      frame('E', JSON.stringify({ message: { toString: 1 } })),
      frame('E', JSON.stringify({ code: 42 })),
      frame('X', 'whatever'),
      frame('B', ''),
      frame('B', 'abc', 1_000_000),
      Buffer.concat([frame('B', 'a'), frame('B', 'b')]),
      Buffer.from([0x45, 0, 0]),
      frame('E', 'x'.repeat(300 * 1024)),
    ];
    for (const sent of forged) {
      const out = readFrame(sent);
      expect(out.kind, sent.subarray(0, 12).toString('hex')).toBe('invalid');
    }
  });
});

describe('what the model is shown', () => {
  it('scrubs buddi’s paths out of what a program said', () => {
    expect(scrubPaths('at /Users/amen/buddi/node_modules/docx/x.js and C:\\buddi\\x', '/w')).toBe('at <buddi> and <buddi>');
  });
});

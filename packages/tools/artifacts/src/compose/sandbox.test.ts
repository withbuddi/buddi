/**
 * What decides whether compose runs, and what buddi accepts back from a
 * program, without running one: the sandbox itself is exercised by the
 * gateway's `compose-sandbox.test.ts`, inside the OS layer the host plugin
 * hands in.
 */
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { COMPOSE_BUILTINS, clearStaleComposeRuns, composeAvailability, composeSlot, holdComposeRun, nodeFloorProblem, programHint, readFrame, runCompose, scrubPaths } from './sandbox.js';

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
  it('says how to fix the errors a model makes again and again, in one line', () => {
    const wrapper = '\nThe program must be `export default async (ctx) => { … return <bytes> }`; a top-level return is not allowed.';
    expect(programHint('SyntaxError: Illegal return statement')).toBe(wrapper);
    expect(programHint('`format` "$#,##0.00" was specified on a cell of type `undefined`. Specify a `type` too.'))
      .toBe('\nA cell with a `format` and no value needs a `type`: see the xlsx guide on empty input cells.');
    // buddi's own runner says the wrapper itself; a hint is for what Node or a library says.
    expect(programHint('the program has no default export: it must be `export default async (ctx) => { … return <bytes> }`')).toBe('');
    expect(programHint('ReferenceError: missing is not defined')).toBe('');
  });
});

describe('the service-wide slots', () => {
  it('hands a finished run’s slot to the next waiter, so a newcomer never makes one too many', async () => {
    const limit = 2;
    let now = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const hold = () => async (): Promise<void> => {
      now += 1;
      most = Math.max(most, now);
      await new Promise<void>((resolve) => releases.push(resolve));
      now -= 1;
    };
    const runs = [composeSlot(undefined, hold(), limit), composeSlot(undefined, hold(), limit), composeSlot(undefined, hold(), limit)];
    await new Promise((r) => setImmediate(r));
    expect(now).toBe(2);
    // One finishes; before the waiter is let in, a newcomer asks — at every point of the microtask queue.
    releases.shift()!();
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
      runs.push(composeSlot(undefined, hold(), limit));
    }
    await new Promise((r) => setImmediate(r));
    expect(most).toBe(limit);
    expect(now).toBe(limit);
    // Drain: every run gets its turn, never more than the limit at once.
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((r) => setImmediate(r));
      expect(now).toBeLessThanOrEqual(limit);
    }
    await Promise.all(runs);
    expect(most).toBe(limit);
  });
});

describe('stale run folders', () => {
  it('clears the run folders a stopped buddi left, and keeps a fresh one and anything else', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'buddi-compose-stale-'));
    try {
      const old = `run-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
      const fresh = `run-${'1'.repeat(8)}-0000-4000-8000-${'1'.repeat(12)}`;
      for (const name of [old, fresh, 'keep-me']) await mkdir(path.join(root, name));
      const hourAgo = new Date(Date.now() - 60 * 60_000);
      await utimes(path.join(root, old), hourAgo, hourAgo);
      await utimes(path.join(root, 'keep-me'), hourAgo, hourAgo);
      expect(await clearStaleComposeRuns(root)).toBe(1);
      expect((await readdir(root)).sort()).toEqual(['keep-me', fresh]);
      // A run still going whose folder looks old (the clock jumped forward) is kept.
      const active = `run-${'2'.repeat(8)}-0000-4000-8000-${'2'.repeat(12)}`;
      await mkdir(path.join(root, active));
      await utimes(path.join(root, active), hourAgo, hourAgo);
      const release = holdComposeRun(active);
      expect(await clearStaleComposeRuns(root)).toBe(0);
      expect(await readdir(root)).toContain(active);
      release();
      expect(await clearStaleComposeRuns(root)).toBe(1);
      // No folder yet: nothing to do, and no error.
      expect(await clearStaleComposeRuns(path.join(root, 'none'))).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

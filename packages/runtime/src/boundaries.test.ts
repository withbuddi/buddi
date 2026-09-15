/**
 * The rule, and proof that it is a rule rather than a comment.
 *
 * `scripts/check-boundaries.mjs` runs first in the test pipeline. Since the
 * wedge it also refuses outbound HTTP that does not go through this package's
 * transport — the global `fetch`, `undici`, a hand-rolled `node:http(s)` client
 * — because every one of them pools a connection per origin and hands a dead
 * one back for ever. A check nobody has watched fail is not a check, so these
 * tests fail it on purpose, against a fixture tree, and then pass it on the
 * real one.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = path.join(repoRoot, 'scripts', 'check-boundaries.mjs');

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway source tree, so nothing is written into the repo being scanned. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-boundaries-'));
  temps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return dir;
}

function check(httpRoot?: string): { code: number; out: string } {
  const args = httpRoot === undefined ? [script] : [script, '--http-root', httpRoot];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

describe('the outbound-HTTP boundary check', () => {
  it('fires on a reintroduced `fetch`, names the file, and says why', async () => {
    const dir = fixture({
      'src/weather.ts': [
        'export async function forecast(url: string) {',
        '  const res = await fetch(url);',
        '  return res.json();',
        '}',
      ].join('\n'),
    });
    const { code, out } = check(dir);
    expect(code).toBe(1);
    expect(out).toContain('src/weather.ts:2');
    expect(out).toContain('global `fetch`');
    // The message has to be usable by whoever tripped it: the reason and the
    // replacement, not just a red line.
    expect(out).toContain('pooled');
    expect(out).toContain('defaultHttpTransport');
  });

  it('fires on undici and on a hand-rolled node:https client', async () => {
    const dir = fixture({
      'src/a.ts': "import { request } from 'undici';\nexport const r = request;\n",
      'src/b.ts': "import { Agent } from 'node:https';\nexport const a = new Agent({ keepAlive: true });\n",
    });
    const { code, out } = check(dir);
    expect(code).toBe(1);
    expect(out).toContain('src/a.ts:1');
    expect(out).toContain('src/b.ts:1');
  });

  it('does not fire on tests, on injected seams, or on prose about the bug', async () => {
    const dir = fixture({
      // Tests stand up servers and inject pooling agents on purpose.
      'src/thing.test.ts': "const res = await fetch('http://127.0.0.1:1/');\n",
      // An injected seam, and an IMAP `fetch` command, are not the global one.
      'src/client.ts': [
        'export class C {',
        '  #fetch = (u: string) => Promise.resolve(u);',
        '  go(u: string) { return this.#fetch(u); }',
        '}',
        'export interface Port {',
        '  fetch(range: string): AsyncIterable<unknown>;',
        '}',
      ].join('\n'),
      // The comment above every converted caller says the word `fetch(` a lot.
      'src/notes.ts': [
        '// Not the global `fetch(...)`: undici pools a connection per origin.',
        '/** See transport.ts — this used to call fetch(url) and wedged for hours. */',
        'export const ok = true;',
      ].join('\n'),
      // The inbound web server is a server, not a pooling client.
      'src/server.ts': "import { createServer } from 'node:http';\nexport const s = createServer;\n",
      // Types cost nothing at runtime.
      'src/types.ts': "import type { IncomingMessage } from 'node:http';\nexport type M = IncomingMessage;\n",
    });
    const { code, out } = check(dir);
    expect(out).not.toContain('Outbound HTTP must go through');
    expect(code).toBe(0);
  });

  it('passes on the repository as it stands', async () => {
    const { code, out } = check();
    expect(out).toContain('no outbound HTTP outside the shared transport');
    expect(code).toBe(0);
  });
});

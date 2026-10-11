/** The `Runtime:` row of `buddi doctor`, against a fake disk: no second Node is run. */
import { describe, expect, test } from 'vitest';
import { bundled, runtimeFacts, runtimeLines } from './runtime-info.js';
import type { RuntimeDeps } from './runtime-info.js';

// Skipped on Windows: POSIX fixtures for the bundled runtime (bin/node, npm).
const POSIX_ONLY = process.platform === 'win32';

const node = '/home/owner/.local/share/buddi/node/node';

function disk(files: Record<string, string>, npm: string | Error = '10.9.9'): RuntimeDeps {
  return {
    exists: file => file in files,
    read: file => files[file],
    npmVersion: async () => { if (npm instanceof Error) throw npm; return npm; },
  };
}

describe.skipIf(POSIX_ONLY)('runtime row', () => {
  test('a bundled node, with npm beside it', async () => {
    const facts = await runtimeFacts(node, 'v22.23.3', disk({ '/home/owner/.local/share/buddi/node/VERSION': 'v22.23.3\n', '/home/owner/.local/share/buddi/node/npm': '' }));
    expect(bundled(facts)).toBe(true);
    expect(runtimeLines(facts, 'the Linux install')).toEqual([
      `Runtime: Node v22.23.3, bundled with the Linux install (${node})`,
      'npm: 10.9.9 beside it (/home/owner/.local/share/buddi/node/npm); plugin installs use this one',
    ]);
  });

  test("the machine's own node, and no npm beside it", async () => {
    const facts = await runtimeFacts('/usr/bin/node', 'v22.22.1', disk({}));
    expect(bundled(facts)).toBe(false);
    expect(runtimeLines(facts, 'this installation')).toEqual([
      "Runtime: Node v22.22.1 at /usr/bin/node, this machine's own (not bundled)",
      'npm: none beside this node; plugin installs use the npm on PATH',
    ]);
  });

  test('a bundled folder whose node was swapped, and an npm that does not answer', async () => {
    const facts = await runtimeFacts(node, 'v24.1.0', disk({ '/home/owner/.local/share/buddi/node/VERSION': 'v22.23.3', '/home/owner/.local/share/buddi/node/npm': '' }, new Error('spawn EACCES')));
    const [row, npm] = runtimeLines(facts, 'the Linux install');
    expect(row).toContain('its folder says v22.23.3');
    expect(npm).toContain('does not answer (spawn EACCES); plugin installs will fail');
  });
});

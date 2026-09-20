/**
 * A fixture plugin, and the only one that proves the property the whole
 * two-approval design exists for: **its top-level code writes a file.**
 *
 * `BUDDI_FIXTURE_MARKER` names that file. A test stages this package and
 * asserts the marker is absent — nothing was imported — and then approves it
 * and asserts the marker appeared. There is no way to fake that: importing a
 * module runs it, so the marker's existence is exactly "this plugin's code has
 * run in this process".
 *
 * It imports `@buddi/core` for the same reason a real plugin does, which also
 * makes it the thing that fails loudly if the staged tree's peer link is wrong.
 */
import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { contributionOf } from '@buddi/core';

const marker = process.env.BUDDI_FIXTURE_MARKER;
if (marker !== undefined && marker !== '') {
  appendFileSync(marker, `imported ${new Date().toISOString()}\n`);
}

export const manifest = {
  name: 'fixture-marker',
  version: '1.0.0',
  description: 'A fixture: it remembers the first moment its code ran.',
  schema: 'fixture_marker',
  migrationsDir: new URL('./migrations', import.meta.url).pathname,
  network: [{ host: 'example.invalid', why: 'a host nobody reaches, declared so the claim can be compared' }],
  tools: [
    {
      name: 'fixture-marker.echo',
      description: 'Return what it was given. It touches nothing.',
      tier: 'auto',
      input: z.object({ text: z.string() }),
      async execute(input) {
        return { text: input.text };
      },
    },
  ],
};

// Proves the peer link resolves to a real core rather than a second copy.
export const summary = contributionOf(manifest);
export default manifest;

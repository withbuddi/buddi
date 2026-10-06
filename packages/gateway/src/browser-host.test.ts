/**
 * The sign-in sites a proposal reads to tell when a mission needs the owner's
 * Chrome: the owner's list and the learned one, merged, from a scratch data
 * directory. Nothing on disk, or a file that is not JSON, is an empty list.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signInSitesOnDisk } from './browser-host.js';

describe('signInSitesOnDisk', () => {
  let data: string;
  beforeEach(async () => {
    data = await mkdtemp(path.join(tmpdir(), 'buddi-sign-in-sites-'));
  });
  afterEach(async () => {
    await rm(data, { recursive: true, force: true });
  });

  it('is empty with nothing on disk', async () => {
    expect(await signInSitesOnDisk({ BUDDI_DATA_DIR: data })).toEqual([]);
  });

  it("merges the owner's list and the learned sites, trimmed, lower-cased and once each", async () => {
    await mkdir(path.join(data, 'browser'), { recursive: true });
    await writeFile(path.join(data, 'browser', 'settings.json'), JSON.stringify({ signInSites: [' PNC.com ', 'chase.com', 7, ''] }));
    await writeFile(path.join(data, 'browser', 'sign-in-sites.json'), JSON.stringify(['pnc.com', 'amazon.com']));
    expect(await signInSitesOnDisk({ BUDDI_DATA_DIR: data })).toEqual(['pnc.com', 'chase.com', 'amazon.com']);
  });

  it('reads past a file that is not JSON', async () => {
    await mkdir(path.join(data, 'browser'), { recursive: true });
    await writeFile(path.join(data, 'browser', 'settings.json'), '{ not json');
    await writeFile(path.join(data, 'browser', 'sign-in-sites.json'), JSON.stringify(['pnc.com']));
    expect(await signInSitesOnDisk({ BUDDI_DATA_DIR: data })).toEqual(['pnc.com']);
  });
});

/** The extension lost buddi when the dashboard moved port after it was paired. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { portMovedSincePairing } from './extension.js';

const data = mkdtempSync(path.join(tmpdir(), 'buddi-port-'));
afterAll(() => rmSync(data, { recursive: true, force: true }));

function state(portMoved: unknown): void {
  writeFileSync(path.join(data, 'installation.json'), JSON.stringify({ version: 1, database: 'managed', webPort: 4391, dbPort: 5555, portMoved }));
}

describe('portMovedSincePairing', () => {
  const env = { BUDDI_DATA_DIR: data };

  it('says so when the web port moved after the pairing', () => {
    state({ web: { from: 4317, to: 4391 }, at: '2026-10-04T10:00:00Z' });
    expect(portMovedSincePairing(env, '2026-10-01T09:00:00Z')).toEqual({ from: 4317, to: 4391 });
  });

  it('is quiet when the pairing came after the move, nothing is paired, or only the database moved', () => {
    state({ web: { from: 4317, to: 4391 }, at: '2026-10-04T10:00:00Z' });
    expect(portMovedSincePairing(env, '2026-10-04T11:00:00Z')).toBeUndefined();
    expect(portMovedSincePairing(env, undefined)).toBeUndefined();
    state({ db: { from: 5555, to: 5601 }, at: '2026-10-04T10:00:00Z' });
    expect(portMovedSincePairing(env, '2026-10-01T09:00:00Z')).toBeUndefined();
    expect(portMovedSincePairing({}, '2026-10-01T09:00:00Z')).toBeUndefined();
  });
});

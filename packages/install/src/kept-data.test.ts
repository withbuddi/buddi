import { describe, expect, test } from 'vitest';
import { keptPluginDataLine, readKeptPluginData } from './kept-data.js';

describe('the kept plugin data line of a packaged doctor', () => {
  test('is printed whenever something waits, and not otherwise', async () => {
    expect(await keptPluginDataLine(async () => [])).toBeNull();
    const line = await keptPluginDataLine(async () => [
      { schema: 'finance', rows: 3, reason: '1 table(s) already had rows and were left staged' },
    ]);
    expect(line).toMatch(/^Kept plugin data: /);
    expect(line).toContain('finance (3 row(s): 1 table(s) already had rows');
  });

  test('a database that cannot be read prints nothing rather than failing the doctor', async () => {
    expect(await keptPluginDataLine(async () => { throw new Error('connection refused'); })).toBeNull();
    expect(await keptPluginDataLine(readKeptPluginData({ env: { DATABASE_URL: 'postgres://x@127.0.0.1:1/x' } }))).toBeNull();
  });

  const url = process.env.DATABASE_URL;
  test.skipIf(url === undefined || url.includes('127.0.0.1:1/'))('reads core.pending_plugin_data of the installation database', async () => {
    const { createPool } = await import('@buddi/core');
    const pool = createPool(url as string);
    const schema = `kept_doctor_${process.pid}`;
    try {
      const exists = await pool.query(`select to_regclass('core.pending_plugin_data')::text as r`);
      if (!exists.rows[0]?.r) return;
      await pool.query(
        `insert into core.pending_plugin_data (schema, archive, staged_path, tables, rows, migrations)
         values ($1, 'drill.tar', '/nowhere', '[]'::jsonb, 7, '[]'::jsonb)`,
        [schema],
      );
      const line = await keptPluginDataLine(readKeptPluginData({ env: { DATABASE_URL: url } }));
      expect(line).toContain(`${schema} (7 row(s))`);
    } finally {
      await pool.query(`delete from core.pending_plugin_data where schema = $1`, [schema]).catch(() => {});
      await pool.end().catch(() => {});
    }
  });
});

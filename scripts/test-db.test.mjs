import { describe, expect, test } from 'vitest';
import { parseArgs, pointsAtDev } from './test-db.mjs';

describe('test:db arguments', () => {
  test('filters repeat, --keep anywhere, a bare -- is ignored', () => {
    expect(parseArgs([])).toEqual({ filters: [], keep: false });
    expect(parseArgs(['--', '--filter', '@buddi/gateway', '--', '--keep', '--filter=@buddi/mcp']))
      .toEqual({ filters: ['@buddi/gateway', '@buddi/mcp'], keep: true });
  });

  test('a filter without a package, and an unknown flag, are refused', () => {
    expect(() => parseArgs(['--filter'])).toThrow(/needs a package/);
    expect(() => parseArgs(['--filter', '--keep'])).toThrow(/needs a package/);
    expect(() => parseArgs(['--watch'])).toThrow(/Unknown argument/);
  });

  test('only port 55433 counts as the dev database', () => {
    expect(pointsAtDev('postgres://u:p@127.0.0.1:55433/buddi')).toBe(true);
    expect(pointsAtDev('postgres://u:p@localhost:55790/buddi')).toBe(false);
    expect(pointsAtDev(undefined)).toBe(false);
  });
});

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { bundleVersion } from './bundle-version.mjs';

describe('bundleVersion', () => {
  test('pre.N becomes the fourth component; a final release gets 1000', () => {
    expect(bundleVersion('0.1.0-pre.39')).toBe('0.1.0.39');
    expect(bundleVersion('v0.1.0-pre.1')).toBe('0.1.0.1');
    expect(bundleVersion('0.1.0')).toBe('0.1.0.1000');
    expect(bundleVersion('1.12.3')).toBe('1.12.3.1000');
  });

  test('sorts the way the releases do, numerically, as Sparkle compares', () => {
    const order = ['0.1.0-pre.9', '0.1.0-pre.10', '0.1.0-pre.39', '0.1.0', '0.1.1-pre.1', '0.1.1', '0.2.0-pre.2'];
    const numbers = order.map(v => bundleVersion(v).split('.').map(Number));
    for (let i = 1; i < numbers.length; i++) {
      const [a, b] = [numbers[i - 1], numbers[i]];
      const first = a.findIndex((n, k) => n !== b[k]);
      expect(a[first]).toBeLessThan(b[first]);
    }
  });

  test('refuses anything else rather than guess', () => {
    for (const bad of ['', 'latest', '0.1', '0.1.0-rc.1', '0.1.0-pre.0', '0.1.0-pre.1000', '0.1.0-pre.07', '01.1.0', '0.1.0-pre.39 extra']) {
      expect(() => bundleVersion(bad)).toThrow();
    }
  });

  test('prints the number for the Makefile and the workflow, and fails loudly', () => {
    const script = fileURLToPath(new URL('./bundle-version.mjs', import.meta.url));
    expect(execFileSync(process.execPath, [script, '0.1.0-pre.39'], { encoding: 'utf8' })).toBe('0.1.0.39\n');
    expect(() => execFileSync(process.execPath, [script, 'nope'], { stdio: 'pipe' })).toThrow();
  });
});

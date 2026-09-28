/** The worker's list: the shell, the Blob, and never an API path. */
import { describe, expect, it, vi } from 'vitest';
import { precacheList, precacheManifest } from './precache';

const bundled = ['index.html', 'build.json', 'assets/index-abc12345.js', 'assets/index-abc12345.css', 'assets/lottie_light-x1y2z3w4.js', 'assets/dm-sans-latin-q1w2e3r4.woff2', 'assets/dm-mono-a1b2c3d4.woff'];
const publicFiles = ['sw.js', 'manifest.webmanifest', 'favicon.png', 'icon-512.png', 'mascot', 'mascot/core.png', 'mascot/README.md', 'mascot/anim', 'mascot/anim/core-idle.json', 'api/secret.json', 'preview/x.png'];

describe('precacheList', () => {
  it('keeps the shell, its assets and the Blob, index.html first', () => {
    expect(precacheList(bundled, publicFiles)).toEqual([
      'index.html',
      'assets/dm-sans-latin-q1w2e3r4.woff2',
      'assets/index-abc12345.css',
      'assets/index-abc12345.js',
      'assets/lottie_light-x1y2z3w4.js',
      'favicon.png',
      'mascot/anim/core-idle.json',
      'mascot/core.png',
    ]);
  });

  it('never lists an API, stream or preview path', () => {
    const list = precacheList([...bundled, 'api/version', 'stream'], publicFiles);
    expect(list.some((file) => /^\/?(api|stream|preview)(\/|$)/.test(file))).toBe(false);
  });
});

describe('precacheManifest', () => {
  it('writes precache.json with the build id', () => {
    const plugin = precacheManifest('0.1.0+abc', () => publicFiles);
    const emitFile = vi.fn();
    const bundle = Object.fromEntries(bundled.map((name) => [name, {}]));
    (plugin.generateBundle as unknown as (this: unknown, o: unknown, b: unknown) => void).call({ emitFile }, {}, bundle);
    const emitted = emitFile.mock.calls[0]?.[0] as { fileName: string; source: string };
    expect(emitted.fileName).toBe('precache.json');
    const parsed = JSON.parse(emitted.source) as { build: string; files: string[] };
    expect(parsed.build).toBe('0.1.0+abc');
    expect(parsed.files[0]).toBe('index.html');
    expect(parsed.files).toContain('mascot/core.png');
    expect(parsed.files.some((file) => file.startsWith('api'))).toBe(false);
  });
});

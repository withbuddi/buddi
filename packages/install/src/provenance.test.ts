import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { attestationsUrl, verifyProvenance } from './provenance.js';
import { provenanceFixture } from './fixtures/provenance.js';

/** What npm serves for 0.1.0-pre.38, as published by the release workflow and signed by Fulcio. */
const REAL = JSON.parse(readFileSync(new URL('./fixtures/attestations-0.1.0-pre.38.json', import.meta.url), 'utf8')) as unknown;
const REAL_INTEGRITY = 'sha512-+S2JINFyeSSumerjdwiTwoHJFt6Dxo+GKYTxXc9PbtYfHUKuYdOC3pA1WmKCt2Z3WruFl+7HhFk9COfJmGupzg==';
const name = '@withbuddi/buddi';
const INTEGRITY = `sha512-${Buffer.from('tarball 0.1.1').toString('base64')}`;

describe('provenance', () => {
  test('the URL npm serves it at', () => {
    expect(attestationsUrl('https://registry.npmjs.org/', name, '0.1.1')).toBe('https://registry.npmjs.org/-/npm/v1/attestations/@withbuddi%2Fbuddi@0.1.1');
  });

  test('a real release verifies against the pinned Fulcio chain', () => {
    expect(verifyProvenance(REAL, { name, version: '0.1.0-pre.38', integrity: REAL_INTEGRITY })).toEqual({
      repository: 'https://github.com/withbuddi/buddi',
      workflow: 'https://github.com/withbuddi/buddi/.github/workflows/release.yml@refs/tags/v0.1.0-pre.38',
    });
  });

  test('the real document refuses another tarball, another version and another workflow', () => {
    const other = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
    expect(() => verifyProvenance(REAL, { name, version: '0.1.0-pre.38', integrity: other })).toThrow('different tarball');
    expect(() => verifyProvenance(REAL, { name, version: '0.1.0-pre.39', integrity: REAL_INTEGRITY })).toThrow('not about @withbuddi/buddi@0.1.0-pre.39');
    expect(() => verifyProvenance(REAL, { name, version: '0.1.0-pre.38', integrity: REAL_INTEGRITY, workflow: 'https://github.com/withbuddi/buddi/.github/workflows/other.yml' })).toThrow(/signed by .*release\.yml/);
  });

  test('a certificate from another authority is refused', () => {
    const { chain } = provenanceFixture({ version: '0.1.1', integrity: INTEGRITY });
    expect(() => verifyProvenance(REAL, { name, version: '0.1.0-pre.38', integrity: REAL_INTEGRITY, chain })).toThrow('not issued by sigstore');
    const { doc } = provenanceFixture({ version: '0.1.1', integrity: INTEGRITY });
    expect(() => verifyProvenance(doc, { name, version: '0.1.1', integrity: INTEGRITY })).toThrow('not issued by sigstore');
  });

  test('a document signed by the test CA verifies with that chain', () => {
    const { doc, chain } = provenanceFixture({ version: '0.1.1', integrity: INTEGRITY });
    expect(verifyProvenance(doc, { name, version: '0.1.1', integrity: INTEGRITY, chain }).repository).toBe('https://github.com/withbuddi/buddi');
  });

  test('runs on its own, as the Mac app\'s payload script runs it', () => {
    const script = fileURLToPath(new URL('./provenance.ts', import.meta.url));
    const fixture = fileURLToPath(new URL('./fixtures/attestations-0.1.0-pre.38.json', import.meta.url));
    const run = (integrity: string) => spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', script, '0.1.0-pre.38', integrity, fixture], { encoding: 'utf8' });
    const ok = run(REAL_INTEGRITY);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('provenance verified (https://github.com/withbuddi/buddi/.github/workflows/release.yml@refs/tags/v0.1.0-pre.38)');
    const bad = run(`sha512-${Buffer.alloc(64, 2).toString('base64')}`);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('its provenance did not check out: the statement names a different tarball');
  });

  test('a fork, a branch build, a tampered statement or no provenance is refused', () => {
    const fork = provenanceFixture({ version: '0.1.1', integrity: INTEGRITY, san: 'https://github.com/someone/buddi/.github/workflows/release.yml@refs/tags/v0.1.1' });
    expect(() => verifyProvenance(fork.doc, { name, version: '0.1.1', integrity: INTEGRITY, chain: fork.chain })).toThrow('signed by https://github.com/someone/buddi');
    const branch = provenanceFixture({ version: '0.1.1', integrity: INTEGRITY, san: 'https://github.com/withbuddi/buddi/.github/workflows/release.yml@refs/heads/main' });
    expect(() => verifyProvenance(branch.doc, { name, version: '0.1.1', integrity: INTEGRITY, chain: branch.chain })).toThrow('refs/heads/main');
    const repo = provenanceFixture({ version: '0.1.1', integrity: INTEGRITY, repository: 'https://github.com/someone/buddi' });
    expect(() => verifyProvenance(repo.doc, { name, version: '0.1.1', integrity: INTEGRITY, chain: repo.chain })).toThrow('names https://github.com/someone/buddi');
    const tampered = provenanceFixture({ version: '0.1.1', integrity: INTEGRITY, tamper: true });
    expect(() => verifyProvenance(tampered.doc, { name, version: '0.1.1', integrity: INTEGRITY, chain: tampered.chain })).toThrow('signature does not verify');
    expect(() => verifyProvenance({ attestations: [] }, { name, version: '0.1.1', integrity: INTEGRITY })).toThrow('no SLSA provenance');
    expect(() => verifyProvenance(null, { name, version: '0.1.1', integrity: INTEGRITY })).toThrow('no SLSA provenance');
  });
});

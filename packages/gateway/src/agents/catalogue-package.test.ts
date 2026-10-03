/**
 * The package format, read strictly (agent-catalogue.md §3, §9): the
 * integrity the market writes, the v1 limits, the denylist, and the picks
 * rendered as "## For this owner".
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentEntry, png, RESEARCHER_PERSONA, RESEARCHER_SKILL } from '../__fixtures__/agent-package.js';
import {
  canonicalJson,
  composePackagePersona,
  cronAt,
  cronClock,
  deniedTools,
  packageIntegrity,
  parseAgentPackage,
  PackageRefusal,
  sriSha256,
} from './catalogue-package.js';
import { lineDiff, readableDiff } from './platform-catalogue.js';

function refusal(entry: Record<string, unknown>): string {
  try {
    parseAgentPackage(entry);
  } catch (err) {
    expect(err).toBeInstanceOf(PackageRefusal);
    return (err as Error).message;
  }
  throw new Error('it was not refused');
}

describe('the integrity', () => {
  it('is the market\'s: sha256 over one canonical document of the manifest, persona, skills and the picture\'s hash', () => {
    const manifest = { name: 'x', kind: 'agent', integrity: 'ignored', claims: { ignored: true } };
    const picture = png(8);
    const expected = `sha256-${createHash('sha256')
      .update(
        `{"agent.json":{"kind":"agent","name":"x"},"avatar.png":"${sriSha256(picture)}","persona.md":"Hi.","skills":{"a.md":"A"}}`,
      )
      .digest('base64')}`;
    expect(packageIntegrity({ manifest, persona: 'Hi.', skills: [{ file: 'a.md', text: 'A' }], avatarSha256: sriSha256(picture) })).toBe(expected);
  });

  it('does not move with key order', () => {
    const a = { kind: 'agent', name: 'x', author: { name: 'w', url: 'https://w' } };
    const b = { author: { url: 'https://w', name: 'w' }, name: 'x', kind: 'agent' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(packageIntegrity({ manifest: a, persona: 'p', skills: [], avatarSha256: null })).toBe(
      packageIntegrity({ manifest: b, persona: 'p', skills: [], avatarSha256: null }),
    );
  });

  it('refuses a listing whose files do not hash to it', () => {
    const entry = agentEntry('researcher');
    expect(() => parseAgentPackage(entry)).not.toThrow();
    expect(refusal({ ...entry, persona: 'You are someone else.' })).toMatch(/does not hash to its integrity/);
    expect(refusal({ ...entry, tools: ['memory.*'] })).toMatch(/does not hash/);
  });
});

describe('reading a package', () => {
  it('reads Researcher with its skill and picture', () => {
    const pkg = parseAgentPackage(
      agentEntry('researcher', { persona: RESEARCHER_PERSONA, skills: [{ file: 'answering-with-sources.md', text: RESEARCHER_SKILL }] }),
    );
    expect(pkg.manifest.title).toBe('Researcher');
    expect(pkg.skills).toEqual([expect.objectContaining({ name: 'answering-with-sources', file: 'answering-with-sources.md' })]);
    expect(pkg.avatar).toBe('https://withbuddi.com/plugins/agents/researcher/avatar.png');
    expect(pkg.avatarSha256).toMatch(/^sha256-/);
  });

  it('refuses an unknown field, and a v1-forbidden one by name', () => {
    expect(refusal(agentEntry('x1', { manifest: { colour: 'red' } }))).toMatch(/unknown field "colour"/);
    expect(refusal(agentEntry('x2', { manifest: { model: 'claude-sonnet-5' } }))).toMatch(/"model" is not allowed in a v1 package/);
    expect(refusal(agentEntry('x3', { manifest: { bundles: [] } }))).toMatch(/"bundles" is not allowed/);
  });

  it('refuses a ? tool whose plugin is not optional, and allows mail ones with mailbox?', () => {
    expect(refusal(agentEntry('x4', { manifest: { tools: ['memory.*', 'weather.forecast?'] } }))).toMatch(/must be in "optional"/);
    expect(() => parseAgentPackage(agentEntry('x5', { manifest: { tools: ['memory.*', 'weather.forecast?'], optional: { weather: '>=0.1.0' } } }))).not.toThrow();
    expect(() => parseAgentPackage(agentEntry('x6', { manifest: { tools: ['memory.*', 'email.read?'], needs: ['mailbox?'] } }))).not.toThrow();
    expect(refusal(agentEntry('x7', { manifest: { tools: ['memory.*', 'email.read?'] } }))).toMatch(/optional/);
  });

  it('refuses a denylisted tool, a glob that reaches one, and a non-by-buddi trust', () => {
    expect(refusal(agentEntry('x8', { manifest: { tools: ['memory.*', 'email.send'] } }))).toMatch(/may not ask for email.send/);
    expect(refusal(agentEntry('x9', { manifest: { tools: ['host.*'] } }))).toMatch(/host/);
    expect(refusal(agentEntry('y1', { manifest: { tools: ['email.*'] } }))).toMatch(/email\.\*/);
    expect(refusal(agentEntry('y2', { manifest: { trust: 'reviewed' } }))).toMatch(/trust/);
  });

  it('lets a by-buddi package answer for roles', () => {
    const pkg = parseAgentPackage(agentEntry('cfo', { manifest: { roles: ['overview', 'recap'] } }));
    expect(pkg.manifest.roles).toEqual(['overview', 'recap']);
  });

  it('refuses a time pick that names no mission, and a mission whose schedule does not parse', () => {
    expect(refusal(agentEntry('y3', { manifest: { fills: [{ id: 'hour', kind: 'time', label: 'When?' }] } }))).toMatch(/time pick/);
    expect(refusal(agentEntry('y4', { manifest: { missions: [{ id: 'mm', name: 'M', cron: '99 * * * *', prompt: 'p' }] } }))).toMatch(/does not parse/);
  });
});

describe('host API 1.27 missions', () => {
  const edition = { id: 'morning', name: 'Morning edition', cron: '0 7 * * *', prompt: 'p' };
  it('takes a context from a plugin the package requires, and a reportMax up to 6,000', () => {
    const pkg = parseAgentPackage(
      agentEntry('n1', { manifest: { requires: { news: '^0.1.0' }, missions: [{ ...edition, reportMax: 3800, context: { plugin: 'news', export: 'edition_material', args: { edition: 'morning' } } }] } }),
    );
    expect(pkg.manifest.missions[0]).toMatchObject({ reportMax: 3800, context: { plugin: 'news', export: 'edition_material' } });
  });
  it('refuses a context from a plugin it does not require, and a reportMax past the limit', () => {
    expect(refusal(agentEntry('n2', { manifest: { missions: [{ ...edition, context: { plugin: 'news', export: 'edition_material' } }] } }))).toMatch(
      /reads its context from news, which it does not require/,
    );
    expect(refusal(agentEntry('n3', { manifest: { missions: [{ ...edition, reportMax: 9000 }] } }))).toMatch(/reportMax|6000/);
  });
  it('takes browser: own on a mission (pre.38), and nothing else for it', () => {
    const pkg = parseAgentPackage(agentEntry('b1', { manifest: { missions: [{ ...edition, browser: 'own' }] } }));
    expect(pkg.manifest.missions[0]).toMatchObject({ browser: 'own' });
    expect(refusal(agentEntry('b2', { manifest: { missions: [{ ...edition, browser: 'chrome' }] } }))).toMatch(/browser/);
  });
});

describe('the denylist', () => {
  it('covers resolved names and declared globs alike', () => {
    expect(deniedTools(['email.*'], ['email.read', 'email.send'])).toEqual(expect.arrayContaining(['email.send', 'email.*']));
    expect(deniedTools(['secret.*?'], [])).toEqual(['secret.*']);
    expect(deniedTools(['secret.list', 'secret.fill', 'agent.delegate'], ['secret.list', 'secret.fill', 'agent.delegate'])).toEqual([]);
    expect(deniedTools(['secret.type'], ['secret.type'])).toEqual(['secret.type']);
    expect(deniedTools(['memory.*', 'web.read'], ['memory.note', 'web.read'])).toEqual([]);
  });
});

describe('the picks and the missions', () => {
  it('writes the persona verbatim, then "## For this owner" from the picks, never a time pick or an empty one', () => {
    const text = composePackagePersona('You are the chef.', [
      { id: 'diet', kind: 'text', label: 'Anything you don\'t eat?', value: 'No pork, no peanuts' },
      { id: 'mailbox', kind: 'mailbox', label: 'Which mailbox', value: 'me@example.com' },
      { id: 'when', kind: 'time', label: 'When?', value: '18:00' },
      { id: 'note', kind: 'text', label: 'Anything else', value: '' },
    ]);
    expect(text).toBe(
      'You are the chef.\n\n## For this owner\n\n- Anything you don\'t eat: No pork, no peanuts\n- Which mailbox: me@example.com',
    );
    expect(composePackagePersona('You are the chef.', [])).toBe('You are the chef.');
  });

  it('moves a mission\'s hour and reads it back', () => {
    expect(cronClock('0 17 * * 0')).toBe('17:00');
    expect(cronAt('0 17 * * 0', '07:30')).toBe('30 7 * * 0');
    expect(cronAt('*/5 * * * *', '07:30')).toBe('*/5 * * * *');
  });

  it('diffs a persona by line, in hunks with two lines of context', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual(['@@ -1,3 +1,3 @@', '  a', '- b', '  c', '+ d']);
    expect(lineDiff('same', 'same')).toEqual([]);
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[2] = 'third, rewritten';
    after.splice(16, 1);
    const diff = lineDiff(before.join('\n'), after.join('\n'));
    expect(diff).toEqual([
      '@@ -1,5 +1,5 @@', '  line 1', '  line 2', '- line 3', '+ third, rewritten', '  line 4', '  line 5',
      '@@ -15,5 +15,4 @@', '  line 15', '  line 16', '- line 17', '  line 18', '  line 19',
    ]);
    // What the owner reads: numbers in the new file, the unchanged run between hunks counted.
    expect(readableDiff(diff)).toEqual([
      '   1   line 1', '   2   line 2', '     - line 3', '   3 + third, rewritten', '   4   line 4', '   5   line 5',
      '     ⋯ 9 lines',
      '  15   line 15', '  16   line 16', '     - line 17', '  17   line 18', '  18   line 19',
    ]);
  });
});

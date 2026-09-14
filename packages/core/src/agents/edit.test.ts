/**
 * Editing an agent file is editing a document somebody wrote. These tests are
 * mostly about what must *not* change: the body, the comments, the key order,
 * the keys this schema never heard of.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentEditError,
  applyFrontmatterPatch,
  enginePatch,
  patchAgentSource,
  serializeYamlValue,
  updateAgentFrontmatter,
} from './edit.js';
import { parseAgentFile, splitFrontmatter } from './frontmatter.js';

/** A file with comments, a block list, and a body that contains `---`. */
const SOURCE = [
  '---',
  '# which agent this is',
  'id: ledger',
  'handle: ledger',
  'name: Finance Advisor',
  'description: The money one',
  '',
  '# engine',
  'provider: anthropic',
  'model: claude-sonnet-5',
  'tools:',
  '  - finance.*',
  '  - memory.*',
  'maxTurns: 12',
  'language: mirror',
  'default: true',
  '---',
  '',
  'You are the finance advisor.',
  '',
  '---',
  '',
  'That horizontal rule above is part of the persona.',
  '',
].join('\n');

const body = (text: string): string => parseAgentFile(text).body;

describe('applyFrontmatterPatch', () => {
  it('rewrites only the touched key and leaves everything else byte-for-byte', () => {
    const out = applyFrontmatterPatch(SOURCE, { model: 'claude-opus-5' });
    expect(out).toContain('model: claude-opus-5');
    expect(out).not.toContain('claude-sonnet-5');
    // Comments, blank lines, the block list and the key order all survive.
    expect(out).toContain('# which agent this is');
    expect(out).toContain('# engine');
    expect(out).toContain('tools:\n  - finance.*\n  - memory.*');
    expect(out.split('\n').indexOf('provider: anthropic')).toBeLessThan(
      out.split('\n').indexOf('model: claude-opus-5'),
    );
  });

  it('never touches the body, `---` and all', () => {
    const out = applyFrontmatterPatch(SOURCE, { maxTurns: 4, language: 'fr' });
    expect(body(out)).toBe(body(SOURCE));
    expect(body(out)).toContain('\n---\n');
  });

  it('appends a key the file did not have', () => {
    const without = SOURCE.replace('provider: anthropic\n', '');
    const out = applyFrontmatterPatch(without, { provider: 'anthropic' });
    const frontmatter = out.split('\n---\n')[0] as string;
    expect(frontmatter).toContain('provider: anthropic');
    expect(frontmatter.trimEnd().endsWith('provider: anthropic')).toBe(true);
  });

  it('removes a key, and its block list with it', () => {
    const out = applyFrontmatterPatch(SOURCE, { tools: null });
    expect(out).not.toContain('finance.*');
    expect(out).not.toContain('memory.*');
    expect(out).not.toContain('tools:');
    // `tools` is required, so the result no longer loads — but the body is
    // still the body, which is what this test is about.
    expect(splitFrontmatter(out).body).toBe(splitFrontmatter(SOURCE).body);
  });

  it('keeps unknown keys somebody else owns', () => {
    const withRoles = SOURCE.replace('language: mirror', 'language: mirror\nroles: [money]');
    const out = applyFrontmatterPatch(withRoles, { model: 'claude-opus-5' });
    expect(out).toContain('roles: [money]');
  });

  it('round-trips: patch, parse, and the values are what was asked for', () => {
    const out = applyFrontmatterPatch(SOURCE, {
      provider: 'openai',
      model: 'gpt-5',
      maxTurns: 6,
      language: 'en',
    });
    const parsed = parseAgentFile(out);
    expect(parsed.frontmatter.provider).toBe('openai');
    expect(parsed.frontmatter.model).toBe('gpt-5');
    expect(parsed.frontmatter.maxTurns).toBe(6);
    expect(parsed.frontmatter.language).toBe('en');
    expect(parsed.body).toBe(body(SOURCE));
  });
});

describe('serializeYamlValue', () => {
  it('quotes only what the parser would otherwise misread', () => {
    expect(serializeYamlValue('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(serializeYamlValue(12)).toBe('12');
    expect(serializeYamlValue(true)).toBe('true');
    expect(serializeYamlValue('Credit: the score one')).toBe('"Credit: the score one"');
    expect(serializeYamlValue('true')).toBe('"true"');
    expect(serializeYamlValue('5')).toBe('"5"');
    expect(serializeYamlValue(['a', 'b'])).toBe('[a, b]');
  });
});

describe('patchAgentSource', () => {
  it('refuses a model the pinned provider does not serve, in the catalogue’s words', () => {
    expect(() => patchAgentSource(SOURCE, { model: 'gpt-5' })).toThrow(AgentEditError);
    try {
      patchAgentSource(SOURCE, { model: 'gpt-5' });
    } catch (err) {
      expect((err as AgentEditError).code).toBe('model-mismatch');
      expect((err as AgentEditError).message).toContain('is a openai model');
      expect((err as AgentEditError).message).toContain('never migrated for you');
    }
  });

  it('re-validates the model the file already had when only the provider moves', () => {
    // The file pins claude-sonnet-5; switching to openai alone would leave an
    // agent that parses today and refuses to load tomorrow.
    expect(() => patchAgentSource(SOURCE, { provider: 'openai' })).toThrow(/claude-sonnet-5/);
  });

  it('accepts a provider and model moved together', () => {
    const edit = patchAgentSource(SOURCE, { provider: 'openai', model: 'gpt-5' });
    expect(edit.after.provider).toBe('openai');
    expect(edit.after.model).toBe('gpt-5');
    expect(edit.changed).toEqual(['provider', 'model']);
  });

  it('reports no change when the file already says it', () => {
    expect(patchAgentSource(SOURCE, { model: 'claude-sonnet-5' }).changed).toEqual([]);
  });

  it('refuses to edit a file that does not load', () => {
    expect(() => patchAgentSource('no frontmatter here', { model: 'claude-opus-5' })).toThrow(
      /does not load/,
    );
  });

  it('refuses a patch that would produce an unloadable file', () => {
    expect(() => patchAgentSource(SOURCE, { maxTurns: -3 })).toThrow(AgentEditError);
    expect(() => patchAgentSource(SOURCE, { maxTurns: -3 })).toThrow(/cannot load/);
  });
});

describe('updateAgentFrontmatter', () => {
  const write = (text: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-agent-edit-'));
    const file = path.join(dir, 'agent.md');
    writeFileSync(file, text);
    return file;
  };

  it('writes the patched file and nothing else', () => {
    const file = write(SOURCE);
    const edit = updateAgentFrontmatter(file, enginePatch({ model: 'claude-opus-5', maxTurns: 4 }));
    expect(edit.written).toBe(true);
    expect(edit.changed).toEqual(['model', 'maxTurns']);
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('model: claude-opus-5');
    expect(body(after)).toBe(body(SOURCE));
  });

  it('writes nothing when the patch changes nothing', () => {
    const file = write(SOURCE);
    const edit = updateAgentFrontmatter(file, enginePatch({ model: 'claude-sonnet-5' }));
    expect(edit.written).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
  });

  it('leaves the file untouched when the patch is refused', () => {
    const file = write(SOURCE);
    expect(() => updateAgentFrontmatter(file, enginePatch({ model: 'gpt-5' }))).toThrow(
      AgentEditError,
    );
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
  });
});

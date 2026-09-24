import { describe, expect, it } from 'vitest';
import { parsePluginUses, pluginUsesChange, pluginUsesMismatch } from './uses.js';
import { hostApiProblem } from './version.js';

describe('uses', () => {
  it('reads a list in one order, whatever order it was written in', () => {
    expect(parsePluginUses(undefined, 'uses')).toEqual({ ok: true, uses: [] });
    expect(parsePluginUses(['files', 'http', 'files'], 'uses')).toEqual({ ok: true, uses: ['http', 'files'] });
  });

  it('refuses an area this build does not have, naming it', () => {
    const parsed = parsePluginUses(['http', 'network'], "package.json's buddi.uses");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/^package.json's buddi.uses names "network", which is not an area/);
    expect(parsePluginUses('http', 'uses').ok).toBe(false);
  });

  it('says what an upgrade adds and drops', () => {
    expect(pluginUsesChange(['http'], ['http', 'files'])).toEqual({ added: ['files'], removed: [] });
    expect(pluginUsesChange(['http', 'schedule'], [])).toEqual({ added: [], removed: ['http', 'schedule'] });
  });

  it('refuses a manifest and a package.json that disagree, in one sentence', () => {
    expect(pluginUsesMismatch('image', ['accounts', 'files'], ['files', 'accounts'])).toBeUndefined();
    expect(pluginUsesMismatch('image', ['accounts', 'files'], ['files'])).toBe(
      'plugin "image" declares that it uses accounts, files in its manifest, and files in ' +
        "package.json's buddi.uses; the install card was drawn from the second, so the two must match",
    );
  });
});

describe('hostApi', () => {
  it('accepts what this host has', () => {
    for (const range of ['^1.0', '1.0', '~1.0', '>=1.0', '^1', '1.0.0', '>=0.9']) {
      expect(hostApiProblem(range, '1.0'), range).toBeUndefined();
    }
    expect(hostApiProblem('^1.2', '1.4')).toBeUndefined();
  });

  it('refuses a plugin that asks for more, with both numbers', () => {
    expect(hostApiProblem('^1.9', '1.0')).toBe(
      'it was built for host API ^1.9, and this buddi has 1.0. Update buddi first, or install a version of the plugin built for this one.',
    );
    expect(hostApiProblem('^2.0', '1.0')).toMatch(/this buddi has 1\.0/);
    expect(hostApiProblem('^0.3', '1.0')).toMatch(/needs an older buddi/);
    expect(hostApiProblem('latest', '1.0')).toMatch(/not a version this buddi can read/);
  });
});

describe('the install summary', () => {
  it('lists each declared area in one plain line, and marks what an upgrade adds', async () => {
    const { contributionOf, renderContribution, renderUses } = await import('../plugins/contribution.js');
    const text = renderContribution(
      contributionOf({ name: 'image', version: '1.0.0', schema: 'image', migrationsDir: '', tools: [], uses: ['files', 'accounts'] }),
    ).join('\n');
    expect(text).toContain('IN BUDDI, BEYOND ITSELF (2)\n  It uses a model account you pick.\n  It keeps files in your Files library.');
    expect(renderUses(['http', 'files'], ['files'])).toEqual([
      'IN BUDDI, BEYOND ITSELF (2)',
      '  It sends web requests.',
      '  It keeps files in your Files library.  (NEW in this version)',
    ]);
  });
});

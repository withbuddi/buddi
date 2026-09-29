import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { PluginManifest } from '../tools.js';
import { authorOfPackageJson, parsePluginAuthor, pluginAuthorMismatch } from './author.js';

const manifest = (author: unknown): PluginManifest =>
  ({ name: 'sample', version: '1.0.0', schema: 'sample', migrationsDir: '', tools: [], author }) as PluginManifest;

describe('author', () => {
  it('accepts a name, with or without an https URL, and no author at all', () => {
    expect(parsePluginAuthor(undefined, 'author')).toEqual({ ok: true, author: undefined });
    expect(parsePluginAuthor({ name: ' withbuddi ', url: 'https://withbuddi.com' }, 'author')).toEqual({
      ok: true,
      author: { name: 'withbuddi', url: 'https://withbuddi.com' },
    });
    expect(parsePluginAuthor({ name: 'Ada' }, 'author')).toEqual({ ok: true, author: { name: 'Ada' } });
  });

  it('refuses what the card cannot show, naming the field', () => {
    const refused = (value: unknown): string | undefined => {
      const parsed = parsePluginAuthor(value, 'author');
      return parsed.ok ? undefined : parsed.message;
    };
    expect(refused('Ada')).toBe('author is not { name, url? }');
    expect(refused({ name: '' })).toBe('author.name is not a name');
    expect(refused({ name: 'x'.repeat(81) })).toBe('author.name is longer than 80 characters');
    expect(refused({ name: 'Ada', url: 'http://ada.dev' })).toBe('author.url is not an https URL');
    expect(refused({ name: 'Ada', url: 'not a url' })).toBe('author.url is not an https URL');
    expect(refused({ name: 'Ada', email: 'a@b.c' })).toBe('author has email, which is not name or url');
  });

  it('is checked at register(), naming the plugin', () => {
    expect(() => new ToolRegistry().register(manifest({ name: 'withbuddi', url: 'https://withbuddi.com' }))).not.toThrow();
    expect(() => new ToolRegistry().register(manifest({ name: 'Ada', url: 'ftp://ada.dev' }))).toThrow(
      'plugin sample: author.url is not an https URL',
    );
  });

  it("reads package.json's author in either of npm's forms, dropping what cannot be shown", () => {
    expect(authorOfPackageJson('Ada Lovelace <ada@example.com> (https://ada.dev)')).toEqual({
      name: 'Ada Lovelace',
      url: 'https://ada.dev',
    });
    expect(authorOfPackageJson('Ada (http://ada.dev)')).toEqual({ name: 'Ada' });
    expect(authorOfPackageJson({ name: 'withbuddi', url: 'https://withbuddi.com', email: 'x@y.z' })).toEqual({
      name: 'withbuddi',
      url: 'https://withbuddi.com',
    });
    expect(authorOfPackageJson(undefined)).toBeUndefined();
    expect(authorOfPackageJson({ name: '' })).toBeUndefined();
    expect(authorOfPackageJson('x'.repeat(81))).toBeUndefined();
  });

  it('refuses two names in one sentence, and lets silence on either side pass', () => {
    expect(pluginAuthorMismatch('sample', { name: 'Ada' }, { name: 'Ada', url: 'https://ada.dev' })).toBeUndefined();
    expect(pluginAuthorMismatch('sample', undefined, { name: 'Ada' })).toBeUndefined();
    expect(pluginAuthorMismatch('sample', { name: 'Ada' }, undefined)).toBeUndefined();
    expect(pluginAuthorMismatch('sample', { name: 'Ada' }, { name: 'Grace' })).toBe(
      'plugin "sample" says its author is "Ada" in its manifest and "Grace" in package.json; ' +
        'the install card was drawn from the second, so the two must match',
    );
  });
});

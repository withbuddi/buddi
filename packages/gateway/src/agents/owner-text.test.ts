import { describe, expect, it } from 'vitest';
import { ownerText, toolPhrase } from './owner-text.js';

const TOOLS = [
  { name: 'artifacts.write', description: 'Save a file to your Files. Markdown, CSV or JSON.' },
  { name: 'web.search', description: 'Search the web — returns titles, links and snippets for a query, ranked by relevance to it.' },
  { name: 'web.fetch' },
];

describe('tool names in owner-facing text', () => {
  it('borrows a short phrase from the description for a parenthetical, drops one with none to borrow', () => {
    expect(ownerText('Writes reports into your Files (artifacts.write).', TOOLS)).toBe('Writes reports into your Files (save a file to your Files).');
    expect(ownerText('Reads more pages (web.fetch) before it answers.', TOOLS)).toBe('Reads more pages before it answers.');
    expect(ownerText('Better sources (web.search, web.fetch).', TOOLS)).toBe('Better sources (search the web).');
  });

  it('rewrites a name in running text and leaves what only looks like one', () => {
    expect(ownerText('Uses artifacts.write for long answers.', TOOLS)).toBe('Uses save a file to your Files for long answers.');
    expect(ownerText('Listed on withbuddi.com, see e.g. the docs.', TOOLS)).toBe('Listed on withbuddi.com, see e.g. the docs.');
    expect(ownerText('Nothing to change here.', TOOLS)).toBe('Nothing to change here.');
  });

  it('takes only a short first clause as the phrase', () => {
    expect(toolPhrase('Save a file to your Files. More.')).toBe('save a file to your Files');
    expect(toolPhrase('Search the web, returning titles, links and snippets for a query, ranked by relevance')).toBeNull();
    expect(toolPhrase(undefined)).toBeNull();
  });
});

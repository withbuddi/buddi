/**
 * The shipped agent files must load against the plugins this build installs.
 * These are the tests that fail the moment an agent file and the finance
 * manifest drift apart — a persona granting a tool nobody registered.
 */
import { describe, expect, it } from 'vitest';
import { AGENTS_DIR, createToolRegistry, loadGatewayCatalog } from './catalog.js';

const catalog = loadGatewayCatalog({ env: {} });

describe('the shipped agents directory', () => {
  it('loads every agent file against the real finance manifest', () => {
    const ids = catalog.list().map((a) => a.id);
    expect(ids).toContain('finance-advisor');
    expect(ids).toContain('concierge');
  });

  it('lists an id, a name and a one-line description for each', () => {
    for (const summary of catalog.list()) {
      expect(summary.name).not.toBe('');
      expect(summary.description).not.toBe('');
      expect(summary.description).not.toContain('\n');
    }
  });

  it('has exactly one default, the finance advisor', () => {
    expect(catalog.list().filter((a) => a.isDefault).map((a) => a.id)).toEqual([
      'finance-advisor',
    ]);
    expect(catalog.defaultAgent().id).toBe('finance-advisor');
    expect(catalog.resolve().id).toBe('finance-advisor');
  });

  it('resolves the finance advisor grant to every registered finance tool', () => {
    const registered = createToolRegistry()
      .list()
      .map((t) => t.name)
      .filter((n) => n.startsWith('finance.'));
    expect(catalog.resolve('finance-advisor').tools).toEqual(registered);
    expect(registered.length).toBeGreaterThan(0);
  });

  it('ships the concierge with no tools and no default flag', () => {
    const concierge = catalog.resolve('concierge');
    expect(concierge.tools).toEqual([]);
    expect(concierge.isDefault).toBe(false);
    expect(concierge.systemPromptTemplate).toContain('You have no tools in this installation.');
    expect(concierge.file.startsWith(AGENTS_DIR)).toBe(true);
  });

  it('substitutes {{today}} in both personas', () => {
    for (const id of ['finance-advisor', 'concierge']) {
      const definition = catalog.resolve(id).definition(new Date('2026-09-13T23:00:00Z'));
      expect(definition.systemPrompt).toContain('Today is 2026-09-13.');
      expect(definition.systemPrompt).not.toContain('{{today}}');
    }
  });

  it('fails closed on an unknown id rather than falling back to the default', () => {
    expect(() => catalog.resolve('tax-wizard')).toThrow(/unknown agent/);
  });
});

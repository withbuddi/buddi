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

  it('resolves the finance advisor grant to every registered finance and memory tool', () => {
    const registered = createToolRegistry()
      .list()
      .map((t) => t.name)
      // ... plus the one agent tool it names explicitly: it may ask a colleague.
      .filter((n) => n.startsWith('finance.') || n.startsWith('memory.') || n === 'agent.delegate');
    expect(catalog.resolve('finance-advisor').tools).toEqual(registered);
    expect(registered).toContain('agent.delegate');
    expect(registered.some((n) => n.startsWith('finance.'))).toBe(true);
    expect(registered.some((n) => n.startsWith('memory.'))).toBe(true);
  });

  it('ships the concierge with the memory tools only, and no default flag', () => {
    const registered = createToolRegistry()
      .list()
      .map((t) => t.name)
      .filter((n) => n.startsWith('memory.'));
    const concierge = catalog.resolve('concierge');
    expect(concierge.tools).toEqual(registered);
    expect(concierge.tools.some((n) => n.startsWith('finance.'))).toBe(false);
    expect(concierge.isDefault).toBe(false);
    expect(concierge.systemPromptTemplate).toContain(
      `Tools available to you in this installation: ${registered.join(', ')}.`,
    );
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

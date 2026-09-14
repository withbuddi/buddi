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
      .filter(
        (n) =>
          n.startsWith('finance.') ||
          n.startsWith('memory.') ||
          n.startsWith('artifacts.') ||
          n.startsWith('reminder.') ||
          n.startsWith('schedule.') ||
          n === 'agent.delegate',
      );
    expect(catalog.resolve('finance-advisor').tools).toEqual(registered);
    expect(registered).toContain('agent.delegate');
    expect(registered.some((n) => n.startsWith('finance.'))).toBe(true);
    expect(registered.some((n) => n.startsWith('memory.'))).toBe(true);
  });

  it('ships the concierge with the memory, reminder and schedule tools, and no default flag', () => {
    const registered = createToolRegistry()
      .list()
      .map((t) => t.name)
      .filter(
        (n) => n.startsWith('memory.') || n.startsWith('reminder.') || n.startsWith('schedule.'),
      );
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

  it('ships the handles the owner types', () => {
    expect(
      Object.fromEntries(catalog.list().map((a) => [a.id, a.handle])),
    ).toEqual({
      concierge: 'buddi',
      'credit-coach': 'credo',
      'finance-advisor': 'ledger',
      'mail-triage': 'postman',
      scout: 'scout',
    });
  });

  /*
   * The living proof that the RuntimeProvider port swaps: one shipped agent
   * runs on a different company's endpoint, and the installation does not
   * depend on that company's key being present.
   */
  it('ships one agent on the second provider, with only its own narrow tools', () => {
    const scout = catalog.resolve('scout');
    expect(scout.provider.kind).toBe('openai');
    expect(scout.provider.credential).toEqual({ kind: 'api-key', env: 'OPENAI_API_KEY' });
    expect(scout.model).toBe('gpt-5');
    expect(scout.isDefault).toBe(false);
    expect(scout.tools.every((n) => n.startsWith('memory.') || n.startsWith('reminder.'))).toBe(
      true,
    );
    expect(scout.tools.some((n) => n.startsWith('finance.'))).toBe(false);
    expect(scout.tools.some((n) => n.startsWith('email.'))).toBe(false);
    // It says so itself, in its own persona.
    expect(scout.systemPromptTemplate).toContain('different AI provider');
  });

  it('loads the whole catalog with no OPENAI_API_KEY, marking only scout unavailable', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test' };
    const withoutKey = loadGatewayCatalog({ env, registry: createToolRegistry(env) });
    expect(withoutKey.list()).toHaveLength(5);
    const summaries = Object.fromEntries(withoutKey.list().map((a) => [a.id, a]));
    expect(summaries.scout?.available).toBe(false);
    expect(summaries.scout?.unavailableReason).toContain('OPENAI_API_KEY');
    for (const id of ['concierge', 'credit-coach', 'finance-advisor', 'mail-triage']) {
      expect(summaries[id]?.available).toBe(true);
    }
    // And the default agent still resolves and still runs.
    expect(withoutKey.defaultAgent().id).toBe('finance-advisor');
  });

  it('resolves each agent by its handle as readily as by its id', () => {
    expect(catalog.resolve('ledger').id).toBe('finance-advisor');
    expect(catalog.resolve('@credo').id).toBe('credit-coach');
    expect(catalog.byHandle('BUDDI')?.id).toBe('concierge');
    expect(catalog.byHandle('ledger')?.id).toBe('finance-advisor');
  });

  it('tells the finance advisor its handle and names its colleagues by theirs', () => {
    const prompt = catalog.resolve('finance-advisor').systemPromptTemplate;
    expect(prompt).toContain('Your handle is @ledger');
    expect(prompt).toContain('@credo — Credit Coach:');
    expect(prompt).toContain('@buddi — Concierge:');
  });

  it('attributes a delegated answer to the credit coach by handle', () => {
    // The persona must quote the handle, never the catalog id.
    const prompt = catalog.resolve('finance-advisor').systemPromptTemplate;
    expect(prompt).toContain('@credo says:');
    expect(prompt).not.toContain('Credit Coach says:');
  });

  it('fails closed on an unknown id rather than falling back to the default', () => {
    expect(() => catalog.resolve('tax-wizard')).toThrow(/unknown agent/);
  });
});

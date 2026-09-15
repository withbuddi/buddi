/**
 * The agent files installed *here* must load against the plugins this build
 * installs. These are the tests that fail the moment an agent file and the
 * finance manifest drift apart — a persona granting a tool nobody registered.
 *
 * They run against this owner's private set, which is no longer in the
 * repository (see README, "Your agents are yours"), so on a clone that has only
 * the examples the whole block is skipped rather than failed: a fresh install
 * is not a broken one. `examples.test.ts` covers that case instead.
 *
 * Even inside the guard, nothing here may assert *what* the private set
 * contains — no roster, no handle map, no "exactly N agents". `private/` is
 * gitignored, and creating an agent is a supported action the owner takes from
 * a menu; a platform test that fails because the product was used as designed
 * is worse than no test. So each assertion below is stated as a property that
 * holds for any private set: roles resolve, handles are unique and round-trip,
 * a catalog composes, availability is reported. The guard's ids exist only to
 * decide whether this is the owner's machine at all.
 */
import { describe, expect, it } from 'vitest';
import { AGENTS_DIR, createToolRegistry, loadGatewayCatalog } from './catalog.js';

const catalog = loadGatewayCatalog({ env: {} });

/** The owner's own agents, as distinct from anything `examples/` ships. */
const owned = () => catalog.list().filter((a) => a.source !== 'example');
const OWNER_IDS = ['concierge', 'credit-coach', 'finance-advisor', 'mail-triage', 'scout'];
const installed = new Set(catalog.list().map((a) => a.id));

describe.skipIf(!OWNER_IDS.every((id) => installed.has(id)))('the installed agents', () => {
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

  it('has exactly one default, and every way of asking agrees on it', () => {
    const flagged = catalog.list().filter((a) => a.isDefault);
    expect(flagged).toHaveLength(1);
    expect(catalog.defaultAgent().id).toBe(flagged[0]?.id);
    expect(catalog.resolve().id).toBe(flagged[0]?.id);
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

  it('grants the concierge only registered tools, in registry order, with no finance and no default flag', () => {
    // Deliberately *not* a copy of the concierge's grant list. Which namespaces
    // the owner hands this persona is the owner's business and changes when the
    // owner edits the file — routing, most recently, which is how this test
    // last broke. What the platform owes is smaller and permanent: every
    // granted name is a tool that exists, the grant comes back in registry
    // order, and the prompt the agent reads lists exactly what it was given.
    const registered = createToolRegistry()
      .list()
      .map((t) => t.name);
    const concierge = catalog.resolve('concierge');
    expect(concierge.tools.length).toBeGreaterThan(0);
    expect(registered).toEqual(expect.arrayContaining(concierge.tools));
    expect(concierge.tools).toEqual(registered.filter((n) => concierge.tools.includes(n)));
    // The one grant that is a security property rather than a preference: the
    // concierge is the general-purpose persona and reaches no money tool.
    expect(concierge.tools.some((n) => n.startsWith('finance.'))).toBe(false);
    expect(concierge.isDefault).toBe(false);
    expect(concierge.systemPromptTemplate).toContain(
      `Tools available to you in this installation: ${concierge.tools.join(', ')}.`,
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

  it('gives every installed agent a handle, unique across the whole catalog', () => {
    // Deliberately *not* a map of this owner's handles. Which personas the
    // owner keeps is the owner's business and changes the moment they make an
    // agent — which is a menu item now, and is how this test last broke. What
    // the platform owes holds for any private set, including none: every agent
    // the owner installed has a handle, and no two agents anywhere in the
    // catalog answer to the same one.
    for (const summary of owned()) {
      expect(summary.handle, summary.id).not.toBe('');
      expect(summary.handle, summary.id).not.toContain('@');
      expect(summary.handle, summary.id).toBe(summary.handle.toLowerCase());
    }
    const handles = catalog.list().map((a) => a.handle);
    expect(new Set(handles).size).toBe(handles.length);
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
    // Narrow is stated as what it may NOT reach, not as an allowlist: which
    // capabilities the owner grants this agent is the owner's business and
    // changes (web.* was granted here the day the web plugin shipped). What
    // the platform owes is that the agent on the second company's endpoint
    // never carries the owner's own data to it.
    expect(scout.tools.some((n) => n.startsWith('finance.'))).toBe(false);
    expect(scout.tools.some((n) => n.startsWith('email.'))).toBe(false);
    expect(scout.tools.some((n) => n.startsWith('artifacts.'))).toBe(false);
    expect(scout.tools.some((n) => n.startsWith('agent.'))).toBe(false);
    expect(scout.tools.some((n) => n.startsWith('platform.'))).toBe(false);
    // It says so itself, in its own persona.
    expect(scout.systemPromptTemplate).toContain('different AI provider');
  });

  it('loads the whole catalog with no OPENAI_API_KEY, marking exactly the OpenAI agents unavailable', () => {
    // A missing key takes out the agents pinned to that provider and nothing
    // else — stated over whatever is installed rather than over a count, so an
    // owner who makes a sixth agent does not break the platform's suite.
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test' };
    const withoutKey = loadGatewayCatalog({ env, registry: createToolRegistry(env) });
    const mine = withoutKey.list().filter((a) => a.source !== 'example');
    expect(mine.length).toBeGreaterThan(0);
    for (const summary of mine) {
      if (summary.providerKind === 'openai') {
        expect(summary.available, summary.id).toBe(false);
        expect(summary.unavailableReason, summary.id).toContain('OPENAI_API_KEY');
      } else {
        expect(summary.available, summary.id).toBe(true);
      }
    }
    // And the installation still names a default agent that can actually run.
    const fallback = withoutKey.defaultAgent();
    expect(withoutKey.list().find((a) => a.id === fallback.id)?.available).toBe(true);
  });

  it('resolves every agent by its handle as readily as by its id', () => {
    for (const summary of catalog.list()) {
      expect(catalog.resolve(summary.handle).id).toBe(summary.id);
      expect(catalog.resolve(`@${summary.handle}`).id).toBe(summary.id);
      expect(catalog.byHandle(summary.handle.toUpperCase())?.id).toBe(summary.id);
    }
  });

  it('tells each agent its own handle and names its colleagues by theirs', () => {
    // The roster paragraph is generated, so it is checked against the catalog
    // that generated it — never against a list of handles typed here.
    for (const summary of catalog.list()) {
      const prompt = catalog.resolve(summary.id).systemPromptTemplate;
      expect(prompt, summary.id).toContain(`Your handle is @${summary.handle}`);
      for (const other of catalog.list()) {
        if (other.id === summary.id) continue;
        expect(prompt, `${summary.id} -> ${other.id}`).toContain(
          `@${other.handle} — ${other.name}: `,
        );
      }
    }
  });

  it('attributes a delegated answer to the delegate by handle, never by name', () => {
    // The persona must quote the handle, never the catalog id or the name.
    const coach = catalog.resolve('credit-coach');
    const prompt = catalog.resolve('finance-advisor').systemPromptTemplate;
    expect(prompt).toContain(`@${coach.handle} says:`);
    expect(prompt).not.toContain(`${coach.name} says:`);
  });

  it('fails closed on an unknown id rather than falling back to the default', () => {
    expect(() => catalog.resolve('tax-wizard')).toThrow(/unknown agent/);
  });
});

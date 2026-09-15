/**
 * A fresh clone, with nothing private on it yet.
 *
 * This is the state anybody who clones the repository is in, and it has to
 * work: the examples alone must load, name a default agent, and resolve every
 * tool they declare against the real registry.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadAgentCatalog } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { createToolRegistry, EXAMPLES_AGENTS_DIR, EXAMPLES_SKILLS_DIR, REPO_ROOT } from './catalog.js';
import { ROLE_MAKER } from './roles.js';

const catalog = () =>
  loadAgentCatalog({
    dirs: [{ dir: EXAMPLES_AGENTS_DIR, skillsDir: EXAMPLES_SKILLS_DIR, source: 'example' }],
    registry: createToolRegistry({}),
    env: {},
  });

describe('the examples this repository ships', () => {
  it('load on their own, with @buddi as the default', () => {
    const loaded = catalog();
    const summaries = loaded.list();
    expect(summaries.map((a) => a.id)).toContain('concierge');
    expect(loaded.defaultAgent().id).toBe('concierge');
    expect(loaded.defaultAgent().handle).toBe('buddi');
    // Exactly one default on a fresh clone: two would make which one answers
    // an accident of load order.
    expect(summaries.filter((a) => a.isDefault).map((a) => a.id)).toEqual(['concierge']);
    expect(summaries.every((a) => a.source === 'example')).toBe(true);
  });

  it('grant the shipped agent nothing but memory, reminders, schedules, the owner profile, the canvas, a colleague and a look at the roster', () => {
    const shipped = catalog().resolve('concierge');
    expect(shipped.tools.length).toBeGreaterThan(0);
    // The canvas is on the list because it is the platform's own, owns no data
    // and reaches nothing outside the page it draws on. Finance, mail and the
    // artifact store are deliberately absent: a fresh clone grants no agent
    // access to anything the owner has not set up.
    // `agent.delegate` is the platform's own and owns no data: it can only
    // reach an agent named in this agent's `delegates.json`, and a fresh clone
    // ships none, so it is fail-closed until the owner wires a colleague.
    expect(
      shipped.tools.every(
        (name) =>
          name.startsWith('memory.') ||
          name.startsWith('reminder.') ||
          name.startsWith('schedule.') ||
          name.startsWith('owner.') ||
          name.startsWith('canvas.') ||
          name.startsWith('platform.') ||
          name === 'agent.delegate',
      ),
    ).toBe(true);
  });

  it('let the shipped agent read the roster but never write an agent file', () => {
    // Making an agent is the most dangerous capability here, so it lives with
    // exactly one agent the owner has to switch to deliberately. Everybody else
    // can answer "what agents do I have" and nothing more.
    const shipped = catalog().resolve('concierge');
    expect(shipped.tools).toContain('platform.list_agents');
    expect(shipped.tools).toContain('platform.installed_tools');
    for (const write of ['platform.create_agent', 'platform.update_agent', 'platform.write_skill', 'platform.delete_agent']) {
      expect(shipped.tools).not.toContain(write);
    }
  });

  it('ship Agent Father, the one agent that may write an agent file', () => {
    const loaded = catalog();
    const father = loaded.resolve('father');
    expect(father.id).toBe('agent-father');
    expect(father.isDefault).toBe(false);
    expect(father.tools).toContain('platform.create_agent');
    expect(father.tools).toContain('platform.delete_agent');
    // Its own grant is the argument it makes to the owner: it writes agents, it
    // does not read their money or their mail.
    expect(
      father.tools.every((name) => name.startsWith('platform.') || name.startsWith('memory.')),
    ).toBe(true);
    // Only one agent in a fresh clone may write.
    const writers = loaded
      .list()
      .filter((a) => (loaded.resolve(a.id).tools ?? []).includes('platform.create_agent'));
    expect(writers.map((a) => a.id)).toEqual(['agent-father']);
  });

  it('let Agent Father answer for the "maker" role, so /new never names it', () => {
    // `/new` is keyed to the role, exactly as `/status` is keyed to `overview`.
    // A fresh clone therefore has the command; an installation that writes its
    // own maker keeps it by claiming the role, and one with neither has no
    // menu entry rather than a dead one.
    const loaded = catalog();
    const resolution = loaded.agentForRole(ROLE_MAKER);
    expect(resolution.ok).toBe(true);
    expect(resolution.ok && resolution.agent.id).toBe('agent-father');
    expect(loaded.agentsWithRole(ROLE_MAKER).map((a) => a.id)).toEqual(['agent-father']);
    // Exactly one claimant: a role resolves to the first, and a second maker in
    // the shipped examples would make which one answers an accident of order.
    expect(loaded.list().filter((a) => a.roles.includes(ROLE_MAKER))).toHaveLength(1);
  });

  it('let the shipped agent conduct a first run: it has the owner tools and the skill', () => {
    // The agent a fresh clone answers with is the agent that meets the owner.
    // Both halves have to be there, or first contact is a blank prompt.
    const shipped = catalog().resolve('concierge');
    expect(shipped.tools).toContain('owner.get_profile');
    expect(shipped.tools).toContain('owner.finish_onboarding');
    expect(shipped.skills.map((s) => s.name)).toContain('first-run');
  });

  it('carry the shared example skill into the prompt', () => {
    const shipped = catalog().resolve('concierge');
    expect(shipped.skills.map((s) => s.name)).toContain('writing-for-the-surface');
  });

  it('give every agent the surface skill, with no `skills:` line to remember', () => {
    // The skill reads the generated surface paragraph, so it is useless to an
    // agent that does not have it — and it must reach agents whose files
    // nobody edited. A shared skill with no `agents` filter is how.
    const loaded = catalog();
    for (const summary of loaded.list()) {
      const agent = loaded.resolve(summary.id);
      expect(agent.skills.map((s) => s.name)).toContain('writing-for-the-surface');
      expect(agent.systemPromptTemplate).toContain('writing-for-the-surface');
    }
  });

  it('keep no personal agent inside the repository', () => {
    // `agents/` at the repo root is the pre-split location. Once migrated it is
    // gone, and nothing tracked by git names the owner's own personas.
    expect(existsSync(path.join(REPO_ROOT, 'agents'))).toBe(false);
  });
});

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

const catalog = () =>
  loadAgentCatalog({
    dirs: [{ dir: EXAMPLES_AGENTS_DIR, skillsDir: EXAMPLES_SKILLS_DIR, source: 'example' }],
    registry: createToolRegistry({}),
    env: {},
  });

describe('the examples this repository ships', () => {
  it('load on their own, with @assistant as the default', () => {
    const loaded = catalog();
    const summaries = loaded.list();
    expect(summaries.map((a) => a.id)).toContain('assistant');
    expect(loaded.defaultAgent().id).toBe('assistant');
    expect(summaries.every((a) => a.source === 'example')).toBe(true);
  });

  it('grant the example agent nothing but memory, reminders, the owner profile, the canvas and a look at the roster', () => {
    const assistant = catalog().resolve('assistant');
    expect(assistant.tools.length).toBeGreaterThan(0);
    // The canvas is on the list because it is the platform's own, owns no data
    // and reaches nothing outside the page it draws on. Finance, mail and the
    // artifact store are deliberately absent: a fresh clone grants no agent
    // access to anything the owner has not set up.
    expect(
      assistant.tools.every(
        (name) =>
          name.startsWith('memory.') ||
          name.startsWith('reminder.') ||
          name.startsWith('owner.') ||
          name.startsWith('canvas.') ||
          name.startsWith('platform.'),
      ),
    ).toBe(true);
  });

  it('let the example agent read the roster but never write an agent file', () => {
    // Making an agent is the most dangerous capability here, so it lives with
    // exactly one agent the owner has to switch to deliberately. Everybody else
    // can answer "what agents do I have" and nothing more.
    const assistant = catalog().resolve('assistant');
    expect(assistant.tools).toContain('platform.list_agents');
    expect(assistant.tools).toContain('platform.installed_tools');
    for (const write of ['platform.create_agent', 'platform.update_agent', 'platform.write_skill', 'platform.delete_agent']) {
      expect(assistant.tools).not.toContain(write);
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

  it('let the example agent conduct a first run: it has the owner tools and the skill', () => {
    // The agent a fresh clone answers with is the agent that meets the owner.
    // Both halves have to be there, or first contact is a blank prompt.
    const assistant = catalog().resolve('assistant');
    expect(assistant.tools).toContain('owner.get_profile');
    expect(assistant.tools).toContain('owner.finish_onboarding');
    expect(assistant.skills.map((s) => s.name)).toContain('first-run');
  });

  it('carry the shared example skill into the prompt', () => {
    const assistant = catalog().resolve('assistant');
    expect(assistant.skills.map((s) => s.name)).toContain('writing-for-the-surface');
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

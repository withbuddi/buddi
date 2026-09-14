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

  it('grant the example agent nothing but memory and reminders', () => {
    const assistant = catalog().resolve('assistant');
    expect(assistant.tools.length).toBeGreaterThan(0);
    expect(
      assistant.tools.every((name) => name.startsWith('memory.') || name.startsWith('reminder.')),
    ).toBe(true);
  });

  it('carry the shared example skill into the prompt', () => {
    const assistant = catalog().resolve('assistant');
    expect(assistant.skills.map((s) => s.name)).toContain('plain-text-surfaces');
  });

  it('keep no personal agent inside the repository', () => {
    // `agents/` at the repo root is the pre-split location. Once migrated it is
    // gone, and nothing tracked by git names the owner's own personas.
    expect(existsSync(path.join(REPO_ROOT, 'agents'))).toBe(false);
  });
});

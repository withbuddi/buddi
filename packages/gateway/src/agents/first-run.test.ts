/**
 * A fresh clone, meeting its owner.
 *
 * Two claims, and between them they are the feature:
 *
 *  1. the installation a `git clone` produces has an agent that *can* conduct
 *     the interview — the example assistant is the default, it holds the
 *     `owner.*` tools, and the first-run skill is composed into its prompt;
 *  2. the interview begins on first contact, once, whichever surface gets
 *     there first.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_SURFACE, loadAgentCatalog, type Queryable } from '@buddi/core';
import { EXAMPLES_AGENTS_DIR, EXAMPLES_SKILLS_DIR, createToolRegistry } from './catalog.js';
import { FIRST_RUN_SUFFIX, shouldStartFirstRun } from './first-run.js';

/* ---------------- the onboarding table, in memory ---------------- */

/**
 * Just enough of `core.onboarding` to prove the claim is atomic: the
 * conditional upsert returns a row only while the state is `pending`, which is
 * the whole of how two surfaces are prevented from interviewing one owner.
 */
class FakeOnboardingDb implements Queryable {
  row: { state: string; surface: string | null } | null = null;
  /** Every statement this saw, so a test can assert reads do not write. */
  statements: string[] = [];

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.statements.push(text);
    if (text.startsWith('select owner_id, state')) {
      return {
        rows: this.row
          ? [
              {
                owner_id: 'owner',
                state: this.row.state,
                started_at: new Date(0),
                completed_at: null,
                surface: this.row.surface,
                steps_done: [],
                nudges_sent: 0,
                last_nudge_at: null,
                unanswered: 0,
                quiet_until: null,
                updated_at: new Date(0),
              },
            ]
          : [],
      };
    }
    if (text.startsWith('insert into core.onboarding')) {
      if (this.row !== null && this.row.state !== 'pending') return { rows: [] };
      this.row = { state: 'in-progress', surface: String(params[1]) };
      return {
        rows: [
          {
            owner_id: 'owner',
            state: 'in-progress',
            started_at: new Date(0),
            completed_at: null,
            surface: this.row.surface,
            steps_done: [],
            nudges_sent: 0,
            last_nudge_at: null,
            unanswered: 0,
            quiet_until: null,
            updated_at: new Date(0),
          },
        ],
      };
    }
    throw new Error(`FakeOnboardingDb: unexpected sql: ${text}`);
  }
}

/* ---------------- the installation a clone produces ---------------- */

/** Exactly what a fresh clone loads: the shipped examples, nothing private. */
function freshInstall() {
  return loadAgentCatalog({
    dir: EXAMPLES_AGENTS_DIR,
    skillsDir: EXAMPLES_SKILLS_DIR,
    registry: createToolRegistry({} as NodeJS.ProcessEnv),
    env: {} as NodeJS.ProcessEnv,
  });
}

describe('a fresh install', () => {
  it('answers with the example assistant, and that is who meets the owner', () => {
    expect(freshInstall().defaultAgent().id).toBe('assistant');
  });

  it('gives that agent both halves of a first run: the tools and the procedure', () => {
    const assistant = freshInstall().defaultAgent();
    expect(assistant.tools).toEqual(
      expect.arrayContaining([
        'owner.get_profile',
        'owner.set_profile',
        'owner.rename_me',
        'owner.finish_onboarding',
      ]),
    );
    expect(assistant.skills.map((s) => s.name)).toContain('first-run');
    // The skill reaches every agent, not only this one: a private agent an
    // owner writes on day two inherits the same manners.
    const skill = assistant.skills.find((s) => s.name === 'first-run');
    expect(path.basename(skill?.file ?? '')).toBe('first-run.md');
  });

  it('carries the arc into the prompt, in the skill rather than in code', () => {
    const prompt = freshInstall().defaultAgent().systemPromptTemplate;
    expect(prompt).toContain('one question, then silence');
    expect(prompt).toContain('owner.finish_onboarding');
  });

  it('tells the run to follow the skill without restating it', () => {
    expect(FIRST_RUN_SUFFIX).toContain('first-run skill');
    expect(FIRST_RUN_SUFFIX).toContain('owner.finish_onboarding');
    // No question text in code: the wording is the skill's, and only the skill's.
    expect(FIRST_RUN_SUFFIX).not.toContain('What should I call you');
  });
});

describe('starting the first run', () => {
  it('begins on first contact', async () => {
    const db = new FakeOnboardingDb();
    expect(await shouldStartFirstRun(db, 'telegram')).toBe(true);
    expect(db.row).toEqual({ state: 'in-progress', surface: 'telegram' });
  });

  it('never begins twice, across both surfaces', async () => {
    const db = new FakeOnboardingDb();
    expect(await shouldStartFirstRun(db, 'telegram')).toBe(true);
    expect(await shouldStartFirstRun(db, CLI_SURFACE.id)).toBe(false);
    expect(await shouldStartFirstRun(db, 'telegram')).toBe(false);
    expect(db.row?.surface).toBe('telegram');
  });

  it('never begins once it is done, whichever surface finished it', async () => {
    const db = new FakeOnboardingDb();
    db.row = { state: 'done', surface: CLI_SURFACE.id };
    expect(await shouldStartFirstRun(db, 'telegram')).toBe(false);
    // And a machine that declined is a machine that is never asked again.
    db.row = { state: 'skipped', surface: CLI_SURFACE.id };
    expect(await shouldStartFirstRun(db, 'telegram')).toBe(false);
  });

  it('writes nothing at all on an installation that is already past it', async () => {
    const db = new FakeOnboardingDb();
    db.row = { state: 'done', surface: 'telegram' };
    await shouldStartFirstRun(db, 'telegram');
    expect(db.statements.some((s) => s.startsWith('insert'))).toBe(false);
  });
});

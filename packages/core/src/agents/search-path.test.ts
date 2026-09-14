import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  migrationNotice,
  resolveAgentSearchPath,
  type ResolveSearchPathOptions,
} from './search-path.js';

const REPO = '/repo';
const HOME = '/home/owner';

/** Resolve against a fixed set of directories that "exist". */
function resolve(present: string[], env: NodeJS.ProcessEnv = {}): ReturnType<typeof resolveAgentSearchPath> {
  const opts: ResolveSearchPathOptions = {
    repoRoot: REPO,
    env,
    home: HOME,
    exists: (dir) => present.includes(dir),
  };
  return resolveAgentSearchPath(opts);
}

describe('resolveAgentSearchPath', () => {
  it('puts the examples first and the owner second', () => {
    const search = resolve([path.join(REPO, 'examples', 'agents')]);
    expect(search.entries.map((e) => e.source)).toEqual(['example', 'private']);
    expect(search.entries[0]?.dir).toBe(path.join(REPO, 'examples', 'agents'));
    expect(search.entries[0]?.skillsDir).toBe(path.join(REPO, 'examples', 'skills'));
  });

  it('prefers <repo>/private when it exists', () => {
    const search = resolve([path.join(REPO, 'private', 'agents')]);
    expect(search.owner.dir).toBe(path.join(REPO, 'private', 'agents'));
    expect(search.owner.skillsDir).toBe(path.join(REPO, 'private', 'skills'));
    expect(search.ownerRoot).toBe(path.join(REPO, 'private'));
    expect(search.legacy).toBe(false);
  });

  it('falls back to ~/.buddi when there is no private directory in the repo', () => {
    const search = resolve([]);
    expect(search.owner.dir).toBe(path.join(HOME, '.buddi', 'agents'));
    expect(search.owner.skillsDir).toBe(path.join(HOME, '.buddi', 'skills'));
    expect(search.owner.exists).toBe(false);
  });

  it('lets BUDDI_AGENTS_DIR and BUDDI_SKILLS_DIR win over both', () => {
    const search = resolve([path.join(REPO, 'private', 'agents')], {
      BUDDI_AGENTS_DIR: '/elsewhere/agents',
      BUDDI_SKILLS_DIR: '/elsewhere/skills',
    });
    expect(search.owner.dir).toBe('/elsewhere/agents');
    expect(search.owner.skillsDir).toBe('/elsewhere/skills');
  });

  it('ignores a blank environment override', () => {
    const search = resolve([path.join(REPO, 'private', 'agents')], { BUDDI_AGENTS_DIR: '   ' });
    expect(search.owner.dir).toBe(path.join(REPO, 'private', 'agents'));
  });

  describe('the pre-split layout', () => {
    it('keeps loading <repo>/agents when nothing private exists yet', () => {
      const search = resolve([path.join(REPO, 'agents')]);
      expect(search.owner.dir).toBe(path.join(REPO, 'agents'));
      expect(search.owner.skillsDir).toBe(path.join(REPO, 'skills'));
      expect(search.legacy).toBe(true);
      // ...but the migration target is still the private directory.
      expect(search.ownerRoot).toBe(path.join(HOME, '.buddi'));
    });

    it('is not used once a private directory exists', () => {
      const search = resolve([path.join(REPO, 'agents'), path.join(REPO, 'private', 'agents')]);
      expect(search.owner.dir).toBe(path.join(REPO, 'private', 'agents'));
      expect(search.legacy).toBe(false);
    });

    it('is not used when the owner pinned a directory explicitly', () => {
      const search = resolve([path.join(REPO, 'agents')], { BUDDI_AGENTS_DIR: '/elsewhere/agents' });
      expect(search.legacy).toBe(false);
      expect(search.owner.dir).toBe('/elsewhere/agents');
    });

    it('is the only case that produces a notice', () => {
      expect(migrationNotice(resolve([path.join(REPO, 'agents')]))).toContain('buddi agents migrate');
      expect(migrationNotice(resolve([path.join(REPO, 'private', 'agents')]))).toBeUndefined();
    });
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateAgents, renderMigration } from './migrate.js';

function repoWithAgents(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'buddi-migrate-'));
  for (const id of ['concierge', 'ledger']) {
    mkdirSync(path.join(repo, 'agents', id), { recursive: true });
    writeFileSync(path.join(repo, 'agents', id, 'agent.md'), `# ${id}\n`);
  }
  mkdirSync(path.join(repo, 'skills'), { recursive: true });
  writeFileSync(path.join(repo, 'skills', 'house-style.md'), '# house style\n');
  // The examples must never be touched.
  mkdirSync(path.join(repo, 'examples', 'agents', 'assistant'), { recursive: true });
  writeFileSync(path.join(repo, 'examples', 'agents', 'assistant', 'agent.md'), '# assistant\n');
  return repo;
}

describe('migrateAgents', () => {
  it('moves agents and skills into the private directory and leaves the examples alone', () => {
    const repo = repoWithAgents();
    const target = path.join(repo, 'private');

    const result = migrateAgents({ repoRoot: repo, targetRoot: target });

    expect(result.moved.map((m) => path.basename(m.from)).sort()).toEqual([
      'concierge',
      'house-style.md',
      'ledger',
    ]);
    expect(readFileSync(path.join(target, 'agents', 'ledger', 'agent.md'), 'utf8')).toBe('# ledger\n');
    expect(readFileSync(path.join(target, 'skills', 'house-style.md'), 'utf8')).toBe('# house style\n');
    // Moved, not copied: the old location is gone.
    expect(existsSync(path.join(repo, 'agents'))).toBe(false);
    expect(existsSync(path.join(repo, 'skills'))).toBe(false);
    expect(result.removed).toHaveLength(2);
    // And the shipped example is exactly where it was.
    expect(existsSync(path.join(repo, 'examples', 'agents', 'assistant', 'agent.md'))).toBe(true);
  });

  it('is idempotent — a second run has nothing to do', () => {
    const repo = repoWithAgents();
    const target = path.join(repo, 'private');
    migrateAgents({ repoRoot: repo, targetRoot: target });

    const again = migrateAgents({ repoRoot: repo, targetRoot: target });
    expect(again.moved).toEqual([]);
    expect(again.skipped).toEqual([]);
    expect(renderMigration(again)).toContain('Nothing to migrate');
    expect(existsSync(path.join(target, 'agents', 'ledger', 'agent.md'))).toBe(true);
  });

  it('never overwrites a private file that is already there', () => {
    const repo = repoWithAgents();
    const target = path.join(repo, 'private');
    mkdirSync(path.join(target, 'agents', 'ledger'), { recursive: true });
    writeFileSync(path.join(target, 'agents', 'ledger', 'agent.md'), '# mine, newer\n');

    const result = migrateAgents({ repoRoot: repo, targetRoot: target });

    expect(result.skipped.map((s) => path.basename(s.from))).toEqual(['ledger']);
    expect(readFileSync(path.join(target, 'agents', 'ledger', 'agent.md'), 'utf8')).toBe('# mine, newer\n');
    // The one it refused to overwrite is still in the repo, not silently lost.
    expect(existsSync(path.join(repo, 'agents', 'ledger', 'agent.md'))).toBe(true);
    expect(existsSync(path.join(repo, 'agents', 'concierge'))).toBe(false);
  });

  it('changes nothing on a dry run', () => {
    const repo = repoWithAgents();
    const target = path.join(repo, 'private');

    const result = migrateAgents({ repoRoot: repo, targetRoot: target, dryRun: true });

    expect(result.moved).toHaveLength(3);
    expect(existsSync(path.join(repo, 'agents', 'ledger'))).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(renderMigration(result, true)).toContain('Would move into');
  });
});

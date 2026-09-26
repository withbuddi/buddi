/**
 * The README and `docs/cli.md` against the command table.
 *
 * A README is documentation nobody compiles, so it rots in one direction only:
 * a command is renamed, and the front page keeps telling strangers to type the
 * old one. Every `buddi …` it prints must be in the table `buddi help` is drawn
 * from, and it must link the reference page, which is rendered from that same
 * table and checked here word for word.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, renderReference } from './commands.js';
import { REPO_ROOT } from './paths.js';

const README = path.join(REPO_ROOT, 'README.md');
const REFERENCE = path.join(REPO_ROOT, 'docs', 'cli.md');

/**
 * The words that can follow `buddi` in a command: lowercase verbs. Placeholders
 * (`<id>`), quoted questions and option values are not commands and stop the
 * scan.
 */
const WORD = /^[a-z][a-z0-9-]*$/;

/**
 * Fence languages whose contents are shell. A ```markdown block is an *example
 * of a file*, not a transcript — the prose inside it is prose, and scanning it
 * for commands finds sentences.
 */
const SHELL_FENCES = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'text']);

/** Words the parser takes that are not rows of the table. */
const UNTABLED = ['help'];

/** Every command path the table documents, as space-joined words, prefixes included. */
export function commandsInTable(): Set<string> {
  const paths = new Set<string>(UNTABLED);
  for (const entry of COMMANDS) {
    const words = entry.name.split(' ').filter((w) => w !== '');
    for (let n = 1; n <= words.length; n += 1) paths.add(words.slice(0, n).join(' '));
  }
  return paths;
}

/**
 * Every fragment of the README that is *code*: a fenced block, or the inside of
 * an inline `code span`. Prose is deliberately excluded — "buddi is one
 * command" is a sentence about buddi, not an invocation of it.
 */
export function codeFragments(markdown: string): { code: string; line: string }[] {
  const fragments: { code: string; line: string }[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fence = fence === undefined ? line.trim().slice(3).trim().toLowerCase() : undefined;
      continue;
    }
    if (fence !== undefined) {
      if (SHELL_FENCES.has(fence)) fragments.push({ code: line, line: line.trim() });
      continue;
    }
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      fragments.push({ code: span[1] as string, line: line.trim() });
    }
  }
  return fragments;
}

/**
 * Every `buddi …` invocation the README prints, with the line it came from.
 *
 * A command ends at the first word that is not a verb: a placeholder (`<id>`),
 * a flag, a quoted question, an argument in capitals.
 */
export function commandsInReadme(markdown: string): { command: string; line: string }[] {
  const found: { command: string; line: string }[] = [];
  for (const { code, line } of codeFragments(markdown)) {
    for (const match of code.matchAll(/\bbuddi\b([^|]*)/g)) {
      const words: string[] = [];
      for (const raw of (match[1] ?? '').trim().split(/\s+/)) {
        const word = raw.replace(/[.,:;)\]]+$/, '');
        if (!WORD.test(word)) break;
        words.push(word);
      }
      if (words.length > 0) found.push({ command: words.join(' '), line });
    }
  }
  return found;
}

/**
 * Is this command (or a prefix of it) documented? `buddi agents show ledger`
 * is `agents show` with an argument; `buddi chat` is itself.
 */
function known(command: string, usage: Set<string>): boolean {
  const words = command.split(' ');
  for (let n = words.length; n > 0; n -= 1) {
    if (usage.has(words.slice(0, n).join(' '))) return true;
  }
  return false;
}

describe('commandsInTable', () => {
  it('registers every command and the groups above them', () => {
    const table = commandsInTable();
    expect(table.has('backup create')).toBe(true);
    expect(table.has('backup')).toBe(true);
    expect(table.has('agents')).toBe(true);
    expect([...table].some((c) => c.includes('<'))).toBe(false);
  });
});

describe('commandsInReadme', () => {
  it('reads a command out of an inline span and out of a fenced block alike', () => {
    const md = 'Run `buddi doctor` first.\n\n```sh\nbuddi service install\n```\n';
    expect(commandsInReadme(md).map((f) => f.command)).toEqual(['doctor', 'service install']);
  });

  it('ignores prose that merely names the tool', () => {
    expect(commandsInReadme('buddi is one command, and it is yours.')).toEqual([]);
  });

  it('stops at an argument, a flag value or a quote', () => {
    expect(commandsInReadme('`buddi ask "can I afford it?"`')[0]?.command).toBe('ask');
    expect(commandsInReadme('`buddi agents set ledger --model claude-opus-5`')[0]?.command).toBe(
      'agents set ledger',
    );
  });

  it('reports the offending line, not just the command', () => {
    const found = commandsInReadme('Then run `buddi nope` and see.');
    expect(found[0]).toEqual({ command: 'nope', line: 'Then run `buddi nope` and see.' });
  });
});

describe('README.md', () => {
  const markdown = readFileSync(README, 'utf8');
  const table = commandsInTable();

  it('prints no command this binary does not have', () => {
    const offenders = commandsInReadme(markdown)
      .filter((f) => !known(f.command, table))
      .map((f) => `  buddi ${f.command}\n      in: ${f.line}`);
    expect(
      offenders.join('\n'),
      `README.md names ${offenders.length} command(s) that "buddi help" does not:`,
    ).toBe('');
  });

  it('links the reference page, which has every command', () => {
    expect(markdown).toContain('docs/cli.md');
  });
});

describe('docs/cli.md', () => {
  it('is what the command table renders (run pnpm docs:cli)', () => {
    const page = readFileSync(REFERENCE, 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n\n?/.exec(page);
    expect(match, 'docs/cli.md has no frontmatter: run pnpm docs:cli').not.toBeNull();
    expect(match?.[1]).toMatch(/^status: reference$/m);
    expect(page.slice(match?.[0].length ?? 0), 'docs/cli.md is behind the command table: run pnpm docs:cli').toBe(
      renderReference(COMMANDS),
    );
  });
});

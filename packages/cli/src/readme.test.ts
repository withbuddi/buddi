/**
 * Every `buddi …` the README prints must be a command this binary has.
 *
 * A README is documentation nobody compiles, so it rots in one direction only:
 * a command is renamed, and the front page keeps telling strangers to type the
 * old one. This test closes that loop against `USAGE` — the same text `buddi
 * help` prints — so the front page cannot outlive the CLI.
 *
 * Both directions are checked: every command the README prints exists, and every
 * command group `buddi help` prints is named somewhere in the README. Only the
 * *group* in the second direction — a README is allowed to be shorter than
 * `--help` about flags, never about whole features.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { USAGE } from './args.js';
import { REPO_ROOT } from './paths.js';

const README = path.join(REPO_ROOT, 'README.md');

/**
 * The words that can follow `buddi` in a command: lowercase verbs, and the two
 * long flags that *are* the command (`--help`, `--version`). Placeholders
 * (`<id>`), quoted questions and option values are not commands and stop the
 * scan.
 */
const WORD = /^[a-z][a-z0-9-]*$/;

/**
 * Commands `parseArgs` accepts that `USAGE` does not print, because a usage
 * text that lists itself is noise. They are still real commands.
 */
const UNPRINTED = ['help', 'version'];

/**
 * Fence languages whose contents are shell. A ```markdown block is an *example
 * of a file*, not a transcript — the prose inside it is prose, and scanning it
 * for commands finds sentences.
 */
const SHELL_FENCES = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'text']);

/**
 * Every command path `USAGE` documents, as space-joined words: `agents`,
 * `agents set`, `db up`, `backup schedule install`.
 *
 * `a|b` alternatives are expanded — `buddi db down|status` documents both — and
 * a line carrying two commands (`buddi jobs retry <id> | buddi jobs cancel
 * <id>`) is split on `buddi` first.
 */
export function commandsInUsage(usage: string): Set<string> {
  const paths = new Set<string>(UNPRINTED);
  for (const line of usage.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('buddi ')) continue;
    for (const clause of trimmed.split(/\s\|\s(?=buddi\s)/)) {
      const words = clause.trim().split(/\s+/).slice(1);
      // `[a, b|c]` → the cross product of the alternative lists, so every
      // spelling the line documents is registered.
      let prefixes: string[] = [];
      for (const word of words) {
        const alternatives = word.split('|').filter((w) => WORD.test(w));
        if (alternatives.length === 0) break;
        prefixes =
          prefixes.length === 0
            ? alternatives
            : prefixes.flatMap((p) => alternatives.map((a) => `${p} ${a}`));
        for (const p of prefixes) paths.add(p);
      }
    }
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

describe('commandsInUsage', () => {
  const usage = commandsInUsage(USAGE);

  it('expands alternatives on one line', () => {
    expect(usage.has('db up')).toBe(true);
    expect(usage.has('db down')).toBe(true);
    expect(usage.has('db status')).toBe(true);
  });

  it('splits a line that documents two commands', () => {
    expect(usage.has('jobs retry')).toBe(true);
    expect(usage.has('jobs cancel')).toBe(true);
  });

  it('registers the bare command as well as its verbs', () => {
    expect(usage.has('agents')).toBe(true);
    expect(usage.has('agents set')).toBe(true);
  });

  it('stops at a placeholder rather than treating it as a verb', () => {
    expect(usage.has('telegram unpair')).toBe(true);
    expect([...usage].some((c) => c.includes('<'))).toBe(false);
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
  const usage = commandsInUsage(USAGE);

  it('prints no command this binary does not have', () => {
    const offenders = commandsInReadme(markdown)
      .filter((f) => !known(f.command, usage))
      .map((f) => `  buddi ${f.command}\n      in: ${f.line}`);
    expect(
      offenders.join('\n'),
      `README.md names ${offenders.length} command(s) that "buddi help" does not:`,
    ).toBe('');
  });

  it('documents every top-level command group', () => {
    const groups = new Set(
      [...usage].map((c) => c.split(' ')[0] as string).filter((c) => !UNPRINTED.includes(c)),
    );
    const mentioned = new Set(commandsInReadme(markdown).map((f) => f.command.split(' ')[0]));
    const missing = [...groups].filter((g) => !mentioned.has(g)).sort();
    expect(missing.join(', '), 'commands "buddi help" documents that README.md never names:').toBe(
      '',
    );
  });
});

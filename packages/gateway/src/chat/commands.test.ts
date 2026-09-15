import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  COMMAND_NAMES,
  MultilineInput,
  attachmentCandidate,
  expandHome,
  helpText,
  isKnownCommand,
  parseCommand,
  saidYes,
  unknownCommandText,
  unquote,
} from './commands.js';

describe('parseCommand', () => {
  it('reads a bare command', () => {
    expect(parseCommand('/agents')).toEqual({ name: '/agents', arg: '' });
  });

  it('reads a command and its argument', () => {
    expect(parseCommand('/use @ledger')).toEqual({ name: '/use', arg: '@ledger' });
  });

  it('keeps multi-word arguments whole', () => {
    expect(parseCommand('/reminders cancel abc-123')).toEqual({
      name: '/reminders',
      arg: 'cancel abc-123',
    });
  });

  it('lower-cases the command but never the argument', () => {
    expect(parseCommand('/USE Ledger')).toEqual({ name: '/use', arg: 'Ledger' });
  });

  it('resolves aliases to the canonical command', () => {
    expect(parseCommand('/exit')?.name).toBe('/quit');
    expect(parseCommand('/?')?.name).toBe('/help');
  });

  it('is not a command when there is no leading slash', () => {
    expect(parseCommand('can I afford a bike?')).toBeUndefined();
    expect(parseCommand('@ledger hello')).toBeUndefined();
  });
});

describe('the command table', () => {
  it('is what /help prints, with no command missing from either', () => {
    const help = helpText();
    for (const command of COMMANDS) expect(help).toContain(command.name);
  });

  it('names every command the dispatcher knows', () => {
    for (const name of COMMAND_NAMES) expect(isKnownCommand(name)).toBe(true);
    expect(isKnownCommand('/wat')).toBe(false);
  });

  it('carries the commands the Telegram surface has, so parity is checkable', () => {
    for (const shared of [
      '/help',
      '/agents',
      '/use',
      '/whoami',
      '/status',
      '/recap',
      '/reminders',
      '/files',
      '/approvals',
      '/devices',
      '/new',
      '/reset',
      '/id',
    ]) {
      expect(COMMAND_NAMES).toContain(shared);
    }
  });

  it('suggests /help for an unknown command, without calling it an error', () => {
    const text = unknownCommandText('/wat');
    expect(text).toContain('/wat');
    expect(text).toContain('/help');
    expect(text.toLowerCase()).not.toContain('error');
  });
});

describe('MultilineInput', () => {
  it('submits a plain line as it stands', () => {
    const input = new MultilineInput();
    expect(input.feed('hello')).toEqual({ kind: 'submit', text: 'hello', literal: false });
    expect(input.active).toBe(false);
  });

  it('continues a line ending in a backslash', () => {
    const input = new MultilineInput();
    expect(input.feed('the first half \\')).toEqual({ kind: 'pending' });
    expect(input.active).toBe(true);
    expect(input.feed('and the second')).toEqual({
      kind: 'submit',
      text: 'the first half \nand the second',
      literal: false,
    });
    expect(input.active).toBe(false);
  });

  it('treats an escaped backslash as the end of the line', () => {
    const input = new MultilineInput();
    expect(input.feed('C:\\\\')).toEqual({ kind: 'submit', text: 'C:\\\\', literal: false });
  });

  it('opens and closes a """ block, interpreting nothing inside it', () => {
    const input = new MultilineInput();
    expect(input.feed('"""')).toEqual({ kind: 'pending' });
    expect(input.inBlock).toBe(true);
    input.feed('/not a command');
    input.feed('  indented');
    expect(input.feed('"""')).toEqual({
      kind: 'submit',
      text: '/not a command\n  indented',
      literal: true,
    });
    expect(input.active).toBe(false);
  });

  it('shows what the prompt should say while a continuation is open', () => {
    const input = new MultilineInput();
    input.feed('one \\');
    expect(input.continuation).toBe('…');
    input.reset();
    input.feed('"""');
    expect(input.continuation).toBe('"""');
  });

  it('drops everything buffered on reset', () => {
    const input = new MultilineInput();
    input.feed('half \\');
    input.reset();
    expect(input.feed('whole')).toEqual({ kind: 'submit', text: 'whole', literal: false });
  });
});

describe('attachmentCandidate', () => {
  const opts = {
    home: '/home/owner',
    cwd: '/work',
    exists: (candidate: string): boolean =>
      ['/home/owner/Downloads/x.pdf', '/work/budget.csv'].includes(candidate),
  };

  it('recognizes a path under ~ that is really there', () => {
    expect(attachmentCandidate('~/Downloads/x.pdf', opts)).toBe('/home/owner/Downloads/x.pdf');
  });

  it('resolves a relative path against the working directory', () => {
    expect(attachmentCandidate('budget.csv', opts)).toBe('/work/budget.csv');
  });

  it('accepts a quoted path with a space in it', () => {
    const quoted = {
      ...opts,
      exists: (candidate: string): boolean => candidate === '/work/my file.csv',
    };
    expect(attachmentCandidate('"my file.csv"', quoted)).toBe('/work/my file.csv');
  });

  it('is not a path when the file is not there', () => {
    expect(attachmentCandidate('~/Downloads/missing.pdf', opts)).toBeUndefined();
  });

  it('is not a path when the message is a sentence', () => {
    expect(attachmentCandidate('what is in budget.csv?', opts)).toBeUndefined();
  });

  it('never steals a message addressed to an agent', () => {
    const always = { ...opts, exists: (): boolean => true };
    expect(attachmentCandidate('@ledger budget.csv', always)).toBeUndefined();
  });

  it('leaves a bare word alone even when something of that name exists', () => {
    const always = { ...opts, exists: (): boolean => true };
    expect(attachmentCandidate('status', always)).toBeUndefined();
  });
});

describe('path helpers', () => {
  it('expands only a leading tilde', () => {
    expect(expandHome('~/x', '/home/o')).toBe('/home/o/x');
    expect(expandHome('~', '/home/o')).toBe('/home/o');
    expect(expandHome('a/~/b', '/home/o')).toBe('a/~/b');
  });

  it('strips one matching pair of quotes', () => {
    expect(unquote('"a b"')).toBe('a b');
    expect(unquote("'a b'")).toBe('a b');
    expect(unquote('"unbalanced')).toBe('"unbalanced');
  });

  it('treats an empty answer as yes', () => {
    expect(saidYes('')).toBe(true);
    expect(saidYes('y')).toBe(true);
    expect(saidYes('YES')).toBe(true);
    expect(saidYes('n')).toBe(false);
  });
});

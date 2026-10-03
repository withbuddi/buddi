/**
 * The composer's text rules, one function at a time: where a popup opens,
 * how a list carries on, what a paste becomes.
 */
import { describe, expect, it } from 'vitest';
import {
  completeMention,
  continueList,
  fencePaste,
  guessLang,
  inFence,
  indentItem,
  leadingMention,
  looksLikeCode,
  mentionAt,
  mentionedHandles,
  parseCommand,
  slashAt,
  useAt,
} from './composer-text';
import { borrowedMaker } from './ChatPage';
import type { ChatAgent } from './types';

const end = (s: string): [string, number] => [s, s.length];

describe('where the popups open', () => {
  it('finds the @word at the caret after a space, a bracket or the start, not inside an address', () => {
    expect(mentionAt(...end('Before you send it, @'))).toEqual({ start: 20, query: '' });
    expect(mentionAt(...end('ask (@le'))).toEqual({ start: 5, query: 'le' });
    expect(mentionAt(...end('@fa'))).toEqual({ start: 0, query: 'fa' });
    expect(mentionAt(...end('mail ana@studio'))).toBeNull();
    expect(mentionAt(...end('done @father now'))).toBeNull();
  });

  it('offers no mention inside a code block', () => {
    expect(mentionAt(...end('```\n@'))).toBeNull();
  });

  it('opens / only at the very start of the message, before any space', () => {
    expect(slashAt(...end('/'))).toEqual({ query: '' });
    expect(slashAt(...end('/qu'))).toEqual({ query: 'qu' });
    expect(slashAt(...end('see /usr'))).toBeNull();
    expect(slashAt(...end('hi\n/use'))).toBeNull();
    expect(slashAt(...end('/quiet 1d'))).toBeNull();
  });

  it('knows /use @… is choosing an agent', () => {
    expect(useAt(...end('/use @'))).toBe(true);
    expect(useAt(...end('/use @le'))).toBe(true);
    expect(useAt(...end('/used'))).toBe(false);
  });

  it('reads a whole message as a command', () => {
    expect(parseCommand('/quiet 1d')).toEqual({ name: 'quiet', arg: '1d' });
    expect(parseCommand(' /STOP ')).toEqual({ name: 'stop', arg: '' });
    expect(parseCommand('/new a plant tracker\nthat waters')).toEqual({ name: 'new', arg: 'a plant tracker\nthat waters' });
    expect(parseCommand('not /a command')).toBeNull();
  });

  it('completes a mention with one space, never two', () => {
    expect(completeMention('ask @le now', 7, 4, 'ledger')).toEqual({ value: 'ask @ledger now', caret: 12 });
    expect(completeMention('ask @le', 7, 4, 'ledger')).toEqual({ value: 'ask @ledger ', caret: 12 });
  });

  it('lists the handles a message names, leaving code out', () => {
    expect(mentionedHandles('@father and @Ledger, not `@scout` or ana@x.com\n```\n@dev\n```')).toEqual(['father', 'ledger']);
    expect(leadingMention('@father: make Postie firmer')).toEqual({ handle: 'father', rest: 'make Postie firmer' });
    expect(leadingMention('make @father')).toBeNull();
  });
});

describe('lists', () => {
  it('carries a bullet on, and numbers on', () => {
    expect(continueList(...end('- milk'))).toEqual({ value: '- milk\n- ', caret: 9 });
    expect(continueList(...end('  * eggs'))).toEqual({ value: '  * eggs\n  * ', caret: 13 });
    expect(continueList(...end('9. flour'))).toEqual({ value: '9. flour\n10. ', caret: 13 });
  });

  it('ends the list on an empty item, keeping the line', () => {
    expect(continueList(...end('- milk\n- '))).toEqual({ value: '- milk\n', caret: 7 });
  });

  it('is not a list in prose or in code', () => {
    expect(continueList(...end('milk'))).toBeNull();
    expect(continueList(...end('```\n- x'))).toBeNull();
  });

  it('indents and outdents an item by two spaces, the caret moving with it', () => {
    expect(indentItem(...end('- milk'), false)).toEqual({ value: '  - milk', caret: 8 });
    expect(indentItem(...end('  - milk'), true)).toEqual({ value: '- milk', caret: 6 });
    expect(indentItem(...end('milk'), false)).toBeNull();
  });
});

describe('pastes', () => {
  const ts = 'export function dueDate(sent: Date, days = 14) {\n  const d = new Date(sent);\n  d.setDate(d.getDate() + days);\n  return d;\n}';

  it('sees code in code, and not in a paragraph or a short line', () => {
    expect(looksLikeCode(ts)).toBe(true);
    expect(looksLikeCode('Dear Ana,\nThursday works.\nSee you then.')).toBe(false);
    expect(looksLikeCode('const a = 1;')).toBe(false);
    expect(looksLikeCode('```js\na();\nb();\n```')).toBe(false);
  });

  it('guesses the language for the tag', () => {
    expect(guessLang(ts)).toBe('ts');
    expect(guessLang('def f(x):\n    return x\nprint(f(1))')).toBe('py');
    expect(guessLang('SELECT *\nFROM t\nWHERE x = 1;')).toBe('sql');
    expect(guessLang('function f() {\n  return 1;\n}')).toBe('js');
  });

  it('fences a paste on lines of its own', () => {
    expect(fencePaste('Why?', 4, 'a();\nb();\n', 'js')).toEqual({ value: 'Why?\n```js\na();\nb();\n```\n', caret: 25 });
    expect(fencePaste('', 0, 'x', 'js').value).toBe('```js\nx\n```\n');
  });

  it('knows when the caret is inside a block', () => {
    expect(inFence('```ts\nconst a', 13)).toBe(true);
    expect(inFence('```ts\na\n```\nafter', 16)).toBe(false);
  });
});

describe('borrowing Agent Father', () => {
  const agent = (id: string, roles: string[] = []): ChatAgent => ({ id, handle: id, name: id, description: '', available: true, roles, provider: 'anthropic', model: 'm' });
  const team = [agent('postie'), agent('father', ['maker']), agent('ledger')];

  it('borrows the maker for a message that starts with its handle, from any other agent', () => {
    expect(borrowedMaker('@father make Postie firmer', team, 'postie')).toEqual({ agent: team[1], rest: 'make Postie firmer' });
  });

  it('does not borrow for a teammate, a mention mid-message, an empty ask, or in the maker’s own chat', () => {
    expect(borrowedMaker('@ledger how much?', team, 'postie')).toBeNull();
    expect(borrowedMaker('ask @father later', team, 'postie')).toBeNull();
    expect(borrowedMaker('@father', team, 'postie')).toBeNull();
    expect(borrowedMaker('@father hello', team, 'father')).toBeNull();
  });
});

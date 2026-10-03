/**
 * Composer v2 (docs/dashboard.md, The composer): the @ popup and its chips,
 * the / menu, live styling painted over the textarea, lists, and pastes.
 *
 * jsdom draws nothing, so what can be held here is the contract the drawing
 * rests on: the paint's text is the textarea's value character for character,
 * the popups are listboxes the field points into, and every key does exactly
 * one thing. The pixels are checked against the kit with Playwright.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { setPluginCommands } from './commands';
import type { ChatAgent } from './types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setPluginCommands([]);
  window.localStorage.clear();
});

const agent = (id: string, name: string, roles: string[] = []): ChatAgent => ({ id, handle: id, name, description: '', available: true, roles, provider: 'anthropic', model: 'claude-sonnet-5' });
const TEAM = [agent('buddi', 'Buddi', ['front-desk']), agent('postie', 'Postie'), agent('ledger', 'Ledger'), agent('scout', 'Scout'), agent('father', 'Agent Father', ['maker'])];

function setup(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn();
  const onCommand = vi.fn();
  const onStop = vi.fn();
  render(
    <Composer disabled={false} running={false} onSend={onSend} onStop={onStop} agentName="Postie"
      team={{ agents: TEAM, selfId: 'postie' }} onCommand={onCommand} {...over} />,
  );
  const field = screen.getByLabelText(/Message Postie/) as HTMLTextAreaElement;
  const type = (value: string): void => { fireEvent.change(field, { target: { value } }); };
  const key = (k: string, extra: Record<string, unknown> = {}): void => { fireEvent.keyDown(field, { key: k, ...extra }); };
  return { field, type, key, onSend, onCommand, onStop };
}

/** The paint's text without the zero-width spaces that hold empty lines and the language tag drawn beside a fence. */
function paintText(): string {
  const paint = screen.getByTestId('composer-paint').cloneNode(true) as HTMLElement;
  paint.querySelectorAll('[data-paint-extra]').forEach((n) => n.remove());
  paint.querySelector('.cv-tail')?.remove();
  return Array.from(paint.children).map((line) => (line.textContent ?? '').replace(/​/g, '')).join('\n');
}

describe('@ mentions in a one-to-one chat', () => {
  it('offers Agent Father to borrow first, then the team, as a listbox the field points into', () => {
    const { field, type } = setup();
    type('Before you send it, @');
    const list = screen.getByRole('listbox', { name: 'Mention someone' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Agent Father @father'),
      expect.stringContaining('Buddi @buddi'),
      expect.stringContaining('Ledger @ledger'),
      expect.stringContaining('Scout @scout'),
    ]);
    expect(within(list).getByText('Borrow')).toBeInTheDocument();
    expect(within(list).getByText('Ask a teammate')).toBeInTheDocument();
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]!.textContent).toContain('Borrows Agent Father for this message');
    expect(field).toHaveAttribute('aria-activedescendant', options[0]!.id);
    expect(field).toHaveAttribute('aria-controls', list.id);
  });

  it('filters as it is typed, moves with the arrows, and completes with Enter', () => {
    const { field, type, key, onSend } = setup();
    type('ask @l');
    let options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain('Postie asks @ledger');
    type('ask @');
    key('ArrowDown');
    options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(field).toHaveAttribute('aria-activedescendant', options[1]!.id);
    key('Enter');
    expect(field.value).toBe('ask @buddi ');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('completes with Tab too, and Escape closes without touching the text', () => {
    const { field, type, key } = setup();
    type('@fa');
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field.value).toBe('@fa');
    type('@fat');
    key('Tab');
    expect(field.value).toBe('@father ');
  });

  it('draws a completed mention as a chip and says what it does on the hint line', () => {
    const { type } = setup();
    type('@father make Postie firmer');
    const chip = screen.getByTestId('composer-paint').querySelector('.cv-chip');
    expect(chip?.textContent).toBe('@father');
    expect(chip).toHaveAttribute('data-agent', 'buddi');
    expect(screen.getByText(/borrows Agent Father for this message/)).toBeInTheDocument();
    type('then @ledger checks it');
    expect(screen.getByText(/Postie asks them/)).toBeInTheDocument();
    // An unknown handle is just text.
    type('@nobody here');
    expect(screen.getByTestId('composer-paint').querySelector('.cv-chip')).toBeNull();
  });

  it('a pointer press picks without taking the caret away', () => {
    const { field, type } = setup();
    type('@');
    const scout = screen.getAllByRole('option').find((o) => o.textContent?.includes('Scout'))!;
    const down = fireEvent.mouseDown(scout);
    expect(down).toBe(false); // default prevented: the field keeps focus
    expect(field.value).toBe('@scout ');
  });
});

describe('@ mentions in a room', () => {
  it('offers the members only', () => {
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Money week"
      mentions={[{ id: 'ledger', handle: 'ledger', name: 'Ledger' }, { id: 'postie', handle: 'postie', name: 'Postie' }]}
      team={{ agents: TEAM, selfId: '' }} />);
    fireEvent.change(screen.getByLabelText(/Message Money week/), { target: { value: '@' } });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('Ledger'), expect.stringContaining('Postie')]);
    expect(screen.getByText('In this room')).toBeInTheDocument();
    expect(screen.queryByText(/Agent Father/)).toBeNull();
  });
});

describe('the / menu', () => {
  it('opens at the start of the message with the chat’s commands, then the plugins’', () => {
    act(() => setPluginCommands([{ plugin: 'news', name: 'edition', description: 'Today’s edition, now' }]));
    const { type } = setup();
    type('/');
    const list = screen.getByRole('listbox', { name: 'Commands' });
    const names = within(list).getAllByRole('option').map((o) => o.querySelector('.cv-pop-cmd')?.textContent);
    expect(names).toEqual(['/use <agent>', '/new [what it is for]', '/stop', '/quiet [1d|1w|off]', '/edition']);
    expect(within(list).getByText('This chat')).toBeInTheDocument();
    expect(within(list).getByText('From News')).toBeInTheDocument();
    // Nothing runs, so /stop is there but off.
    expect(within(list).getAllByRole('option')[2]).toHaveAttribute('aria-disabled', 'true');
  });

  it('never opens later in a message', () => {
    const { type } = setup();
    type('look in /usr');
    expect(screen.queryByRole('listbox')).toBeNull();
    type('first line\n/');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says so when nothing matches, and Enter then sends it as text', () => {
    const { type, key, onSend } = setup();
    type('/sned');
    expect(screen.getByText(/No command called/)).toBeInTheDocument();
    key('Enter');
    expect(onSend).toHaveBeenCalledWith('/sned', []);
  });

  it('Enter on /use asks for the agent: the @ popup in Talk to mode, and picking one switches', () => {
    const { field, type, key, onCommand } = setup();
    type('/');
    key('Enter');
    expect(field.value).toBe('/use @');
    // The jsdom caret follows the value.
    fireEvent.select(field);
    expect(screen.getByText('Talk to')).toBeInTheDocument();
    expect(screen.queryByText('Agent Father')).not.toBeInTheDocument();
    key('ArrowDown');
    key('Enter');
    expect(onCommand).toHaveBeenCalledWith('use', 'ledger');
    expect(field.value).toBe('');
  });

  it('runs /quiet from the menu, and /quiet 1d typed whole, without sending anything', () => {
    const { field, type, key, onCommand, onSend } = setup();
    type('/q');
    key('Enter');
    expect(onCommand).toHaveBeenLastCalledWith('quiet', '');
    type('/quiet 1d');
    key('Enter');
    expect(onCommand).toHaveBeenLastCalledWith('quiet', '1d');
    expect(onSend).not.toHaveBeenCalled();
    expect(field.value).toBe('');
  });

  it('Tab puts a command in the box for words instead of running it', () => {
    const { field, type, key, onCommand } = setup();
    type('/ne');
    key('Tab');
    expect(field.value).toBe('/new ');
    expect(onCommand).not.toHaveBeenCalled();
    type('/new a plant tracker');
    key('Enter');
    expect(onCommand).toHaveBeenCalledWith('new', 'a plant tracker');
  });

  it('/stop runs while the agent works, and Esc in the box does the same', () => {
    const { type, key, onCommand, onStop } = setup({ running: true });
    type('/st');
    expect(screen.getByRole('option', { name: /\/stop/ })).not.toHaveAttribute('aria-disabled');
    key('Enter');
    expect(onCommand).toHaveBeenCalledWith('stop', '');
    key('Escape');
    expect(onStop).toHaveBeenCalled();
  });

  it('a plugin’s command is sent to the agent as the owner’s words', () => {
    act(() => setPluginCommands([{ plugin: 'news', name: 'edition', description: 'Today’s edition, now' }]));
    const { type, key, onSend, onCommand } = setup();
    type('/ed');
    key('Enter');
    expect(onSend).toHaveBeenCalledWith('/edition', []);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('is not there at all without a page to run the commands (Home)', () => {
    render(<Composer disabled={false} running={false} onSend={() => {}} onStop={() => {}} agentName="Buddi" slim />);
    fireEvent.change(screen.getByLabelText(/Message Buddi/), { target: { value: '/' } });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('the paint', () => {
  const styled = '# Reply to Ana\n@father make Postie **firmer** about *late* invoices.\nUse `drafts/late.md` and [the thread](https://mail.local/t/88).\n\n- Thank her for the prints\n- Ask for the invoice by **Friday**\n- ';

  it('is the value, character for character, styled', () => {
    const { type } = setup();
    type(styled);
    expect(paintText()).toBe(styled);
    const paint = screen.getByTestId('composer-paint');
    expect(paint).toHaveAttribute('aria-hidden', 'true');
    expect(paint.querySelector('[data-h] .cv-h')?.textContent).toBe('Reply to Ana');
    expect(paint.querySelector('.cv-b')?.textContent).toBe('**firmer**');
    expect(paint.querySelector('.cv-i')?.textContent).toBe('*late*');
    expect(paint.querySelector('.cv-code')?.textContent).toBe('`drafts/late.md`');
    expect(paint.querySelector('.cv-link')?.textContent).toBe('the thread');
    expect(paint.querySelectorAll('.cv-bullet')).toHaveLength(3);
  });

  it('draws a fenced block with its language, closed or still open', () => {
    const { type } = setup();
    const code = 'Why?\n```ts\nconst a = 1;\n\n```\n';
    type(code);
    expect(paintText()).toBe(code);
    const paint = screen.getByTestId('composer-paint');
    expect(paint.querySelector('[data-code="open"] .cv-lang')?.textContent).toBe('TypeScript');
    expect(paint.querySelectorAll('[data-code="body"]')).toHaveLength(2);
    expect(paint.querySelector('[data-code="close"]')).not.toBeNull();
    type('```py\nx = 1');
    expect(paint.querySelector('[data-code="open"]')).toHaveAttribute('data-unclosed', 'true');
    expect(paintText()).toBe('```py\nx = 1');
  });

  it('keeps every line, the empty ones and the trailing one included', () => {
    const { type } = setup();
    for (const value of ['', 'a', 'a\n', '\n\n', 'a\n\nb\n', '  - x\n  ']) {
      type(value);
      expect(paintText()).toBe(value);
    }
  });

  it('never changes a glyph’s advance: no cv rule on text sets a size, a face, a weight, spacing or padding', () => {
    // The paint and the textarea share one cell; the rules below are the ones that touch characters inside it.
    const css = readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, selector, body]) => ({ selector: selector!.trim(), body: body! }))
      .filter((r) => /\.cv-(code|b|i|h|mark|bullet|chip|link|link-md|code-ink|line|tail)\b/.test(r.selector) && !/cv-hint|cv-pop|cv-note|cv-lang/.test(r.selector));
    expect(rules.length).toBeGreaterThan(10);
    for (const rule of rules) {
      const props = rule.body.split(';').map((d) => d.split(':')[0]!.trim()).filter(Boolean);
      for (const prop of props) {
        expect([rule.selector, prop]).not.toEqual([rule.selector, expect.stringMatching(/^(font-size|font-weight|letter-spacing|word-spacing|padding.*|margin.*|border(-width)?|line-height|white-space)$/)]);
      }
      // Italic is the upright face slanted, never the italic face with its own widths.
      if (/font-style:\s*italic/.test(rule.body)) expect(rule.body).toMatch(/'DM Sans Upright'.*font-synthesis: style/s);
    }
    // The cell itself: the paint and the textarea are styled by one rule.
    expect(css).toMatch(/\.cv-field > \.cv-paint, \.cv-field > textarea \{[^}]*font-family: var\(--font-sans\); font-size: var\(--text-base\)[^}]*white-space: pre-wrap/);
  });
});

describe('lists in the box', () => {
  it('Enter carries the list on and an empty item ends it; nothing is sent', () => {
    const { field, type, key, onSend } = setup();
    type('- milk');
    key('Enter');
    expect(field.value).toBe('- milk\n- ');
    expect(screen.getByText(/Enter continues the list/)).toBeInTheDocument();
    key('Enter');
    expect(field.value).toBe('- milk\n');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('numbers on, and Tab / Shift+Tab indent the item', () => {
    const { field, type, key } = setup();
    type('1. flour');
    key('Enter');
    expect(field.value).toBe('1. flour\n2. ');
    key('Tab');
    expect(field.value).toBe('1. flour\n  2. ');
    key('Tab', { shiftKey: true });
    expect(field.value).toBe('1. flour\n2. ');
  });
});

describe('code blocks in the box', () => {
  it('Enter adds a line inside an open block; ⌘Enter sends', () => {
    const { type, key, onSend } = setup();
    type('```ts\nconst a = 1;');
    key('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText(/In a code block Enter adds a line/)).toBeInTheDocument();
    key('Enter', { metaKey: true });
    expect(onSend).toHaveBeenCalledWith('```ts\nconst a = 1;', []);
  });
});

describe('pastes', () => {
  const paste = (field: HTMLElement, text: string): boolean =>
    fireEvent.paste(field, { clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : ''), files: [] } });
  const code = 'export function dueDate(sent: Date, days = 14) {\n  const d = new Date(sent);\n  d.setDate(d.getDate() + days);\n  return d;\n}';

  it('fences pasted multi-line code, says so, and Undo puts it back as pasted', () => {
    const { field, type } = setup();
    type('Why does this skip weekends?');
    paste(field, code);
    expect(field.value).toBe(`Why does this skip weekends?\n\`\`\`ts\n${code}\n\`\`\`\n`);
    expect(screen.getByRole('status')).toHaveTextContent('Pasted as code · TypeScript');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(field.value).toBe(`Why does this skip weekends?${code}`);
    expect(screen.queryByText(/Pasted as code/)).toBeNull();
  });

  it('leaves prose and short pastes to the textarea', () => {
    const { field } = setup();
    expect(paste(field, 'Dear Ana,\nThursday works.\nSee you.')).toBe(true);
    expect(paste(field, 'a();')).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not fence a paste into a block already open', () => {
    const { field, type } = setup();
    type('```\n');
    expect(paste(field, code)).toBe(true);
  });

  it('turns a paste over 4,000 characters into a file at once, and Put it in the message takes it back', async () => {
    const uploads: File[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (body instanceof FormData) uploads.push(body.get('file') as File);
      return new Response(JSON.stringify({ artifactId: 'art-1', filename: 'pasted-text.txt', mime: 'text/plain', kind: 'document', sizeBytes: 5000 }), { status: 200 });
    }));
    const { field, type } = setup();
    type('Summarise what changed in this log');
    const long = 'line of the log\n'.repeat(320);
    paste(field, long);
    expect(field.value).toBe('Summarise what changed in this log');
    expect(screen.getByRole('status')).toHaveTextContent('Long paste, attached as a file');
    expect(await screen.findByText('pasted-text.txt')).toBeInTheDocument();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.name).toBe('pasted-text.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Put it in the message' }));
    expect(field.value).toBe(`Summarise what changed in this log${long}`);
    expect(screen.queryByText('pasted-text.txt')).toBeNull();
  });
});

describe('states that stay as they were', () => {
  it('a disabled box offers nothing and sends nothing', () => {
    const { field, type } = setup({ disabled: true });
    expect(field).toBeDisabled();
    type('@');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('while the agent works the box says so and still sends', () => {
    const { field, type, key, onSend } = setup({ running: true });
    expect(field).toHaveAttribute('placeholder', 'Postie is working…');
    type('and copy Marc on it');
    key('Enter');
    expect(onSend).toHaveBeenCalledWith('and copy Marc on it', []);
  });

  it('tells the owner what @ and / do in the empty box', () => {
    const { field } = setup();
    expect(field).toHaveAttribute('placeholder', 'Message Postie · @ to mention, / for commands');
  });
});

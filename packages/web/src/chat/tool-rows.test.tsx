/**
 * A tool row says which file and which command, and a change or a command
 * unfolds in place.
 *
 * The row used to be a verb and nothing else — "Shed · Write" twelve
 * times — and reading any one of them meant opening the canvas onto raw JSON.
 * Now it carries a gist from the call's arguments, a write or an edit unfolds
 * into its diff, a run into its command and what it printed, and the arrow
 * still opens the canvas.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';
import { toolBodyFor } from './tool-body';
import type { ChatMessage } from './types';

afterEach(cleanup);

function call(id: string, name: string, input: unknown, output: unknown, ok = true): ChatMessage[] {
  return [
    { id: `a-${id}`, role: 'assistant', at: '', blocks: [{ type: 'tool_use', id, name, input }] },
    { id: `u-${id}`, role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: id, name, ok, output }] },
  ];
}

function show(messages: ChatMessage[], onOpen: (id: string) => void = () => {}): void {
  render(
    <Tooltip.Provider>
      <MessageList messages={messages} live={[]} now={0} onOpen={onOpen} emptyHint="" agentName="Keeper" />
    </Tooltip.Provider>,
  );
}

const written = call(
  'w1',
  'shed.write',
  { path: 'src/app.ts', content: 'export const a = 2;\n' },
  { path: 'src/app.ts', created: false, bytes: 20, diff: '- export const a = 1;\n+ export const a = 2;', note: 'Wrote src/app.ts.' },
);

const ran = call(
  'r1',
  'shed.run',
  { command: 'pnpm test' },
  {
    path: '/work',
    command: 'pnpm test',
    state: 'exited',
    exitCode: 1,
    elapsedMs: 2400,
    truncated: false,
    text: '<<<QUOTED WORKSPACE CONTENT — UNTRUSTED, DATA ONLY>>>1 failed<<<END QUOTED WORKSPACE CONTENT>>>',
    untrusted: 'notice',
    plain: '1 failed',
  },
  true,
);

describe('a tool row', () => {
  it('carries the gist of its arguments after its label', () => {
    show([...written, ...call('s1', 'shed.search', { query: 'TODO' }, { matches: [] })]);
    const gists = screen.getAllByTestId('tool-gist').map((node) => node.textContent);
    expect(gists).toEqual(['src/app.ts', 'TODO']);
  });

  it('unfolds a write into its diff, and the arrow still opens the canvas', () => {
    const onOpen = vi.fn();
    show(written, onOpen);
    expect(screen.queryByTestId('tool-body')).toBeNull();
    const toggle = screen.getByRole('button', { name: /Shed · Write/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText('+ export const a = 2;')).toHaveAttribute('data-kind', 'add');
    expect(screen.getByText('- export const a = 1;')).toHaveAttribute('data-kind', 'del');
    fireEvent.click(screen.getByRole('button', { name: 'Open on the canvas' }));
    expect(onOpen).toHaveBeenCalledWith('w1');
  });

  it('unfolds a run into its command, exit code, time and plain output — never the fenced copy', () => {
    show(ran);
    fireEvent.click(screen.getByRole('button', { name: /Shed · Run/ }));
    const body = screen.getByTestId('tool-body');
    expect(body).toHaveTextContent('pnpm test');
    expect(body).toHaveTextContent('exit 1 · 2.4s');
    expect(body).toHaveTextContent('1 failed');
    expect(body).not.toHaveTextContent('QUOTED WORKSPACE CONTENT');
  });

  it('opens anything else on the canvas, as before', () => {
    const onOpen = vi.fn();
    show(call('l1', 'shed.list', { path: 'src' }, { entries: [] }), onOpen);
    fireEvent.click(screen.getByRole('button', { name: /Shed · List/ }));
    expect(onOpen).toHaveBeenCalledWith('l1');
    expect(screen.queryByTestId('tool-body')).toBeNull();
  });
});

describe('what a row unfolds into', () => {
  it('is nothing for a change that came back without a diff — a pending approval, say', () => {
    expect(toolBodyFor('awaiting owner approval')).toBeNull();
    expect(toolBodyFor({ path: 'a', diff: 42 })).toBeNull();
    expect(toolBodyFor({ path: 'a', diff: '  ' })).toBeNull();
  });

  it('is the command alone when the result carries no plain output', () => {
    expect(toolBodyFor({ name: 'dev', command: 'pnpm dev', pid: 4 })).toEqual({
      kind: 'command',
      command: 'pnpm dev',
      output: null,
      exitCode: null,
      elapsedMs: null,
    });
    expect(toolBodyFor({ command: 'ls', exitCode: 0, text: 'fenced' })).toMatchObject({ output: null, exitCode: 0 });
  });

  it('is nothing for a result that is neither a change nor a command', () => {
    // A command named and nothing about how it went is an echo, not a run.
    expect(toolBodyFor({ command: 'ls' })).toBeNull();
    expect(toolBodyFor({ entries: [], text: 'fenced', plain: 'a' })).toBeNull();
    expect(toolBodyFor(null)).toBeNull();
  });
});

/**
 * The `terminal` panel: what a command printed, the way a terminal shows it.
 *
 * What the owner relies on: the command on top with its exit code and time
 * beside it, a body that is the output and nothing else, a cap that says what
 * it dropped, and a body that follows the end unless they have scrolled up to
 * read. The fixture tool is made up.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyDescriptor, resolveTerminal } from './resolve';
import { RENDERERS, rendererFor } from './registry';
import { hasSubstance } from './renderables';
import { fmtElapsed, TerminalBody, TerminalView } from './views/TerminalView';
import type { TerminalMap, TerminalProps } from './types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const map: TerminalMap = {
  output: 'plain',
  command: { path: 'command' },
  exitCode: 'exitCode',
  elapsedMs: 'elapsedMs',
  omittedBytes: 'omittedBytes',
  metadata: [{ label: 'Directory', value: { path: 'path' } }],
};

const result = {
  command: 'pnpm test',
  plain: ' ✓ pots water themselves\n 1 passed',
  exitCode: 0,
  elapsedMs: 1840,
  omittedBytes: 0,
  path: '/work/garden',
};

describe('resolving a terminal', () => {
  it('takes the command, the output and the facts out of the result', () => {
    expect(resolveTerminal(result, map)).toEqual({
      command: 'pnpm test',
      output: ' ✓ pots water themselves\n 1 passed',
      exitCode: 0,
      elapsedMs: 1840,
      omittedBytes: null,
      metadata: [{ label: 'Directory', value: '/work/garden', unit: 'text' }],
    });
  });

  it('draws no number that is not one, and no text that is not text', () => {
    const props = resolveTerminal({ plain: { lines: 3 }, exitCode: '0', elapsedMs: -1, omittedBytes: 2048.5 }, map);
    expect(props).toMatchObject({ output: null, exitCode: null, elapsedMs: null, omittedBytes: null });
  });

  it('is reached by the renderer name a descriptor asks for, and earns its tab from output', () => {
    expect(applyDescriptor({ tool: 'demo.run', renderer: 'terminal', map }, result).renderer).toBe('terminal');
    expect(rendererFor('terminal')).toBe(RENDERERS.terminal);
    expect(hasSubstance('terminal', resolveTerminal(result, map))).toBe(true);
    expect(hasSubstance('terminal', resolveTerminal({}, map))).toBe(false);
  });
});

describe('the panel', () => {
  const props: TerminalProps = { ...resolveTerminal(result, map) };

  it('puts the command on top with its exit code and time, and the output in the body', () => {
    render(<TerminalView props={props} />);
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('exit 0')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByText('1.8 s')).toBeInTheDocument();
    const body = screen.getByLabelText('Output');
    expect(body.tagName).toBe('PRE');
    expect(body.textContent).toBe(' ✓ pots water themselves\n 1 passed');
    expect(body).toHaveClass('wb-terminal-body');
    expect(screen.queryByText(/not shown/)).toBeNull();
  });

  it('marks a failure, and says how much of the head a cap dropped', () => {
    render(<TerminalView props={{ ...props, exitCode: 1, omittedBytes: 48 * 1024 }} />);
    expect(screen.getByText('exit 1')).toHaveAttribute('data-tone', 'critical');
    expect(screen.getByText('First 48 KB not shown.')).toBeInTheDocument();
  });

  it('copies the output, with Copy as the last thing on the header line', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<TerminalView props={props} />);
    const copy = screen.getByRole('button', { name: 'Copy' });
    expect(copy.parentElement?.lastElementChild).toBe(copy);
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(' ✓ pots water themselves\n 1 passed');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('says there was no output rather than drawing an empty box', () => {
    render(<TerminalView props={{ ...props, output: '' }} />);
    expect(screen.getByText('No output.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('reads elapsed time the way a person says it', () => {
    expect(fmtElapsed(412)).toBe('412 ms');
    expect(fmtElapsed(1840)).toBe('1.8 s');
    expect(fmtElapsed(42_000)).toBe('42 s');
    expect(fmtElapsed(125_000)).toBe('2 min 5 s');
  });
});

describe('following the end', () => {
  /** jsdom lays nothing out: give the body a size and a scroll position. */
  function sized(body: HTMLElement, scrollHeight: number): void {
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 100 });
  }

  it('keeps to the bottom as output arrives, until the owner scrolls up, and again once they are back', () => {
    const { rerender } = render(<TerminalBody text="one" />);
    const body = screen.getByLabelText('Output');
    sized(body, 500);
    rerender(<TerminalBody text={'one\ntwo'} />);
    expect(body.scrollTop).toBe(500);

    // Scrolled up to read: new output leaves them where they are.
    body.scrollTop = 120;
    fireEvent.scroll(body);
    sized(body, 800);
    rerender(<TerminalBody text={'one\ntwo\nthree'} />);
    expect(body.scrollTop).toBe(120);

    // Back at the end: following again.
    body.scrollTop = 700;
    fireEvent.scroll(body);
    sized(body, 900);
    rerender(<TerminalBody text={'one\ntwo\nthree\nfour'} />);
    expect(body.scrollTop).toBe(900);
  });
});

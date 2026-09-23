/**
 * The `diff` panel: a change, with added and removed lines told apart.
 *
 * The properties worth a test are the ones the owner reads by colour: which
 * lines went in, which came out, and which are only the diff talking about
 * itself (a header, a hunk, a truncation). The same line renderer draws the
 * chat's inline rows, so these hold there too. The fixture tool is made up.
 */
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDescriptor, resolveDiff } from './resolve';
import { RENDERERS, rendererFor } from './registry';
import { hasSubstance } from './renderables';
import { diffLines } from './views/DiffLines';
import { DiffView } from './views/DiffView';
import type { DiffMap, ViewDescriptor } from './types';

afterEach(cleanup);

const map: DiffMap = {
  diff: 'change',
  title: { path: 'file' },
  metadata: [{ label: 'Bytes', value: { path: 'bytes' }, unit: 'number' }],
};

const unified = [
  'diff --git a/src/pot.ts b/src/pot.ts',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/src/pot.ts',
  '+++ b/src/pot.ts',
  '@@ -1,3 +1,3 @@',
  ' const soil = 1;',
  '-const water = 2;',
  '+const water = 3;',
  '--- not a header, a removed line that began with two dashes',
].join('\n');

describe('reading a diff line by line', () => {
  it('tells added, removed, hunk, header and context apart', () => {
    expect(diffLines(unified).map((line) => line.kind)).toEqual([
      'meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'del',
    ]);
  });

  it('reads the short form a file write reports, truncation included', () => {
    expect(diffLines('- old line\n+ new line\n… 12 more changed lines').map((line) => line.kind)).toEqual([
      'del', 'add', 'meta',
    ]);
    expect(diffLines('(no change)')[0]?.kind).toBe('meta');
  });
});

describe('resolving a diff', () => {
  it('takes the diff, the title and the facts out of the result', () => {
    expect(resolveDiff({ change: '+ a', file: 'src/pot.ts', bytes: 12 }, map)).toEqual({
      diff: '+ a',
      title: 'src/pot.ts',
      metadata: [{ label: 'Bytes', value: 12, unit: 'number' }],
    });
  });

  it('reads the diff as text or not at all', () => {
    expect(resolveDiff({ change: { lines: 3 } }, map).diff).toBeNull();
    expect(resolveDiff({ change: '   ' }, map).diff).toBeNull();
    expect(resolveDiff({}, map).diff).toBeNull();
  });

  it('is a renderer a descriptor can name, and earns the screen only with a diff', () => {
    expect(rendererFor('diff')).toBe(RENDERERS.diff);
    const descriptor: ViewDescriptor = { tool: 'shed.repaint', renderer: 'diff', map };
    expect(applyDescriptor(descriptor, { change: '+ a' })).toMatchObject({ renderer: 'diff', props: { diff: '+ a' } });
    expect(hasSubstance('diff', { diff: '+ a' })).toBe(true);
    expect(hasSubstance('diff', { diff: null })).toBe(false);
  });
});

describe('the diff panel', () => {
  it('draws each line with its kind, under the title and the facts', () => {
    render(<DiffView props={{ diff: unified, title: 'src/pot.ts', metadata: [{ label: 'Bytes', value: 12, unit: 'number' }] }} />);
    expect(screen.getByRole('heading', { name: 'src/pot.ts' })).toBeInTheDocument();
    expect(screen.getByText('Bytes')).toBeInTheDocument();
    const added = screen.getByText('+const water = 3;');
    expect(added).toHaveAttribute('data-kind', 'add');
    expect(screen.getByText('-const water = 2;')).toHaveAttribute('data-kind', 'del');
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toHaveAttribute('data-kind', 'hunk');
  });

  it('says so when there is no diff, rather than drawing an empty box', () => {
    render(<DiffView props={{ diff: null, title: null, metadata: [] }} />);
    expect(screen.getByText('This change came back with no diff.')).toBeInTheDocument();
  });
});

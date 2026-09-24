/**
 * The empty canvas promises only what this agent's own tools can draw.
 *
 * Every agent's empty canvas used to list the same three views — whatever the
 * installation had first — so an agent with no such tools promised a chart it
 * could never make. The fixture tools are made up.
 */
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { Canvas, examplesFor } from './Canvas';
import type { ViewDescriptor } from './types';

afterEach(cleanup);

const descriptors: ViewDescriptor[] = [
  { tool: 'ledger.balance', renderer: 'timeseries', title: 'Projected line', map: {} as never },
  { tool: 'ledger.accounts', renderer: 'table', title: 'Ledger rows', map: {} as never },
  { tool: 'ledger.split', renderer: 'bars', title: 'Split', map: {} as never },
  { tool: 'paint.make', renderer: 'image', title: 'Picture', map: {} as never },
  { tool: 'code.change', renderer: 'diff', title: 'Change', map: {} as never },
  { tool: 'code.change_again', renderer: 'diff', title: 'Another change', map: {} as never },
  { tool: 'code.run', renderer: 'terminal', title: 'Run', map: {} as never },
];

function empty(grantedTools?: string[]): void {
  render(
    <Canvas
      renderables={[]}
      activeId={null}
      onActivate={() => {}}
      timezone="UTC"
      descriptors={descriptors}
      {...(grantedTools ? { grantedTools } : {})}
    />,
  );
}

describe('the empty canvas', () => {
  it('names only what the agent’s granted tools draw', () => {
    empty(['paint.make', 'memory.note']);
    expect(screen.getByText('Things it can put here:')).toBeInTheDocument();
    expect(screen.getByText('Picture')).toBeInTheDocument();
    expect(screen.getByText('a picture')).toBeInTheDocument();
    expect(screen.queryByText('Projected line')).toBeNull();
  });

  it('lists nothing when none of its tools draws a view, or when it is not known whose canvas it is', () => {
    empty(['memory.note']);
    expect(screen.queryByText('Things it can put here:')).toBeNull();
    cleanup();
    empty();
    expect(screen.queryByText('Things it can put here:')).toBeNull();
  });

  it('prefers different shapes: a change and a run before a second change', () => {
    const titles = examplesFor(descriptors, ['code.change', 'code.change_again', 'code.run']).map((d) => d.title);
    expect(titles).toEqual(['Change', 'Run', 'Another change']);
  });
});

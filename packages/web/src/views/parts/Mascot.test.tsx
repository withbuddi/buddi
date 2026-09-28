import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Empty } from '../../ui';
import { Mascot, MascotProvider } from './Avatar';

it("draws the default agent's uploaded picture in the slot", () => {
  const { container } = render(
    <MascotProvider picture="/api/agents/concierge/avatar?v=1">
      <Mascot size="lg" />
    </MascotProvider>,
  );
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/agents/concierge/avatar?v=1');
});

it('draws nothing at all without an uploaded picture — no monogram, no placeholder', () => {
  const { container } = render(
    <MascotProvider picture={null}>
      <Mascot />
    </MascotProvider>,
  );
  expect(container.innerHTML).toBe('');
});

it('draws nothing once the picture fails to load', () => {
  render(
    <MascotProvider picture="/api/agents/concierge/avatar?v=2">
      <Mascot />
    </MascotProvider>,
  );
  fireEvent.error(screen.getByTestId('mascot').querySelector('img')!);
  expect(screen.queryByTestId('mascot')).toBeNull();
});

it('lets an empty state carry the mascot, and read the same without one', () => {
  const { rerender } = render(
    <MascotProvider picture="/p.png">
      <Empty mascot>Nothing scheduled.</Empty>
    </MascotProvider>,
  );
  expect(screen.getByTestId('mascot')).toBeTruthy();
  expect(screen.getByText('Nothing scheduled.')).toBeTruthy();
  rerender(
    <MascotProvider picture={undefined}>
      <Empty mascot>Nothing scheduled.</Empty>
    </MascotProvider>,
  );
  expect(screen.queryByTestId('mascot')).toBeNull();
  expect(screen.getByText('Nothing scheduled.')).toBeTruthy();
});

describe('the greeting face', () => {
  function motion(reduced: boolean): void {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: reduced && query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    // No loop to fetch: the Blob keeps its still, which is all these tests read.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  }
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("moves at once when the picture is buddi's own core still — no pixel glance", () => {
    motion(false);
    render(
      <MascotProvider picture="./mascot/core.png">
        <Mascot size="lg" anim="idle" />
      </MascotProvider>,
    );
    const blob = screen.getByTestId('blob');
    expect(blob).toHaveAttribute('data-state', 'idle');
    expect(blob.querySelector('img')?.getAttribute('src')).toBe('./mascot/core.png');
  });

  it("keeps the core still under reduced motion, and never swaps an owner's own photo before it is known", () => {
    motion(true);
    const { unmount } = render(
      <MascotProvider picture="./mascot/core.png">
        <Mascot size="lg" anim="idle" />
      </MascotProvider>,
    );
    expect(screen.queryByTestId('blob')).toBeNull();
    unmount();

    motion(false);
    render(
      <MascotProvider picture="/api/agents/concierge/avatar?v=3">
        <Mascot size="lg" anim="idle" />
      </MascotProvider>,
    );
    expect(screen.queryByTestId('blob')).toBeNull();
    expect(screen.getByTestId('mascot').querySelector('img')?.getAttribute('src')).toBe('/api/agents/concierge/avatar?v=3');
  });
});

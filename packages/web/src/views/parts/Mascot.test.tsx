import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
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

import { act, fireEvent, render, screen } from '@testing-library/react';
import { ActionMenu } from './index';

it('probe', async () => {
  render(<ActionMenu label="More" items={[{ label: 'Stop', onSelect: () => {} }]} />);
  const trigger = screen.getByRole('button', { name: 'More' });
  for (let i = 0; i < 2; i++) {
    const t0 = performance.now();
    await act(async () => { fireEvent.keyDown(trigger, { key: 'Enter' }); });
    console.log('open', i, Math.round(performance.now() - t0), !!screen.queryByText('Stop'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await act(async () => {});
  }
});

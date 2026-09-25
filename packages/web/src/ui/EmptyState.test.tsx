import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, EmptyState } from './index';
import { EmptyPiece } from '../pages/PluginPage';

describe('EmptyState', () => {
  it('says nothing is here as a neutral state: icon, title, one line, one action', () => {
    const { container } = render(
      <EmptyState icon="files" title="Nothing here yet" action={<Button>Add one</Button>}>
        Drop a file into any conversation and it shows up here too.
      </EmptyState>,
    );
    const root = container.querySelector('.ui-empty-state')!;
    expect(root).not.toBeNull();
    // Not a notice: no tone, no alert.
    expect(root.closest('.ui-notice')).toBeNull();
    expect(root.getAttribute('data-tone')).toBeNull();
    expect(root.getAttribute('role')).toBeNull();
    expect(root.querySelector('.ui-empty-state-icon svg[data-icon="files"]')).not.toBeNull();
    expect(root.querySelector('.ui-empty-state-title')?.textContent).toBe('Nothing here yet');
    expect(root.querySelector('.ui-empty-state-line')?.textContent).toBe('Drop a file into any conversation and it shows up here too.');
    expect(screen.getByRole('button', { name: 'Add one' })).toBeTruthy();
  });

  it('leaves out what it is not given', () => {
    const { container } = render(<EmptyState title="No reminders" />);
    expect(container.querySelector('.ui-empty-state-icon')).toBeNull();
    expect(container.querySelector('.ui-empty-state-line')).toBeNull();
    expect(container.querySelector('.ui-empty-state-action')).toBeNull();
  });

  it('turns a plugin page\'s empty sentence into a title and a line', () => {
    const { container } = render(<EmptyPiece text="No conversations yet. buddi builds them as mail arrives." />);
    expect(container.querySelector('.ui-empty-state-title')?.textContent).toBe('No conversations yet');
    expect(container.querySelector('.ui-empty-state-line')?.textContent).toBe('buddi builds them as mail arrives.');
    const { container: one } = render(<EmptyPiece text="Nothing here yet." />);
    expect(one.querySelector('.ui-empty-state-title')?.textContent).toBe('Nothing here yet');
  });
});

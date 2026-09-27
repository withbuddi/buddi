import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChipPicker } from './index';

const FEW = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
];
const MANY = [
  ...FEW,
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'ja', label: 'Japanese' },
];

function Harness({ options = FEW, initial = [], max, spy }: { options?: typeof FEW; initial?: string[]; max?: number; spy?: (v: string[]) => void }): JSX.Element {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <ChipPicker
      label="Languages"
      options={options}
      value={value}
      max={max}
      onChange={(next) => {
        spy?.(next);
        setValue(next);
      }}
    />
  );
}

const chips = (): string[] =>
  screen.queryAllByRole('button', { name: /^Remove / }).map((b) => b.getAttribute('aria-label')!.slice('Remove '.length));

describe('ChipPicker', () => {
  it('shows the chosen values as chips and takes one off with its ×', () => {
    const spy = vi.fn();
    render(<Harness initial={['fr', 'en']} spy={spy} />);
    expect(chips()).toEqual(['French', 'English']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove French' }));
    expect(spy).toHaveBeenLastCalledWith(['en']);
    expect(chips()).toEqual(['English']);
  });

  it('adds from a listbox of the options not yet chosen', () => {
    render(<Harness initial={['fr']} />);
    const add = screen.getByRole('button', { name: 'Add…' });
    expect(add).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(add);
    const list = screen.getByRole('listbox', { name: 'Languages' });
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['English', 'Spanish']);
    // Eight or fewer: no filter field.
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(within(list).getByRole('option', { name: 'Spanish' }));
    expect(chips()).toEqual(['French', 'Spanish']);
  });

  it('greys Add at the cap', () => {
    render(<Harness initial={['fr']} max={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    fireEvent.click(screen.getByRole('option', { name: 'English' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove English' }));
    expect(screen.getByRole('button', { name: 'Add…' })).toBeEnabled();
  });

  it('filters past eight options; Enter picks, Backspace on an empty filter removes, Escape closes', () => {
    render(<Harness options={MANY} initial={['fr']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    const filter = screen.getByRole('searchbox', { name: 'Filter Languages' });
    expect(filter).toHaveFocus();
    fireEvent.change(filter, { target: { value: 'ja' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Japanese']);
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(chips()).toEqual(['French', 'Japanese']);
    expect(filter).toHaveValue('');
    // Arrow down then Enter: the second remaining option.
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(chips()).toEqual(['French', 'Japanese', 'Spanish']);
    fireEvent.keyDown(filter, { key: 'Backspace' });
    expect(chips()).toEqual(['French', 'Japanese']);
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add…' })).toHaveFocus();
  });

  it('works from the listbox itself when there is no filter', () => {
    render(<Harness initial={['fr']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    const list = screen.getByRole('listbox');
    expect(list).toHaveFocus();
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(chips()).toEqual(['French', 'English']);
    fireEvent.keyDown(list, { key: 'Backspace' });
    expect(chips()).toEqual(['French']);
  });
});

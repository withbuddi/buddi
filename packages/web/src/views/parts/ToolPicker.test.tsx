/**
 * The tool picker. Fixtures are invented plugins (`orchard`, `shed`, `larder`)
 * so the tests need nothing installed and the page learns every distinction
 * from the data.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ToolPickerView } from '../../api';
import { grantFrom, ToolPicker } from './ToolPicker';

const tool = (name: string, description: string, extra: Partial<{ grantable: boolean; core: boolean; gated: boolean }> = {}) => ({
  name, description, tier: extra.gated ? 'gated' : 'auto', gated: extra.gated ?? false, grantable: extra.grantable ?? true, core: extra.core ?? false,
});

const view: ToolPickerView = {
  id: 'keeper',
  granted: ['larder.note', 'larder.recall', 'orchard.rows', 'orchard.forecast'],
  groups: [
    { plugin: 'larder', glob: 'larder.*', tools: [tool('larder.note', 'Write a note to remember.', { core: true }), tool('larder.recall', 'Find a note again.', { core: true })] },
    { plugin: 'orchard', glob: 'orchard.*', tools: [tool('orchard.rows', 'List the rows.'), tool('orchard.forecast', 'Project the harvest.')] },
    { plugin: 'shed', tools: [tool('shed.inventory', 'What is on the shelves.'), tool('shed.build', 'Make a new shed keeper.', { grantable: false })] },
  ],
  suggested: { plugin: 'orchard', label: 'Suggested by the orchard plugin since you accepted', tools: [{ name: 'shed.inventory', description: 'What is on the shelves.' }] },
};

function Harness({ initial, onChange }: { initial: string[]; onChange?: (next: string[]) => void }): JSX.Element {
  const [chosen, setChosen] = useState(initial);
  return <ToolPicker view={view} chosen={chosen} onChange={(next) => { setChosen(next); onChange?.(next); }} />;
}

/** Unfold the named groups, which all start folded. */
const unfold = (...plugins: string[]): void => {
  for (const plugin of plugins) fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${plugin} `) }));
};

describe('grantFrom', () => {
  it('saves a whole group as its glob and a partial one as names', () => {
    expect(grantFrom(view.groups, ['orchard.rows', 'orchard.forecast', 'larder.note'])).toEqual(['larder.note', 'orchard.*']);
  });
  it('never saves a glob the server did not offer', () => {
    expect(grantFrom(view.groups, ['shed.inventory', 'shed.build'])).toEqual(['shed.inventory', 'shed.build']);
  });
  it('round-trips: what was loaded, expanded, saves back to the same reach', () => {
    expect(grantFrom(view.groups, view.granted)).toEqual(['larder.*', 'orchard.*']);
  });
  it('keeps a grant it cannot draw', () => {
    expect(grantFrom(view.groups, ['gone.tool'])).toEqual(['gone.tool']);
  });
});

describe('the picker', () => {
  it('groups every installed tool by plugin, pre-checked from the grant', () => {
    render(<Harness initial={view.granted} />);
    unfold('orchard', 'shed');
    expect(screen.getByRole('group', { name: 'orchard' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'shed' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /orchard\.rows/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /shed\.inventory/ })).not.toBeChecked();
    expect(screen.getByText('List the rows.')).toBeInTheDocument();
  });

  it('filters by name or by description', () => {
    render(<Harness initial={[]} />);
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'harvest' } });
    expect(screen.getByRole('checkbox', { name: /orchard\.forecast/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /orchard\.rows/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'shed' })).toBeNull();
    fireEvent.change(search, { target: { value: 'shed.inv' } });
    expect(screen.getByRole('checkbox', { name: /shed\.inventory/ })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'nothing like it' } });
    expect(screen.getByText(/No installed tool matches/)).toBeInTheDocument();
  });

  it('checks and clears a whole plugin with all and none', () => {
    const onChange = vi.fn();
    render(<Harness initial={[]} onChange={onChange} />);
    unfold('orchard');
    fireEvent.click(screen.getByRole('button', { name: 'All orchard tools' }));
    expect(screen.getByRole('checkbox', { name: /orchard\.rows/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /orchard\.forecast/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'No orchard tools' }));
    expect(screen.getByRole('checkbox', { name: /orchard\.rows/ })).not.toBeChecked();
  });

  it('draws the agent-writing tools disabled, with the note, and all never checks them', () => {
    render(<Harness initial={[]} />);
    unfold('shed');
    const build = screen.getByRole('checkbox', { name: /shed\.build/ });
    expect(build).toBeDisabled();
    expect(screen.getByText(/Granted only by editing the file by hand/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All shed tools' }));
    expect(build).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /shed\.inventory/ })).toBeChecked();
  });

  it('tags core tools and asks once before removing one', () => {
    const onChange = vi.fn();
    render(<Harness initial={view.granted} onChange={onChange} />);
    unfold('larder');
    const note = screen.getByRole('checkbox', { name: /larder\.note/ });
    expect(within(screen.getByRole('group', { name: 'larder' })).getAllByText('core')).toHaveLength(2);
    fireEvent.click(note);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('This agent will not remember anything between conversations.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(note).toBeChecked();
    fireEvent.click(note);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(note).not.toBeChecked();
    expect(onChange).toHaveBeenCalledWith(['larder.recall', 'orchard.rows', 'orchard.forecast']);
  });

  it('offers the plugin\'s newer suggestions on top, one click each, applying none by itself', () => {
    render(<Harness initial={view.granted} />);
    const suggested = screen.getByRole('group', { name: 'Suggested by the orchard plugin since you accepted' });
    expect(within(suggested).getByRole('button', { name: 'Add shed.inventory' })).toBeVisible();
    unfold('shed');
    expect(screen.getByRole('checkbox', { name: /shed\.inventory/ })).not.toBeChecked();
    fireEvent.click(within(suggested).getByRole('button', { name: 'Add shed.inventory' }));
    expect(screen.getByRole('checkbox', { name: /shed\.inventory/ })).toBeChecked();
    expect(screen.queryByRole('group', { name: /Suggested by/ })).toBeNull();
  });

  it('is usable from the keyboard: checkboxes and search are focusable controls', () => {
    render(<Harness initial={[]} />);
    const search = screen.getByRole('searchbox');
    search.focus();
    expect(search).toHaveFocus();
    unfold('orchard');
    const rows = screen.getByRole('checkbox', { name: /orchard\.rows/ });
    rows.focus();
    expect(rows).toHaveFocus();
    expect(rows.tagName).toBe('INPUT');
  });

  it('starts with every group folded, the count in its header', () => {
    render(<Harness initial={['larder.note', 'orchard.rows', 'orchard.forecast']} />);
    for (const plugin of ['larder', 'orchard', 'shed']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${plugin} `) })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('group', { name: plugin })).not.toHaveAttribute('data-open');
    }
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: /^larder / })).toHaveTextContent('1 of 2 granted');
    // A whole group that saves as its glob says so.
    expect(screen.getByRole('button', { name: /^orchard / })).toHaveTextContent('all 2');
    // Nothing granted reads as a count, not as "all".
    expect(screen.getByRole('button', { name: /^shed / })).toHaveTextContent('0 of 2 granted');
    // all / none stay on the folded header.
    expect(screen.getByRole('button', { name: 'All shed tools' })).toBeEnabled();
  });

  it('toggles a group from its header, by click or by keyboard', () => {
    render(<Harness initial={[]} />);
    const head = screen.getByRole('button', { name: /^orchard / });
    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'orchard' })).toHaveAttribute('data-open', 'true');
    expect(screen.getByRole('checkbox', { name: /orchard\.rows/ })).toBeInTheDocument();
    fireEvent.click(head);
    expect(screen.queryByRole('checkbox', { name: /orchard\.rows/ })).toBeNull();
    // A native button: Enter and Space press it.
    expect(head.tagName).toBe('BUTTON');
    head.focus();
    expect(head).toHaveFocus();
  });

  it('unfolds the groups a search matches and folds them all when it clears', () => {
    render(<Harness initial={[]} />);
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'rows' } });
    expect(screen.getByRole('button', { name: /^orchard / })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('checkbox', { name: /orchard\.rows/ })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /orchard\.forecast/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'larder' })).toBeNull();
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: /^orchard / })).toHaveAttribute('aria-expanded', 'false');
  });
});

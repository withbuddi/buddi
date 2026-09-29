/**
 * The centred question (Modal), a sheet's foot, and a row's ⋯ menu: what
 * each is to a screen reader, and that a click in one never reaches the row
 * around it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { ActionMenu, Button, List, ListRow, Modal, Sheet } from './index';

describe('Modal', () => {
  it('is an alert dialog named by its title, with its buttons in the foot', () => {
    render(
      <Modal title="Disable finance?" onClose={vi.fn()} foot={<Button>Disable</Button>}>
        <p>Its data is kept.</p>
      </Modal>,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Disable finance?' });
    expect(dialog).toHaveClass('ui-modal');
    expect(dialog).toHaveTextContent('Its data is kept.');
    expect(screen.getByRole('button', { name: 'Disable' }).closest('.ui-modal-foot')).not.toBeNull();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Modal title="Remove it?" onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens over a sheet, and Escape closes only itself', () => {
    const closeSheet = vi.fn();
    const closeModal = vi.fn();
    const page = (asking: boolean): JSX.Element => (
      <>
        <Sheet title="finance" onClose={closeSheet} foot={<Button>Remove…</Button>}>
          <p>detail</p>
        </Sheet>
        {asking ? <Modal title="Remove finance?" onClose={closeModal} /> : null}
      </>
    );
    // The sheet is open first; the question is asked from it.
    const { rerender } = render(page(false));
    rerender(page(true));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(closeModal).toHaveBeenCalledOnce();
    expect(closeSheet).not.toHaveBeenCalled();
  });
});

describe('Sheet', () => {
  it('holds its actions in a foot after the content', () => {
    render(
      <Sheet title="finance" onClose={vi.fn()} foot={<Button>Update</Button>}>
        <p>detail</p>
      </Sheet>,
    );
    const foot = screen.getByRole('button', { name: 'Update' }).closest('.ui-sheet-foot');
    expect(foot).not.toBeNull();
    expect(foot?.previousElementSibling).toHaveTextContent('detail');
  });
});

describe('ActionMenu', () => {
  it('lists its actions behind ⋯, skips the empty ones, and keeps its clicks from the row', async () => {
    const details = vi.fn();
    const remove = vi.fn();
    const row = vi.fn();
    render(
      <List>
        <ListRow
          title="finance"
          onClick={row}
          side={
            <ActionMenu
              label="More for finance"
              items={[
                { label: 'Details', onSelect: details },
                null,
                false,
                { label: 'Disable…', hint: 'keeps its data', onSelect: vi.fn() },
                'separator',
                { label: 'Remove…', tone: 'critical', onSelect: remove },
              ]}
            />
          }
        />
      </List>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'More for finance' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Details', 'Disable…keeps its data', 'Remove…']);
    expect(items[2]).toHaveAttribute('data-tone', 'critical');
    expect(screen.getByRole('separator')).toHaveClass('ui-menu-sep');
    fireEvent.click(items[2] as HTMLElement);
    expect(remove).toHaveBeenCalledOnce();
    expect(details).not.toHaveBeenCalled();
    expect(row).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});

/**
 * The small pieces Settings → Plugins brought into the design system: a row
 * and a card that open their detail, a dimmed row, filter chips, a search
 * field, an app's face and a breadcrumb.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppIcon, Breadcrumb, Button, Card, FilterChips, List, ListRow, SearchField } from './index';

describe('ListRow', () => {
  it('opens its detail on a click or on Enter, and leaves the clicks of its controls alone', () => {
    const open = vi.fn();
    const act = vi.fn();
    render(
      <List>
        <ListRow
          title="finance"
          label="finance: details"
          onClick={open}
          side={
            <Button
              onClick={(event) => {
                event.stopPropagation();
                act();
              }}
            >
              Update
            </Button>
          }
        />
      </List>,
    );
    const row = screen.getByLabelText('finance: details');
    expect(row).toHaveAttribute('data-interactive', 'true');
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    // Enter on a control inside is that control's, not the row's.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Update' }), { key: 'Enter' });
    expect(act).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('dims a row that is off, and a plain row is neither clickable nor dimmed', () => {
    render(
      <List>
        <ListRow title="speech" dimmed side="disabled" />
        <ListRow title="calendar" />
      </List>,
    );
    const speech = screen.getByText('speech').closest('.ui-list-row');
    expect(speech).toHaveAttribute('data-dimmed', 'true');
    expect(speech).not.toHaveAttribute('tabindex');
    const calendar = screen.getByText('calendar').closest('.ui-list-row');
    expect(calendar).not.toHaveAttribute('data-dimmed');
    expect(calendar).not.toHaveAttribute('data-interactive');
  });
});

describe('Card', () => {
  it('opens on a click or Enter when given onClick, and is plain without it', () => {
    const open = vi.fn();
    render(
      <>
        <Card onClick={open} label="Weather: details">
          <p>The weather.</p>
        </Card>
        <Card title="Plain">
          <p>Nothing to open.</p>
        </Card>
      </>,
    );
    const card = screen.getByLabelText('Weather: details');
    expect(card).toHaveAttribute('data-interactive', 'true');
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: ' ' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Nothing to open.').closest('.ui-card')).not.toHaveAttribute('data-interactive');
  });
});

describe('FilterChips', () => {
  function Harness(): JSX.Element {
    const [value, setValue] = useState<'all' | 'money'>('all');
    return (
      <FilterChips
        label="Show"
        options={[
          { value: 'all', label: 'All' },
          { value: 'money', label: 'Money' },
        ]}
        value={value}
        onChange={setValue}
      />
    );
  }

  it('is a named group of toggles with the chosen one pressed', () => {
    render(<Harness />);
    expect(screen.getByRole('group', { name: 'Show' })).toHaveClass('ui-filter-chips');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Money' }));
    expect(screen.getByRole('button', { name: 'Money' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('SearchField', () => {
  it('is a named search box that says every keystroke', () => {
    const onChange = vi.fn();
    render(<SearchField grow label="Search plugins" value="" placeholder="weather, money…" onChange={onChange} />);
    const box = screen.getByRole('searchbox', { name: 'Search plugins' });
    expect(box).toHaveAttribute('placeholder', 'weather, money…');
    expect(box.closest('.ui-search')).toHaveAttribute('data-grow', 'true');
    fireEvent.change(box, { target: { value: 'wea' } });
    expect(onChange).toHaveBeenCalledWith('wea');
  });
});

describe('AppIcon', () => {
  it('draws a sanitised icon inline in the accent, and buddi\'s own on a quiet tile without one', () => {
    const { container } = render(
      <>
        <AppIcon svg={'<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3"></circle></svg>'} size="lg" />
        <AppIcon />
        <AppIcon icon="folder" />
      </>,
    );
    const [market, plug, folder] = [...container.querySelectorAll('.ui-app-icon')];
    expect(market).toHaveAttribute('data-tone', 'accent');
    expect(market).toHaveAttribute('data-size', 'lg');
    expect(market).toHaveAttribute('aria-hidden', 'true');
    expect(market?.querySelector('.ui-app-icon-svg circle')).not.toBeNull();
    expect(plug).not.toHaveAttribute('data-tone');
    expect(plug?.querySelector('svg')).toHaveAttribute('data-icon', 'plug');
    expect(folder?.querySelector('svg')).toHaveAttribute('data-icon', 'folder');
  });
});

describe('Breadcrumb', () => {
  it('links each step back, a chevron after it, and marks where you are', () => {
    const home = vi.fn();
    render(
      <Breadcrumb
        label="Folder"
        items={[
          { label: 'Home', onClick: home },
          { label: 'Settings', href: '#/settings' },
          { label: 'code', current: true },
        ]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Folder' });
    expect(nav.querySelectorAll('svg[data-icon="chevron-right"]')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(home).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '#/settings');
    expect(screen.getByText('code')).toHaveAttribute('aria-current', 'page');
  });

  it('can sit inside a title, as a span', () => {
    const { container } = render(
      <h2>
        <Breadcrumb inline items={[{ label: 'Settings', href: '#/settings' }]} />
      </h2>,
    );
    expect(container.querySelector('nav')).toBeNull();
    expect(container.querySelector('span.ui-crumbs')).not.toBeNull();
  });
});

/**
 * The `tiles` panel: a row of small cards, one per item, or the one card that
 * says the tool is not set up yet. The fixture tool is made up.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: { pages: vi.fn() } }));

import { api } from '../api';
import { resetPluginPageLinks } from '../pages/pageLinks';
import { applyDescriptor, resolveTiles } from './resolve';
import { rendererFor } from './registry';
import { hasSubstance } from './renderables';
import { Tiles } from './views/Tiles';
import type { TilesMap, ViewDescriptor } from './types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); resetPluginPageLinks(); });

const map: TilesMap = {
  items: 'daily',
  icon: { path: 'icon' },
  value: 'temps',
  label: 'weekday',
  lines: ['condition', 'rain', 'ignored'],
  tone: 'tone',
  empty: 'No days came back.',
  notice: { text: 'message', icon: 'cloud', link: { page: 'settings' } },
};

const output = {
  daily: [
    { icon: 'rain', temps: '64° / 55°', weekday: 'Tuesday', condition: 'Rain', rain: '80% · 0.4 in', ignored: 'x', tone: 'warning' },
    { icon: 'rocket', temps: '70° / 58°', weekday: 'Wednesday', condition: 'Clear', tone: 'loud' },
    { icon: 'sun' },
  ],
};

describe('tiles', () => {
  it('resolves one tile per item: pinned icons only, two lines at most, known tones only', () => {
    const props = resolveTiles(output, map, 'demo.forecast');
    expect(props.notice).toBe(false);
    expect(props.tiles).toHaveLength(2);
    expect(props.tiles[0]).toEqual({ icon: 'rain', value: '64° / 55°', label: 'Tuesday', lines: ['Rain', '80% · 0.4 in'], tone: 'warning', link: null });
    expect(props.tiles[1]!.icon).toBeNull();
    expect(props.tiles[1]!.tone).toBe('neutral');
    expect(resolveTiles({ daily: [] }, map).tiles).toEqual([]);
    const constant = resolveTiles({ events: [{ t: '09:30', title: 'Standup' }] }, { items: 'events', icon: { const: 'calendar' }, value: 't', label: 'title' });
    expect(constant.tiles[0]!.icon).toBe('calendar');
  });

  it('draws a list of cards, each read as one sentence, the unknown glyph as the dot', () => {
    const { renderer, props } = applyDescriptor({ tool: 'demo.forecast', renderer: 'tiles', map } as ViewDescriptor, output);
    expect(renderer).toBe('tiles');
    expect(hasSubstance('tiles', props)).toBe(true);
    const Component = rendererFor('tiles');
    render(<Component props={props as never} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Tuesday, 64° / 55°, Rain, 80% · 0.4 in');
    expect(items[0]!.querySelector('[data-icon="rain"]')).not.toBeNull();
    expect(items[1]!.querySelector('svg[data-icon="dot"]')).not.toBeNull();
  });

  it('says so when there is nothing', () => {
    render(<Tiles props={resolveTiles({ daily: [] }, map)} />);
    expect(screen.getByText('No days came back.')).toBeInTheDocument();
  });

  it('draws the one notice card, linking to the plugin page, and does not take the screen for it', async () => {
    vi.mocked(api.pages).mockResolvedValue({ pages: [{ plugin: 'demo', id: 'settings', title: 'Demo', place: 'settings', body: [] }] } as never);
    const props = resolveTiles({ linked: false, message: 'No calendar is linked yet.' }, map, 'demo.today');
    expect(props.notice).toBe(true);
    expect(props.tiles[0]!.link).toEqual({ plugin: 'demo', page: 'settings' });
    expect(hasSubstance('tiles', props)).toBe(false);
    render(<Tiles props={props} />);
    expect(screen.getByRole('listitem')).toHaveTextContent('No calendar is linked yet.');
    const link = await screen.findByRole('link', { name: 'Settings → Demo' });
    expect(link).toHaveAttribute('href', '#/settings/p.demo.settings');
  });

  it('draws no link to a page the plugin does not have', async () => {
    vi.mocked(api.pages).mockResolvedValue({ pages: [] } as never);
    render(<Tiles props={resolveTiles({ message: 'Not set up.' }, map, 'demo.today')} />);
    await waitFor(() => expect(api.pages).toHaveBeenCalled());
    expect(screen.queryByRole('link')).toBeNull();
  });
});

/** Home's glances: three at most, hidden ones left out, each a quiet link with a × that hides it. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api', () => ({ api: { setGlanceHidden: vi.fn() } }));

import { api, type HomeGlance } from '../../api';
import { HomeGlances, shownGlances } from './HomeGlances';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const glance = (id: string, extra: Partial<HomeGlance> = {}): HomeGlance => ({
  id, title: id, plugin: id.split('.')[0]!, icon: 'cloud', text: `text ${id}`, hidden: false, ...extra,
});

describe('HomeGlances', () => {
  it('shows the first three that are not hidden, in order', () => {
    const list = [glance('a.x'), glance('b.x', { hidden: true }), glance('c.x'), glance('d.x'), glance('e.x')];
    expect(shownGlances(list).map((g) => g.id)).toEqual(['a.x', 'c.x', 'd.x']);
    expect(shownGlances(undefined)).toEqual([]);
  });

  it('links to the plugin page and hides one on ×, remembering it on the server', async () => {
    vi.mocked(api.setGlanceHidden).mockResolvedValue({ id: 'weather.now', hidden: true });
    const navigate = vi.fn();
    const onChanged = vi.fn();
    render(
      <HomeGlances
        glances={[glance('weather.now', { text: '18°C Lyon', title: 'Weather at home', link: { plugin: 'weather', page: 'settings', place: 'settings' } }), glance('calendar.next')]}
        navigate={navigate}
        onChanged={onChanged}
      />,
    );
    const link = screen.getByRole('link', { name: '18°C Lyon' });
    expect(link).toHaveAttribute('href', '#/settings/p.weather.settings');
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('#/settings/p.weather.settings');
    expect(screen.getByText('text calendar.next')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Weather at home from Home' }));
    expect(screen.queryByText('18°C Lyon')).toBeNull();
    expect(api.setGlanceHidden).toHaveBeenCalledWith('weather.now', true);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('draws nothing when there is nothing to show', () => {
    const { container } = render(<HomeGlances glances={[glance('a.x', { hidden: true })]} navigate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

/** Home's glances: three at most, hidden ones left out, each a quiet link with a × that hides it. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api', () => ({ api: { setGlanceHidden: vi.fn() } }));

import { api, type HomeGlance } from '../../api';
import { HomeGlanceCard, HomeGlances, cardGlance, shownGlances, sparkPoints } from './HomeGlances';

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

  it('leaves the glance drawn as the card off the date line', () => {
    render(<HomeGlances glances={[glance('weather.now'), glance('calendar.next')]} navigate={() => {}} except="weather.now" />);
    expect(screen.queryByText('text weather.now')).toBeNull();
    expect(screen.getByText('text calendar.next')).toBeInTheDocument();
  });
});

const CARD = { value: '70°F', caption: 'Clear · Somerset', trend: { label: 'Next 12 hours', points: [70, 68, 65, 61] }, foot: 'High 74° · Low 58°' };

describe('HomeGlanceCard', () => {
  it('picks the first shown glance that sent a card', () => {
    expect(cardGlance([glance('a.x'), glance('b.x', { card: CARD, hidden: true }), glance('c.x', { card: CARD })])?.id).toBe('c.x');
    expect(cardGlance([glance('a.x')])).toBeNull();
    expect(cardGlance(undefined)).toBeNull();
  });

  it('draws the figure, the line, the sparkline and the foot, with the Blob, linking to the plugin page', () => {
    const navigate = vi.fn();
    render(
      <HomeGlanceCard
        glance={glance('weather.now', { title: 'Weather at home', icon: 'sun', card: CARD, link: { plugin: 'weather', page: 'weather', place: 'rail' } })}
        navigate={navigate}
        blob={<span data-testid="blob" />}
      />,
    );
    const card = screen.getByRole('group', { name: 'Weather at home' });
    expect(card).toHaveTextContent('70°F');
    expect(card).toHaveTextContent('Clear · Somerset');
    expect(card).toHaveTextContent('Next 12 hours');
    expect(card).toHaveTextContent('High 74° · Low 58°');
    expect(screen.getByTestId('spark')).toBeInTheDocument();
    expect(card).toContainElement(screen.getByTestId('blob'));
    fireEvent.click(screen.getByRole('link'));
    expect(navigate).toHaveBeenCalledWith('#/p/weather/weather');
  });

  it('leaves the Blob alone in its place once hidden', () => {
    vi.mocked(api.setGlanceHidden).mockResolvedValue({ id: 'weather.now', hidden: true });
    render(<HomeGlanceCard glance={glance('weather.now', { title: 'Weather at home', card: CARD })} navigate={() => {}} blob={<span data-testid="blob" />} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Weather at home from Home' }));
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByTestId('blob')).toBeInTheDocument();
    expect(api.setGlanceHidden).toHaveBeenCalledWith('weather.now', true);
  });

  it('puts the highest point at the top of the box and the lowest at the foot', () => {
    const [first, , last] = sparkPoints([10, 15, 20]);
    expect(first).toEqual([0, 22]);
    expect(last).toEqual([100, 2]);
    expect(sparkPoints([5, 5])[0]![1]).toBe(22);
  });
});

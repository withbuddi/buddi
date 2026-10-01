/** The clocks body: offsets and days across date lines and half-hour zones, day and night faces, reduced motion. */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClocksView, faceFacts, handAngles, offsetLabel, offsetWords } from './WidgetClocks';
import { WidgetBodyView } from './WidgetBody';

const NOON_UTC = new Date('2026-10-01T12:32:20Z');

function motion(reduce: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(((query: string) => ({
    matches: reduce && query.includes('reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('offsets, the owner’s way', () => {
  it('writes whole hours, half hours and quarter hours, ahead and behind', () => {
    expect(offsetLabel(360)).toBe('+6 h');
    expect(offsetLabel(-90)).toBe('−1 h 30');
    expect(offsetLabel(30)).toBe('+30 min');
    expect(offsetLabel(345)).toBe('+5 h 45');
    expect(offsetLabel(0)).toBe('Same time');
    expect(offsetWords(-360)).toBe('6 hours behind');
    expect(offsetWords(90)).toBe('1 hour 30 minutes ahead');
  });
});

describe('a face’s facts', () => {
  it('counts the day and the offset from the owner’s zone, across the date line', () => {
    // 21:30 in Lisbon (UTC+1 in October): Auckland is already tomorrow, Honolulu still today.
    const late = new Date('2026-10-01T20:30:00Z');
    const auckland = faceFacts(late, { label: 'Auckland', zone: 'Pacific/Auckland' }, 'Europe/Lisbon', false, '24h');
    expect(auckland).toMatchObject({ day: 'Tomorrow', offsetText: '+12 h', time: '09:30', daytime: true });
    expect(auckland.label).toBe('Auckland, 09:30 tomorrow, 12 hours ahead');
    // 01:00 in Tokyo: Lisbon is yesterday seen from Tokyo.
    const early = new Date('2026-10-01T16:00:00Z');
    expect(faceFacts(early, { label: 'Lisbon', zone: 'Europe/Lisbon' }, 'Asia/Tokyo', false)).toMatchObject({ day: 'Yesterday', offsetText: '−8 h' });
  });

  it('handles half-hour and three-quarter zones', () => {
    expect(faceFacts(NOON_UTC, { label: 'Mumbai', zone: 'Asia/Kolkata' }, 'Europe/Paris', false, '12h')).toMatchObject({ offsetText: '+3 h 30', time: '6:02 PM', day: 'Today', daytime: false });
    expect(faceFacts(NOON_UTC, { label: 'Kathmandu', zone: 'Asia/Kathmandu' }, 'Europe/Paris', false)).toMatchObject({ offsetText: '+3 h 45' });
    expect(faceFacts(NOON_UTC, { label: 'St. John’s', zone: 'America/St_Johns' }, 'Europe/Paris', false)).toMatchObject({ offsetText: '−4 h 30' });
  });

  it('is a day face from 6:00 to 18:00 there and a night face otherwise', () => {
    const at = (iso: string): boolean => faceFacts(new Date(iso), { label: 'UTC', zone: 'UTC' }, 'UTC', true).daytime;
    expect(at('2026-10-01T05:59:00Z')).toBe(false);
    expect(at('2026-10-01T06:00:00Z')).toBe(true);
    expect(at('2026-10-01T17:59:00Z')).toBe(true);
    expect(at('2026-10-01T18:00:00Z')).toBe(false);
  });

  it('calls the owner’s own face Here and reads it as your time', () => {
    const f = faceFacts(NOON_UTC, { label: 'Lyon', zone: 'Europe/Paris' }, 'Europe/Paris', true, '12h');
    expect(f.offsetText).toBe('Here');
    expect(f.label).toBe('Lyon, 2:32 PM, your time');
  });

  it('turns the hands, the second hand only when drawn', () => {
    expect(handAngles({ h: 15, m: 30, s: 0 }, false)).toEqual({ hour: 105, minute: 180, second: null });
    expect(handAngles({ h: 0, m: 0, s: 30 }, true)).toEqual({ hour: 0.25, minute: 3, second: 180 });
  });
});

describe('the faces', () => {
  const body = {
    kind: 'clocks' as const,
    home: 'Europe/Paris',
    time: '12h' as const,
    clocks: [
      { label: 'Lyon', zone: 'Europe/Paris' },
      { label: 'Ben', zone: 'America/New_York' },
      { label: 'Mumbai', zone: 'Asia/Kolkata' },
      { label: 'Tokyo', zone: 'Asia/Tokyo' },
    ],
  };

  it('draws four at medium and two at small, each named for a screen reader, light by day and dark at night', () => {
    vi.useFakeTimers({ now: NOON_UTC, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    motion(false);
    const { unmount } = render(<WidgetBodyView body={body} size="medium" />);
    const faces = screen.getAllByRole('img');
    expect(faces.map((f) => f.getAttribute('aria-label'))).toEqual([
      'Lyon, 2:32 PM, your time',
      'Ben, 8:32 AM, 6 hours behind',
      'Mumbai, 6:02 PM, 3 hours 30 minutes ahead',
      'Tokyo, 9:32 PM, 7 hours ahead',
    ]);
    expect(faces.map((f) => f.getAttribute('data-night'))).toEqual([null, null, 'true', 'true']);
    expect(faces[1]!.textContent).toBe('BenToday−6 h');
    unmount();
    render(<WidgetBodyView body={body} size="small" />);
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  it('ticks every second with a second hand, and under reduced motion moves once a minute without one', () => {
    vi.useFakeTimers({ now: NOON_UTC, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    motion(false);
    const { container, unmount } = render(<ClocksView body={body} size="small" />);
    expect(container.querySelectorAll('[data-testid="second-hand"]')).toHaveLength(2);
    const before = container.querySelector('[data-testid="second-hand"]')!.getAttribute('transform');
    act(() => { vi.advanceTimersByTime(1010); });
    expect(container.querySelector('[data-testid="second-hand"]')!.getAttribute('transform')).not.toBe(before);
    unmount();

    motion(true);
    const reduced = render(<ClocksView body={body} size="small" />);
    expect(reduced.container.querySelectorAll('[data-testid="second-hand"]')).toHaveLength(0);
    const label = (): string | null => screen.getAllByRole('img')[0]!.getAttribute('aria-label');
    expect(label()).toBe('Lyon, 2:32 PM, your time');
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(label()).toBe('Lyon, 2:32 PM, your time');
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(label()).toBe('Lyon, 2:33 PM, your time');
  });

  it('leaves out a face whose zone this browser does not know', () => {
    motion(false);
    render(<ClocksView body={{ ...body, clocks: [body.clocks[0]!, { label: 'Mars', zone: 'Mars/Olympus' }] }} size="small" />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });
});

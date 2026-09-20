import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Structured } from './Structured';
import { hostOf, shortUrl } from './Structured';

afterEach(cleanup);

// Assembled so no source file names a real host (the bundle rule).
const HTTPS = ['https', '://'].join('');
const url = (host: string, path = '') => `${HTTPS}${host}${path}`;

describe('rows that carry a link', () => {
  it('read as records: the title is the link, the host under it, the long text below', () => {
    render(<Structured props={{ value: { results: [
      { rank: 1, title: 'Guide to events', url: url('www.news.test', '/news/48877/guide'), source: 'www.news.test', snippet: 'A long description of the thing that happened, with more than forty characters in it.' },
      { rank: 2, title: 'Home', url: url('monitor.test'), source: 'monitor.test', snippet: 'Shellfish farmers warn overregulation could drive them out.' },
    ] } }} />);
    const links = screen.getAllByRole('link');
    expect(links[0]!.textContent).toBe('Guide to events');
    expect(links[0]!.getAttribute('href')).toBe(url('www.news.test', '/news/48877/guide'));
    expect(links[0]!.getAttribute('rel')).toContain('noopener');
    // The host is said once: the source column that repeats it is dropped, the rank stays.
    expect(screen.getByText('news.test')).toBeDefined();
    expect(screen.queryByText('www.news.test')).toBeNull();
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText(/A long description/)).toBeDefined();
    expect(document.querySelector('table')).toBeNull();
  });

  it('keeps a table when there is no title, but draws each URL as a short link', () => {
    render(<Structured props={{ value: { rows: [
      { amount: 12, url: url('shop.test', '/orders/1234567890/receipt?x=1') },
      { amount: 30, url: url('shop.test', '/orders/2') },
    ] } }} />);
    expect(document.querySelector('table')).not.toBeNull();
    const link = screen.getAllByRole('link')[0]!;
    expect(link.getAttribute('href')).toBe(url('shop.test', '/orders/1234567890/receipt?x=1'));
    expect(link.textContent!.length).toBeLessThanOrEqual(48);
    expect(link.textContent!.startsWith('shop.test/orders/')).toBe(true);
  });

  it('shortens honestly', () => {
    expect(hostOf(url('www.a.test', '/x'))).toBe('a.test');
    expect(shortUrl(url('a.test'))).toBe('a.test');
    expect(shortUrl(url('a.test', '/' + 'p'.repeat(80)), 20).endsWith('…')).toBe(true);
  });
});

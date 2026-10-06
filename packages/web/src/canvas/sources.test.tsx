/**
 * Sources: a turn's web reads and searches as one canvas tab.
 *
 * The page hands the canvas the names to gather (`chat/sources.ts`); this
 * package knows none, so the fixtures use invented ones. What is under test is
 * the grouping by turn — including while the turn is still streaming — and the
 * two shapes the panel draws: a page read and a search.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Canvas } from './Canvas';
import { renderablesFrom, sourcesHolding, type SourceEntry, type SourcesPanelProps } from './renderables';
import { SourcesView, sourceOf, sourcesSummary } from './views/SourcesView';
import type { ChatMessage } from '../chat/types';

afterEach(cleanup);

const GATHERED = new Set(['lens.fetch', 'lens.find']);
const AT = '2026-10-02T12:02:00Z';

const owner = (id: string, text: string): ChatMessage => ({ id, role: 'user', at: AT, blocks: [{ type: 'text', text }] });
const call = (id: string, name: string, input: unknown): ChatMessage => ({ id: `u-${id}`, role: 'assistant', at: AT, blocks: [{ type: 'tool_use', id, name, input }] });
const result = (id: string, name: string, output: unknown, ok = true, error?: unknown): ChatMessage => ({
  id: `r-${id}`, role: 'user', at: AT, blocks: [{ type: 'tool_result', toolUseId: id, name, ok, output, ...(error === undefined ? {} : { error }) }],
});

const page = (url: string, title: string, text: string, extra: Record<string, unknown> = {}) => ({
  ok: true, url, source: new URL(url).hostname.replace(/^www\./, ''), retrievedAt: AT, title, text, truncated: false, untrusted: '…', ...extra,
});
const search = (query: string, urls: string[]) => ({
  available: true, query, provider: 'Tavily', untrusted: '…', note: '…',
  results: urls.map((url, index) => ({ rank: index + 1, title: `Result ${index + 1}`, url, source: new URL(url).hostname, snippet: `Snippet ${index + 1}` })),
});

function turn(): ChatMessage[] {
  return [
    owner('o1', 'Compare three standing desks'),
    call('s1', 'lens.find', { query: 'standing desk review' }),
    result('s1', 'lens.find', search('standing desk review', ['https://www.rtings.com/desks/', 'https://theverge.com/v2', 'https://wired.com/e7', 'https://example.org/four'])),
    call('r1', 'lens.fetch', { url: 'https://rtings.com/desks' }),
    result('r1', 'lens.fetch', page('https://www.rtings.com/desks', 'The best standing desks', 'We tested thirty one desks for wobble.')),
    call('r2', 'lens.fetch', { url: 'https://wired.com/e7' }),
    result('r2', 'lens.fetch', { ok: false, url: 'https://wired.com/e7', source: 'wired.com', retrievedAt: AT, problem: 'timeout', message: 'that site did not answer in time', untrusted: '…' }),
  ];
}

describe('gathering by turn', () => {
  it('puts every web call of a turn in one Sources tab, not a tab each', () => {
    const tabs = renderablesFrom({ messages: turn(), descriptors: [], gathered: GATHERED });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ id: 'sources:s1', title: 'Sources', source: 'sources', renderer: 'sources', count: 3, substantial: true });
    expect((tabs[0]!.props as SourcesPanelProps).entries.map((entry) => entry.id)).toEqual(['s1', 'r1', 'r2']);
  });

  it('starts a new tab when the owner speaks again', () => {
    const messages = [...turn(), owner('o2', 'And the cheapest?'), call('r3', 'lens.fetch', { url: 'https://ikea.com/trotten' }), result('r3', 'lens.fetch', page('https://ikea.com/trotten', 'Trotten', 'A crank desk.'))];
    const tabs = renderablesFrom({ messages, descriptors: [], gathered: GATHERED });
    expect(tabs.map((tab) => [tab.id, tab.count])).toEqual([['sources:s1', 3], ['sources:r3', 1]]);
  });

  it('starts a new tab when the owner sends files alone', () => {
    const files: ChatMessage = {
      id: 'o2', role: 'user', at: AT,
      blocks: [{ type: 'attachment', artifactId: 'f1', filename: 'statement.csv', mime: 'text/csv', kind: 'document', sizeBytes: 10 }],
    };
    const messages = [...turn(), files, call('r3', 'lens.fetch', { url: 'https://ikea.com/trotten' }), result('r3', 'lens.fetch', page('https://ikea.com/trotten', 'Trotten', 'A crank desk.'))];
    const tabs = renderablesFrom({ messages, descriptors: [], gathered: GATHERED });
    expect(tabs.map((tab) => [tab.id, tab.count])).toEqual([['sources:s1', 3], ['sources:r3', 1]]);
  });

  it('keeps working while the turn streams: a call joins at once, its result lands in place', () => {
    const all = turn();
    // Only the search is back; the first read has been called, not answered.
    const streaming = renderablesFrom({ messages: all.slice(0, 4), descriptors: [], gathered: GATHERED });
    expect(streaming).toHaveLength(1);
    const entries = (streaming[0]!.props as SourcesPanelProps).entries;
    expect(entries.map((entry) => [entry.id, entry.ok])).toEqual([['s1', true], ['r1', null]]);
    expect(streaming[0]!.id).toBe('sources:s1');

    render(<SourcesView entries={entries} />);
    expect(screen.getByText('Reading rtings.com…')).toBeDefined();
    cleanup();

    const landed = renderablesFrom({ messages: all.slice(0, 5), descriptors: [], gathered: GATHERED });
    expect(landed[0]!.id).toBe('sources:s1');
    expect((landed[0]!.props as SourcesPanelProps).entries.map((entry) => entry.ok)).toEqual([true, true]);
  });

  it('a tab with only a pending call does not take the screen; all failures keep a red dot', () => {
    const pending = renderablesFrom({ messages: [owner('o', 'go'), call('r', 'lens.fetch', { url: 'https://a.test' })], descriptors: [], gathered: GATHERED });
    expect(pending[0]!.substantial).toBe(false);
    const failed = renderablesFrom({ messages: [owner('o', 'go'), call('r', 'lens.fetch', { url: 'https://a.test' }), result('r', 'lens.fetch', null, false, 'boom')], descriptors: [], gathered: GATHERED });
    expect(failed[0]).toMatchObject({ tone: 'critical', substantial: false });
  });

  it('draws a tab per call when nothing is gathered, as before', () => {
    const tabs = renderablesFrom({ messages: turn(), descriptors: [] });
    expect(tabs.some((tab) => tab.source === 'sources')).toBe(false);
  });

  it('finds the tab holding a call, for a click in the conversation', () => {
    const tabs = renderablesFrom({ messages: turn(), descriptors: [], gathered: GATHERED });
    expect(sourcesHolding(tabs, 'r2')?.id).toBe('sources:s1');
    expect(sourcesHolding(tabs, 'nope')).toBeNull();
  });
});

function entriesOf(messages = turn()): SourceEntry[] {
  return (renderablesFrom({ messages, descriptors: [], gathered: GATHERED })[0]!.props as SourcesPanelProps).entries;
}

describe('the page card', () => {
  it('links the title out safely and says where, when and how long', () => {
    render(<SourcesView entries={entriesOf()} timezone="UTC" />);
    const link = screen.getByRole('link', { name: /The best standing desks/ });
    expect(link.getAttribute('href')).toBe('https://www.rtings.com/desks');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText(/rtings\.com · read \S+( [AP]M)? · 7 words · 1 min read/)).toBeDefined();
  });

  it('opens on the text taken, with Show more and a quiet Raw JSON', () => {
    render(<SourcesView entries={entriesOf()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show what was read from rtings.com' }));
    const text = screen.getByText('We tested thirty one desks for wobble.');
    expect(text.getAttribute('data-clamped')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(text.getAttribute('data-clamped')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Raw JSON' })[0]!);
    expect(document.querySelector('.wb-src-raw')?.textContent).toContain('"retrievedAt"');
  });

  it('says a truncated page was only read from the start', () => {
    const messages = [owner('o', 'go'), call('r', 'lens.fetch', { url: 'https://a.test/x' }), result('r', 'lens.fetch', page('https://a.test/x', 'Long', 'Start of it.', { truncated: true }))];
    render(<SourcesView entries={entriesOf(messages)} focus="r" />);
    expect(screen.getByText(/Only the beginning of the page was read/)).toBeDefined();
  });

  it('draws a letter tile from the domain and loads nothing from another host', () => {
    const { container } = render(<SourcesView entries={entriesOf()} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.wb-src-tile')?.textContent).toBe('r');
  });

  it('never makes a link of anything but http and https', () => {
    const messages = [owner('o', 'go'), call('r', 'lens.fetch', { url: 'javascript:alert(1)' }), result('r', 'lens.fetch', page('https://a.test', 'x', 'y', { url: 'javascript:alert(1)' }))];
    render(<SourcesView entries={entriesOf(messages)} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('errors in plain words', () => {
  const failing = (problem: string, extra: Record<string, unknown> = {}) => sourceOf({
    id: 'x', tool: 'lens.fetch', input: { url: 'https://a.test/p' }, ok: true, at: AT,
    output: { ok: false, url: 'https://a.test/p', source: 'a.test', retrievedAt: AT, problem, message: 'raw words', ...extra },
  });

  it.each([
    ['blocked', /private network/],
    ['timeout', /Timed out/],
    ['not-found', /Page not found/],
    ['too-large', /Too large to read/],
    ['forbidden', /turned the reader away/],
  ])('%s', (problem, words) => {
    expect(failing(problem).why).toMatch(words);
  });

  it('falls back on the reader’s own sentence, then on the call’s error', () => {
    expect(failing('something-new').why).toBe('Raw words.');
    expect(sourceOf({ id: 'x', tool: 'lens.fetch', input: { url: 'https://a.test' }, output: null, ok: false, error: 'tool timed out', at: AT }).why)
      .toBe('The read failed: tool timed out');
  });

  it('shows a read whose text came back as binary garbage as a failure, not the garbage', () => {
    const garbage = '��t��j�@ E��\u0001�\u0002k�� ��x�\u0007 ����'.repeat(20);
    const entry: SourceEntry = { id: 'g', tool: 'lens.fetch', input: { url: 'https://www.amazon.com/dp/B0' }, ok: true, at: AT,
      output: page('https://www.amazon.com/dp/B0', 'Amazon', garbage) };
    expect(sourceOf(entry)).toMatchObject({ state: 'failed', text: null, why: 'The page came back unreadable.' });
    render(<SourcesView entries={[entry]} />);
    expect(screen.getByText('Couldn’t read amazon.com')).toBeDefined();
    expect(screen.queryByText(/��/)).toBeNull();
    // Ordinary prose, accents and all, is left alone.
    expect(sourceOf({ ...entry, output: page('https://a.test/p', 'Café', 'Le café coûte 3 € — très bon, déjà servi à Paris.') }).state).toBe('ok');
  });

  it('heads a failed page with the site it could not read', () => {
    render(<SourcesView entries={entriesOf()} />);
    expect(screen.getByText('Couldn’t read wired.com')).toBeDefined();
    expect(screen.getByText(/Timed out — the site didn’t answer in time/)).toBeDefined();
  });
});

describe('the search card', () => {
  it('shows the query, the results linked, and marks the ones read this turn', () => {
    render(<SourcesView entries={entriesOf()} />);
    expect(screen.getByText('“standing desk review”')).toBeDefined();
    expect(screen.getByText('Tavily · 4 results')).toBeDefined();
    const results = document.querySelectorAll('.wb-src-result');
    expect(results).toHaveLength(3);
    // Read under another spelling of the same URL; the timed-out one is not read.
    expect(within(results[0] as HTMLElement).queryByText('Read')).not.toBeNull();
    expect(within(results[2] as HTMLElement).queryByText('Read')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 4' }));
    expect(document.querySelectorAll('.wb-src-result')).toHaveLength(4);
  });

  it('says plainly when search is not set up, or found nothing', () => {
    const off = sourceOf({ id: 's', tool: 'lens.find', input: { query: 'q' }, output: { available: false, query: 'q', results: [] }, ok: true, at: AT });
    expect(off).toMatchObject({ state: 'failed', why: expect.stringMatching(/isn’t set up/) });
    const none = [owner('o', 'go'), call('s', 'lens.find', { query: 'q' }), result('s', 'lens.find', search('q', []))];
    render(<SourcesView entries={entriesOf(none)} />);
    expect(screen.getByText('No results.')).toBeDefined();
  });

  it('summarises the turn for the panel head', () => {
    expect(sourcesSummary({ entries: entriesOf() })).toBe('1 search · 2 pages');
  });
});

describe('on the canvas', () => {
  it('draws one Sources tab with its count and the panel', () => {
    const renderables = renderablesFrom({ messages: turn(), descriptors: [], gathered: GATHERED });
    render(<Canvas renderables={renderables} activeId={null} onActivate={() => {}} timezone="UTC" />);
    const tab = screen.getByRole('tab', { name: /Sources/ });
    expect(within(tab).getByText('3')).toBeDefined();
    expect(screen.getByText('1 search · 2 pages')).toBeDefined();
    expect(screen.getByText('Couldn’t read wired.com')).toBeDefined();
  });
});

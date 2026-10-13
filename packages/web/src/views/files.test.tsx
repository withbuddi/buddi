/**
 * Files: the route, the table parser, and the list drawn from the API.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Files, parseDelimited } from './Files';
import { fileRoute, parseFileRoute, placeOf, FILES_ROUTE } from '../routes';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the files route', () => {
  it('is its own place with a stable per-file address', () => {
    expect(placeOf('#/files')).toBe(FILES_ROUTE);
    expect(placeOf('#/files/abc')).toBe(FILES_ROUTE);
    expect(fileRoute('a-1')).toBe('#/files/a-1');
    expect(parseFileRoute('#/files')).toEqual({ filters: {} });
    expect(parseFileRoute('#/files/a-1')).toEqual({ artifactId: 'a-1', filters: {} });
    expect(fileRoute(null, { q: 'tax', family: 'pdf' })).toBe('#/files?q=tax&family=pdf');
    expect(parseFileRoute('#/files?q=tax&family=pdf')).toEqual({ filters: { q: 'tax', family: 'pdf' } });
    expect(parseFileRoute('#/chat/x')).toBeNull();
  });
});

describe('the table parser', () => {
  it('respects quotes, embedded newlines and doubled quotes, and never evaluates', () => {
    const { rows } = parseDelimited('a,b\n"x, with comma","line\nbreak"\n"say ""hi""",=SUM(1)\n', ',', 100, 100);
    expect(rows).toEqual([['a', 'b'], ['x, with comma', 'line\nbreak'], ['say "hi"', '=SUM(1)']]);
  });
  it('stops at the row and column limits and says so', () => {
    const text = Array.from({ length: 10 }, (_, i) => `${i},${i},${i}`).join('\n');
    const out = parseDelimited(text, ',', 3, 2);
    expect(out.rows).toHaveLength(3);
    expect(out.rows[0]).toEqual(['0', '0']);
    expect(out.truncatedRows).toBe(true);
    expect(out.truncatedCols).toBe(true);
    // Exactly at the limit with nothing after it is not truncated.
    expect(parseDelimited('a\nb\nc\n', ',', 3, 5).truncatedRows).toBe(false);
  });
});

describe('the library page', () => {
  it('lists files newest first with origin and kind, and opens one by its route', async () => {
    const entries = [
      { id: 'f1', filename: 'report.pdf', mime: 'application/pdf', family: 'pdf', sizeBytes: 2048, createdAt: '2026-09-20T10:00:00Z', origin: 'produced', agentId: 'ledger', deleted: false, contexts: 2, context: { agentId: 'ledger', groupName: null } },
      { id: 'f2', filename: 'photo.png', mime: 'image/png', family: 'image', sizeBytes: 100, createdAt: '2026-09-19T10:00:00Z', origin: 'uploaded', agentId: null, deleted: false, contexts: 1, context: null },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/f1')) return new Response(JSON.stringify({ entry: entries[0], contexts: [{ conversationId: 'c1', kind: 'produced', agentId: 'ledger', conversationAgentId: 'ledger', groupId: null, groupName: null, at: '2026-09-20T10:00:00Z' }], contextsTotal: 1, contextsOffset: 0, available: true }), { status: 200 });
      return new Response(JSON.stringify({ entries, next: null }), { status: 200 });
    }));
    const navigate = vi.fn();
    const agents = [{ id: 'ledger', handle: 'ledger', name: 'Ledger', description: '', available: true, roles: [], provider: 'openai', model: 'm' }];
    render(<Tooltip.Provider><Files hash="#/files/f1" timezone="UTC" navigate={navigate} agents={agents} attention={{} as never} /></Tooltip.Provider>);
    await waitFor(() => expect(screen.getAllByText('report.pdf').length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Made by Ledger/).length).toBeGreaterThan(0);
    expect(screen.getByText(/You sent it/)).toBeDefined();
    // The selected file's detail: a download, and a way back to the conversation.
    await waitFor(() => expect(screen.getByRole('link', { name: 'Download' })).toBeDefined());
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe('/api/artifacts/f1/download');
    expect(screen.getByRole('link', { name: 'Open conversation' }).getAttribute('href')).toBe('#/chat/ledger/c1');
  });
});

describe('a file with versions', () => {
  const V = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;
  const entry = (id: string) => ({ id, filename: 'packing.md', mime: 'text/markdown', family: 'text', sizeBytes: 20, createdAt: '2026-10-13T10:00:00Z', origin: 'produced', agentId: 'ledger', deleted: false, contexts: 1, context: null, versions: 3 });
  const versions = [
    { id: V(3), filename: 'packing.md', createdAt: '2026-10-13T10:00:00Z', sizeBytes: 30, sha256: '3'.repeat(64), createdBy: 'ledger', editedAt: '2026-10-13T11:00:00Z' },
    { id: V(2), filename: 'packing.md', createdAt: '2026-10-13T09:00:00Z', sizeBytes: 20, sha256: '2'.repeat(64), createdBy: 'ledger', editedAt: null },
    { id: V(1), filename: 'packing.md', createdAt: '2026-10-13T08:00:00Z', sizeBytes: 10, sha256: '1'.repeat(64), createdBy: 'ledger', editedAt: null },
  ];
  const agents = [{ id: 'ledger', handle: 'ledger', name: 'Ledger', description: '', available: true, roles: [], provider: 'openai', model: 'm' }];
  const serve = (calls: Array<{ url: string; init?: RequestInit }>) => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const one = /^\/api\/artifacts\/([0-9a-f-]{36})$/.exec(url);
    if (one) return new Response(JSON.stringify({ entry: entry(one[1]!), contexts: [], contextsTotal: 0, contextsOffset: 0, available: true, versions }), { status: 200 });
    if (url.endsWith(`/${V(1)}/content`) && !init?.method) return new Response(JSON.stringify({ text: '# v1\n', sha256: '1'.repeat(64), sizeBytes: 5, editable: true, truncated: false }), { status: 200 });
    if (url.endsWith('/content') && init?.method === 'PUT') return new Response(JSON.stringify({ sha256: '4'.repeat(64), sizeBytes: 5 }), { status: 200 });
    if (url.includes('/preview') || url.endsWith('/content')) return new Response(JSON.stringify({ text: '# now\n', sha256: '3'.repeat(64), sizeBytes: 6, editable: true, truncated: false }), { status: 200 });
    return new Response(JSON.stringify({ entries: [entry(V(3))], next: null }), { status: 200 });
  });

  it('lists as one row with its version count, and its page lists the versions', async () => {
    vi.stubGlobal('fetch', serve([]));
    render(<Tooltip.Provider><Files hash={`#/files/${V(3)}`} timezone="UTC" navigate={vi.fn()} agents={agents} attention={{} as never} /></Tooltip.Provider>);
    expect(await screen.findByText(/· 3 versions/)).toBeDefined();
    const section = await screen.findByRole('region', { name: 'Versions' });
    expect(section.querySelectorAll('li')).toHaveLength(3);
    expect(section.textContent).toContain('Ledger, edited by you');
    expect(screen.queryByText('Not the latest version.')).toBeNull();
  });

  it('says an older version is not the latest, and Restore saves its text over the newest', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', serve(calls));
    const navigate = vi.fn();
    render(<Tooltip.Provider><Files hash={`#/files/${V(2)}`} timezone="UTC" navigate={navigate} agents={agents} attention={{} as never} /></Tooltip.Provider>);
    expect(await screen.findByText('Not the latest version.')).toBeDefined();
    screen.getByRole('button', { name: 'Open latest' }).click();
    expect(navigate).toHaveBeenCalledWith(`#/files/${V(3)}`);
    const section = await screen.findByRole('region', { name: 'Versions' });
    const oldest = [...section.querySelectorAll('li')].at(-1)!;
    (oldest.querySelector('button') as HTMLButtonElement).click();
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.init?.method === 'PUT')!;
    expect(put.url).toBe(`/api/artifacts/${V(3)}/content`);
    expect(JSON.parse(String(put.init!.body))).toEqual({ text: '# v1\n', base: '3'.repeat(64) });
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith(`#/files/${V(3)}`));
  });
});

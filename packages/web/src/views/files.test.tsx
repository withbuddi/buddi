/**
 * Files: the route, the table parser, and the list drawn from the API.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Toast from '@radix-ui/react-toast';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Files, parseDelimited } from './Files';
import { fileRoute, parseFileRoute, placeOf, FILES_ROUTE } from '../routes';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the files route', () => {
  it('is its own place with a stable per-file address', () => {
    expect(placeOf('#/files')).toBe(FILES_ROUTE);
    expect(placeOf('#/files/abc')).toBe(FILES_ROUTE);
    expect(fileRoute('a-1')).toBe('#/files/a-1');
    expect(fileRoute('a-1', {}, 2)).toBe('#/files/a-1?v=2');
    expect(parseFileRoute('#/files')).toEqual({ filters: {} });
    expect(parseFileRoute('#/files/a-1')).toEqual({ fileId: 'a-1', filters: {} });
    expect(parseFileRoute('#/files/a-1?v=2')).toEqual({ fileId: 'a-1', version: 2, filters: {} });
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
      { id: 'v1', fileId: 'f1', version: 1, versions: 1, filename: 'report.pdf', mime: 'application/pdf', family: 'pdf', sizeBytes: 2048, createdAt: '2026-09-20T10:00:00Z', origin: 'produced', agentId: 'ledger', deleted: false, contexts: 2, context: { agentId: 'ledger', groupName: null } },
      { id: 'f2', fileId: 'file-2', version: 1, versions: 1, filename: 'photo.png', mime: 'image/png', family: 'image', sizeBytes: 100, createdAt: '2026-09-19T10:00:00Z', origin: 'uploaded', agentId: null, deleted: false, contexts: 1, context: null },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/files/f1')) return new Response(JSON.stringify({ file: { id: 'f1' }, current: { version: 1, artifactId: 'v1' }, versions: [], entry: entries[0], contexts: [{ conversationId: 'c1', kind: 'produced', agentId: 'ledger', conversationAgentId: 'ledger', groupId: null, groupName: null, at: '2026-09-20T10:00:00Z' }], contextsTotal: 1, contextsOffset: 0, available: true }), { status: 200 });
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
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe('/api/artifacts/v1/download');
    expect(screen.getByRole('link', { name: 'Open conversation' }).getAttribute('href')).toBe('#/chat/ledger/c1');
  });
});

describe('a file with versions', () => {
  const V = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;
  const FILE = 'f0000000-0000-4000-8000-000000000000';
  const entry = (id: string) => ({ id, fileId: FILE, version: Number(id[7]), filename: 'packing.md', mime: 'text/markdown', family: 'text', sizeBytes: 20, createdAt: '2026-10-13T10:00:00Z', origin: 'produced', agentId: 'ledger', deleted: false, contexts: 1, context: null, versions: 3 });
  const versions = [
    { id: V(3), version: 3, filename: 'packing.md', createdAt: '2026-10-13T10:00:00Z', sizeBytes: 30, sha256: '3'.repeat(64), createdBy: 'owner', restoredFrom: null },
    { id: V(2), version: 2, filename: 'packing.md', createdAt: '2026-10-13T09:00:00Z', sizeBytes: 20, sha256: '2'.repeat(64), createdBy: 'ledger', restoredFrom: null },
    { id: V(1), version: 1, filename: 'packing.md', createdAt: '2026-10-13T08:00:00Z', sizeBytes: 10, sha256: '1'.repeat(64), createdBy: 'ledger', restoredFrom: null },
  ];
  const agents = [{ id: 'ledger', handle: 'ledger', name: 'Ledger', description: '', available: true, roles: [], provider: 'openai', model: 'm' }];
  const serve = (calls: Array<{ url: string; init?: RequestInit }>, versionsAnswer: (body: unknown) => Response = () => new Response(JSON.stringify({ fileId: FILE, version: 4, artifactId: V(4), sha256: '4'.repeat(64), createdBy: 'owner', sizeBytes: 10, created: true }), { status: 200 })) => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url === `/api/files/${FILE}/versions`) return versionsAnswer(JSON.parse(String(init!.body)));
    const one = /^\/api\/files\/([0-9a-f-]{36})(?:\?version=(\d+))?$/.exec(url);
    if (one) {
      const shown = one[2] ? versions.find((v) => v.version === Number(one[2]))! : versions[0]!;
      return new Response(JSON.stringify({ file: { id: FILE, name: 'packing.md' }, current: { fileId: FILE, version: 3, artifactId: V(3) }, versions, entry: entry(shown.id), contexts: [], contextsTotal: 0, contextsOffset: 0, available: true }), { status: 200 });
    }
    if (url.includes('/preview')) return new Response('# now', { status: 200 });
    return new Response(JSON.stringify({ entries: [entry(V(3))], next: null }), { status: 200 });
  });

  it('lists as one row with its version count, and its page lists the versions with their authors', async () => {
    vi.stubGlobal('fetch', serve([]));
    render(<Tooltip.Provider><Files hash={`#/files/${FILE}`} timezone="UTC" navigate={vi.fn()} agents={agents} attention={{} as never} /></Tooltip.Provider>);
    expect(await screen.findByText(/· 3 versions/)).toBeDefined();
    const section = await screen.findByRole('region', { name: 'Versions' });
    expect(section.querySelectorAll('li')).toHaveLength(3);
    expect(section.textContent).toContain('v3 · Newest');
    expect(section.textContent).toContain('You');
    expect(section.textContent).toContain('Ledger');
    expect(screen.queryByText(/is not the newest version/)).toBeNull();
  });

  it('says an older version is not the newest, and Restore as newest copies it on the server', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', serve(calls));
    const navigate = vi.fn();
    render(<Tooltip.Provider><Files hash={`#/files/${FILE}?v=2`} timezone="UTC" navigate={navigate} agents={agents} attention={{} as never} /></Tooltip.Provider>);
    expect(await screen.findByText('v2 is not the newest version (v3 is).')).toBeDefined();
    screen.getByRole('button', { name: 'Open newest' }).click();
    expect(navigate).toHaveBeenCalledWith(`#/files/${FILE}`);
    const section = await screen.findByRole('region', { name: 'Versions' });
    const oldest = [...section.querySelectorAll('li')].at(-1)!;
    fireEvent.click([...oldest.querySelectorAll('button')].find((button) => button.textContent === 'Restore as newest')!);
    await waitFor(() => expect(calls.some((call) => call.url === `/api/files/${FILE}/versions`)).toBe(true));
    const post = calls.find((call) => call.url === `/api/files/${FILE}/versions`)!;
    // Its bytes, by number: never a preview's text.
    expect(JSON.parse(String(post.init!.body))).toEqual({ base: 3, from: 1 });
    // The address stays the file's: the newest is what the Restore made.
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith(`#/files/${FILE}`));
  });

  it('says a version was made by a program, and shows that program read-only', async () => {
    const composed = versions.map((v) => (v.version === 3 ? v : { ...v, composed: true }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/files/${FILE}/versions/2/source`) return new Response(JSON.stringify({ fileId: FILE, version: 2, artifactId: V(2), kind: 'docx', library: 'docx', libraryVersion: '9.8.1', nodeVersion: '26.11.1', program: "import { Document } from 'docx';", createdAt: null }), { status: 200 });
      if (url.startsWith(`/api/files/${FILE}`)) return new Response(JSON.stringify({ file: { id: FILE, name: 'packing.md' }, current: { fileId: FILE, version: 3, artifactId: V(3) }, versions: composed, entry: entry(V(2)), contexts: [], contextsTotal: 0, contextsOffset: 0, available: true }), { status: 200 });
      if (url.includes('/preview')) return new Response('# now', { status: 200 });
      return new Response(JSON.stringify({ entries: [entry(V(3))], next: null }), { status: 200 });
    }));
    render(<Tooltip.Provider><Files hash={`#/files/${FILE}?v=2`} timezone="UTC" navigate={vi.fn()} agents={agents} attention={{} as never} /></Tooltip.Provider>);
    expect(await screen.findByText('Made by a program')).toBeDefined();
    const section = await screen.findByRole('region', { name: 'Versions' });
    expect(section.textContent).toContain('Ledger with a program');
    fireEvent.click(screen.getByRole('button', { name: 'View program' }));
    expect((await screen.findByLabelText('Program')).textContent).toBe("import { Document } from 'docx';");
  });

  it('opens an old link naming a version’s id at its file’s address', async () => {
    const navigate = vi.fn();
    vi.stubGlobal('fetch', serve([]));
    render(<Tooltip.Provider><Files hash={`#/files/${V(2)}`} timezone="UTC" navigate={navigate} agents={agents} attention={{} as never} /></Tooltip.Provider>);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`#/files/${FILE}?v=2`, true));
  });

  it('offers the editor’s choice when a newer version was saved before the Restore', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let first = true;
    vi.stubGlobal('fetch', serve(calls, () => {
      if (!first) return new Response(JSON.stringify({ fileId: FILE, version: 5, artifactId: V(5), sha256: '5'.repeat(64), createdBy: 'owner', sizeBytes: 10, created: true }), { status: 200 });
      first = false;
      return new Response(JSON.stringify({ error: 'This file changed since you opened it: v4 is newer.', conflict: 'newer', current: { fileId: FILE, version: 4, artifactId: V(4), sha256: '4'.repeat(64), createdBy: 'ledger' } }), { status: 409 });
    }));
    const navigate = vi.fn();
    render(<Tooltip.Provider><Files hash={`#/files/${FILE}`} timezone="UTC" navigate={navigate} agents={agents} attention={{} as never} /></Tooltip.Provider>);
    const section = await screen.findByRole('region', { name: 'Versions' });
    fireEvent.click([...[...section.querySelectorAll('li')].at(-1)!.querySelectorAll('button')].find((button) => button.textContent === 'Restore as newest')!);
    expect(await screen.findByText(/This file changed since you opened it \(v4 is newer\)/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(calls.filter((call) => call.url === `/api/files/${FILE}/versions`)).toHaveLength(2));
    const posts = calls.filter((call) => call.url === `/api/files/${FILE}/versions`).map((call) => JSON.parse(String(call.init!.body)));
    expect(posts).toEqual([{ base: 3, from: 1 }, { base: 4, from: 1 }]);
  });

  it('answers a Restore refused for a changed workspace copy the same way, Keep mine writing over it', async () => {
    // Codex P2: a workspace conflict on Restore had no way out.
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let first = true;
    vi.stubGlobal('fetch', serve(calls, () => {
      if (!first) return new Response(JSON.stringify({ fileId: FILE, version: 4, artifactId: V(4), sha256: '4'.repeat(64), createdBy: 'owner', sizeBytes: 10, created: true }), { status: 200 });
      first = false;
      return new Response(JSON.stringify({ error: 'This file changed since you opened it: a command changed its copy in buddi’s workspace.', conflict: 'workspace', current: { fileId: FILE, version: 3, artifactId: V(3), sha256: '3'.repeat(64), createdBy: 'owner' }, workspaceText: '# there\n' }), { status: 409 });
    }));
    render(<Tooltip.Provider><Files hash={`#/files/${FILE}`} timezone="UTC" navigate={vi.fn()} agents={agents} attention={{} as never} /></Tooltip.Provider>);
    const section = await screen.findByRole('region', { name: 'Versions' });
    fireEvent.click([...[...section.querySelectorAll('li')].at(-1)!.querySelectorAll('button')].find((button) => button.textContent === 'Restore as newest')!);
    expect(await screen.findByText(/a command changed its copy in buddi’s workspace/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(calls.filter((call) => call.url === `/api/files/${FILE}/versions`)).toHaveLength(2));
    const posts = calls.filter((call) => call.url === `/api/files/${FILE}/versions`).map((call) => JSON.parse(String(call.init!.body)));
    expect(posts).toEqual([{ base: 3, from: 1 }, { base: 3, from: 1, overwriteWorkspace: true }]);
  });
});

describe('deleting a file', () => {
  const V = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;
  const FILE = 'f0000000-0000-4000-8000-000000000000';
  const entry = { id: V(2), fileId: FILE, version: 2, filename: 'packing.md', mime: 'text/markdown', family: 'text', sizeBytes: 20, createdAt: '2026-10-13T10:00:00Z', origin: 'produced', agentId: 'ledger', deleted: false, contexts: 1, context: null, versions: 2 };
  const versions = [
    { id: V(2), version: 2, filename: 'packing.md', createdAt: '2026-10-13T10:00:00Z', sizeBytes: 20, sha256: '2'.repeat(64), createdBy: 'ledger', restoredFrom: null },
    { id: V(1), version: 1, filename: 'packing.md', createdAt: '2026-10-13T09:00:00Z', sizeBytes: 10, sha256: '1'.repeat(64), createdBy: 'ledger', restoredFrom: null },
  ];
  it('asks first, deletes every version, goes back to the list and offers Undo', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ fileId: FILE }), { status: 200 });
      if (url === `/api/files/${FILE}/undelete`) return new Response(JSON.stringify({ fileId: FILE, restored: true }), { status: 200 });
      if (/^\/api\/files\/[0-9a-f-]{36}$/.test(url)) return new Response(JSON.stringify({ file: { id: FILE }, current: { fileId: FILE, version: 2, artifactId: V(2) }, entry, contexts: [], contextsTotal: 0, contextsOffset: 0, available: true, versions }), { status: 200 });
      if (url.includes('/preview')) return new Response('# packing', { status: 200 });
      return new Response(JSON.stringify({ entries: [entry], next: null }), { status: 200 });
    }));
    const navigate = vi.fn();
    const agents = [{ id: 'ledger', handle: 'ledger', name: 'Ledger', description: '', available: true, roles: [], provider: 'openai', model: 'm' }];
    render(<Toast.Provider><Tooltip.Provider><Files hash={`#/files/${FILE}`} timezone="UTC" navigate={navigate} agents={agents} attention={{} as never} /></Tooltip.Provider><Toast.Viewport /></Toast.Provider>);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    await user.click(await screen.findByRole('button', { name: 'More for packing.md' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete file/ }));
    const prompt = await screen.findByRole('alertdialog', { name: 'Delete this file?' });
    expect(prompt.textContent).toContain('Delete packing.md and its 2 versions? Conversations that used it will show it as deleted.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url === `/api/files/${FILE}`)).toBe(true));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/files'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls.some((call) => call.url === `/api/files/${FILE}/undelete` && call.body === '{}')).toBe(true));
  }, 30_000);

  it('deletes one version from the list of versions', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') { calls.push(url); return new Response(JSON.stringify({ fileId: FILE, version: 1, fileDeleted: false }), { status: 200 }); }
      if (/^\/api\/files\/[0-9a-f-]{36}$/.test(url)) return new Response(JSON.stringify({ file: { id: FILE }, current: { fileId: FILE, version: 2, artifactId: V(2) }, entry, contexts: [], contextsTotal: 0, contextsOffset: 0, available: true, versions }), { status: 200 });
      if (url.includes('/preview')) return new Response('# packing', { status: 200 });
      return new Response(JSON.stringify({ entries: [entry], next: null }), { status: 200 });
    }));
    render(<Toast.Provider><Tooltip.Provider><Files hash={`#/files/${FILE}`} timezone="UTC" navigate={vi.fn()} agents={[]} attention={{} as never} /></Tooltip.Provider><Toast.Viewport /></Toast.Provider>);
    const section = await screen.findByRole('region', { name: 'Versions' });
    const older = [...section.querySelectorAll('li')].at(-1)!;
    fireEvent.click([...older.querySelectorAll('button')].find((button) => button.textContent === 'Delete version')!);
    await waitFor(() => expect(calls).toEqual([`/api/files/${FILE}/versions/1`]));
  });
});

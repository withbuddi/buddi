/**
 * The agents' downloads area and what `browser.act` says about a download
 * (docs/browser.md, "Downloads"). No browser and no database: the driver hands
 * a stream, and Files is a fake that records what it was given.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost, hostBindingOf, type CoreToolContext } from '@buddi/core/testing';
import { DownloadRefused, DownloadStore, downloadMime, downloadName, downloadSource, type PendingDownload } from './downloads.js';
import { BrowserService, type DownloadReport } from './service.js';
import { commandSchema, type BrowserDriver, type Observation } from './types.js';

const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const dirs: string[] = [];
const services: BrowserService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-downloads-'));
  dirs.push(dir);
  return dir;
}

const CSV = 'Date,Description,Amount\n2026-09-01,Coffee,-3.20\n';
const streamed = (body: string | Buffer, extra: Partial<PendingDownload> = {}): PendingDownload => ({
  filename: 'transactions.csv', url: 'https://bank.example/export?token=secret', read: { stream: async () => Readable.from([Buffer.from(body)]) }, ...extra,
});

describe('the downloads area', () => {
  it('saves under <agent>/<day>/, never executable, with a clean name and its type', async () => {
    const root = path.join(await scratch(), 'downloads');
    const store = new DownloadStore(root, { now: () => Date.parse('2026-10-05T09:00:00Z') });
    const saved = await store.save('cfo', streamed(CSV));
    expect(saved.path).toBe(path.join(root, 'cfo', '2026-10-05', 'transactions.csv'));
    expect(await readFile(saved.path, 'utf8')).toBe(CSV);
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    expect(saved).toMatchObject({ filename: 'transactions.csv', size: CSV.length, mime: 'text/csv' });
    // The same name again the same day is a second file, not an overwrite.
    expect((await store.save('cfo', streamed('other'))).filename).toBe('transactions (2).csv');
    expect(downloadName('../../etc/.passwd')).toBe('passwd');
    expect(downloadName('')).toBe('download');
    expect(downloadMime('x.bin', 'text/csv; charset=utf-8')).toBe('text/csv');
    expect(downloadMime('statement.pdf', 'application/octet-stream')).toBe('application/pdf');
    expect(downloadSource('https://bank.example/export?token=secret#x')).toBe('https://bank.example/export');
  });

  it('refuses a file over the per-file cap, and an agent over its cap, leaving nothing behind', async () => {
    const root = path.join(await scratch(), 'downloads');
    const store = new DownloadStore(root, { fileCap: 10, agentCap: 30 });
    await expect(store.save('cfo', streamed('x'.repeat(11)))).rejects.toThrow(/most agents may download per file/);
    await expect(store.save('cfo', streamed('x', { size: 11 }))).rejects.toBeInstanceOf(DownloadRefused);
    await store.save('cfo', streamed('x'.repeat(10), { filename: 'a.csv' }));
    await store.save('cfo', streamed('x'.repeat(10), { filename: 'b.csv' }));
    await store.save('cfo', streamed('x'.repeat(10), { filename: 'c.csv' }));
    await expect(store.save('cfo', streamed('y', { filename: 'd.csv' }))).rejects.toThrow(/downloads area is full .* Settings → Browser/);
    // Another agent has its own room.
    await expect(store.save('scout', streamed('y'))).resolves.toMatchObject({ size: 1 });
    const usage = await store.usage();
    expect(usage).toMatchObject({ bytes: 31, files: 4, fileCap: 10, agentCap: 30 });
    expect(usage.agents.map((a) => [a.agent, a.files])).toEqual([['cfo', 3], ['scout', 1]]);
    // Nothing partial from the refusals: only the three that fitted.
    const files = (await readdir(path.join(root, 'cfo'), { recursive: true })).filter((name) => name.endsWith('.csv')).map((name) => path.basename(name));
    expect(files.sort()).toEqual(['a.csv', 'b.csv', 'c.csv']);
    expect((await store.clear()).files).toBe(0);
  });

  it('sweeps days older than the retention, on its own clock', async () => {
    const root = path.join(await scratch(), 'downloads');
    let now = Date.parse('2026-09-01T12:00:00Z');
    const store = new DownloadStore(root, { now: () => now });
    await store.save('cfo', streamed(CSV));
    now = Date.parse('2026-09-30T12:00:00Z');
    await store.save('cfo', streamed(CSV, { filename: 'september.csv' }));
    now = Date.parse('2026-10-02T12:00:00Z');
    expect(await store.sweep()).toBe(1);
    expect(await readdir(path.join(root, 'cfo'))).toEqual(['2026-09-30']);
    now = Date.parse('2026-11-01T12:00:00Z');
    expect(await store.sweep()).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('reads a Chrome download only from the owner’s home, freshly written, the size Chrome said, not a link', async () => {
    const home = await scratch();
    const now = Date.now();
    const store = new DownloadStore(path.join(home, 'buddi-data', 'downloads'), { homeDir: path.join(home, 'owner'), now: () => now });
    await mkdir(path.join(home, 'owner', 'Downloads'), { recursive: true });
    const file = path.join(home, 'owner', 'Downloads', 'statement.csv');
    await writeFile(file, CSV);
    const chrome = (extra: Partial<PendingDownload> = {}): PendingDownload => ({ filename: 'statement.csv', url: 'https://bank.example/x', read: { path: file }, size: CSV.length, ...extra });
    expect(await readFile((await store.save('cfo', chrome())).path, 'utf8')).toBe(CSV);
    await expect(store.save('cfo', chrome({ size: 3 }))).rejects.toThrow(/could not be read/);
    await expect(store.save('cfo', chrome({ read: { path: path.join(home, 'elsewhere.csv') } }))).rejects.toThrow(/could not be read/);
    await expect(store.save('cfo', chrome({ read: { path: 'Downloads/statement.csv' } }))).rejects.toThrow(/could not be read/);
    const old = new Date(now - 60 * 60 * 1000);
    await utimes(file, old, old);
    await expect(store.save('cfo', chrome())).rejects.toThrow(/could not be read/);
  });
});

describe('browser.act and a download', () => {
  const observation: Observation = { id: 'o1', url: 'https://bank.example/accounts', title: 'Accounts', tree: '- link "Export CSV"', tabs: [], capturedAt: new Date().toISOString() };
  const navigate = commandSchema.parse({ action: 'navigate', url: 'https://bank.example/accounts' });
  const click = commandSchema.parse({ action: 'click', target: { ref: 'e1' } });

  async function setup(limits: { fileCap?: number } = {}) {
    let now = Date.parse('2026-10-05T09:00:00Z');
    const root = path.join(await scratch(), 'downloads');
    const store = new DownloadStore(root, { now: () => now, ...limits });
    const pending: PendingDownload[] = [];
    const driver: BrowserDriver = { start: vi.fn(async () => {}), perform: vi.fn(async () => {}), observe: vi.fn(async () => observation),
      screenshot: vi.fn(async () => undefined), close: vi.fn(async () => {}), takeDownloads: () => pending.splice(0) };
    const service = new BrowserService(driver, { downloads: store, now: () => now, sleep: async () => {} });
    services.push(service);
    await service.enable();
    const saved: Array<{ bytes: Buffer; mime: string; filename?: string; caption?: string; source?: unknown }> = [];
    const facts: CoreToolContext = { db: {} as never, ownerId: 'owner', now: () => new Date(now), timezone: 'UTC', agentId: 'cfo', conversationId: 'c1',
      sessionTools: ['browser.act'], ownerRequest: { id: 'r1', text: 'Get my transactions', expiresAt: Date.now() + 60_000 },
      provenance: () => ({ runId: 'run-7', turn: 1, step: 1, sources: [] }) };
    const host = createPluginHost(BROWSER_HOST, facts);
    const files = {
      async save(input: { bytes: Buffer; mime: string; filename?: string; caption?: string; source?: unknown }) {
        saved.push(input);
        return { id: '11111111-2222-4333-8444-555555555555', kind: 'document', mime: input.mime, filename: input.filename ?? null, sizeBytes: input.bytes.length,
          sha256: 'x', caption: input.caption ?? null, createdBy: 'cfo', createdAt: new Date(now).toISOString(), conversationId: null } as never;
      },
      get: async () => null, read: async () => Buffer.alloc(0), list: async () => [],
    };
    const ctx = { ...facts, buddi: { ...host, files } } as CoreToolContext;
    return { service, ctx, pending, saved, store, root, advance: (ms: number) => { now += ms; } };
  }

  it('lands as an artifact the agent can pass on, tagged with the agent, the run and where it came from; swept later', async () => {
    const { service, ctx, pending, saved, store, root, advance } = await setup();
    await service.execute(navigate, ctx);
    pending.push(streamed(CSV));
    const result = await service.execute(click, ctx) as { completed: boolean; downloads: DownloadReport[]; message: string };
    expect(result.completed).toBe(true);
    expect(result.downloads).toEqual([{ artifactId: '11111111-2222-4333-8444-555555555555', name: 'transactions.csv', size: CSV.length, type: 'text/csv' }]);
    expect(result.message).toMatch(/artifact 11111111-2222-4333-8444-555555555555\. To import it, pass that id to the owning plugin's import tool/);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.bytes.toString()).toBe(CSV);
    expect(saved[0]).toMatchObject({ mime: 'text/csv', filename: 'transactions.csv', caption: 'Downloaded from bank.example',
      source: { surface: 'browser', chatId: 'run-7', messageId: 'https://bank.example/export' } });
    expect(await readdir(path.join(root, 'cfo', '2026-10-05'))).toEqual(['transactions.csv']);
    // Thirty days on, the landing copy is gone; Files keeps its own.
    advance(31 * 24 * 60 * 60 * 1000);
    expect(await store.sweep()).toBe(1);
    expect((await store.usage()).files).toBe(0);
  });

  it('refuses over the cap and says why, and the page action still counts', async () => {
    const { service, ctx, pending, saved } = await setup({ fileCap: 8 });
    await service.execute(navigate, ctx);
    pending.push(streamed(CSV));
    const result = await service.execute(click, ctx) as { completed: boolean; downloads: DownloadReport[]; message: string };
    expect(result.completed).toBe(true);
    expect(result.downloads).toEqual([{ name: 'transactions.csv', refused: expect.stringMatching(/most agents may download per file/) }]);
    expect(result.message).toMatch(/The download transactions\.csv was refused/);
    expect(saved).toHaveLength(0);
  });
});

/**
 * The agents' downloads area and what `browser.act` says about a download
 * (docs/browser.md, "Downloads"). No browser and no database: the driver hands
 * a stream, and Files is a fake that records what it was given.
 */
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost, hostBindingOf, type CoreToolContext } from '@buddi/core/testing';
import { DownloadRefused, DownloadStore, downloadMime, downloadName, downloadSource, watchTransfer, type PendingDownload } from './downloads.js';
import { BrowserService, type DownloadReport } from './service.js';
import { commandSchema, type BrowserDriver, type Observation } from './types.js';
import { applySettingsChange, settingsSchema } from './settings.js';

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

  it('reads a Chrome download only from Chrome’s download folder, resolved whole: no symlinked folder, no dot-folder, not buddi’s data', async () => {
    const home = await scratch();
    const now = Date.now();
    const owner = path.join(home, 'owner');
    const data = path.join(owner, 'Downloads', 'buddi-data');
    const store = new DownloadStore(path.join(data, 'downloads'), { homeDir: owner, dataDir: data, now: () => now });
    await mkdir(path.join(owner, 'Downloads', '.hidden'), { recursive: true });
    await mkdir(path.join(owner, '.ssh'), { recursive: true });
    await mkdir(path.join(data, 'secrets'), { recursive: true });
    await writeFile(path.join(owner, '.ssh', 'id_ed25519'), CSV);
    await writeFile(path.join(owner, 'Downloads', '.hidden', 'x.csv'), CSV);
    await writeFile(path.join(data, 'secrets', 'key'), CSV);
    await writeFile(path.join(owner, 'notes.csv'), CSV);
    // A folder inside Downloads that is a link out of it: lexically inside, really not.
    await symlink(path.join(owner, '.ssh'), path.join(owner, 'Downloads', 'keys'));
    const chrome = (file: string): PendingDownload => ({ filename: path.basename(file), url: 'https://bank.example/x', read: { path: file }, size: CSV.length });
    for (const file of [
      path.join(owner, 'Downloads', 'keys', 'id_ed25519'),
      path.join(owner, 'Downloads', '.hidden', 'x.csv'),
      path.join(data, 'secrets', 'key'),
      path.join(owner, 'notes.csv'),
      path.join(owner, 'Downloads', '..', 'notes.csv'),
    ]) await expect(store.save('cfo', chrome(file)), file).rejects.toThrow(/could not be read from your Downloads folder/);

    // The owner's Chrome saves elsewhere: the setting names it, and ~/Downloads no longer counts.
    let folder: string | undefined = '~/Statements';
    const moved = new DownloadStore(path.join(home, 'area'), { homeDir: owner, chromeFolder: () => folder, now: () => now });
    await mkdir(path.join(owner, 'Statements'), { recursive: true });
    await writeFile(path.join(owner, 'Statements', 'march.csv'), CSV);
    await writeFile(path.join(owner, 'Downloads', 'april.csv'), CSV);
    expect(moved.chromeFolder()).toBe(path.join(owner, 'Statements'));
    await expect(moved.save('cfo', chrome(path.join(owner, 'Statements', 'march.csv')))).resolves.toMatchObject({ size: CSV.length });
    await expect(moved.save('cfo', chrome(path.join(owner, 'Downloads', 'april.csv')))).rejects.toThrow(/your Chrome’s download folder/);
    folder = undefined;
    await expect(moved.save('cfo', chrome(path.join(owner, 'Downloads', 'april.csv')))).resolves.toMatchObject({ size: CSV.length });
  });

  it('takes the Chrome download folder as a setting: absolute or ~/, and null puts it back to ~/Downloads', () => {
    const base = settingsSchema.parse({});
    expect(base.downloadsFolder).toBeUndefined();
    expect(applySettingsChange(base, { downloadsFolder: '~/Statements' }).downloadsFolder).toBe('~/Statements');
    expect(applySettingsChange(base, { downloadsFolder: '/Volumes/Data/Downloads' }).downloadsFolder).toBe('/Volumes/Data/Downloads');
    expect(() => applySettingsChange(base, { downloadsFolder: 'Downloads' })).toThrow(/absolute path/);
    expect(applySettingsChange({ ...base, downloadsFolder: '~/Statements' }, { downloadsFolder: null }).downloadsFolder).toBeUndefined();
  });

  it('stops a transfer that passes the cap or the timeout, and one whose run was cancelled', async () => {
    let bytes = 0;
    const cancel = vi.fn(async () => {});
    const never = new Promise<string | null>(() => {});
    const big = watchTransfer({ done: never, size: async () => bytes, cancel, cap: 100, pollMs: 5, timeoutMs: 60_000 });
    bytes = 101;
    await expect(big).rejects.toThrow(/larger than 1 KB, the most agents may download per file/);
    expect(cancel).toHaveBeenCalledTimes(1);

    const slow = watchTransfer({ done: never, size: async () => 1, cancel, cap: 100, pollMs: 5, timeoutMs: 30 });
    await expect(slow).rejects.toThrow(/still downloading after 1 minutes, so it was stopped/);
    expect(cancel).toHaveBeenCalledTimes(2);
    await expect(watchTransfer({ done: Promise.resolve(null), size: async () => 1, cancel })).resolves.toBeNull();

    // Over the cap, the store says the cap's sentence and keeps nothing.
    const root = path.join(await scratch(), 'downloads');
    const store = new DownloadStore(root);
    const refusedLate = streamed(CSV, { failure: () => watchTransfer({ done: never, size: async () => 101, cancel, cap: 100, pollMs: 5 }) });
    await expect(store.save('cfo', refusedLate)).rejects.toThrow(/most agents may download per file/);
    expect((await store.usage()).files).toBe(0);

    // The run is cancelled while the transfer runs: stopped, with a sentence.
    const stop = new AbortController();
    const running = streamed(CSV, { failure: () => never, cancel });
    const saving = store.save('cfo', running, { signal: stop.signal });
    stop.abort();
    await expect(saving).rejects.toThrow(/run was stopped, so the download was stopped too/);
    expect(cancel).toHaveBeenCalledTimes(4);
  });

  it('lists what waits, files one again, and removes it once filed', async () => {
    const root = path.join(await scratch(), 'downloads');
    const store = new DownloadStore(root, { now: () => Date.parse('2026-10-05T09:00:00Z') });
    await store.save('cfo', streamed(CSV));
    expect(await store.waiting()).toEqual([{ id: 'cfo/2026-10-05/transactions.csv', agent: 'cfo', day: '2026-10-05', name: 'transactions.csv', size: CSV.length, mime: 'text/csv' }]);
    const read = await store.readWaiting('cfo/2026-10-05/transactions.csv');
    expect(read).toMatchObject({ agent: 'cfo', name: 'transactions.csv', mime: 'text/csv' });
    expect(read.bytes.toString()).toBe(CSV);
    for (const bad of ['../x/2026-10-05/a.csv', 'cfo/2026-10-05/../../x', 'cfo/latest/transactions.csv', 'cfo/2026-10-05/.secret']) {
      await expect(store.readWaiting(bad), bad).rejects.toBeInstanceOf(DownloadRefused);
    }
    await store.removeWaiting('cfo/2026-10-05/transactions.csv');
    expect(await store.waiting()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    await expect(store.removeWaiting('cfo/2026-10-05/transactions.csv')).rejects.toThrow(/no longer in the downloads area/);
  });
});

describe('browser.act and a download', () => {
  const observation: Observation = { id: 'o1', url: 'https://bank.example/accounts', title: 'Accounts', tree: '- link "Export CSV"', tabs: [], capturedAt: new Date().toISOString() };
  const navigate = commandSchema.parse({ action: 'navigate', url: 'https://bank.example/accounts' });
  const click = commandSchema.parse({ action: 'click', target: { ref: 'e1' } });

  async function setup(limits: { fileCap?: number; failSave?: boolean } = {}) {
    let now = Date.parse('2026-10-05T09:00:00Z');
    const root = path.join(await scratch(), 'downloads');
    const store = new DownloadStore(root, { now: () => now, ...(limits.fileCap ? { fileCap: limits.fileCap } : {}) });
    const pending: PendingDownload[] = [];
    const driver: BrowserDriver = { start: vi.fn(async () => {}), perform: vi.fn(async () => {}), observe: vi.fn(async () => observation),
      screenshot: vi.fn(async () => undefined), close: vi.fn(async () => {}), takeDownloads: () => pending.splice(0) };
    const cleanup = vi.fn(async () => {});
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
        if (limits.failSave) throw new Error('database unavailable');
        saved.push(input);
        return { id: '11111111-2222-4333-8444-555555555555', kind: 'document', mime: input.mime, filename: input.filename ?? null, sizeBytes: input.bytes.length,
          sha256: 'x', caption: input.caption ?? null, createdBy: 'cfo', createdAt: new Date(now).toISOString(), conversationId: null } as never;
      },
      get: async () => null, read: async () => Buffer.alloc(0), list: async () => [],
    };
    const ctx = { ...facts, buddi: { ...host, files } } as CoreToolContext;
    return { service, ctx, pending, saved, store, root, cleanup, advance: (ms: number) => { now += ms; } };
  }

  it('lands as an artifact the agent can pass on, tagged with the agent, the run and where it came from; one copy, in Files', async () => {
    const { service, ctx, pending, saved, store, root, cleanup } = await setup();
    await service.execute(navigate, ctx);
    pending.push(streamed(CSV, { cleanup }));
    const result = await service.execute(click, ctx) as { completed: boolean; downloads: DownloadReport[]; message: string };
    expect(result.completed).toBe(true);
    expect(result.downloads).toEqual([{ artifactId: '11111111-2222-4333-8444-555555555555', name: 'transactions.csv', size: CSV.length, type: 'text/csv' }]);
    expect(result.message).toMatch(/artifact 11111111-2222-4333-8444-555555555555\. To import it, pass that id to the owning plugin's import tool/);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.bytes.toString()).toBe(CSV);
    expect(saved[0]).toMatchObject({ mime: 'text/csv', filename: 'transactions.csv', caption: 'Downloaded from bank.example',
      source: { surface: 'browser', chatId: 'run-7', messageId: 'https://bank.example/export' } });
    // Registered, so nothing waits in the landing folder: Files holds the only copy.
    expect((await store.usage()).files).toBe(0);
    expect(await readdir(path.join(root, 'cfo'))).toEqual([]);
    await expect(access(path.join(root, 'cfo', '2026-10-05', 'transactions.csv'))).rejects.toThrow();
    // The browser's own copy is removed once the file was taken.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('says a plain sentence when no agent is named, never a TypeError', async () => {
    const { service, ctx, pending, saved } = await setup();
    await service.execute(navigate, ctx);
    pending.push(streamed(CSV));
    const anonymous = { ...ctx, agentId: undefined } as CoreToolContext;
    await expect(service.execute(click, anonymous)).rejects.toThrow('A browser action belongs to an agent and a conversation.');
    expect(saved).toHaveLength(0);
  });

  it('keeps a download whose registration failed as a leftover, which the sweep clears after thirty days', async () => {
    const { service, ctx, pending, store, root, advance } = await setup({ failSave: true });
    await service.execute(navigate, ctx);
    pending.push(streamed(CSV));
    const result = await service.execute(click, ctx) as { downloads: DownloadReport[] };
    expect(result.downloads).toEqual([{ name: 'transactions.csv', refused: expect.stringMatching(/could not be saved \(database unavailable\)/) }]);
    expect(await readdir(path.join(root, 'cfo', '2026-10-05'))).toEqual(['transactions.csv']);
    expect((await store.usage()).files).toBe(1);
    advance(31 * 24 * 60 * 60 * 1000);
    expect(await store.sweep()).toBe(1);
    expect((await store.usage()).files).toBe(0);
  });

  it('refuses over the cap and says why, and the page action still counts', async () => {
    const { service, ctx, pending, saved, cleanup } = await setup({ fileCap: 8 });
    await service.execute(navigate, ctx);
    pending.push(streamed(CSV, { cleanup }));
    const result = await service.execute(click, ctx) as { completed: boolean; downloads: DownloadReport[]; message: string };
    expect(result.completed).toBe(true);
    expect(result.downloads).toEqual([{ name: 'transactions.csv', refused: expect.stringMatching(/most agents may download per file/) }]);
    expect(result.message).toMatch(/The download transactions\.csv was refused: That download is larger than 1 KB, the most agents may download per file\./);
    expect(saved).toHaveLength(0);
    // Refused, and the browser's copy goes all the same.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

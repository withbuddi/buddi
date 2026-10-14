/**
 * Open in app (web/open-in-app.ts): the newest version of a Word file
 * exported to a working copy the server names, handed to the owner's app (a
 * stand-in here), a whole save there brought back as his version through the
 * one owner save, a save refused because buddi wrote a newer version
 * meanwhile — Keep mine, Show theirs (the copy kept), Save mine as new file —
 * and the limits: this computer only and never through a proxy, the copy
 * always under `<data>/open/<fileId>/` and never through a link, a
 * half-written save never imported, an app's lock file never imported and a
 * copy it holds never removed, unimported work never removed, and a session
 * that survives a restart.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CORE_MIGRATIONS_DIR, CORE_SCHEMA, OFFICE_MIME, ToolRegistry, createPool, ensureOwner, getFile, migrate, saveArtifact, saveVersion,
  type AgentCatalog, type CoreToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { hostFetch } from '../__fixtures__/host-fetch.js';
import { csrfCookieName } from './http.js';
import { OpenInApp, runOpener, type Launched } from './open-in-app.js';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_open_in_app_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const catalog = { get: () => undefined, list: () => [], byHandle: () => undefined, agentsWithRole: () => [], resolve: () => undefined } as unknown as AgentCatalog;

/** A whole Word package with this text: what an app's save leaves. */
const docx = (text: string): Buffer => Buffer.from(zipSync({
  '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  'word/document.xml': strToU8(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
}));

suite('Open in app', () => {
  let admin: Pool;
  let pool: Pool;
  let app: WebServer;
  let dir: string;
  let env: Record<string, string | undefined>;
  const launched: string[] = [];
  const opener: { mode: 'ok' | 'fail' | 'unconfirmed' } = { mode: 'ok' };
  const base = (): string => `http://127.0.0.1:${app.port}`;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-open-in-app-')));
    env = { ...process.env, BUDDI_DATA_DIR: dir, BUDDI_VAULT: 'memory' };
    app = await startWebServer({
      pool, registry: new ToolRegistry(), catalog, timezone: 'UTC', now: () => new Date(), env,
      ctx: { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as CoreToolContext,
      config: { enabled: true, host: '127.0.0.1', port: 0 }, token: TOKEN, openAccess: true, log: () => {},
      // The owner's app is a stand-in; a save is read at the first look after it.
      openInApp: {
        launch: async (file): Promise<Launched> => {
          if (opener.mode === 'fail') throw new Error('no application knows this kind of file');
          launched.push(file);
          return opener.mode === 'unconfirmed' ? 'unconfirmed' : 'opened';
        },
        settleMs: 0, pollMs: 3_600_000,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function caller(cookies: string[], extra: Record<string, string> = {}, origin = base()) {
    const csrf = cookies.find((c) => c.startsWith(`${csrfCookieName(app.port)}=`))?.split('=')[1] ?? '';
    return async (method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await hostFetch(`${base()}${route}`, {
        method,
        headers: { Cookie: cookies.join('; '), Connection: 'close', ...extra, ...(method === 'GET' ? {} : { Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
  }

  async function localCookies(): Promise<string[]> {
    const res = await hostFetch(`${base()}/api/session`, { headers: { Connection: 'close' } });
    return res.headers.getSetCookie().map((c) => c.split(';')[0]!);
  }
  const local = async () => caller(await localCookies());

  async function remote() {
    const proxy = { 'X-Forwarded-For': '203.0.113.4', Host: 'buddi.tail1234.ts.net:9443' };
    const exchange = await hostFetch(`${base()}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, { headers: { ...proxy, Connection: 'close' } });
    return caller(exchange.headers.getSetCookie().map((c) => c.split(';')[0]!), proxy, 'https://buddi.tail1234.ts.net:9443');
  }

  const word = async (name: string, text = `${name} ${Math.random()}`, createdBy = 'writer'): Promise<{ fileId: string; bytes: Buffer }> => {
    const bytes = docx(text);
    const row = await saveArtifact(pool, { bytes, mime: OFFICE_MIME.docx, filename: name, createdBy, source: { surface: 'telegram', chatId: '1' } }, env);
    return { fileId: row.fileId, bytes };
  };
  const copyOf = (fileId: string, name: string): string => path.join(dir, 'open', fileId, name);
  const versions = async (call: Awaited<ReturnType<typeof local>>, fileId: string): Promise<number> => (await call('GET', `/api/files/${fileId}`)).body.versions.length;

  it('exports the newest version to a copy under the data folder, hands it to the app, and keeps a record beside it', async () => {
    const call = await local();
    const { fileId, bytes } = await word('Letter.docx');
    const opened = await call('POST', `/api/files/${fileId}/open`, {});
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ open: true, fileId, name: 'Letter.docx', base: 1, state: 'watching', launch: 'opened' });
    expect(launched.at(-1)).toBe(copyOf(fileId, 'Letter.docx'));
    expect(await readFile(copyOf(fileId, 'Letter.docx'))).toEqual(bytes);
    expect(JSON.parse(await readFile(copyOf(fileId, '.buddi.json'), 'utf8'))).toMatchObject({ fileId, name: 'Letter.docx', base: 1, state: 'watching' });
    // Open again: the same copy, launched again, nothing new in Files.
    expect((await call('POST', `/api/files/${fileId}/open`, {})).body).toMatchObject({ base: 1 });
    expect(await versions(call, fileId)).toBe(1);
    // An opener that did not answer is said as such, not as success.
    opener.mode = 'unconfirmed';
    expect((await call('POST', `/api/files/${fileId}/open`, {})).body.launch).toBe('unconfirmed');
    opener.mode = 'ok';
  });

  it('reports an opener that refused, in the 502 shape', async () => {
    const call = await local();
    const { fileId } = await word('Nobody.docx');
    opener.mode = 'fail';
    const refused = await call('POST', `/api/files/${fileId}/open`, {});
    opener.mode = 'ok';
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatch(/Nobody\.docx could not be opened in an app \(no application knows this kind of file\)/);
  });

  it('brings back only a whole save, as the owner’s next version — never the app’s lock file, never a half-written one', async () => {
    const call = await local();
    const { fileId } = await word('Plan.docx');
    await call('POST', `/api/files/${fileId}/open`, {});
    const copy = copyOf(fileId, 'Plan.docx');
    await writeFile(path.join(dir, 'open', fileId, '~$Plan.docx'), 'owner lock');
    // Half way through the app's save: not a whole package yet.
    const whole = docx('plan as saved in Word');
    await writeFile(copy, whole.subarray(0, Math.floor(whole.length / 2)));
    expect((await call('GET', `/api/files/${fileId}/open`)).body).toMatchObject({ open: true, base: 1, unsaved: true });
    expect(await versions(call, fileId)).toBe(1);
    // The save finished.
    await writeFile(copy, whole);
    expect((await call('GET', `/api/files/${fileId}/open`)).body).toMatchObject({ open: true, base: 2, savedVersion: 2, unsaved: false });
    const view = (await call('GET', `/api/files/${fileId}`)).body;
    expect(view.current).toMatchObject({ version: 2, createdBy: 'owner', createdByName: null });
    // Looked at again with nothing new: no third version.
    await call('GET', `/api/files/${fileId}/open`);
    expect(await versions(call, fileId)).toBe(2);
  });

  it('holds a save over a newer version for his choice: Keep mine saves it, Show theirs keeps the copy, Save mine as new file keeps it in Files', async () => {
    const call = await local();
    const { fileId } = await word('Budget.docx');
    await call('POST', `/api/files/${fileId}/open`, {});
    const copy = copyOf(fileId, 'Budget.docx');
    await saveVersion(pool, { id: fileId, bytes: docx('budget v2 by buddi'), createdBy: 'writer' }, env);
    await writeFile(copy, docx('budget as the owner saved it'));
    const refused = await call('GET', `/api/files/${fileId}/open`);
    expect(refused.body).toMatchObject({ state: 'conflict', base: 1, conflict: 'newer', current: { version: 2, createdBy: 'writer' } });
    expect(refused.body.error).toMatch(/This file changed since you opened it: v2 is newer/);
    expect(await versions(call, fileId)).toBe(2);

    const mine = await call('POST', `/api/files/${fileId}/open/resolve`, { keep: 'mine' });
    expect(mine.body).toMatchObject({ state: 'watching', base: 3, savedVersion: 3 });
    expect((await call('GET', `/api/files/${fileId}`)).body.current).toMatchObject({ version: 3, createdBy: 'owner' });

    // Again, and this time theirs: the watch stops, his copy stays on disk.
    await saveVersion(pool, { id: fileId, bytes: docx('budget v4 by buddi'), createdBy: 'writer', readVersion: 3 }, env);
    await writeFile(copy, docx('budget saved again in Word'));
    expect((await call('GET', `/api/files/${fileId}/open`)).body).toMatchObject({ conflict: 'newer', current: { version: 4 } });
    const theirs = await call('POST', `/api/files/${fileId}/open/resolve`, { keep: 'theirs' });
    expect(theirs.body).toMatchObject({ open: true, state: 'detached', unsaved: true });
    expect((await readFile(copy)).equals(docx('budget saved again in Word'))).toBe(true);
    await writeFile(copy, docx('and saved once more'));
    await call('GET', `/api/files/${fileId}/open`);
    expect((await call('GET', `/api/files/${fileId}`)).body.current).toMatchObject({ version: 4, createdBy: 'writer' });

    // Save mine as new file: a file of his, and the copy is let go (no app holds it).
    const kept = await call('POST', `/api/files/${fileId}/open/resolve`, { keep: 'new' });
    expect(kept.body).toMatchObject({ open: false, closed: true, savedAs: { filename: 'Budget (your copy).docx' } });
    const made = await getFile(pool, kept.body.savedAs.fileId);
    expect(made).toMatchObject({ createdBy: 'owner', mime: OFFICE_MIME.docx });
    await expect(stat(path.join(dir, 'open', fileId))).rejects.toThrow();
    expect((await call('GET', `/api/files/${fileId}/open`)).body).toEqual({ open: false });
  });

  it('never reopens over work Files lacks: it is brought back, or raises the bar', async () => {
    const call = await local();
    const { fileId } = await word('Notes.docx');
    await call('POST', `/api/files/${fileId}/open`, {});
    await call('POST', `/api/files/${fileId}/open/resolve`, { keep: 'theirs' });
    await writeFile(copyOf(fileId, 'Notes.docx'), docx('typed after Show theirs'));
    const again = await call('POST', `/api/files/${fileId}/open`, {});
    expect(again.body).toMatchObject({ state: 'watching', savedVersion: 2, base: 2 });
    expect((await readFile(copyOf(fileId, 'Notes.docx'))).equals(docx('typed after Show theirs'))).toBe(true);
  });

  it('is refused off this computer, and through a proxy on it', async () => {
    const { fileId } = await word('Remote.docx');
    const far = await remote();
    expect((await far('GET', '/api/session')).body).toMatchObject({ signedInThrough: 'ticket' });
    // A local session's own cookies, carried through Tailscale Serve (which connects from 127.0.0.1).
    const proxied = caller(await localCookies(), { 'X-Forwarded-For': '100.101.102.103', 'Tailscale-User-Login': 'someone@example.com' });
    // Off this computer: 403. Through the proxy the local session is not honoured at all (401); either way nothing opens.
    for (const call of [far, proxied]) {
      expect([401, 403]).toContain((await call('POST', `/api/files/${fileId}/open`, {})).status);
      expect([401, 403]).toContain((await call('GET', `/api/files/${fileId}/open`)).status);
      expect([401, 403]).toContain((await call('POST', `/api/files/${fileId}/open/resolve`, { keep: 'mine' })).status);
    }
    expect((await far('POST', `/api/files/${fileId}/open`, {})).status).toBe(403);
    await expect(stat(path.join(dir, 'open', fileId))).rejects.toThrow();
  });

  it('keeps the copy under open/<fileId> whatever the file is called, and never goes through a link', async () => {
    const call = await local();
    const sneaky = await word('../../../escape.docx');
    expect((await call('POST', `/api/files/${sneaky.fileId}/open`, {})).status).toBe(200);
    expect(launched.at(-1)).toBe(copyOf(sneaky.fileId, 'escape.docx'));
    await expect(stat(path.join(dir, '..', 'escape.docx'))).rejects.toThrow();

    // Its folder swapped for a link elsewhere: nothing is written there.
    const linked = await word('Linked.docx');
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'buddi-open-elsewhere-'));
    await mkdir(path.join(dir, 'open'), { recursive: true });
    await symlink(elsewhere, path.join(dir, 'open', linked.fileId));
    expect((await call('POST', `/api/files/${linked.fileId}/open`, {})).status).toBe(409);
    expect(await readdir(elsewhere)).toEqual([]);

    // The working copy itself swapped for a link to another file: never read, never imported.
    const target = await word('Target.docx');
    await call('POST', `/api/files/${target.fileId}/open`, {});
    const secret = path.join(elsewhere, 'secret.docx');
    await writeFile(secret, docx('a file outside buddi'));
    await unlink(copyOf(target.fileId, 'Target.docx'));
    await symlink(secret, copyOf(target.fileId, 'Target.docx'));
    await call('GET', `/api/files/${target.fileId}/open`);
    expect(await versions(call, target.fileId)).toBe(1);
    expect((await call('POST', `/api/files/${target.fileId}/open`, {})).status).toBe(409);
    await rm(elsewhere, { recursive: true, force: true });

    // Only an Office document, and only a file in Files.
    const text = await saveArtifact(pool, { bytes: Buffer.from('# notes'), mime: 'text/markdown', filename: 'notes.md', createdBy: 'writer' }, env);
    expect((await call('POST', `/api/files/${text.fileId}/open`, {})).status).toBe(415);
    expect((await call('POST', '/api/files/00000000-0000-4000-8000-000000000000/open', {})).status).toBe(404);
  });

  describe('across a restart, and the sweep', () => {
    let clock = Date.now();
    const instance = (): OpenInApp => new OpenInApp({ pool, env, ownerId: 'owner', launch: async () => 'opened', settleMs: 0, pollMs: 3_600_000, now: () => clock });

    it('resumes the session a previous run left and brings back what was saved while buddi was down', async () => {
      const { fileId } = await word('Restart.docx');
      const first = instance();
      expect((await first.open(fileId)).body).toMatchObject({ base: 1 });
      first.close();
      // buddi is down; he saves in Word.
      await writeFile(copyOf(fileId, 'Restart.docx'), docx('saved while buddi was down'));
      const second = instance();
      await second.ready;
      expect((await second.status(fileId)).body).toMatchObject({ open: true, base: 2, savedVersion: 2, unsaved: false });
      expect((await getFile(pool, fileId))).not.toBeNull();
      // Reopening after it never writes the stored version over his copy.
      await second.open(fileId);
      expect((await readFile(copyOf(fileId, 'Restart.docx'))).equals(docx('saved while buddi was down'))).toBe(true);
      second.close();
    });

    it('removes only copies that hold nothing new and that no app holds', async () => {
      const sweeper = instance();
      const clean = await word('Clean.docx');
      const held = await word('Held.docx');
      const pending = await word('Pending.docx');
      for (const f of [clean, held, pending]) await sweeper.open(f.fileId);
      await writeFile(path.join(dir, 'open', held.fileId, '~$Held.docx'), 'lock');
      // A refused save waiting for his choice.
      await saveVersion(pool, { id: pending.fileId, bytes: docx('newer by buddi'), createdBy: 'writer' }, env);
      await writeFile(copyOf(pending.fileId, 'Pending.docx'), docx('his, refused'));
      await sweeper.lookAll();
      expect((await sweeper.status(pending.fileId)).body).toMatchObject({ state: 'conflict' });
      // A day and more later.
      clock += 25 * 60 * 60 * 1000;
      await sweeper.sweep();
      await expect(stat(path.join(dir, 'open', clean.fileId))).rejects.toThrow();
      expect((await stat(copyOf(held.fileId, 'Held.docx'))).isFile()).toBe(true);
      expect((await readFile(copyOf(pending.fileId, 'Pending.docx'))).equals(docx('his, refused'))).toBe(true);
      // The app let go of the held one: now it goes too.
      await unlink(path.join(dir, 'open', held.fileId, '~$Held.docx'));
      await sweeper.sweep();
      await expect(stat(path.join(dir, 'open', held.fileId))).rejects.toThrow();
      expect((await stat(copyOf(pending.fileId, 'Pending.docx'))).isFile()).toBe(true);
      sweeper.close();
    });
  });
});

describe('the system opener', () => {
  it('is opened only on a zero exit, refused on any other, and unconfirmed when it does not answer', async () => {
    const env = { PATH: process.env.PATH ?? '' };
    await expect(runOpener('true', [], env, 5_000)).resolves.toBe('opened');
    await expect(runOpener('false', [], env, 5_000)).rejects.toThrow(/answered 1/);
    await expect(runOpener('sleep', ['5'], env, 100)).resolves.toBe('unconfirmed');
    await expect(runOpener('no-such-opener-buddi', [], env, 5_000)).rejects.toThrow();
  });
});

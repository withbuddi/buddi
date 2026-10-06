/**
 * One card for the engine and the first model (host API 1.32), on a real
 * database: asking twice answers the same card, a second plugin asking for the
 * engine meanwhile answers it too, approving starts the download, and once the
 * engine is here a later plugin gets no card. The download is served by a fake
 * server on 127.0.0.1; the database is created by this suite and dropped.
 *
 * Isolated: an explicit throwaway `DATABASE_URL` and the memory vault, never
 * the keychain and never the dev database's port (`isolatedTestDatabaseUrl`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from '../db.js';
import { urlForDatabase } from '../backup/restore.js';
import { isolatedTestDatabaseUrl } from '../testing/database-url.js';
import { decideApproval } from '../actions/approvals.js';
import { executeApproved } from '../actions/execute.js';
import { ToolRegistry } from '../registry.js';
import { configurePluginHost, createPluginHost, hostBindingOf, resetPluginHost } from '../host/build.js';
import type { CoreToolContext, PluginManifest } from '../tools.js';
import { configureRuntimes, resetRuntimesConfig } from './config.js';
import { createRuntimesManifest, RUNTIMES_TOOL, type RuntimesDownload } from './consent.js';
import { startFakeServer, sha256, tgz, type FakeServer } from './__fixtures__/server.js';
import { modelState, resetModels, startModelDownload } from './models.js';
import { onnxState, removeOnnxRuntime, resetOnnxRuntime, startOnnxDownload } from './onnx.js';

const databaseUrl = isolatedTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_runtimes_${process.pid}`;

const BINDING = Buffer.from('binding '.repeat(100));
const LIBRARY = Buffer.from('library '.repeat(1000));
const TARBALL = tgz([
  { name: 'package/bin/napi-v6/linux/x64/onnxruntime_binding.node', body: BINDING },
  { name: 'package/bin/napi-v6/linux/x64/libonnxruntime.so.1', body: LIBRARY },
]);
const MODEL = Buffer.from('minilm '.repeat(500));

suite('one card for a local model', () => {
  let admin: Pool;
  let pool: Pool;
  let data: string;
  let server: FakeServer;
  const now = new Date('2026-10-06T10:00:00Z');
  const told: string[] = [];

  const manifest = (name: string): PluginManifest =>
    ({ name, version: '1.0.0', schema: name, migrationsDir: '', tools: [], uses: ['onnx'] }) as unknown as PluginManifest;
  const hostFor = (name: string) => createPluginHost(hostBindingOf(manifest(name)), { db: pool, now: () => now, timezone: 'UTC', agentId: 'assistant' });
  const cards = async (): Promise<Array<{ id: string; preview: string; canonical_args: RuntimesDownload }>> =>
    (await pool.query(`select id, preview, canonical_args from core.actions where tool = $1 order by created_at`, [RUNTIMES_TOOL])).rows;
  // The real path: the owner's decision, then the executor through the registry (an ownerOnly tool, run as the owner).
  const approve = async (id: string): Promise<void> => {
    const registry = new ToolRegistry();
    registry.register(createRuntimesManifest());
    await decideApproval(pool, { actionId: id, decision: 'approved', by: 'owner', via: 'web', now });
    const executed = await executeApproved(pool, { actionId: id, registry, ctx: { db: pool, now: () => now, timezone: 'UTC' } as CoreToolContext, worker: 'test', now });
    expect(executed.state).toBe('succeeded');
  };

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
    server = await startFakeServer();
    server.files.set('/onnxruntime-node/-/onnxruntime-node-9.9.9.tgz', TARBALL);
    server.files.set('/acme/minilm/model.onnx', MODEL);
    data = await mkdtemp(path.join(tmpdir(), 'buddi-runtimes-db-'));
    configurePluginHost({ env: { BUDDI_DATA_DIR: data }, askApproval: async (action) => { told.push(action.tool); } });
    configureRuntimes({
      get: server.get,
      platform: 'linux',
      arch: 'x64',
      log: () => {},
      pinFor: () => ({
        key: 'linux-x64',
        pin: {
          version: '9.9.9',
          tarball: { url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-9.9.9.tgz', sha256: sha256(TARBALL), bytes: TARBALL.length },
          files: [
            { entry: 'package/bin/napi-v6/linux/x64/onnxruntime_binding.node', name: 'onnxruntime_binding.node', sha256: sha256(BINDING), bytes: BINDING.length },
            { entry: 'package/bin/napi-v6/linux/x64/libonnxruntime.so.1', name: 'libonnxruntime.so.1', sha256: sha256(LIBRARY), bytes: LIBRARY.length },
          ],
        },
      }),
    });
  }, 120_000);

  afterEach(async () => {
    await pool.query(`delete from core.approvals; delete from core.actions`);
  });

  afterAll(async () => {
    resetOnnxRuntime();
    resetModels();
    resetRuntimesConfig();
    resetPluginHost();
    await server?.close();
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists "${DB}"`).catch(() => {});
    await admin?.end().catch(() => {});
    if (data) await rm(data, { recursive: true, force: true });
  });

  it('raises one card for the model and the engine, and no more until it is decided', async () => {
    const speech = hostFor('speech');
    const first = await speech.onnx!.ensure({ reason: 'to transcribe your voice notes', model: { name: 'Whisper base model', bytes: 135_000_000 } });
    expect(first.state).toBe('absent');
    expect(first.pending).toBeDefined();
    const again = await speech.onnx!.ensure({ reason: 'to transcribe your voice notes', model: { name: 'Whisper base model', bytes: 135_000_000 } });
    expect(again.pending).toBe(first.pending);
    // Another plugin that needs only the engine is answered by the same card.
    const news = await hostFor('news').onnx!.ensure({ reason: 'to group stories' });
    expect(news.pending).toBe(first.pending);
    const raised = await cards();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.preview).toMatch(/^Download the Whisper base model \(135 MB\) and the engine that runs it \([^)]+\)\?\nspeech asks: to transcribe your voice notes\./);
    // Nothing was fetched before the owner's yes.
    expect(server.hits.size).toBe(0);
    expect(onnxState().state).toBe('absent');

    await approve(first.pending!);
    expect(onnxState().state).toBe('downloading');
    await startOnnxDownload();
    expect(onnxState().state).toBe('ready');

    // A later plugin reuses the engine with no new card.
    const later = await hostFor('news').onnx!.ensure({ reason: 'to group stories', model: { name: 'MiniLM', bytes: 90_000_000 } });
    expect(later).toMatchObject({ state: 'ready' });
    expect(later.pending).toBeUndefined();
    expect(await cards()).toHaveLength(1);
  });

  it('raises one card when two plugins ask in the same tick', async () => {
    await removeOnnxRuntime();
    expect(onnxState().state).toBe('absent');
    const asked = await Promise.all([
      hostFor('speech').onnx!.ensure({ reason: 'to transcribe' }),
      hostFor('news').onnx!.ensure({ reason: 'to group stories' }),
      hostFor('digest').onnx!.ensure({ reason: 'to rank' }),
    ]);
    expect(new Set(asked.map((a) => a.pending)).size).toBe(1);
    expect(await cards()).toHaveLength(1);
    // Telegram and push are told about the one card, once.
    expect(told.slice(-1)).toEqual([RUNTIMES_TOOL]);
    const before = told.length;
    await hostFor('speech').onnx!.ensure({ reason: 'again' });
    expect(told).toHaveLength(before);
  });

  it('asks once for a shared model, downloads it once, and then answers its folder', async () => {
    const files = [{ url: 'https://huggingface.co/acme/minilm/model.onnx', sha256: sha256(MODEL), bytes: MODEL.length }];
    const news = hostFor('news');
    const asked = await news.models!.ensure({ id: 'minilm', files, reason: 'to group stories', name: 'MiniLM model' });
    expect(asked).toMatchObject({ id: 'minilm', state: 'absent', sizeBytes: MODEL.length });
    const twice = await hostFor('digest').models!.ensure({ id: 'minilm', files, reason: 'to rank', name: 'MiniLM model' });
    expect(twice.pending).toBe(asked.pending);
    expect((await cards())[0]!.preview).toMatch(/^Download the MiniLM model \(4 KB\)\?/);
    await approve(asked.pending!);
    await startModelDownload({ id: 'minilm', files });
    expect(modelState('minilm')).toMatchObject({ state: 'ready', path: path.join(data, 'models', 'minilm') });
    const ready = await hostFor('digest').models!.ensure({ id: 'minilm', files, reason: 'to rank' });
    expect(ready.state).toBe('ready');
    expect(ready.pending).toBeUndefined();
    expect(server.hits.get('/acme/minilm/model.onnx')).toBe(1);
    expect(await cards()).toHaveLength(1);
  });
});

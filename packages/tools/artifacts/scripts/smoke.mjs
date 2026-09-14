#!/usr/bin/env node
/**
 * End-to-end smoke test for the artifact store and the artifacts plugin.
 *
 *   pnpm db:up && pnpm -r build
 *   node packages/tools/artifacts/scripts/smoke.mjs [path/to/a.pdf]
 *
 * It saves a PDF through the core store and reads it back through
 * registry.invoke(), so tier and argument validation are exercised the way the
 * agent will hit them.
 *
 * Nothing of the owner's is touched: the script creates a throwaway database and
 * a throwaway data dir, and drops both at the end. A PDF given on the command
 * line is only ever *read* — the copy that gets written lives in the temp dir.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

// Minimal .env loader: this package does not depend on dotenv.
try {
  for (const line of readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env: rely on the ambient environment */
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

const source = process.argv[2];
if (!source) {
  console.error('usage: node packages/tools/artifacts/scripts/smoke.mjs <path/to/a.pdf>');
  process.exit(1);
}

const { ToolRegistry, createPool, migrateCore, saveArtifact, listArtifacts } = await import(
  '@buddi/core'
);
const { manifest } = await import('../dist/index.js');

const TEST_DB = `buddi_artifacts_smoke_${process.pid}`;
const admin = createPool(databaseUrl);
await admin.query(`drop database if exists ${TEST_DB}`);
await admin.query(`create database ${TEST_DB}`);
const pool = createPool(databaseUrl.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`));
const dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-artifacts-smoke-'));
process.env.BUDDI_DATA_DIR = dataDir;

const registry = new ToolRegistry();
registry.register(manifest);

const ctx = {
  db: pool,
  ownerId: 'smoke',
  now: () => new Date(),
  agentId: 'finance-advisor',
};

async function call(name, args) {
  const result = await registry.invoke(name, args, ctx);
  if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
  return result.output;
}

try {
  await migrateCore(pool);
  console.log(`data dir: ${dataDir}`);
  console.log(`database: ${TEST_DB}`);

  const bytes = await readFile(source);
  const saved = await saveArtifact(pool, {
    bytes,
    mime: 'application/pdf',
    filename: path.basename(source),
    caption: 'statement dropped in chat',
    createdBy: 'owner',
    source: { surface: 'telegram', chatId: '42', messageId: '1001' },
  });
  console.log(
    `\n--- saved\n${saved.id}  ${saved.kind}  ${saved.sizeBytes} bytes  ${saved.storagePath}`,
  );

  // The same file again, from the same chat: one artifact, not two.
  const again = await saveArtifact(pool, {
    bytes,
    mime: 'application/pdf',
    filename: path.basename(source),
    createdBy: 'owner',
    source: { surface: 'telegram', chatId: '42', messageId: '1002' },
  });
  console.log(`dedup: ${again.id === saved.id ? 'same artifact ✓' : 'DUPLICATE ✗'}`);
  console.log(`rows: ${(await listArtifacts(pool, { limit: 10 })).length}`);

  const listed = await call('artifacts.list', { limit: 5 });
  console.log(`\n--- artifacts.list\n${JSON.stringify(listed, null, 2)}`);

  const described = await call('artifacts.describe', { id: saved.id });
  console.log(
    `\n--- artifacts.describe\npages: ${described.pages}  truncated: ${described.truncated}` +
      `  chars: ${described.text?.length ?? 0}`,
  );
  console.log(`\nfirst 300 chars of extracted text:\n${(described.text ?? '').slice(0, 300)}`);

  const full = await call('artifacts.text', { id: saved.id });
  console.log(`\n--- artifacts.text\nchars: ${full.chars}  truncated: ${full.truncated}`);
} finally {
  await pool.end();
  await admin.query(`drop database if exists ${TEST_DB}`);
  await admin.end();
  await rm(dataDir, { recursive: true, force: true });
}

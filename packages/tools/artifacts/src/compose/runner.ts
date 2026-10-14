/**
 * `run.mjs`: what the confined child Node runs (docs/files.md, "Composed
 * documents"). Written into each run's work folder beside `program.mjs`,
 * the attachments and `plan.json`.
 *
 * It resolves every bare import itself — a program's `docx` or
 * `pptxgenjs`, and their own dependencies — to the real folders buddi
 * granted (`libraries.ts`), refusing any other package a program names;
 * calls the program's default export with `ctx`; and sends what came back
 * to buddi on fd 3, framed (a type byte, a 4-byte length, the payload): `B`
 * the file's bytes, `E` an error as JSON. stdout and stderr stay the
 * program's console.
 */
export const RUNNER_SOURCE = String.raw`// buddi's compose runner. The program is program.mjs; this file is buddi's.
import { registerHooks, isBuiltin } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const work = path.dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(path.join(work, 'plan.json'), 'utf8'));
const OUT = 3;

function writeAll(buffer) {
  let at = 0;
  while (at < buffer.length) {
    try { at += writeSync(OUT, buffer, at, buffer.length - at); }
    catch (err) { if (err && err.code === 'EAGAIN') continue; throw err; }
  }
}
function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeUInt32BE(payload.length, 1);
  writeAll(head);
  writeAll(payload);
}
let reported = false;
function report(err, extra) {
  if (reported) return;
  reported = true;
  const e = err instanceof Error ? err : new Error(String(err));
  // fetch() says "fetch failed" and keeps why in its cause.
  const denied = e.code === 'ERR_ACCESS_DENIED' ? e : e.cause && e.cause.code === 'ERR_ACCESS_DENIED' ? e.cause : null;
  frame('E', Buffer.from(JSON.stringify({
    name: e.name, message: String(e.message), code: denied ? denied.code : e.code, permission: denied ? denied.permission : e.permission,
    stack: String(e.stack ?? ''), ...extra,
  })));
}

const dirs = Object.keys(plan.deps).sort((a, b) => b.length - a.length);
function ownerOf(parentURL) {
  if (!parentURL || !parentURL.startsWith('file:')) return null;
  const file = fileURLToPath(parentURL);
  for (const dir of dirs) if (file === dir || file.startsWith(dir + path.sep)) return dir;
  return null;
}
registerHooks({
  resolve(specifier, context, next) {
    if (isBuiltin(specifier) || specifier.startsWith('.') || path.isAbsolute(specifier) || /^[a-z][a-z0-9+.-]+:/i.test(specifier)) {
      return next(specifier, context);
    }
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    const owner = ownerOf(context.parentURL);
    const dir = owner === null ? plan.top[name] : plan.deps[owner][name];
    if (!dir) {
      const err = new Error(owner === null
        ? 'a compose program can import only ' + Object.keys(plan.top).join(' or ') + ' (and node: built-ins), not "' + name + '"'
        : "Cannot find package '" + name + "'");
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
    const sub = specifier.slice(name.length);
    // require() follows the package's main by path; import resolves its exports from inside its real folder.
    if (context.conditions && context.conditions.includes('require')) return next(sub ? path.join(dir, sub) : dir, context);
    return next(specifier, { ...context, parentURL: pathToFileURL(path.join(dir, 'package.json')).href });
  },
});

process.on('unhandledRejection', (err) => { report(err); process.exit(1); });
process.on('uncaughtException', (err) => { report(err); process.exit(1); });

function describe(value) {
  if (value === null || value === undefined) return String(value);
  const name = value && value.constructor && value.constructor.name;
  if (name === 'Document' || name === 'File') return 'a docx Document (pass it to Packer.toBuffer(doc) and return that)';
  if (name === 'PptxGenJS') return 'the presentation itself (return await pres.write({ outputType: "nodebuffer" }))';
  return typeof value === 'object' ? 'an object (' + (name || 'Object') + ')' : 'a ' + typeof value;
}

const files = plan.attachments.map((a) => {
  const bytes = readFileSync(path.join(work, a.file));
  const base64 = bytes.toString('base64');
  return Object.freeze({
    fileId: a.fileId, name: a.name, mime: a.mime, type: a.type, width: a.width, height: a.height,
    bytes, base64, dataUri: 'data:' + a.mime + ';base64,' + base64,
  });
});
const ctx = Object.freeze({
  kind: plan.kind,
  files: Object.freeze(files),
  file(id) { return files.find((f) => f.fileId === id || f.name === id) ?? null; },
});

try {
  const program = await import(pathToFileURL(path.join(work, 'program.mjs')).href);
  if (typeof program.default !== 'function') {
    report(new Error('the program must export a default async function (ctx) that returns the file\'s bytes'), { shape: true });
    process.exit(1);
  }
  const out = await program.default(ctx);
  const bytes = out instanceof Uint8Array ? Buffer.from(out.buffer, out.byteOffset, out.byteLength)
    : out instanceof ArrayBuffer ? Buffer.from(out) : null;
  if (bytes === null) {
    report(new Error('the program returned ' + describe(out) + ', not the file\'s bytes (a Buffer or Uint8Array)'), { shape: true });
    process.exit(1);
  }
  if (bytes.length > plan.maxBytes) {
    report(new Error('the file is ' + bytes.length + ' bytes'), { tooLarge: true });
    process.exit(1);
  }
  frame('B', bytes);
  process.exit(0);
} catch (err) {
  report(err);
  process.exit(1);
}
`;

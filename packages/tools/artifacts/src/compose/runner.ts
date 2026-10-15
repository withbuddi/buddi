/**
 * `run.mjs`: what the confined child Node runs (docs/files.md, "Composed
 * documents"). Written into each run's work folder beside `program.mjs`,
 * and the attachments. The plan — where the libraries are — comes on fd 4
 * and is never a file the program could read.
 *
 * It resolves every bare import itself — a program's `docx`,
 * `pptxgenjs` or `write-excel-file` (its universal build), and their own
 * dependencies — to the real folders buddi granted (`libraries.ts`),
 * refusing any other package a program names;
 * calls the program's default export with `ctx`; and sends what came back
 * to buddi on fd 3, framed (a type byte, a 4-byte length, the payload): `B`
 * the file's bytes, `E` an error as JSON. stdout and stderr stay the
 * program's console.
 */
export const RUNNER_SOURCE = String.raw`// buddi's compose runner. The program is program.mjs; this file is buddi's.
import { registerHooks, isBuiltin } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { closeSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const work = path.dirname(fileURLToPath(import.meta.url));
// The plan comes on fd 4, read whole and closed: it names buddi's install paths, which the program never sees.
const plan = JSON.parse(readFileSync(4, 'utf8'));
closeSync(4);
const OUT = 3;
// Its own deadline, kept here as well as in buddi: a child whose buddi went away (a restart) and that only
// waits uses no CPU, so the CPU limit never stops it. Unref'd: it never keeps a finished run alive.
const exit = process.exit.bind(process);
if (Number.isFinite(plan.deadlineMs)) setTimeout(() => exit(124), plan.deadlineMs).unref();

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
  const text = (value) => (typeof value === 'string' ? value.slice(0, 16384) : undefined);
  frame('E', Buffer.from(JSON.stringify({
    name: text(e.name), message: text(String(e.message)), code: text(denied ? denied.code : e.code),
    permission: text(denied ? denied.permission : e.permission), builtin: text(denied ? denied.builtin : undefined),
    stack: text(String(e.stack ?? '')), ...extra,
  })));
}

const dirs = Object.keys(plan.deps).sort((a, b) => b.length - a.length);
function ownerOf(parentURL) {
  if (!parentURL || !parentURL.startsWith('file:')) return null;
  const file = fileURLToPath(parentURL);
  for (const dir of dirs) if (file === dir || file.startsWith(dir + path.sep)) return dir;
  return null;
}
// The built-ins a program and its library may load: what docx, pptxgenjs and write-excel-file were traced to need, and
// nothing that reaches outside (no fs, net, child_process, worker_threads, vm, sqlite, inspector, module…).
const BUILTINS = new Set(plan.builtins);
// pptxgenjs imports fs and https at every write, to read images by path or URL; it gets a module that refuses.
const STUBBED = new Set(['fs', 'https']);
const STUB = 'buddi-stub:';
function refusedBuiltin(name) {
  const err = new Error('a compose program may not load node:' + name);
  err.code = 'ERR_ACCESS_DENIED';
  err.permission = 'Builtin';
  err.builtin = name;
  return err;
}
// Where code may come from: a file inside the work folder or a granted library, or an allowed built-in.
// Never a data: or blob: URL (code from a string, past --disallow-code-generation-from-strings), never anything else.
const roots = [work, ...Object.keys(plan.deps)];
function allowedURL(url) {
  if (url.startsWith('node:')) return BUILTINS.has(url.slice(5).split('/')[0]);
  if (!url.startsWith('file:')) return false;
  let file;
  try { file = fileURLToPath(url); } catch { return false; }
  return roots.some((root) => file === root || file.startsWith(root + path.sep));
}
function refusedURL(url) {
  const err = new Error('a compose program may load code only from its library, not from ' + (url.split(':')[0] || 'there') + ': URLs');
  err.code = 'ERR_ACCESS_DENIED';
  err.permission = 'Code';
  return err;
}
function checked(result) {
  if (!result || typeof result.url !== 'string' || !allowedURL(result.url)) throw refusedURL(result && result.url || '');
  return result;
}
const ASYNC_ZIP = plan.top['write-excel-file'] ? pathToFileURL(path.join(plan.top['write-excel-file'], 'modules', 'zip', 'zipToArrayBuffer.js')).href : null;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const next = (spec, ctx) => checked(nextResolve(spec, ctx));
    if (isBuiltin(specifier)) {
      const name = specifier.replace(/^node:/, '');
      const root = name.split('/')[0];
      if (BUILTINS.has(root)) return next(specifier, context);
      const owner = ownerOf(context.parentURL);
      if (owner !== null && owner === plan.top.pptxgenjs && STUBBED.has(name)) return { url: STUB + name, shortCircuit: true };
      throw refusedBuiltin(name);
    }
    if (specifier.startsWith('.') || path.isAbsolute(specifier) || /^[a-z][a-z0-9+.-]+:/i.test(specifier)) {
      return next(specifier, context);
    }
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    const owner = ownerOf(context.parentURL);
    const dir = owner === null ? plan.top[name] : plan.deps[owner][name];
    if (!dir) {
      const err = new Error(owner === null
        ? 'a compose program can import only ' + Object.keys(plan.top).join(' or ') + ' (and a few node: built-ins: ' + plan.builtins.join(', ') + '), not "' + name + '"'
        : "Cannot find package '" + name + "'");
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
    let sub = specifier.slice(name.length);
    if (owner === null && name === 'write-excel-file') {
      // Its universal build only (toBlob, fflate): the node build writes files and streams, the browser one needs a page.
      if (sub === '') sub = '/universal';
      if (sub !== '/universal') {
        const err = new Error("import writeXlsxFile from 'write-excel-file' (its universal build: await writeXlsxFile(sheets, options).toBlob()); write-excel-file" + sub + ' is not available to a compose program');
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      }
    }
    // require() follows the package's main by path; import resolves its exports from inside its real folder.
    if (context.conditions && context.conditions.includes('require')) return next(sub ? path.join(dir, sub) : dir, context);
    // fflate as write-excel-file loads it: its plain build; the Node one reaches for node:module and worker threads.
    const plain = owner !== null && owner === plan.top['write-excel-file'] && name === 'fflate';
    const conditions = plain && context.conditions ? context.conditions.filter((c) => c !== 'node' && c !== 'module-sync') : context.conditions;
    return next(name + sub, { ...context, conditions, parentURL: pathToFileURL(path.join(dir, 'package.json')).href });
  },
  load(url, context, next) {
    if (!url.startsWith(STUB) && !allowedURL(url)) throw refusedURL(url);
    // write-excel-file zips with fflate's async zip, which starts a worker for a part over 160 KB; there are none here.
    if (url === ASYNC_ZIP) {
      return {
        format: 'module', shortCircuit: true,
        source: "import zipSync from './zipToArrayBufferSync.js';\nexport default function zipToArrayBuffer(files) { return Promise.resolve().then(() => zipSync(files)); }\n",
      };
    }
    if (url.startsWith(STUB)) {
      const name = url.slice(STUB.length);
      return {
        format: 'module', shortCircuit: true,
        source: 'const refuse = () => { throw new Error("a compose program cannot read files or the network; images come in ctx.files"); };\n'
          + 'const stub = new Proxy({}, { get: (_t, key) => key === "then" ? undefined : refuse });\n'
          + 'export default stub;\nexport const promises = stub;\n// node:' + name + '\n',
      };
    }
    return next(url, context);
  },
});

// What reaches around the resolver goes before the program runs: built-ins by name, native bindings,
// addons, the diagnostic report (it writes files), and the network globals.
for (const key of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'report', 'mainModule']) {
  try { delete process[key]; } catch { /* not configurable */ }
  try { if (key in process) Object.defineProperty(process, key, { value: undefined, configurable: false, writable: false }); } catch { /* kept */ }
}
for (const key of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request', 'Response', 'Headers']) {
  try { delete globalThis[key]; } catch { /* not configurable */ }
}

process.on('unhandledRejection', (err) => { report(err); process.exit(1); });
process.on('uncaughtException', (err) => { report(err); process.exit(1); });

function describe(value) {
  if (value === null || value === undefined) return String(value);
  const name = value && value.constructor && value.constructor.name;
  if (name === 'Document' || name === 'File') return 'a docx Document (pass it to Packer.toBuffer(doc) and return that)';
  if (name === 'PptxGenJS') return 'the presentation itself (return await pres.write({ outputType: "nodebuffer" }))';
  if (name === 'Blob') return 'a Blob (return Buffer.from(await blob.arrayBuffer()))';
  if (value && typeof value.toBlob === 'function') return 'what writeXlsxFile returns (return Buffer.from(await (await writeXlsxFile(sheets, options).toBlob()).arrayBuffer()))';
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
    report(new Error('the program has no default export: it must be \`export default async (ctx) => { … return <bytes> }\`'), { shape: true });
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

/**
 * JSON Schema tool inputs (buddi-planning/specs/mcp-client.md §3, §7).
 *
 * A tool may describe its input with JSON Schema instead of zod: a remote MCP
 * server's tools arrive that way, and rewriting a schema into zod would lose
 * what the server itself validates. This module turns such a schema into the
 * same `safeParse` shape a zod schema has, so the registry, the executor and
 * the approval envelope treat both alike: what is validated is what is
 * canonicalised, hashed and later executed.
 *
 * The validator is Ajv 8. It compiles a schema to a function with `new
 * Function`; there is no interpreting mode. What makes that acceptable for a
 * schema buddi did not write:
 *
 *  - Ajv 8's code generator never splices a schema value into code: every
 *    value goes through its `_`/`str` templates, which quote and escape it
 *    (the v8 rewrite exists largely to make untrusted schemas safe to compile).
 *  - The schema is checked against its meta-schema before compiling, bounded
 *    in size and depth, and may not reach anything outside itself: no remote
 *    `$ref`, no `$data`, schemas are not added to a shared store by `$id`.
 *  - A `pattern` is compiled by an engine that refuses long patterns, which
 *    bounds the obvious catastrophic-backtracking cases a hostile server could
 *    plant; an argument is data a model wrote, bounded by the tool call.
 *  - Validation never coerces types or removes properties; it fills declared
 *    defaults on a copy, never on the caller's object.
 */
import AjvModule, { type ValidateFunction } from 'ajv';
import Ajv2019Module from 'ajv/dist/2019.js';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

/** A JSON Schema document, as plain data (draft-07, 2019-09 or 2020-12). */
export type JSONSchema7 = { [key: string]: unknown };

type AjvLike = InstanceType<typeof AjvModule.default>;
type AjvCtor = new (opts: Record<string, unknown>) => AjvLike;

// CommonJS default interop: the class is the module or its `default`.
const interop = <T>(m: unknown): T => ((m as { default?: T }).default ?? m) as T;
const Draft7 = interop<AjvCtor>(AjvModule);
const Draft2019 = interop<AjvCtor>(Ajv2019Module);
const Draft2020 = interop<AjvCtor>(Ajv2020Module);
const addFormats = interop<(ajv: AjvLike) => void>(addFormatsModule);

export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_SCHEMA_DEPTH = 32;
const MAX_PATTERN_LENGTH = 512;

const patternEngine = Object.assign(
  (pattern: string, flags: string): RegExp => {
    if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`pattern longer than ${MAX_PATTERN_LENGTH} characters`);
    return new RegExp(pattern, flags);
  },
  { code: 'new RegExp' },
);

type Draft = '07' | '2019' | '2020';
const instances = new Map<Draft, AjvLike>();

function ajvFor(draft: Draft): AjvLike {
  let ajv = instances.get(draft);
  if (ajv === undefined) {
    const Ctor = draft === '2020' ? Draft2020 : draft === '2019' ? Draft2019 : Draft7;
    ajv = new Ctor({
      strict: false,
      allErrors: false,
      useDefaults: true,
      coerceTypes: false,
      removeAdditional: false,
      addUsedSchema: false,
      validateSchema: true,
      $data: false,
      logger: false,
      code: { regExp: patternEngine },
    });
    addFormats(ajv);
    instances.set(draft, ajv);
  }
  return ajv;
}

/** Which draft a schema asks for. MCP's default when it says nothing is 2020-12. */
function draftsFor(schema: JSONSchema7): Draft[] {
  const declared = typeof schema.$schema === 'string' ? schema.$schema : '';
  if (declared.includes('2020-12')) return ['2020'];
  if (declared.includes('2019-09')) return ['2019'];
  if (/draft-0[67]/.test(declared)) return ['07'];
  return ['2020', '07'];
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_SCHEMA_DEPTH) return depth;
  if (value === null || typeof value !== 'object') return depth;
  let max = depth;
  for (const child of Object.values(value as object)) {
    max = Math.max(max, depthOf(child, depth + 1));
    if (max > MAX_SCHEMA_DEPTH) break;
  }
  return max;
}

export interface SchemaIssue { path: (string | number)[]; message: string }
export type SafeParseResult =
  | { success: true; data: unknown }
  | { success: false; error: { issues: SchemaIssue[] } };

/** A compiled JSON Schema, shaped like a zod schema where core asks it anything. */
export interface JsonSchemaValidator {
  safeParse(value: unknown): SafeParseResult;
  /** Forget the compiled function (a tool unregistered). */
  dispose(): void;
}

/**
 * Compile `schema`, or throw a sentence naming what is wrong with it. The
 * schema is copied first, so a caller that later mutates its object changes
 * nothing that was checked.
 */
export function compileJsonSchema(schema: JSONSchema7): JsonSchemaValidator {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('the input schema is not an object');
  let text: string;
  try { text = JSON.stringify(schema); } catch { throw new Error('the input schema is not plain JSON'); }
  if (Buffer.byteLength(text) > MAX_SCHEMA_BYTES) throw new Error(`the input schema is larger than ${MAX_SCHEMA_BYTES} bytes`);
  const copy = JSON.parse(text) as JSONSchema7;
  if (depthOf(copy) > MAX_SCHEMA_DEPTH) throw new Error(`the input schema is nested deeper than ${MAX_SCHEMA_DEPTH}`);
  if (/"\$data"\s*:/.test(text)) throw new Error('the input schema uses $data, which buddi does not allow');
  let lastError: unknown;
  for (const draft of draftsFor(copy)) {
    const ajv = ajvFor(draft);
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(copy);
    } catch (err) {
      lastError = err;
      ajv.removeSchema(copy);
      continue;
    }
    return {
      safeParse(value) {
        let data: unknown;
        try { data = value === undefined ? undefined : structuredClone(value); }
        catch { return { success: false, error: { issues: [{ path: [], message: 'arguments must be plain JSON' }] } }; }
        if (validate(data)) return { success: true, data };
        const issues = (validate.errors ?? []).map((e) => ({
          path: e.instancePath.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')),
          message: e.message ?? `fails ${e.keyword}`,
        }));
        return { success: false, error: { issues: issues.length > 0 ? issues : [{ path: [], message: 'does not match the input schema' }] } };
      },
      dispose() { ajv.removeSchema(copy); },
    };
  }
  throw new Error(`the input schema does not compile: ${lastError instanceof Error ? lastError.message.slice(0, 300) : String(lastError)}`);
}

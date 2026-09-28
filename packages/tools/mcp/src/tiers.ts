/**
 * How a server's tool becomes a buddi tool (docs/connections.md, "Review"):
 * its name under `mcp.<connection>.`, its tier from the server's annotations,
 * whether its input schema can be used at all, and the hash the review keeps.
 */
import { createHash } from 'node:crypto';
import type { JSONSchema7 } from '@buddi/core/plugin';

/** A tool as the server lists it (`tools/list`), the fields buddi reads. */
export interface ServerTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JSONSchema7;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export type ToolTier = 'auto' | 'gated';

/** The plugin's namespace: `mcp.<connection>.<tool>`. */
export const NAMESPACE = 'mcp';

/**
 * The tier the review assigns (spec §3): `readOnlyHint: true` is `auto`;
 * everything else is gated. `destructiveHint: true` is gated and never
 * remembered; a tool with no annotations is gated like any other write.
 */
export function tierOf(tool: Pick<ServerTool, 'annotations'>): { tier: ToolTier; destructive: boolean } {
  const a = tool.annotations;
  const destructive = a?.destructiveHint === true;
  if (a?.readOnlyHint === true && !destructive) return { tier: 'auto', destructive: false };
  return { tier: 'gated', destructive };
}

/** Whether the server said anything at all about this tool's effect. */
export function annotated(tool: Pick<ServerTool, 'annotations'>): boolean {
  const a = tool.annotations;
  return a !== undefined && (a.readOnlyHint !== undefined || a.destructiveHint !== undefined || a.idempotentHint !== undefined || a.openWorldHint !== undefined);
}

export const SLUG = /^[a-z][a-z0-9_-]{0,23}$/;

/** A slug from a server's name or host: `GitHub MCP Server` → `github`. */
export function suggestSlug(name: string, taken: ReadonlySet<string> = new Set()): string {
  const words = name.toLowerCase().replace(/\b(mcp|server|remote|official)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let base = (words.join('_') || 'service').replace(/^[^a-z]+/, '').slice(0, 20) || 'service';
  if (!SLUG.test(base)) base = 'service';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const next = `${base}_${n}`;
    if (!taken.has(next)) return next;
  }
  return `${base}_${Date.now() % 10000}`;
}

/**
 * The last part of `mcp.<connection>.<tool>`: what a model provider can carry
 * (letters, digits, `_`, `-`), unique within the connection. The server's own
 * name is kept beside it and is what a call sends.
 */
export function localNames(names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    let base = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'tool';
    let local = base;
    for (let n = 2; used.has(local.toLowerCase()); n++) local = `${base.slice(0, 60)}_${n}`;
    used.add(local.toLowerCase());
    out.set(name, local);
  }
  return out;
}

/** JSON with object keys sorted, so equal values hash equal. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * Why an input schema cannot be registered, or null when it can. `compile`
 * is the registry's own validator (core's `compileJsonSchema`), when the
 * caller has it; the shape rules are checked here either way.
 */
export function schemaProblem(schema: unknown, compile?: (schema: JSONSchema7) => void): string | null {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return 'its input schema is not an object';
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object') return 'its input is not an object';
  if (s.anyOf !== undefined || s.oneOf !== undefined || s.allOf !== undefined) return 'its input is a choice of shapes, which model providers refuse';
  try {
    compile?.(s);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** One tool, as reviewed: what changes it changes what the owner read. */
export function toolHash(tool: ServerTool): string {
  return sha256(stableJson({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? null,
    annotations: tool.annotations ?? null,
  }));
}

/** The whole list, order-free. */
export function listHash(tools: readonly ServerTool[]): string {
  return sha256(tools.map(toolHash).sort().join('\n'));
}

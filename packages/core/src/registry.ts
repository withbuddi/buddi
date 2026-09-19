/**
 * Tool registry — the only thing core knows about tools.
 *
 * Fail-closed rules (ARCHITECTURE.md, "Trust model"):
 *  - Unknown tool          -> refuse ('unknown-tool')
 *  - Invalid arguments     -> refuse ('invalid-args'), zod decides
 *  - Tier 'gated'          -> never executes here. The call becomes an immutable
 *                             action plus a pending approval, and the model is
 *                             told 'approval-required' with the action id. The
 *                             only path that ever runs it is `executeApproved`.
 *  - Tier 'session'      -> require a live owner request and runtime-resolved
 *                          agent grant; the driver enforces ownership/budgets.
 *  - Tier 'draft'        -> refuse ('tier-not-executable').
 *  - Tool threw            -> 'tool-error'; defects never surface as success.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import { decideApproval } from './actions/approvals.js';
import { executeApproved } from './actions/execute.js';
import { findToolPermission } from './actions/permissions.js';
import { createAction } from './actions/store.js';
import type { ExecutableTool } from './actions/execute.js';
import type { EffectDescription, PluginManifest, Tier, ToolContext, ToolDefinition } from './tools.js';
import { parseViewDescriptors, type ViewDescriptor } from './views.js';

/** Tiers this build executes directly, with no human in the loop. */
export const EXECUTABLE_TIERS: readonly Tier[] = ['auto'];

/** Tiers that become an action and wait for the owner. */
export const GATED_TIERS: readonly Tier[] = ['gated'];

export type ToolSpec = {
  name: string;
  description: string;
  tier: Tier;
  /** JSON Schema derived from the tool's zod input schema. */
  inputSchema: Record<string, unknown>;
};

export type InvokeResult<O = unknown> =
  | { ok: true; output: O }
  | {
      /**
       * The call was recorded and is waiting for the owner. Not an error and
       * not a refusal: the model is told which action it is waiting on, and the
       * run suspends until a decision arrives.
       */
      ok: false;
      reason: 'approval-required';
      actionId: string;
      preview: string;
      message: string;
    }
  | {
      ok: false;
      reason: 'unknown-tool' | 'invalid-args' | 'tier-not-executable' | 'tool-error' | 'session-not-authorized';
      message: string;
    };

type Entry = {
  tool: ToolDefinition<any, any>;
  plugin: string;
  version: string;
  /** Derived once at registration — see `toolInputSchema`. */
  inputSchema: Record<string, unknown>;
};

/**
 * Every provider this platform speaks to requires a tool's parameters to be a
 * plain *object* schema, and both are stricter than JSON Schema itself:
 * Anthropic refuses a request whose `input_schema.type` is missing
 * (`tools.N.custom.input_schema.type: Field required`) and refuses it again if
 * you merely add the type to a union (`input_schema does not support oneOf,
 * allOf, or anyOf at the top level`); OpenAI wants the same of
 * `function.parameters`. That requirement is a property of the whole tool
 * surface, not of one adapter, so it is settled here — the registry is the
 * single place every provider gets its schemas from, and a third-party plugin
 * with an exotic zod schema must not be able to break every conversation for
 * the agent that installs it.
 *
 * Two shapes are in play and they are not the same mistake:
 *
 *  - A **union of object variants** — `z.discriminatedUnion(...)`, or a
 *    `z.union([z.object(), z.object()])` — is a legitimate and useful input.
 *    `zodToJsonSchema` renders it as a bare `anyOf` because there is nothing
 *    else it could do, but the input *is* an object, so it is flattened into
 *    one: every branch's properties merged, required narrowed to the keys every
 *    branch requires, and a key that differs across branches described by the
 *    alternatives (which are legal *below* the top level). Repaired.
 *  - A tool whose input genuinely is not an object — a top-level string, array
 *    or number, or an unconstrained `z.unknown()` — cannot be called through
 *    any provider at all. There is no honest repair, so it is refused at
 *    registration, naming the tool and the plugin, which is the last boundary
 *    where the bug can still be attributed to whoever wrote it.
 *
 * The flattening is a *description*, never a relaxation: `invoke` parses every
 * call with the tool's own zod schema, so a model that mixes two variants is
 * still refused with zod's message. What it costs is a hint — the JSON Schema
 * no longer ties one variant's fields to another's — and what it buys is a
 * request the API will accept at all.
 */
type JsonSchema = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The branch list of a union schema, if this is one. */
function unionBranches(schema: JsonSchema): JsonSchema[] | undefined {
  const branches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  if (!branches.every(isPlainObject)) return undefined;
  return branches as JsonSchema[];
}

/**
 * Every object variant this schema can be, or undefined if it can be something
 * that is not an object. Nested unions are flattened as they are walked.
 */
function objectVariants(schema: JsonSchema): JsonSchema[] | undefined {
  if (schema.type === 'object') return [schema];
  const branches = unionBranches(schema);
  if (!branches) return undefined;
  const variants: JsonSchema[] = [];
  for (const branch of branches) {
    const nested = objectVariants(branch);
    if (!nested) return undefined;
    variants.push(...nested);
  }
  return variants;
}

/** One property schema standing for several — collapsing literals to an enum. */
function mergeProperty(variants: JsonSchema[]): JsonSchema {
  const unique: JsonSchema[] = [];
  for (const variant of variants) {
    if (!unique.some((seen) => JSON.stringify(seen) === JSON.stringify(variant))) {
      unique.push(variant);
    }
  }
  if (unique.length === 1) return unique[0]!;
  // A discriminator: `{type:'string',const:'a'}` per branch reads far better to
  // a model as one enum than as a pile of one-value alternatives.
  const consts = unique.map((v) => v.const);
  if (
    consts.every((c) => c !== undefined) &&
    unique.every((v) => Object.keys(v).every((k) => k === 'const' || k === 'type' || k === 'description'))
  ) {
    const types = new Set(unique.map((v) => v.type).filter((t) => t !== undefined));
    const description = unique.find((v) => typeof v.description === 'string')?.description;
    return {
      ...(types.size === 1 ? { type: [...types][0] } : {}),
      enum: consts,
      ...(description === undefined ? {} : { description }),
    };
  }
  return { anyOf: unique };
}

/** One object schema covering every variant — see the note above. */
function flattenVariants(variants: JsonSchema[]): JsonSchema {
  const properties: Record<string, JsonSchema[]> = {};
  for (const variant of variants) {
    const props = isPlainObject(variant.properties) ? variant.properties : {};
    for (const [key, value] of Object.entries(props)) {
      if (!isPlainObject(value)) continue;
      (properties[key] ??= []).push(value);
    }
  }
  // Required only where *every* variant requires it: anything narrower would
  // have the schema reject a call zod would accept.
  const required = Object.keys(properties).filter((key) =>
    variants.every((v) => Array.isArray(v.required) && (v.required as string[]).includes(key)),
  );
  const description = variants.find((v) => typeof v.description === 'string')?.description;
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, vs]) => [key, mergeProperty(vs)]),
    ),
    ...(required.length > 0 ? { required } : {}),
    ...(description === undefined ? {} : { description }),
  };
}

/** How a refused schema is described in the error — enough to find the bug. */
function describeSchema(schema: JsonSchema): string {
  if (typeof schema.type === 'string') return `type '${schema.type}'`;
  if (Array.isArray(schema.type)) return `type ${JSON.stringify(schema.type)}`;
  if (unionBranches(schema)) return 'a union whose branches are not all objects';
  return `no type at all (${JSON.stringify(schema).slice(0, 120)})`;
}

/**
 * The JSON Schema for one tool's input, guaranteed to be a plain object schema
 * with no union at the top level.
 *
 * Throws if it cannot be — the loud failure at the boundary where the offending
 * plugin can still be named.
 */
export function toolInputSchema(tool: ToolDefinition<any, any>, plugin: string): JsonSchema {
  const schema = zodToJsonSchema(tool.input, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as JsonSchema;

  if (schema.type === 'object' && !unionBranches(schema)) return schema;
  const variants = objectVariants(schema);
  if (variants) return flattenVariants(variants);
  throw new Error(
    `tool ${tool.name} (plugin ${plugin}) declares an input that is not an object: ` +
      `${describeSchema(schema)}. Tool inputs must be an object schema (or a union of ` +
      `object schemas) — every model provider requires it.`,
  );
}

export class ToolRegistry {
  readonly #tools = new Map<string, Entry>();
  readonly #manifests = new Map<string, PluginManifest>();

  register(manifest: PluginManifest): void {
    if (this.#manifests.has(manifest.name)) {
      throw new Error(`plugin already registered: ${manifest.name}`);
    }
    // Derived before anything is stored, so a plugin that fails either check
    // leaves the registry exactly as it was.
    const schemas = new Map<string, Record<string, unknown>>();
    for (const tool of manifest.tools) {
      const existing = this.#tools.get(tool.name);
      if (existing) {
        throw new Error(
          `tool name collision: ${tool.name} (${existing.plugin} and ${manifest.name})`,
        );
      }
      // The provider contract, checked where the plugin can still be named.
      schemas.set(tool.name, toolInputSchema(tool, manifest.name));
    }
    // View descriptors are the one contribution that leaves this process and is
    // read by code that cannot check it — the browser draws what it is handed.
    // So they are parsed here, at load, and a bad one is a startup error naming
    // the plugin and the tool rather than an empty panel in the page.
    if (manifest.views !== undefined) {
      parseViewDescriptors(manifest.views, {
        plugin: manifest.name,
        tools: manifest.tools.map((t) => t.name),
      });
    }
    this.#manifests.set(manifest.name, manifest);
    for (const tool of manifest.tools) {
      this.#tools.set(tool.name, {
        tool,
        plugin: manifest.name,
        version: manifest.version,
        inputSchema: schemas.get(tool.name)!,
      });
    }
  }

  manifests(): PluginManifest[] {
    return [...this.#manifests.values()];
  }

  /**
   * Every view descriptor the installed plugins contribute, in registration
   * order. This is what the dashboard asks for: the browser owns the renderers
   * and learns the domain mapping from here, so an installation with no finance
   * plugin serves no finance mapping and the page has no idea it ever existed.
   */
  views(): ViewDescriptor[] {
    return [...this.#manifests.values()].flatMap((m) => m.views ?? []);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  isSequential(name: string): boolean {
    return this.#tools.get(name)?.tool.sequential === true;
  }

  waitsForOwner(name: string): boolean {
    return this.#tools.get(name)?.tool.waitsForOwner === true;
  }

  async image(name: string, output: unknown, ctx: ToolContext): Promise<{ mime: string; data: string } | undefined> {
    return this.#tools.get(name)?.tool.image?.(output, ctx);
  }

  /**
   * Tool specs for the model, in registration order.
   *
   * The schema was derived and checked at `register()`, so what a provider is
   * handed here is always an object schema — see `toolInputSchema`.
   */
  list(): ToolSpec[] {
    return [...this.#tools.values()].map(({ tool, inputSchema }) => ({
      name: tool.name,
      description: tool.description,
      tier: tool.tier,
      inputSchema,
    }));
  }

  /**
   * The registered tool, for the **Executor only** (`executeApproved`).
   *
   * It hands back `execute` with no tier check, which is exactly why nothing
   * else may call it: the tier check is `invoke`, and the only legitimate
   * bypass is an approval row saying the owner said yes to this precise action.
   */
  lookup(name: string): ExecutableTool | undefined {
    const entry = this.#tools.get(name);
    if (!entry) return undefined;
    const { tool, version } = entry;
    return {
      name: tool.name,
      version,
      ...(tool.reusableApproval ? { reusableApproval: true } : {}),
      input: tool.input,
      ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
      ...(tool.describe ? { describe: (input: unknown, ctx: ToolContext) => tool.describe!(input, ctx) } : {}),
      execute: (input: unknown, ctx: ToolContext) => tool.execute(input, ctx),
    };
  }

  async invoke(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<InvokeResult> {
    ctx.signal?.throwIfAborted();
    const entry = this.#tools.get(name);
    if (!entry) {
      return { ok: false, reason: 'unknown-tool', message: `unknown tool: ${name}` };
    }
    const { tool, version } = entry;

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-args',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      };
    }

    if (GATED_TIERS.includes(tool.tier)) {
      if (tool.reusableApproval && (ctx.delegationDepth ?? 0) > 0) {
        return { ok: false, reason: 'tool-error', message: 'Host execution requires a direct owner conversation; delegates do not inherit host permissions.' };
      }
      return this.#requestApproval(tool, version, parsed.data, ctx);
    }

    if (tool.tier === 'session' && (!ctx.ownerRequest ||
      ctx.ownerRequest.expiresAt <= Date.now() || !ctx.sessionTools?.includes(name) ||
      !ctx.agentId || !ctx.conversationId || (ctx.delegationDepth ?? 0) > 0)) {
      return { ok: false, reason: 'session-not-authorized',
        message: 'This tool requires a current owner request and an explicit agent grant; ask the owner directly.' };
    }

    if (tool.tier !== 'session' && !EXECUTABLE_TIERS.includes(tool.tier)) {
      return {
        ok: false,
        reason: 'tier-not-executable',
        message: `tool ${name} is tier '${tool.tier}'; only ${EXECUTABLE_TIERS.join(
          ', ',
        )} executes in this build`,
      };
    }

    try {
      const output = await tool.execute(parsed.data, ctx);
      return { ok: true, output };
    } catch (err) {
      return {
        ok: false,
        reason: 'tool-error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * A gated call: describe the effect, record the immutable action, ask.
   *
   * Order matters and is the whole point — the action object exists *before*
   * anyone is asked, so the preview the owner sees and the thing that can later
   * execute are the same recorded object, hash included.
   */
  async #requestApproval(
    tool: ToolDefinition<any, any>,
    version: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<InvokeResult> {
    let described: EffectDescription;
    try {
      described = tool.describe
        ? await tool.describe(args, ctx)
        : // No `describe`: the canonical arguments *are* the envelope and the
          // preview is their JSON. Honest, complete, and plainly a fallback.
          { envelope: args, preview: `${tool.name} ${JSON.stringify(args ?? null)}` };
    } catch (err) {
      return {
        ok: false,
        reason: 'tool-error',
        message: `${tool.name} could not describe this effect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    try {
      const action = await createAction(ctx.db, {
        tool: tool.name,
        toolVersion: version,
        agentId: ctx.agentId ?? 'unknown',
        conversationId: ctx.conversationId ?? null,
        jobId: ctx.jobId ?? null,
        canonicalArgs: args,
        envelope: described.envelope,
        preview: described.preview,
        now: ctx.now(),
      });
      const permission = tool.reusableApproval
        ? await findToolPermission(ctx.db, ctx, tool.name, version) : undefined;
      if (permission) {
        const decision = await decideApproval(ctx.db, { actionId: action.id, decision: 'approved',
          by: ctx.ownerId, via: `permission:${permission.id}`, now: ctx.now() });
        if (!decision.ok) throw new Error(decision.message);
        const executed = await executeApproved(ctx.db, { actionId: action.id, registry: this,
          ctx, worker: 'standing-permission', now: ctx.now() });
        return executed.ok ? { ok: true, output: executed.result }
          : { ok: false, reason: 'tool-error', message: executed.message };
      }
      return {
        ok: false,
        reason: 'approval-required',
        actionId: action.id,
        preview: action.preview,
        message: `awaiting owner approval (action ${action.id})`,
      };
    } catch (err) {
      // Recording the action failed, so there is nothing to approve and
      // certainly nothing to execute. Fail closed, loudly.
      return {
        ok: false,
        reason: 'tool-error',
        message: `could not record the approval request for ${tool.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
}

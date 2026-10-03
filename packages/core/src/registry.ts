/**
 * Tool registry — the only thing core knows about tools.
 *
 * Fail-closed rules (docs/architecture.md, "Trust model"):
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
import { asksEachTime, decideApproval } from './actions/approvals.js';
import { executeApproved } from './actions/execute.js';
import { findToolPermission } from './actions/permissions.js';
import { missionExtrasProblem } from './tools.js';
import { createAction } from './actions/store.js';
import type { ExecutableTool } from './actions/execute.js';
import type { CarryOverRequest, EffectDescription, PluginManifest, PreviewProvider, Tier, CoreToolContext, ToolDefinition } from './tools.js';
import { isToolRefusal } from './tools.js';
import { parseViewDescriptors, type ViewDescriptor } from './views.js';
import { OWNER_AGENT_ID, parsePageContributions, type PageDescriptor, type PageQuery, type WorkspaceFiles } from './pages.js';
import type { HomeContribution } from './home.js';
import { parseMetrics, metricContext, type RegisteredMetric } from './metrics.js';
import { parseWidgets, type RegisteredWidget } from './widgets.js';
import { UNTRUSTED_KINDS, type UntrustedKind } from './learning/types.js';
import { hostBindingOf, networkAreaOf, readOnlyHostOf, registerHostOf, releaseHostBinding, withPluginHost, type HostBinding } from './host/build.js';
import { registerSecretDestination, unregisterSecretDestinations } from './secrets/destinations.js';
import { primeSecretScrubber, scrubDeep, scrubText } from './secrets/scrub.js';
import { compileJsonSchema, type JsonSchemaValidator } from './json-schema.js';
import { parsePluginAuthor } from './plugin/author.js';
import { PluginCallRefusal, exportsProblem, readinessOf, type PluginReadiness } from './plugin/requires.js';
import { satisfiesRange } from './semver.js';
import { routeProviderProblem, type RegisteredRouteProvider } from './routes.js';
import type { HostFacts } from './host/build.js';

/** Tiers this build executes directly, with no human in the loop. */
export const EXECUTABLE_TIERS: readonly Tier[] = ['auto'];

/** Tiers that become an action and wait for the owner. */
export const GATED_TIERS: readonly Tier[] = ['gated'];

/**
 * The tiers a tool may choose per call (`ToolDefinition.tierFor`).
 *
 * `draft` is missing on purpose: it is a statement about what a tool *is* —
 * something this build does not execute at all — and a tool that decided to be
 * a draft one call in three would be a tool nobody could reason about.
 */
export const PER_CALL_TIERS: readonly Tier[] = ['auto', 'gated', 'session'];

/**
 * Everything the `session` tier asks, in one place.
 *
 * It is asked of a tool that *declares* `session` on every call, whatever a
 * `tierFor` decided that call costs — the declaration is what the runtime
 * resolved a grant from, so it is also what the grant is checked against.
 *
 * Three ways through, and only three (docs/browser.md, "Missions" and
 * "Delegates"):
 *
 *  - **The owner's own run**: a live owner request, depth 0.
 *  - **The owner's run, one level down**: a live owner request and the tool
 *    in `delegatedSession`, which only the delegation tool sets, and only when
 *    the delegating conversation is an owner conversation with a browser
 *    session.
 *  - **An opted-in mission**: no owner request, the tool declares
 *    `unattended`, and the mission executor listed it in `unattendedSession`.
 *    Depth 0 only: a mission's delegate never browses.
 *
 * Every way also needs the agent's grant (`sessionTools`), an agent and a
 * conversation.
 */
function sessionAuthorized(name: string, ctx: CoreToolContext, unattended = false): boolean {
  if (!ctx.sessionTools?.includes(name) || !ctx.agentId || !ctx.conversationId) return false;
  const depth = ctx.delegationDepth ?? 0;
  if (ctx.ownerRequest) {
    if (ctx.ownerRequest.expiresAt <= Date.now()) return false;
    return depth === 0 || (depth === 1 && ctx.delegatedSession?.includes(name) === true);
  }
  return unattended && depth === 0 && ctx.unattendedSession?.includes(name) === true;
}

/** A page descriptor, and the plugin whose route it lives under. */
export type RegisteredPage = PageDescriptor & { plugin: string };

/** A page query, and the plugin whose route it answers on. */
export type RegisteredQuery = PageQuery & { plugin: string };

export type ToolSpec = {
  name: string;
  description: string;
  tier: Tier;
  /** JSON Schema derived from the tool's zod input, or the tool's own JSON Schema as written. */
  inputSchema: Record<string, unknown>;
};

/** What core asks of a tool's input, zod or JSON Schema alike. */
export interface InputValidator {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
}

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
      reason: 'unknown-tool' | 'invalid-args' | 'tier-not-executable' | 'tool-error' | 'session-not-authorized' | 'ask-only';
      message: string;
    };

type Entry = {
  tool: ToolDefinition<any, any>;
  plugin: string;
  version: string;
  /** Derived once at registration — see `toolInputSchema`. */
  inputSchema: Record<string, unknown>;
  /** The tool's zod schema, or its compiled JSON Schema: what `invoke` and the executor parse with. */
  validator: InputValidator;
  /** Registered through `ctx.buddi.tools` rather than the manifest; removable the same way. */
  runtime?: { dispose?: () => void };
};

/** `<plugin>.<what>`, each part plain: what every provider's name mapping can carry. */
const TOOL_NAME = /^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/;
const MAX_TOOL_NAME = 128;

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
  if (tool.inputSchema !== undefined) {
    /*
     * Passed to the model as written: a server's schema is the server's
     * description of its tool, and rewriting it is exactly what JSON Schema
     * inputs exist to avoid. It must already be what every provider accepts —
     * an object at the top, no union there — or it is refused here, naming it.
     */
    const schema = tool.inputSchema as JsonSchema;
    if (!isPlainObject(schema) || schema.type !== 'object' || unionBranches(schema) || Array.isArray(schema.allOf)) {
      throw new Error(
        `tool ${tool.name} (plugin ${plugin}) declares an input schema that is not a plain object schema: ` +
          `${isPlainObject(schema) ? describeSchema(schema) : 'not an object'}. The top level must be ` +
          `type "object" with no anyOf, oneOf or allOf — every model provider requires it.`,
      );
    }
    return JSON.parse(JSON.stringify(schema)) as JsonSchema;
  }
  if (tool.input === undefined) {
    throw new Error(`tool ${tool.name} (plugin ${plugin}) declares no input: give it a zod \`input\` or a JSON Schema \`inputSchema\``);
  }
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

/** How long a plugin's setup answer or an export call may take. */
export const PLUGIN_CALL_TIMEOUT_MS = 5_000;

function withinMs<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginCallRefusal(`${what} did not answer within ${Math.round(ms / 1000)} seconds.`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class ToolRegistry {
  readonly #tools = new Map<string, Entry>();
  readonly #manifests = new Map<string, PluginManifest>();
  /** Per plugin, what `parsePageContributions` made of its screens. */
  readonly #pages = new Map<string, PageDescriptor[]>();
  readonly #queries = new Map<string, PageQuery[]>();
  readonly #pageTools = new Map<string, Set<string>>();
  /** Per plugin, the metrics `parseMetrics` checked and made strict. */
  readonly #metrics = new Map<string, RegisteredMetric[]>();
  /** Per plugin, the widgets `parseWidgets` checked, refresh made concrete. */
  readonly #widgets = new Map<string, RegisteredWidget[]>();
  /** Per plugin, what its `ctx.buddi` is bound to (docs/plugin-host-api.md §3). */
  readonly #bindings = new Map<string, HostBinding>();

  /**
   * The context handed to one of `plugin`'s functions: the caller's, with that
   * plugin's `ctx.buddi` on it. Every road from here into plugin code goes
   * through this, so a plugin always sees its own host and never another's.
   */
  #host<C extends CoreToolContext>(plugin: string, ctx: C): C {
    const binding = this.#bindings.get(plugin);
    return binding === undefined ? ctx : withPluginHost(binding, ctx);
  }

  register(manifest: PluginManifest): void {
    if (this.#manifests.has(manifest.name)) {
      throw new Error(`plugin already registered: ${manifest.name}`);
    }
    // Derived before anything is stored, so a plugin that fails either check
    // leaves the registry exactly as it was. The host binding first: a `uses`
    // naming an area this build does not have is a startup error naming the
    // plugin, like every other check here.
    const binding = hostBindingOf(manifest);
    const author = parsePluginAuthor(manifest.author, `plugin ${manifest.name}: author`);
    if (!author.ok) throw new Error(author.message);
    const checked = this.#checkTools(manifest.name, manifest.tools);
    for (const route of manifest.routes ?? []) {
      const problem = routeProviderProblem(route);
      if (problem !== undefined) throw new Error(`plugin ${manifest.name}: ${problem}`);
    }
    // View descriptors are the one contribution that leaves this process and is
    // read by code that cannot check it — the browser draws what it is handed.
    // So they are parsed here, at load, and a bad one is a startup error naming
    // the plugin and the tool rather than an empty panel in the page.
    if (manifest.views !== undefined) {
      parseViewDescriptors(manifest.views, {
        plugin: manifest.name,
        tools: manifest.tools.map((t) => t.name),
        pages: (manifest.pages ?? []).map((p) => p.id),
      });
    }
    // Page descriptors leave this process the same way and are checked the
    // same way — shape, then every query, tool and route they name. What comes
    // back is kept: the queries with their parameters made strict, and the set
    // of tools the pages actually name, which is all the act route may invoke.
    const contributions =
      manifest.pages !== undefined || manifest.queries !== undefined
        ? parsePageContributions({
            plugin: manifest.name,
            ...(manifest.pages ? { pages: manifest.pages } : {}),
            ...(manifest.queries ? { queries: manifest.queries } : {}),
            tools: manifest.tools.map((t) => t.name),
            agents: (manifest.agents ?? []).map((a) => a.id),
          })
        : undefined;
    /*
     * Metrics are checked here for the same reason pages are: a goal set on a
     * badly declared metric is a thing that fails silently on a Tuesday six
     * weeks from now, and the only moment the plugin can still be named is
     * this one. Nothing is stored until every one of them has passed.
     */
    const metrics =
      manifest.metrics === undefined
        ? undefined
        : parseMetrics(manifest.name, manifest.metrics, (id) =>
            [...this.#metrics.values()].some((list) => list.some((m) => m.id === id)),
          );
    // Widgets the same way: a bad id, size or link names the plugin now.
    const widgets =
      manifest.widgets === undefined
        ? undefined
        : parseWidgets(manifest.name, manifest.widgets, {
            pages: (manifest.pages ?? []).map((p) => p.id),
            taken: (id) => [...this.#widgets.values()].some((list) => list.some((w) => w.id === id)),
          });
    const exported = exportsProblem(manifest.name, manifest.exports);
    if (exported !== undefined) throw new Error(exported);
    // A mission's context reads this plugin or one it requires (1.27); its reportMax is bounded.
    const reachable = [manifest.name, ...Object.keys(binding.requires)];
    for (const mission of [...(manifest.missions ?? []), ...(manifest.agents ?? []).flatMap((a) => a.missions ?? [])]) {
      const problem = missionExtrasProblem(mission, reachable);
      if (problem !== undefined) throw new Error(`plugin ${manifest.name}: ${problem}`);
    }
    if (manifest.setup !== undefined && typeof manifest.setup?.produce !== 'function') {
      throw new Error(`plugin ${manifest.name}: setup needs a \`produce(ctx)\` answering { ready, note?, page? }`);
    }
    if (manifest.files !== undefined) {
      const names = new Set((manifest.queries ?? []).map((q) => q.name));
      for (const [role, name] of Object.entries(manifest.files)) {
        if (typeof name !== 'string' || !names.has(name)) {
          throw new Error(`plugin ${manifest.name}: files.${role} names ${String(name)}, which is not a query of this plugin`);
        }
      }
    }
    if (manifest.destinations !== undefined && manifest.destinations.length > 0) {
      if (!binding.uses.includes('secrets')) {
        throw new Error(`plugin ${manifest.name} declares secret destinations but not uses: secrets`);
      }
      for (const destination of manifest.destinations) registerSecretDestination(manifest.name, destination);
    }
    this.#manifests.set(manifest.name, manifest);
    binding.toolsArea = {
      register: (definitions) => this.#addRuntimeTools(manifest.name, definitions),
      unregister: (names) => this.#removeRuntimeTools(manifest.name, names),
      registered: () =>
        [...this.#tools.values()].filter((e) => e.plugin === manifest.name && e.runtime).map((e) => e.tool.name),
    };
    binding.callExport = (target, name, args, facts) => this.#callExport(manifest.name, target, name, args, facts);
    binding.hasPlugin = (target) => {
      const range = binding.requires[target] ?? binding.optional[target];
      const loaded = this.#manifests.get(target);
      return range !== undefined && loaded !== undefined && satisfiesRange(loaded.version, range) === true;
    };
    this.#bindings.set(manifest.name, binding);
    if (metrics) {
      this.#metrics.set(
        manifest.name,
        metrics.map((metric) => ({
          ...metric,
          measure: (params: unknown, ctx: CoreToolContext) => metric.measure(params, this.#host(manifest.name, ctx)),
        })),
      );
    }
    if (widgets && widgets.length > 0) {
      this.#widgets.set(
        manifest.name,
        widgets.map((widget) => ({
          ...widget,
          // Read-only, like a metric: the plugin's db is the page query's pool.
          produce: (ctx: CoreToolContext, request) => widget.produce(this.#host(manifest.name, metricContext(ctx)), request),
          // A setting's choices read when the sheet opens: the same host, the same read-only pool.
          options: async (key: string, ctx: CoreToolContext) => {
            const field = widget.settings?.find((f) => f.key === key);
            if (!field || (field.kind !== 'select' && field.kind !== 'multiselect')) return [];
            if (Array.isArray(field.options)) return field.options;
            return field.options(this.#host(manifest.name, metricContext(ctx)));
          },
        })),
      );
    }
    if (contributions) {
      this.#pages.set(manifest.name, contributions.pages);
      this.#queries.set(
        manifest.name,
        contributions.queries.map((query) => ({
          ...query,
          produce: (params: unknown, ctx: CoreToolContext) => query.produce(params, this.#host(manifest.name, ctx)),
        })),
      );
      this.#pageTools.set(manifest.name, new Set(contributions.tools));
    }
    for (const entry of checked) {
      this.#tools.set(entry.tool.name, { ...entry, plugin: manifest.name, version: manifest.version });
    }
    this.#changed();
    manifest.register?.(registerHostOf(binding));
  }

  /**
   * Take a whole plugin out while buddi runs: the owner disabled it. Its tools
   * (manifest and runtime), pages, queries, views, Home blocks and glances,
   * metrics, sources and sentinels (both are read off `manifests()` on every
   * tick), channels and secret destinations all go at once, and `onChange`
   * fires so every agent's grants are resolved again for its next turn.
   * Returns false when the plugin was not registered here.
   */
  unregister(plugin: string): boolean {
    if (!this.#manifests.has(plugin)) return false;
    for (const [name, entry] of [...this.#tools]) {
      if (entry.plugin !== plugin) continue;
      this.#tools.delete(name);
      entry.runtime?.dispose?.();
    }
    this.#manifests.delete(plugin);
    this.#pages.delete(plugin);
    this.#queries.delete(plugin);
    this.#pageTools.delete(plugin);
    this.#metrics.delete(plugin);
    this.#widgets.delete(plugin);
    const binding = this.#bindings.get(plugin);
    this.#bindings.delete(plugin);
    if (binding !== undefined) releaseHostBinding(binding);
    unregisterSecretDestinations(plugin);
    this.#changed();
    return true;
  }

  /**
   * The per-tool checks, for a manifest's tools and for runtime ones alike:
   * no name registered twice (in the registry or in this batch), tier and
   * `tierFor` coherent, `untrusted` a known kind, and an input a provider can
   * take. Nothing is stored; a batch that fails anywhere stores nothing.
   */
  #checkTools(plugin: string, tools: readonly ToolDefinition<any, any>[]): Array<Pick<Entry, 'tool' | 'inputSchema' | 'validator'>> {
    const seen = new Set<string>();
    const out: Array<Pick<Entry, 'tool' | 'inputSchema' | 'validator'>> = [];
    try {
      for (const tool of tools) {
        const existing = this.#tools.get(tool.name);
        if (existing || seen.has(tool.name)) {
          throw new Error(`tool name collision: ${tool.name} (${existing?.plugin ?? plugin} and ${plugin})`);
        }
        seen.add(tool.name);
        /*
         * `draft` is a statement that this build runs the tool at all — not a
         * cost one call can weigh — so deciding per call is meaningless under
         * it, and a plugin that wrote both has misunderstood one of them.
         * Caught here, where the plugin can still be named.
         */
        if (tool.tierFor !== undefined && tool.tier === 'draft') {
          throw new Error(
            `tool ${tool.name} (plugin ${plugin}) declares tier 'draft' and a tierFor; ` +
              `a draft tool never executes, so there is nothing to decide per call`,
          );
        }
        if (tool.untrusted !== undefined && !UNTRUSTED_KINDS.includes(tool.untrusted)) {
          throw new Error(
            `tool ${tool.name} (plugin ${plugin}) declares untrusted "${String(tool.untrusted)}"; ` +
              `expected one of ${UNTRUSTED_KINDS.join(', ')}`,
          );
        }
        if (tool.input !== undefined && tool.inputSchema !== undefined) {
          throw new Error(`tool ${tool.name} (plugin ${plugin}) declares both a zod input and a JSON Schema inputSchema; give one`);
        }
        // The provider contract, checked where the plugin can still be named.
        const inputSchema = toolInputSchema(tool, plugin);
        let validator: InputValidator;
        if (tool.inputSchema !== undefined) {
          try {
            validator = compileJsonSchema(tool.inputSchema);
          } catch (err) {
            throw new Error(`tool ${tool.name} (plugin ${plugin}): ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          validator = tool.input! as unknown as InputValidator;
        }
        out.push({ tool, inputSchema, validator });
      }
    } catch (err) {
      for (const done of out) (done.validator as Partial<JsonSchemaValidator>).dispose?.();
      throw err;
    }
    return out;
  }

  /** `ctx.buddi.tools.register`: see `ToolsArea`. */
  #addRuntimeTools(plugin: string, definitions: readonly ToolDefinition<any, any>[]): void {
    const manifest = this.#manifests.get(plugin);
    const binding = this.#bindings.get(plugin);
    if (!manifest || !binding) throw new Error(`plugin ${plugin} is not registered`);
    if (!Array.isArray(definitions)) throw new Error(`${plugin}: tools.register takes an array of tool definitions`);
    for (const tool of definitions) {
      const name = typeof tool?.name === 'string' ? tool.name : '';
      if (!name.startsWith(`${plugin}.`) || name.length > MAX_TOOL_NAME || !TOOL_NAME.test(name)) {
        throw new Error(
          `${plugin} may register tools only in its own namespace (${plugin}.<what>, letters, digits, _ and -), not ${JSON.stringify(name)}`,
        );
      }
      if (typeof tool.description !== 'string' || typeof tool.execute !== 'function' || typeof tool.tier !== 'string') {
        throw new Error(`${plugin}: tool ${name} needs a description, a tier and an execute function`);
      }
    }
    const checked = this.#checkTools(plugin, definitions);
    for (const entry of checked) {
      this.#tools.set(entry.tool.name, {
        ...entry,
        plugin,
        version: manifest.version,
        runtime: { dispose: (entry.validator as Partial<JsonSchemaValidator>).dispose },
      });
      binding.tools.add(entry.tool.name);
    }
    if (checked.length > 0) this.#changed();
  }

  /** `ctx.buddi.tools.unregister`: only what this plugin registered at runtime. */
  #removeRuntimeTools(plugin: string, names: readonly string[]): void {
    const binding = this.#bindings.get(plugin);
    if (!binding) throw new Error(`plugin ${plugin} is not registered`);
    if (!Array.isArray(names)) throw new Error(`${plugin}: tools.unregister takes an array of tool names`);
    for (const name of names) {
      const entry = this.#tools.get(name);
      if (!entry || entry.plugin !== plugin || !entry.runtime) {
        throw new Error(`${plugin} may remove only tools it registered at runtime, and ${JSON.stringify(name)} is not one`);
      }
    }
    for (const name of new Set(names)) {
      const entry = this.#tools.get(name)!;
      this.#tools.delete(name);
      binding.tools.delete(name);
      entry.runtime?.dispose?.();
    }
    if (names.length > 0) this.#changed();
  }

  readonly #listeners = new Set<() => void>();
  #revision = 0;
  #notifyScheduled = false;

  /** Bumped whenever the set of tools changes. */
  get revision(): number {
    return this.#revision;
  }

  /**
   * Called after the set of tools changed (a plugin registered, or added or
   * removed tools at runtime), once per burst: listeners run on a microtask,
   * so a plugin that removes and re-adds a connection's tools causes one
   * catalog reload, not two. Returns an unsubscribe. A throwing listener is
   * contained.
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    this.#revision += 1;
    if (this.#notifyScheduled || this.#listeners.size === 0) return;
    this.#notifyScheduled = true;
    queueMicrotask(() => {
      this.#notifyScheduled = false;
      for (const listener of this.#listeners) {
        try {
          listener();
        } catch (err) {
          console.error(`tool registry listener failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
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

  /**
   * Every page the installed plugins contribute, each carrying the plugin it
   * came from: that is the `<plugin>` of its route and the only namespace a
   * page id is unique in. This is what `GET /api/pages` serves.
   */
  pages(): RegisteredPage[] {
    return [...this.#pages].flatMap(([plugin, pages]) => pages.map((page) => ({ ...page, plugin })));
  }

  /**
   * Every page query, with its plugin. The query route finds one by the pair;
   * nothing else may call `produce`, and nothing here exposes it to a model.
   */
  queries(): RegisteredQuery[] {
    return [...this.#queries].flatMap(([plugin, queries]) => queries.map((query) => ({ ...query, plugin })));
  }

  /**
   * The plugins that read a per-agent directory, and the queries they read it
   * with — what the canvas's Files tab is drawn over. Served with the pages.
   */
  files(): Array<WorkspaceFiles & { plugin: string }> {
    return [...this.#manifests.values()].flatMap((m) => (m.files ? [{ ...m.files, plugin: m.name }] : []));
  }

  /**
   * The tools this plugin's *pages* name — and therefore the only tools the
   * act route may invoke for it.
   *
   * Without this, `POST /api/pages/<plugin>/act` would be a general "run any
   * tool of this plugin as the owner" endpoint, which is wider than anything
   * the spec describes: a page is not a console. A plugin that contributes no
   * pages contributes no page tools, so its act route can do nothing at all.
   */
  /**
   * The hosts a plugin declared: its manifest's `network`, then the ones it
   * declared while buddi runs (`ctx.buddi.network`, since 1.7). What the
   * Plugins page lists under "what leaves your machine". Undefined for a
   * plugin this registry does not hold.
   */
  networkOf(plugin: string): Array<{ host: string; why: string; runtime: boolean }> | undefined {
    const binding = this.#bindings.get(plugin);
    return binding ? networkAreaOf(binding).declared() : undefined;
  }

  pageTools(plugin: string): string[] {
    return [...(this.#pageTools.get(plugin) ?? [])];
  }

  /** Which plugin contributed a tool — the act route's "of that plugin" check. */
  pluginOf(name: string): string | undefined {
    return this.#tools.get(name)?.plugin;
  }

  /**
   * The preview provider this plugin registered, if it has one.
   *
   * By plugin name because that is what the route carries: `/preview/<plugin>/
   * <name>/` names the plugin first, and a name is only ever resolved by the
   * plugin that owns it. Undefined for every plugin that ships no processes,
   * which the gateway answers 404 — the same answer a name nobody knows gets,
   * and for the same reason.
   */
  previews(plugin: string): PreviewProvider | undefined {
    const previews = this.#manifests.get(plugin)?.previews;
    if (previews === undefined) return undefined;
    return { resolve: (name, ctx: CoreToolContext) => previews.resolve(name, this.#host(plugin, ctx)) };
  }

  /**
   * Every plugin's carry-over contributor, in registration order, each bound
   * to that plugin's own host (docs/plugins.md §2.8). The caller bounds time
   * and size; this only routes.
   */
  carryOvers(): Array<{ plugin: string; lines: (request: CarryOverRequest, ctx: CoreToolContext) => Promise<string[]> }> {
    return [...this.#manifests.values()].flatMap((m) => {
      const contributor = m.carryOver;
      if (contributor === undefined) return [];
      return [{ plugin: m.name, lines: (request: CarryOverRequest, ctx: CoreToolContext) => contributor.lines(request, this.#host(m.name, ctx)) }];
    });
  }

  /** Every Home block the installed plugins contribute, in registration order. */
  home(): HomeContribution[] {
    return [...this.#manifests.values()].flatMap((m) =>
      (m.home ?? []).map((block): HomeContribution =>
        block.placement === 'glance'
          ? { ...block, produce: (ctx: CoreToolContext) => block.produce(this.#host(m.name, ctx)) }
          : { ...block, produce: (ctx: CoreToolContext) => block.produce(this.#host(m.name, ctx)) },
      ),
    );
  }

  /** The plugin that contributes a Home block or glance, by the contribution's id. */
  homePlugin(id: string): string | undefined {
    for (const m of this.#manifests.values()) if ((m.home ?? []).some((h) => h.id === id)) return m.name;
    return undefined;
  }

  /**
   * Whether `plugin` can do anything yet (host API 1.18): its `setup` answer,
   * on the read-only pool, within `timeoutMs`. Undefined when the plugin is
   * not registered or declares no setup — it is simply loaded. A setup that
   * throws, times out or answers nonsense rejects; the caller decides what
   * that means (the Plugins page shows the plugin as loaded and logs it).
   */
  async readiness(plugin: string, ctx: CoreToolContext, timeoutMs = PLUGIN_CALL_TIMEOUT_MS): Promise<PluginReadiness | undefined> {
    const manifest = this.#manifests.get(plugin);
    if (manifest?.setup === undefined) return undefined;
    const raw = await withinMs(
      Promise.resolve().then(() => manifest.setup!.produce(this.#host(plugin, metricContext(ctx)))),
      timeoutMs,
      `${plugin}'s setup`,
    );
    const answer = readinessOf(raw, (manifest.pages ?? []).map((p) => p.id));
    if (answer === undefined) throw new Error(`${plugin}'s setup answered something that is not { ready, note?, page? }`);
    return answer;
  }

  /**
   * The host binding this registry made for `plugin`: the one whose
   * `plugins.call`, `tools` and runtime network a context outside a tool —
   * a source, a watcher, a sentinel — must share to act as the same plugin.
   */
  hostBinding(plugin: string): HostBinding | undefined {
    return this.#bindings.get(plugin);
  }

  /** The plugins `plugin` requires, with their ranges; empty when none or not registered. */
  requiresOf(plugin: string): Readonly<Record<string, string>> {
    return this.#bindings.get(plugin)?.requires ?? {};
  }

  /**
   * One plugin calling another's export (`ctx.buddi.plugins.call`). Every
   * refusal is core's: the target must be in the caller's `requires`,
   * registered here at a version in range, and export that name; the
   * arguments pass the export's own parameters; it runs with the target's
   * own host over the read-only pool, within the timeout. Never a tool.
   */
  async #callExport(caller: string, target: string, name: string, args: unknown, facts: HostFacts): Promise<unknown> {
    const binding = this.#bindings.get(caller);
    // `optional` (1.27) opens the same road while the plugin is there.
    const range = binding?.requires[target] ?? binding?.optional[target];
    if (range === undefined) {
      throw new PluginCallRefusal(`${caller} may call only the plugins it requires or names as optional, and ${target} is not one of them.`);
    }
    const manifest = this.#manifests.get(target);
    if (manifest === undefined) throw new PluginCallRefusal(`${target} is not loaded, so ${caller} cannot call it.`);
    if (satisfiesRange(manifest.version, range) !== true) {
      throw new PluginCallRefusal(`${caller} needs ${target} ${range}, and ${manifest.version} is installed.`);
    }
    return this.#runExport(target, name, args, facts);
  }

  /**
   * Core's own call to a plugin's export: a mission's `context` (1.27), read
   * before the run so its answer opens the run's first message. The same road
   * as `ctx.buddi.plugins.call` — loaded, exported, the export's own params,
   * the target's read-only host, the timeout — with no caller plugin to check:
   * the agent package that declared the mission was checked at install.
   */
  async callExportAsCore(target: string, name: string, args: unknown, facts: HostFacts): Promise<unknown> {
    if (!this.#manifests.has(target)) throw new PluginCallRefusal(`${target} is not loaded.`);
    return this.#runExport(target, name, args, facts);
  }

  async #runExport(target: string, name: string, args: unknown, facts: HostFacts): Promise<unknown> {
    const manifest = this.#manifests.get(target)!;
    const exported = Object.prototype.hasOwnProperty.call(manifest.exports ?? {}, name) ? manifest.exports![name] : undefined;
    if (exported === undefined) {
      const names = Object.keys(manifest.exports ?? {});
      throw new PluginCallRefusal(
        `${target} exports no ${JSON.stringify(name)}${names.length === 0 ? '; it exports nothing' : `; it exports ${names.join(', ')}`}.`,
      );
    }
    const parsed = exported.params.safeParse(args);
    if (!parsed.success) {
      throw new PluginCallRefusal(`${target}.${name}: ${parsed.error.issues.map((i: { path: unknown[]; message: string }) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
    }
    const ctx = { ...(facts as CoreToolContext), agentId: OWNER_AGENT_ID };
    // The target's host with only its reading parts: the caller must not reach
    // the target's schedule, notices, tools or other effects through it.
    const exportCtx = (): CoreToolContext => {
      const hosted = this.#host(target, metricContext(ctx));
      return hosted.buddi ? { ...hosted, buddi: readOnlyHostOf(hosted.buddi, `${target}.${name}`) } : hosted;
    };
    return withinMs(
      Promise.resolve().then(() => exported.produce(parsed.data, exportCtx())),
      PLUGIN_CALL_TIMEOUT_MS,
      `${target}.${name}`,
    );
  }

  /** Every widget the installed plugins export, each carrying its plugin, in registration order. */
  widgets(): RegisteredWidget[] {
    return [...this.#widgets.values()].flat();
  }

  /** One widget by its id, or undefined. */
  widget(id: string): RegisteredWidget | undefined {
    for (const list of this.#widgets.values()) {
      const found = list.find((w) => w.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Every metric the installed plugins contribute, each carrying its plugin,
   * in registration order. The model of `home()`: this is what `goal.metrics`
   * lists, so an installation with no finance plugin offers no debt to watch
   * and no agent has any idea one could exist.
   */
  metrics(): RegisteredMetric[] {
    return [...this.#metrics.values()].flat();
  }

  /** One metric by its namespaced id, or undefined. What `measureMetric` asks. */
  metric(id: string): RegisteredMetric | undefined {
    for (const list of this.#metrics.values()) {
      const found = list.find((m) => m.id === id);
      if (found) return found;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  isSequential(name: string): boolean {
    return this.#tools.get(name)?.tool.sequential === true;
  }

  /** Whether this call's result leaves a decision with the owner; a function decides per result. */
  waitsForOwner(name: string, output?: unknown): boolean {
    const waits = this.#tools.get(name)?.tool.waitsForOwner;
    if (typeof waits === 'function') {
      try { return waits(output) === true; } catch { return false; }
    }
    return waits === true;
  }

  /** Whether this tool's calls spend their own budget rather than the run's turns. */
  hasOwnBudget(name: string): boolean {
    return this.#tools.get(name)?.tool.ownBudget === true;
  }

  /** Every route the installed plugins provide, each carrying its plugin, in registration order. */
  routeProviders(): RegisteredRouteProvider[] {
    return [...this.#manifests.values()].flatMap((manifest) => (manifest.routes ?? []).map((route): RegisteredRouteProvider => ({
      kind: route.kind,
      label: route.label,
      ...(route.platforms ? { platforms: route.platforms } : {}),
      ...(route.exclusive !== undefined ? { exclusive: route.exclusive } : {}),
      health: () => route.health(),
      look: (session) => route.look(session),
      do: (session, command) => route.do(session, command),
      ...(route.release ? { release: (session: string) => route.release!(session) } : {}),
      ...(route.reach ? { reach: route.reach } : {}),
      ...(route.takeover ? { takeover: (session: string) => route.takeover!(session) } : {}),
      ...(route.resume ? { resume: (session: string) => route.resume!(session) } : {}),
      ...(route.handMessage !== undefined ? { handMessage: route.handMessage } : {}),
      ...(route.focused ? { focused: (session: string) => route.focused!(session) } : {}),
      ...(route.typeSecret ? { typeSecret: (session: string, value: string) => route.typeSecret!(session, value) } : {}),
      plugin: manifest.name,
    })));
  }

  /**
   * The tier a tool always runs at. Undefined for an unknown tool and for one
   * that decides per call (`tierFor`): a caller that needs certainty, like the
   * restart recovery deciding whether a run had acted, reads that as "may have".
   */
  tierOf(name: string): Tier | undefined {
    const tool = this.#tools.get(name)?.tool;
    return tool && tool.tierFor === undefined ? tool.tier : undefined;
  }

  /** Whether a call to this tool reaches outside the run without an approval (`sideEffect`). */
  hasSideEffect(name: string): boolean {
    return this.#tools.get(name)?.tool.sideEffect === true;
  }

  /** What kind of untrusted text this tool's output is, when it declares one. */
  untrustedKind(name: string): UntrustedKind | undefined {
    return this.#tools.get(name)?.tool.untrusted;
  }

  async image(name: string, output: unknown, ctx: CoreToolContext): Promise<{ mime: string; data: string } | undefined> {
    const entry = this.#tools.get(name);
    return entry?.tool.image?.(output, this.#host(entry.plugin, ctx));
  }

  /**
   * Tool specs for the model, in registration order.
   *
   * The schema was derived and checked at `register()`, so what a provider is
   * handed here is always an object schema — see `toolInputSchema`.
   */
  list(): ToolSpec[] {
    return [...this.#tools.values()]
      .filter(({ tool }) => tool.ownerOnly !== true)
      .map(({ tool, inputSchema }) => ({
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
    const { tool, version, plugin } = entry;
    const host = (ctx: CoreToolContext): CoreToolContext => this.#host(plugin, ctx);
    return {
      name: tool.name,
      version,
      ...(tool.reusableApproval ? { reusableApproval: true } : {}),
      ...(tool.producesArtifacts ? { producesArtifacts: true } : {}),
      input: entry.validator,
      ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
      ...(tool.describe ? { describe: (input: unknown, ctx: CoreToolContext) => tool.describe!(input, host(ctx)) } : {}),
      // `claim` travels with the rest. A tool declares it so that a lost race
      // settles `refused` with nothing in the effect ledger; a lookup that
      // dropped it would leave the hook silently never called, and the
      // executor would go on to record an attempt for something that was
      // never attempted.
      ...(tool.claim ? { claim: (input: unknown, ctx: CoreToolContext) => tool.claim!(input, host(ctx)) } : {}),
      execute: (input: unknown, ctx: CoreToolContext) => tool.execute(input, host(ctx)),
    };
  }

  async invoke(
    name: string,
    rawArgs: unknown,
    caller: CoreToolContext,
    /**
     * `askOnly`: this caller may record an approval and nothing more — a call
     * whose tier would run it here (`auto`, `session`) is refused unrun. An
     * owner API token acting through a plugin page is such a caller: it acts
     * as the owner, so an `auto` or `ownerOnly` tool would otherwise store a
     * secret or a standing rule with no person at the dashboard.
     */
    opts: { askOnly?: boolean } = {},
  ): Promise<InvokeResult> {
    caller.signal?.throwIfAborted();
    const entry = this.#tools.get(name);
    if (!entry) {
      return { ok: false, reason: 'unknown-tool', message: `unknown tool: ${name}` };
    }
    const { tool, version } = entry;
    const ctx = this.#host(entry.plugin, caller);

    /*
     * An `ownerOnly` tool is not listed to a model, and this is the other half
     * of that: it does not exist for anybody but the owner's own path. The
     * refusal is deliberately the same one a made-up name gets — there is
     * nothing for a model to learn here, and "that tool exists but is not for
     * you" is a sentence worth nothing to it.
     */
    if (tool.ownerOnly === true && ctx.agentId !== OWNER_AGENT_ID) {
      return { ok: false, reason: 'unknown-tool', message: `unknown tool: ${name}` };
    }

    const parsed = entry.validator.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-args',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      };
    }

    /*
     * The tier this call runs under.
     *
     * `tool.tier` — the *declared* tier — unless the tool decides per call,
     * which it may only do once the arguments have been validated: a rule read
     * off unparsed input is a rule read off whatever the model happened to
     * send. And that is the reason for everything below. `tierFor` reads
     * arguments a **model** chose, so it cannot be the boundary; the declared
     * tier is, and `tierFor` only chooses inside the envelope that declaration
     * already bought. See `ToolDefinition.tierFor`.
     */
    const declared: Tier = tool.tier;
    let tier: Tier = declared;
    let tierReason: string | undefined;
    const decidedPerCall = tool.tierFor !== undefined;
    if (tool.tierFor) {
      let decided: { tier: Tier; reason?: string };
      try {
        decided = await tool.tierFor(parsed.data, ctx);
      } catch (err) {
        if (isToolRefusal(err)) return { ok: false, reason: 'tool-error', message: err.message };
        return {
          ok: false,
          reason: 'tool-error',
          message: `${tool.name} could not decide what this call needs: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      if (!PER_CALL_TIERS.includes(decided?.tier as Tier)) {
        // A tier outside the three is a defect in the plugin, and the safe
        // reading of a defect is that nothing runs.
        return {
          ok: false,
          reason: 'tool-error',
          message: `${tool.name} asked for tier '${String(decided?.tier)}' on this call; only ${PER_CALL_TIERS.join(
            ', ',
          )} may be decided per call`,
        };
      }
      /*
       * The envelope. Two refusals, both naming a defect in the plugin rather
       * than anything the model did:
       *
       *  - A tool that *is* gated may not decide it is not. Gated means the
       *    owner sees every call before it happens, and a rule written over
       *    model-chosen arguments is not allowed to overrule that.
       *  - `session` is a grant the runtime resolved at run start from the
       *    *declared* tier (`sessionTools`), so a per-call `session` on a tool
       *    that did not declare it can never be authorized — it would be an
       *    hour of debugging for a plugin author, and it is one sentence here.
       */
      if (decided.tier === 'session' && declared !== 'session') {
        return {
          ok: false,
          reason: 'tool-error',
          message: `${tool.name} asked for tier 'session' on this call but declares '${declared}'; a session grant is resolved from the declared tier, so declare 'session' and narrow from there`,
        };
      }
      if (GATED_TIERS.includes(declared) && !GATED_TIERS.includes(decided.tier)) {
        return {
          ok: false,
          reason: 'tool-error',
          message: `${tool.name} asked for tier '${decided.tier}' on this call but declares 'gated'; a gated tool is gated on every call`,
        };
      }
      tier = decided.tier;
      if (typeof decided.reason === 'string' && decided.reason.trim() !== '') {
        tierReason = decided.reason.trim();
      }
    }

    /*
     * The session floor.
     *
     * A tool that declares `session` keeps every one of that tier's
     * preconditions on **every** call, whatever `tierFor` returned: a live
     * owner request, an explicit grant, an agent and a conversation, and no
     * delegation. What `tierFor` chooses inside that envelope is only "run it
     * now, under the grant that was already resolved" (`auto`) or "ask the
     * owner about this one" (`gated`).
     *
     * Without this, a developer agent's delegate — `delegationDepth > 0` and
     * an empty `sessionTools` — would get a shell out of a tool that declared
     * the strictest tier there is, which is the exact opposite of what the
     * declaration means.
     */
    if ((declared === 'session' || tier === 'session') && !sessionAuthorized(name, ctx, tool.unattended === true)) {
      return { ok: false, reason: 'session-not-authorized',
        message: (ctx.delegationDepth ?? 0) > 0
          ? 'A delegated run cannot use this tool unless the owner is in the conversation that asked, with a browser session open there. Answer with what you have; the asking agent can do it itself.'
          : !ctx.ownerRequest && tool.unattended === true
            ? 'This mission has not opted in to browsing (its package says browser: own when it should). Report what you could not check instead.'
            : 'This tool requires a current owner request and an explicit agent grant; ask the owner directly.' };
    }

    if (opts.askOnly === true && !GATED_TIERS.includes(tier)) {
      return { ok: false, reason: 'ask-only', message: `${name} would run without an approval, and this caller may only ask.` };
    }

    if (GATED_TIERS.includes(tier)) {
      if (tool.reusableApproval && (ctx.delegationDepth ?? 0) > 0) {
        return { ok: false, reason: 'tool-error', message: 'Host execution requires a direct owner conversation; delegates do not inherit host permissions.' };
      }
      return this.#requestApproval(tool, version, parsed.data, ctx, tierReason, decidedPerCall);
    }

    if (tier !== 'session' && !EXECUTABLE_TIERS.includes(tier)) {
      return {
        ok: false,
        reason: 'tier-not-executable',
        message: `tool ${name} is tier '${tier}'; only ${EXECUTABLE_TIERS.join(
          ', ',
        )} executes in this build`,
      };
    }

    /*
     * Choke point 1 of the scrub (owner-secrets §5): the tool result and the
     * error, before either is returned or recorded. This covers process output
     * (`developer.output`), page text (`browser.act`, `web.read`), every tool
     * result and every thrown message — a process that printed its own
     * environment, a page that echoed a field, an error that quoted a header.
     */
    await primeSecretScrubber();
    try {
      const output = await tool.execute(parsed.data, ctx);
      return { ok: true, output: scrubDeep(output) };
    } catch (err) {
      return {
        ok: false,
        reason: 'tool-error',
        message: scrubText(err instanceof Error ? err.message : String(err)),
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
    ctx: CoreToolContext,
    /** Why this call is gated, when a `tierFor` decided it and said so. */
    tierReason?: string,
    /** Whether a `tierFor` chose this call's tier at all. */
    decidedPerCall = false,
  ): Promise<InvokeResult> {
    let described: EffectDescription;
    try {
      described = tool.describe
        ? await tool.describe(args, ctx)
        : // No `describe`: the canonical arguments *are* the envelope and the
          // preview is their JSON. Honest, complete, and plainly a fallback.
          { envelope: args, preview: `${tool.name} ${JSON.stringify(args ?? null)}` };
    } catch (err) {
      if (isToolRefusal(err)) return { ok: false, reason: 'tool-error', message: err.message };
      return {
        ok: false,
        reason: 'tool-error',
        message: `${tool.name} could not describe this effect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    /*
     * The rule that made this gated, on the card.
     *
     * The owner is being asked about *this* call and not the tool in general,
     * so the sentence that explains the difference belongs in the preview —
     * which is also the only text an approval surface is allowed to render.
     * Appended rather than substituted: the tool's own account of the effect
     * is still what is being approved. Once, though: a tool that already
     * worked the reason into its own sentence is not followed by a second
     * copy of it.
     */
    const preview = tierReason && !described.preview.includes(tierReason)
      ? `${described.preview.replace(/\s+$/, '')} — ${tierReason}`
      : described.preview;

    try {
      const action = await createAction(ctx.db, {
        tool: tool.name,
        toolVersion: version,
        agentId: ctx.agentId ?? 'unknown',
        conversationId: ctx.conversationId ?? null,
        jobId: ctx.jobId ?? null,
        canonicalArgs: args,
        envelope: described.envelope,
        preview,
        // The controls the tool offered the owner. They are part of what was
        // shown, so they are recorded on the action and hashed with it.
        ...(described.choices && described.choices.length > 0 ? { choices: described.choices } : {}),
        /*
         * The tier this call was recorded under. Always `gated` — that is the
         * only tier that records anything — but written down because
         * `tierFor` makes the tier a property of the call: without it, an
         * action created by a per-call rule is indistinguishable from one
         * created by a tool that is simply gated, and the Executor has
         * nothing to assert.
         */
        tier: 'gated',
        now: ctx.now(),
      });
      /*
       * A standing permission is keyed on the tool, not on the call.
       *
       * `tierFor` exists because one tool has many costs; "always allow
       * `developer.run`" was said about a call that was `ls`, and it must not
       * answer for the call that is `npm install`. There is nothing in the
       * permission row that could tell them apart, so a call whose tier was
       * decided per call is always put to the owner.
       */
      const permission = tool.reusableApproval && !decidedPerCall && !asksEachTime(described.envelope)
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

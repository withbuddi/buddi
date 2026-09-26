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
import { decideApproval } from './actions/approvals.js';
import { executeApproved } from './actions/execute.js';
import { findToolPermission } from './actions/permissions.js';
import { createAction } from './actions/store.js';
import type { ExecutableTool } from './actions/execute.js';
import type { EffectDescription, PluginManifest, PreviewProvider, Tier, CoreToolContext, ToolDefinition } from './tools.js';
import { isToolRefusal } from './tools.js';
import { parseViewDescriptors, type ViewDescriptor } from './views.js';
import { OWNER_AGENT_ID, parsePageContributions, type PageDescriptor, type PageQuery, type WorkspaceFiles } from './pages.js';
import type { HomeContribution } from './home.js';
import { parseMetrics, type RegisteredMetric } from './metrics.js';
import { UNTRUSTED_KINDS, type UntrustedKind } from './learning/types.js';
import { hostBindingOf, registerHostOf, withPluginHost, type HostBinding } from './host/build.js';
import { registerSecretDestination } from './secrets/destinations.js';
import { primeSecretScrubber, scrubDeep, scrubText } from './secrets/scrub.js';

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
 */
function sessionAuthorized(name: string, ctx: CoreToolContext): boolean {
  return Boolean(
    ctx.ownerRequest &&
      ctx.ownerRequest.expiresAt > Date.now() &&
      ctx.sessionTools?.includes(name) &&
      ctx.agentId &&
      ctx.conversationId &&
      (ctx.delegationDepth ?? 0) === 0,
  );
}

/** A page descriptor, and the plugin whose route it lives under. */
export type RegisteredPage = PageDescriptor & { plugin: string };

/** A page query, and the plugin whose route it answers on. */
export type RegisteredQuery = PageQuery & { plugin: string };

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
  /** Per plugin, what `parsePageContributions` made of its screens. */
  readonly #pages = new Map<string, PageDescriptor[]>();
  readonly #queries = new Map<string, PageQuery[]>();
  readonly #pageTools = new Map<string, Set<string>>();
  /** Per plugin, the metrics `parseMetrics` checked and made strict. */
  readonly #metrics = new Map<string, RegisteredMetric[]>();
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
    const schemas = new Map<string, Record<string, unknown>>();
    for (const tool of manifest.tools) {
      const existing = this.#tools.get(tool.name);
      if (existing) {
        throw new Error(
          `tool name collision: ${tool.name} (${existing.plugin} and ${manifest.name})`,
        );
      }
      /*
       * `draft` is a statement that this build runs the tool at all — not a
       * cost one call can weigh — so deciding per call is meaningless under
       * it, and a plugin that wrote both has misunderstood one of them.
       * Caught here, where the plugin can still be named.
       */
      if (tool.tierFor !== undefined && tool.tier === 'draft') {
        throw new Error(
          `tool ${tool.name} (plugin ${manifest.name}) declares tier 'draft' and a tierFor; ` +
            `a draft tool never executes, so there is nothing to decide per call`,
        );
      }
      if (tool.untrusted !== undefined && !UNTRUSTED_KINDS.includes(tool.untrusted)) {
        throw new Error(
          `tool ${tool.name} (plugin ${manifest.name}) declares untrusted "${String(tool.untrusted)}"; ` +
            `expected one of ${UNTRUSTED_KINDS.join(', ')}`,
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
    for (const tool of manifest.tools) {
      this.#tools.set(tool.name, {
        tool,
        plugin: manifest.name,
        version: manifest.version,
        inputSchema: schemas.get(tool.name)!,
      });
    }
    manifest.register?.(registerHostOf(binding));
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

  /** Every Home block the installed plugins contribute, in registration order. */
  home(): HomeContribution[] {
    return [...this.#manifests.values()].flatMap((m) =>
      (m.home ?? []).map((block) => ({
        ...block,
        produce: (ctx: CoreToolContext) => block.produce(this.#host(m.name, ctx)),
      })),
    );
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

  waitsForOwner(name: string): boolean {
    return this.#tools.get(name)?.tool.waitsForOwner === true;
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
      input: tool.input,
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
    if ((declared === 'session' || tier === 'session') && !sessionAuthorized(name, ctx)) {
      return { ok: false, reason: 'session-not-authorized',
        message: 'This tool requires a current owner request and an explicit agent grant; ask the owner directly.' };
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
      const permission = tool.reusableApproval && !decidedPerCall
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

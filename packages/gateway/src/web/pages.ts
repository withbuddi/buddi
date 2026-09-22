/**
 * The three routes a plugin's screens are made of.
 *
 * `docs/specs/plugin-pages.md` §3. The dashboard reads the descriptors once,
 * draws them with its own generic components, and then:
 *
 *   - `GET  /api/pages`                     — every descriptor, session-gated;
 *   - `GET  /api/pages/<plugin>/<query>`    — one read, its parameters checked
 *                                             by the query's own schema;
 *   - `POST /api/pages/<plugin>/act`        — one write, as the owner.
 *
 * Three rules hold here and nowhere else:
 *
 *  1. **A query cannot write.** `produce` is handed `pageQueryContext`, whose
 *     pool refuses anything that is not a `select`. A plugin that tried gets a
 *     502 with its own refusal in it, not a write nobody approved.
 *  2. **A page writes only through its plugin's tools.** The act route resolves
 *     the tool through the registry and refuses any name that belongs to
 *     another plugin — including a core `platform.*` tool. A page is not a
 *     console.
 *  3. **A write from a page is the owner acting.** It is invoked with
 *     `agentId: 'owner'`, so an `auto` tool runs and a `gated` one records the
 *     same immutable action an agent's call would have, and the page draws the
 *     approval card in place. There is no third path.
 */
import { OWNER_AGENT_ID, pageQueryContext, ReadOnlyRefusal, type ToolContext, type ToolRegistry } from '@buddi/core';

/** What these routes need. Nothing that is not already in the server's deps. */
export interface PagesDeps {
  registry: ToolRegistry;
  ctx: ToolContext;
  now: () => Date;
}

export interface PagesReply {
  status: number;
  body: unknown;
}

/** How many parameters a query route will look at. A page asks small questions. */
export const PAGE_PARAM_LIMIT = 24;

/**
 * Every descriptor, with the plugin each came from.
 *
 * Data only: a `PageQuery` holds functions and a zod schema and never leaves
 * this process — the browser learns what to *ask for*, not how it is answered.
 */
export function listPageDescriptors(deps: PagesDeps): PagesReply {
  return { status: 200, body: { pages: deps.registry.pages() } };
}

/**
 * One read.
 *
 * Every parameter arrives as a string, because a query string is strings: a
 * query that wants a number writes `z.coerce.number()`, and one that wants a
 * boolean writes `z.enum(['true','false'])`. The schema is the plugin's, so
 * the refusal is the plugin's sentence rather than a generic 400.
 */
export async function runPageQuery(
  deps: PagesDeps,
  plugin: string,
  name: string,
  params: URLSearchParams,
): Promise<PagesReply> {
  const query = deps.registry.queries().find((q) => q.plugin === plugin && q.name === name);
  if (!query) return { status: 404, body: { error: `No plugin page query called ${plugin}/${name}.` } };

  const given: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.keys(given).length >= PAGE_PARAM_LIMIT) {
      return { status: 400, body: { error: `A page query takes at most ${PAGE_PARAM_LIMIT} parameters.` } };
    }
    given[key] = value;
  }

  const parsed = query.params.safeParse(given);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        error: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      },
    };
  }

  let produced: unknown;
  try {
    produced = await query.produce(parsed.data, pageQueryContext(deps.ctx));
  } catch (error) {
    if (error instanceof ReadOnlyRefusal) {
      // The plugin's defect, named as one: a query tried to write.
      return { status: 502, body: { error: `${plugin}.${name} is not a read: ${error.message}` } };
    }
    return {
      status: 502,
      body: { error: `${plugin}.${name} could not answer: ${error instanceof Error ? error.message : String(error)}` },
    };
  }

  if (query.result) {
    const checked = query.result.safeParse(produced);
    if (!checked.success) {
      // Validated before it leaves, exactly like a descriptor: the page draws
      // what it is handed and cannot check it.
      return {
        status: 502,
        body: {
          error: `${plugin}.${name} answered with something its own result shape refuses: ${checked.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')}`,
        },
      };
    }
    return { status: 200, body: { data: checked.data } };
  }
  return { status: 200, body: { data: produced ?? null } };
}

/**
 * One write: `{ tool, args }`, invoked as the owner.
 *
 * The answer is the tool's own result, or `{ approvalId }` when the tool is
 * gated — the page then draws the approval card from the ordinary approvals
 * route, so a decision made there and a decision made on Home are the same
 * row and the same race.
 */
export async function actOnPage(deps: PagesDeps, plugin: string, body: unknown): Promise<PagesReply> {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { error: 'Send `{ tool, args }`.' } };
  }
  const { tool, args } = body as { tool?: unknown; args?: unknown };
  if (typeof tool !== 'string' || tool.trim() === '') {
    return { status: 400, body: { error: 'Name the tool with `tool`.' } };
  }
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return { status: 400, body: { error: '`args` must be an object.' } };
  }
  /*
   * The plugin boundary, and the reason this route is not a general "run a
   * tool" endpoint: a page may write only through the tools of the plugin
   * whose page it is. A tool of another plugin is not refused with a lecture —
   * as far as this route is concerned it does not exist.
   */
  if (deps.registry.pluginOf(tool) !== plugin) {
    return { status: 404, body: { error: `${plugin} has no tool called ${tool}.` } };
  }

  const result = await deps.registry.invoke(tool, args ?? {}, {
    ...deps.ctx,
    agentId: OWNER_AGENT_ID,
    now: deps.now,
  });
  if (result.ok) return { status: 200, body: { result: result.output } };
  if (result.reason === 'approval-required') {
    return { status: 200, body: { approvalId: result.actionId, preview: result.preview } };
  }
  if (result.reason === 'invalid-args') return { status: 400, body: { error: result.message } };
  if (result.reason === 'unknown-tool') return { status: 404, body: { error: result.message } };
  return { status: 400, body: { error: result.message } };
}

/** `/api/pages/<plugin>/<query>` and `/api/pages/<plugin>/act`, as a path. */
export const PAGE_ROUTE = /^\/api\/pages\/([a-z][a-z0-9_-]{0,39})\/([a-z][a-z0-9_]{0,39})$/;

/**
 * Settings → Connections, the owner's routes (docs/connections.md).
 *
 *   GET    /api/connections                 the list, the cards, the agents
 *   POST   /api/connections                 1. address: { url, name? }, or a program on this computer:
 *                                             { transport: 'stdio', name, command, args: [], env: [{ name, value, secret? }] },
 *                                             recorded and not started (the review starts it)
 *   PUT    /api/connections/:id/program     change a program: another command, arguments or variables' names is another review
 *   GET    /api/connections/:id             one connection
 *   POST   /api/connections/:id/consent     2. consent: { clientId?, cli? } → { authorizeUrl }
 *   POST   /api/connections/:id/token       2. or a token: { token, header?, prefix? }, tried before it is kept
 *   POST   /api/connections/:id/device      2. or a code typed on the service's site → { userCode, verificationUri, expiresAt, interval };
 *                                             GET /api/connections/:id carries `device` while it waits and once it ends
 *   POST   /api/connections/callback        the consent page came back: { state, code? | error? }
 *   GET    /api/connections/:id/review      3. review: the tools as buddi would take them
 *   POST   /api/connections/:id/review      3. keep them: { slug?, hash }
 *   POST   /api/connections/:id/grant       4. grant: { agents: [id], exact?: true } (exact also takes it from agents not named)
 *   DELETE /api/connections/:id             disconnect, taking the grants out of every agent file
 *   GET    /api/connections/signals         the ones that need the owner: Home's line, the rail's dot
 *   GET    /api/connections/:id/tools       its registered tools, with whether each may be remembered
 *   GET    /api/connections/remembered/:agent  the agent's gated connection tools, remembered or not
 *   POST   /api/connections/remembered      { agent, tool, remember }: remembered approval, per agent
 *
 * Every one is an owner route behind the dashboard's session, origin and CSRF
 * gate, like every other. The consent state is bound to the dashboard session
 * that asked for it, or, with `cli: true` (`buddi connections add`), owned by
 * the CLI and finished by whichever owner session the callback page opens in
 * (the design is at `PendingConsent` in @buddi/tool-mcp's service.ts); the
 * redirect is the dashboard's own `/connections/callback`, on the origin the
 * owner is using. `buddi connections` reaches these routes as the owner the
 * way `buddi mcp` does (packages/cli/src/mcp/gateway-client.ts).
 *
 * Grants go through `updateAgentFromOwner`, the one path Agent Father's and
 * the agent editor's writes take: nothing is granted silently, and nothing is
 * written that the registry cannot resolve.
 */
import type { Pool } from 'pg';
import { grantToolPermission, listToolPermissions, revokeToolPermission, type AgentCatalog, type ToolRegistry } from '@buddi/core';
import { CATALOG, ConnectionError, ConnectionsService, type ConnectionView, type ProgramInput } from '@buddi/tool-mcp';
import { readBoundAgentFile, updateAgentFromOwner } from '../agents/platform.js';
import { ROLE_FRONT_DESK, ROLE_MAKER } from '../agents/roles.js';

/** Where the consent page sends the owner back: a dashboard page, not an API. */
export const CONNECTIONS_CALLBACK_PATH = '/connections/callback';

export interface ConnectionsRouteDeps {
  service: ConnectionsService | undefined;
  registry: ToolRegistry;
  catalog: AgentCatalog;
  /** Where remembered approvals live (`core.tool_permissions`), and whose they are. */
  pool?: Pool;
  ownerId?: string;
}

/** One gated connection tool, as a settings screen offers remembering it. */
export interface RememberableTool {
  /** `mcp.<slug>.<tool>`. */
  tool: string;
  /** The connection's slug. */
  connection: string;
  /** A destructive tool asks every time; `why` says so. */
  rememberable: boolean;
  why: string | null;
}

export const NEVER_REMEMBERED = 'It can delete or destroy something, so it asks you every time and is never remembered.';

/** Whether a registered `mcp.*` tool is gated, and whether its approval may be remembered. */
function rememberable(registry: ToolRegistry, name: string): RememberableTool | undefined {
  if (!name.startsWith('mcp.')) return undefined;
  const spec = registry.list().find((t) => t.name === name);
  const tool = registry.lookup(name);
  if (!spec || !tool || spec.tier !== 'gated') return undefined;
  const reusable = tool.reusableApproval === true;
  return { tool: name, connection: name.split('.')[1] ?? '', rememberable: reusable, why: reusable ? null : NEVER_REMEMBERED };
}

export interface ConnectionsRequest {
  method: string;
  /** `/api/connections…`, trailing slash removed. */
  path: string;
  body: Record<string, unknown>;
  sessionId: string;
  /** The dashboard origin the owner is on (checked by the write gate). */
  origin: string | undefined;
}

export interface RouteAnswer { status: number; body: unknown }

interface AgentChoice { id: string; name: string; handle: string; frontDesk: boolean }

/** The agents a connection can be given to: every loaded agent but the maker, the front desk first. */
function agentChoices(catalog: AgentCatalog): AgentChoice[] {
  const list = catalog.list().filter((a) => !a.roles.includes(ROLE_MAKER));
  let front = list.find((a) => a.roles.includes(ROLE_FRONT_DESK))?.id;
  if (!front) {
    try { front = catalog.defaultAgent().id; } catch { front = undefined; }
  }
  const choices = list.map((a) => ({ id: a.id, name: a.name, handle: a.handle, frontDesk: a.id === front }));
  return [...choices.filter((c) => c.frontDesk), ...choices.filter((c) => !c.frontDesk)];
}

/** Which agents' files grant anything of `slug`'s. */
export function agentsHolding(registry: ToolRegistry, catalog: AgentCatalog, slug: string | null): string[] {
  if (!slug) return [];
  const prefix = ConnectionsService.grantPrefix(slug);
  return catalog.list()
    .filter((a) => (readBoundAgentFile(registry, a.id)?.tools ?? []).some((entry) => entry.startsWith(prefix)))
    .map((a) => a.id);
}

function withAgents(deps: ConnectionsRouteDeps, view: ConnectionView): ConnectionView & { agents: string[] } {
  return { ...view, agents: agentsHolding(deps.registry, deps.catalog, view.slug) };
}

/** Add `mcp.<slug>.*` to each agent's `tools:` line, one owner write per agent. */
export async function grantConnection(
  deps: Pick<ConnectionsRouteDeps, 'registry'>,
  slug: string,
  agentIds: readonly string[],
): Promise<{ granted: string[]; failed: Array<{ agent: string; message: string }> }> {
  const grant = `${ConnectionsService.grantPrefix(slug)}*`;
  const granted: string[] = [];
  const failed: Array<{ agent: string; message: string }> = [];
  for (const id of agentIds) {
    const file = readBoundAgentFile(deps.registry, id);
    if (!file) { failed.push({ agent: id, message: 'No such agent.' }); continue; }
    if (file.tools.includes(grant)) { granted.push(id); continue; }
    try {
      await updateAgentFromOwner(deps.registry, { id, tools: [...file.tools, grant] });
      granted.push(id);
    } catch (err) {
      failed.push({ agent: id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { granted, failed };
}

/** Take every `mcp.<slug>.…` entry out of every agent file that has one. */
export async function revokeConnection(
  deps: Pick<ConnectionsRouteDeps, 'registry' | 'catalog'>,
  slug: string,
): Promise<{ touched: string[]; failed: Array<{ agent: string; message: string }> }> {
  const prefix = ConnectionsService.grantPrefix(slug);
  const touched: string[] = [];
  const failed: Array<{ agent: string; message: string }> = [];
  for (const id of agentsHolding(deps.registry, deps.catalog, slug)) {
    const file = readBoundAgentFile(deps.registry, id);
    if (!file) continue;
    try {
      await updateAgentFromOwner(deps.registry, { id, tools: file.tools.filter((entry) => !entry.startsWith(prefix)) });
      touched.push(id);
    } catch (err) {
      failed.push({ agent: id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { touched, failed };
}

/** A program's form as the page sends it, read without trusting its shape. */
function programInput(body: Record<string, unknown>): ProgramInput {
  const env = Array.isArray(body.env) ? body.env : [];
  return {
    name: typeof body.name === 'string' ? body.name : '',
    command: typeof body.command === 'string' ? body.command : '',
    args: Array.isArray(body.args) ? body.args.map((a) => String(a)) : [],
    env: env.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null).map((e) => ({
      name: typeof e.name === 'string' ? e.name : '',
      ...(typeof e.value === 'string' ? { value: e.value } : {}),
      secret: e.secret === true,
    })),
  };
}

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

export async function connectionsRoute(deps: ConnectionsRouteDeps, req: ConnectionsRequest): Promise<RouteAnswer> {
  const service = deps.service;
  if (!service) return { status: 503, body: { error: 'Connections are not available in this process.' } };
  try {
    return await route(deps, service, req);
  } catch (err) {
    if (err instanceof ConnectionError) return { status: err.status, body: { error: err.message, ...(err.code ? { code: err.code } : {}) } };
    throw err;
  }
}

async function route(deps: ConnectionsRouteDeps, service: ConnectionsService, req: ConnectionsRequest): Promise<RouteAnswer> {
  const { method, path, body } = req;
  if (path === '/api/connections') {
    if (method === 'GET') {
      const connections = await service.list();
      return {
        status: 200,
        body: {
          connections: connections.map((c) => withAgents(deps, c)),
          catalog: CATALOG,
          agents: agentChoices(deps.catalog),
          vault: service.tokens.available,
          tokens: service.deps.secrets !== undefined,
          callbackPath: CONNECTIONS_CALLBACK_PATH,
        },
      };
    }
    if (method === 'POST') {
      if (body.transport === 'stdio') {
        const added = await service.addProgram(programInput(body));
        return { status: 201, body: { connection: withAgents(deps, added.connection), signIn: 'none' } };
      }
      if (typeof body.url !== 'string' || body.url.trim() === '') return { status: 400, body: { error: 'Give the service\'s address.' } };
      const added = await service.add({ url: body.url, ...(typeof body.name === 'string' ? { name: body.name } : {}) });
      return { status: 201, body: { ...added, connection: withAgents(deps, added.connection) } };
    }
    return { status: 405, body: { error: 'method not allowed' } };
  }
  if (path === '/api/connections/signals') {
    if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
    return { status: 200, body: { signals: await service.signals() } };
  }
  const remembered = /^\/api\/connections\/remembered(?:\/([a-z0-9][a-z0-9_-]{0,63}))?$/i.exec(path);
  if (remembered) return rememberedRoute(deps, req, remembered[1]);
  if (path === '/api/connections/callback') {
    if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    if (typeof body.state !== 'string') return { status: 400, body: { error: 'The service came back without the sign-in\'s state.' } };
    const done = await service.finishConsent({
      sessionId: req.sessionId,
      state: body.state,
      ...(typeof body.code === 'string' ? { code: body.code } : {}),
      ...(typeof body.error === 'string' && body.error ? { error: body.error } : {}),
    });
    return { status: 200, body: done };
  }
  const one = new RegExp(`^/api/connections/${ID}(?:/(consent|reconnect|token|device|review|grant|tools|program))?$`, 'i').exec(path);
  if (!one) return { status: 404, body: { error: 'no such route' } };
  const id = one[1]!.toLowerCase();
  const what = one[2];
  if (!what) {
    if (method === 'GET') return { status: 200, body: withAgents(deps, await service.get(id)) };
    if (method === 'DELETE') {
      const view = await service.get(id);
      const revoked = view.slug ? await revokeConnection(deps, view.slug) : { touched: [], failed: [] };
      if (revoked.failed.length > 0) {
        return { status: 409, body: { error: `Nothing was disconnected: ${revoked.failed.map((f) => `${f.agent}: ${f.message}`).join('; ')}`, touched: revoked.touched } };
      }
      const gone = await service.disconnect(id);
      return { status: 200, body: { ...gone, touched: revoked.touched } };
    }
    return { status: 405, body: { error: 'method not allowed' } };
  }
  if (what === 'consent' || what === 'reconnect') {
    if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    if (!req.origin) return { status: 400, body: { error: 'This request did not say which dashboard it came from.' } };
    const redirectUri = `${req.origin}${CONNECTIONS_CALLBACK_PATH}`;
    const started = await service.beginConsent(id, {
      sessionId: req.sessionId,
      redirectUri,
      ...(body.cli === true ? { cli: true } : {}),
      ...(typeof body.clientId === 'string' && body.clientId.trim() ? { clientId: body.clientId } : {}),
    });
    return { status: 200, body: { ...started, redirectUri } };
  }
  if (what === 'token') {
    if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    if (typeof body.token !== 'string' || body.token.trim() === '') return { status: 400, body: { error: 'Paste the token.' } };
    const done = await service.useToken(id, {
      token: body.token,
      ...(typeof body.header === 'string' ? { header: body.header } : {}),
      ...(typeof body.prefix === 'string' ? { prefix: body.prefix } : {}),
    });
    return { status: 200, body: { ...done, connection: withAgents(deps, await service.get(id)) } };
  }
  if (what === 'device') {
    if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    const started = await service.beginDevice(id);
    return { status: 200, body: { ...started, connection: withAgents(deps, await service.get(id)) } };
  }
  if (what === 'program') {
    if (method !== 'PUT' && method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    return { status: 200, body: withAgents(deps, await service.updateProgram(id, programInput(body))) };
  }
  if (what === 'tools') {
    if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
    const view = await service.get(id);
    const tools = service.registeredNames(id).map((name) => {
      const gated = rememberable(deps.registry, name);
      return { tool: name, tier: gated ? 'gated' : 'auto', rememberable: gated?.rememberable ?? false, why: gated?.why ?? null };
    });
    return { status: 200, body: { connection: view.slug, tools } };
  }
  if (what === 'review') {
    if (method === 'GET') return { status: 200, body: await service.review(id) };
    if (method === 'POST') {
      if (typeof body.hash !== 'string') return { status: 400, body: { error: 'Say which review you read (hash).' } };
      const saved = await service.saveReview(id, { hash: body.hash, ...(typeof body.slug === 'string' ? { slug: body.slug } : {}) });
      return { status: 200, body: withAgents(deps, saved) };
    }
    return { status: 405, body: { error: 'method not allowed' } };
  }
  // grant
  if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
  const view = await service.get(id);
  if (!view.slug || view.state === 'pending-review') return { status: 409, body: { error: 'Review the connection\'s tools before giving them to an agent.' } };
  const agents = Array.isArray(body.agents) ? body.agents.filter((a): a is string => typeof a === 'string').slice(0, 50) : [];
  const known = new Set(agentChoices(deps.catalog).map((a) => a.id));
  const unknown = agents.filter((a) => !known.has(a));
  if (unknown.length > 0) return { status: 400, body: { error: `No such agent: ${unknown.join(', ')}.` } };
  const result = await grantConnection(deps, view.slug, agents);
  // `exact`: the list is who holds it now, so an agent left out loses it.
  if (body.exact === true) {
    const prefix = ConnectionsService.grantPrefix(view.slug);
    for (const agent of agentsHolding(deps.registry, deps.catalog, view.slug)) {
      if (agents.includes(agent)) continue;
      const file = readBoundAgentFile(deps.registry, agent);
      if (!file) continue;
      try {
        await updateAgentFromOwner(deps.registry, { id: agent, tools: file.tools.filter((entry) => !entry.startsWith(prefix)) });
      } catch (err) {
        result.failed.push({ agent, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  const refused = result.failed.length > 0 && result.granted.length === 0 && agents.length > 0;
  return {
    status: refused ? 409 : 200,
    body: {
      ...result,
      ...(refused ? { error: `Nothing was given: ${result.failed.map((f) => `${f.agent}: ${f.message}`).join('; ')}` } : {}),
      connection: withAgents(deps, await service.get(id)),
    },
  };
}

/**
 * Remembered approval, per agent (docs/connections.md, "What an agent gets"):
 * the row a card's "Always" writes, set from a settings screen instead. Only
 * for a gated connection tool that allows it; a destructive one says why not.
 */
async function rememberedRoute(deps: ConnectionsRouteDeps, req: ConnectionsRequest, agentId: string | undefined): Promise<RouteAnswer> {
  const pool = deps.pool;
  const ownerId = deps.ownerId;
  if (!pool || !ownerId) return { status: 503, body: { error: 'Remembered approvals are not available in this process.' } };
  const held = async (agent: string): Promise<Set<string>> => {
    const permissions = await listToolPermissions(pool, ownerId);
    return new Set(permissions.filter((p) => p.agentId === agent && p.conversationId === '' && deps.registry.lookup(p.tool)?.version === p.toolVersion).map((p) => p.tool));
  };
  if (req.method === 'GET') {
    if (!agentId) return { status: 404, body: { error: 'no such route' } };
    const agent = deps.catalog.get(agentId);
    if (!agent) return { status: 404, body: { error: 'No such agent.' } };
    const on = await held(agent.id);
    const tools = agent.tools
      .map((name) => rememberable(deps.registry, name))
      .filter((t): t is RememberableTool => t !== undefined)
      .map((t) => ({ ...t, remembered: t.rememberable && on.has(t.tool) }));
    return { status: 200, body: { agent: agent.id, tools } };
  }
  if (req.method !== 'POST' || agentId) return { status: 405, body: { error: 'method not allowed' } };
  const { agent: agentRaw, tool: toolRaw, remember } = req.body;
  if (typeof agentRaw !== 'string' || typeof toolRaw !== 'string' || typeof remember !== 'boolean') {
    return { status: 400, body: { error: 'Say which agent, which tool, and whether to remember (agent, tool, remember).' } };
  }
  const agent = deps.catalog.get(agentRaw);
  if (!agent) return { status: 404, body: { error: 'No such agent.' } };
  const tool = rememberable(deps.registry, toolRaw);
  if (!tool) return { status: 404, body: { error: `${toolRaw} is not a connection tool that asks you first.` } };
  if (remember) {
    if (!tool.rememberable) return { status: 409, body: { error: NEVER_REMEMBERED } };
    if (!agent.tools.includes(tool.tool)) return { status: 409, body: { error: `${agent.name} does not hold ${tool.tool}. Give it the connection first.` } };
    await grantToolPermission(pool, { ownerId, agentId: agent.id, tool: tool.tool, toolVersion: deps.registry.lookup(tool.tool)!.version, via: 'settings' });
  } else {
    for (const p of await listToolPermissions(pool, ownerId)) {
      if (p.agentId === agent.id && p.tool === tool.tool && p.conversationId === '') await revokeToolPermission(pool, ownerId, p.id);
    }
  }
  return { status: 200, body: { agent: agent.id, tool: tool.tool, remembered: remember } };
}

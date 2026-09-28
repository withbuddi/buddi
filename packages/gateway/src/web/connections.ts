/**
 * Settings → Connections, the owner's routes (docs/connections.md).
 *
 *   GET    /api/connections                 the list, the cards, the agents
 *   POST   /api/connections                 1. address: { url, name? }
 *   GET    /api/connections/:id             one connection
 *   POST   /api/connections/:id/consent     2. consent: { clientId? } → { authorizeUrl }
 *   POST   /api/connections/callback        the consent page came back: { state, code? | error? }
 *   GET    /api/connections/:id/review      3. review: the tools as buddi would take them
 *   POST   /api/connections/:id/review      3. keep them: { slug?, hash }
 *   POST   /api/connections/:id/grant       4. grant: { agents: [id] }
 *   DELETE /api/connections/:id             disconnect, taking the grants out of every agent file
 *
 * Every one is an owner route behind the dashboard's session, origin and CSRF
 * gate, like every other. The consent state is bound to the dashboard session
 * that asked for it; the redirect is the dashboard's own
 * `/connections/callback`, on the origin the owner is using.
 *
 * Grants go through `updateAgentFromOwner`, the one path Agent Father's and
 * the agent editor's writes take: nothing is granted silently, and nothing is
 * written that the registry cannot resolve.
 */
import type { AgentCatalog, ToolRegistry } from '@buddi/core';
import { CATALOG, ConnectionError, ConnectionsService, type ConnectionView } from '@buddi/tool-mcp';
import { readBoundAgentFile, updateAgentFromOwner } from '../agents/platform.js';
import { ROLE_FRONT_DESK, ROLE_MAKER } from '../agents/roles.js';

/** Where the consent page sends the owner back: a dashboard page, not an API. */
export const CONNECTIONS_CALLBACK_PATH = '/connections/callback';

export interface ConnectionsRouteDeps {
  service: ConnectionsService | undefined;
  registry: ToolRegistry;
  catalog: AgentCatalog;
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
          callbackPath: CONNECTIONS_CALLBACK_PATH,
        },
      };
    }
    if (method === 'POST') {
      if (typeof body.url !== 'string' || body.url.trim() === '') return { status: 400, body: { error: 'Give the service\'s address.' } };
      const added = await service.add({ url: body.url, ...(typeof body.name === 'string' ? { name: body.name } : {}) });
      return { status: 201, body: { ...added, connection: withAgents(deps, added.connection) } };
    }
    return { status: 405, body: { error: 'method not allowed' } };
  }
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
  const one = new RegExp(`^/api/connections/${ID}(?:/(consent|reconnect|review|grant))?$`, 'i').exec(path);
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
      ...(typeof body.clientId === 'string' && body.clientId.trim() ? { clientId: body.clientId } : {}),
    });
    return { status: 200, body: { ...started, redirectUri } };
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
  return { status: result.failed.length > 0 && result.granted.length === 0 ? 409 : 200, body: { ...result, connection: withAgents(deps, await service.get(id)) } };
}

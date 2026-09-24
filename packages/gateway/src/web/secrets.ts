/**
 * The dashboard's Keys and secrets routes (docs/specs/owner-secrets.md §6).
 *
 * The reads are core's own page queries (`secrets.list`, `secrets.uses`); the
 * writes are the ownerOnly tools of the same manifest — `secrets.put`,
 * `secrets.rename`, `secrets.rebind`, `secrets.delete`,
 * `secrets.scrub_history` — invoked as the owner through the registry, the same
 * atomic path the plugin pages' act route uses and the same guarantee: no model
 * ever sees a tool that takes a value, and a decision made here is the same
 * write any surface would make. The value the owner typed crosses exactly one
 * boundary — this route's body — into the tool that stores it.
 */
import type { Pool } from 'pg';
import { SECRETS_QUERIES, type ToolRegistry, type CoreToolContext } from '@buddi/core';

export interface SecretsDeps {
  pool: Pool;
  registry: ToolRegistry;
  ctx: Omit<CoreToolContext, 'db'>;
  now?: () => Date;
}

export interface RouteReply {
  status: number;
  body: unknown;
}

const reply = (status: number, body: unknown): RouteReply => ({ status, body });

/** Writes from one session: the act route's own budget, reused here. */
const lastWrite = new Map<string, number>();
function writeRateLimited(session: string, at: number): boolean {
  const last = lastWrite.get(session) ?? 0;
  if (at - last < 1_000) return true;
  lastWrite.set(session, at);
  if (lastWrite.size > 5_000) {
    for (const [key, when] of lastWrite) if (at - when > 60_000) lastWrite.delete(key);
  }
  return false;
}

/** The query named `name`, run as the owner on the same pool the page reads with. */
function runQuery(deps: SecretsDeps, name: string, params: unknown): Promise<unknown> {
  const query = SECRETS_QUERIES.find((q) => q.name === name);
  if (query === undefined) throw new Error(`no secrets query ${name}`);
  return query.produce(params, { ...deps.ctx, db: deps.pool, now: deps.now ?? (() => new Date()) } as CoreToolContext);
}

/** One write: the tool by name, invoked as the owner, the answer the tool's own. */
async function invoke(deps: SecretsDeps, tool: string, args: unknown, session: string): Promise<RouteReply> {
  const now = deps.now ?? (() => new Date());
  if (writeRateLimited(session, now().getTime())) {
    return reply(429, { error: 'Too many writes from this page. Wait a moment and try again.' });
  }
  const result = await deps.registry.invoke(tool, args ?? {}, { ...deps.ctx, db: deps.pool, now } as CoreToolContext);
  if (result.ok) return reply(200, { result: result.output });
  if (result.reason === 'invalid-args') return reply(400, { error: result.message });
  if (result.reason === 'unknown-tool') return reply(404, { error: result.message });
  return reply(400, { error: result.message });
}

const SETTINGS_TOOLS = new Set(['secrets.put', 'secrets.rename', 'secrets.rebind', 'secrets.delete', 'secrets.scrub_history']);

/** `GET /api/secrets` — the page's one read: secrets, destinations, buddi's own keys. */
export async function listSecrets(deps: SecretsDeps): Promise<RouteReply> {
  const result = await SECRETS_QUERIES[0]!.produce({}, { ...deps.ctx, db: deps.pool, now: deps.now ?? (() => new Date()) } as CoreToolContext);
  return reply(200, result);
}

/** `GET /api/secrets/uses` — the use log, whole or one secret's. */
export async function secretUses(deps: SecretsDeps, url: URL): Promise<RouteReply> {
  const name = url.searchParams.get('name') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const uses = SECRETS_QUERIES[1]!;
  return reply(200, await uses.produce({ ...(name !== undefined ? { name } : {}), limit }, { ...deps.ctx, db: deps.pool, now: deps.now ?? (() => new Date()) } as CoreToolContext));
}

/** `POST /api/secrets` — one owner write, `{ tool, args }`. */
export async function secretsAct(
  deps: SecretsDeps,
  body: unknown,
  session: { id: string },
): Promise<RouteReply> {
  if (typeof body !== 'object' || body === null) return reply(400, { error: 'Send `{ tool, args }`.' });
  const { tool, args } = body as { tool?: unknown; args?: unknown };
  if (typeof tool !== 'string' || !SETTINGS_TOOLS.has(tool)) {
    return reply(404, { error: 'That is not a write the Keys and secrets page makes.' });
  }
  return invoke(deps, tool, args, session.id);
}


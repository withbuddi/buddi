/**
 * A fake of the slice of Cloudflare's API v4 that "Set it up for me" calls,
 * on a loopback port: zones, the Access organization, tunnels and their
 * configuration and token, DNS records, Access policies and applications.
 * State is in memory and inspectable; a permission can be withheld (403 with
 * code 10000, as Cloudflare answers) and one call can be made to fail.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CloudflarePermission } from '../web/access/cloudflare-api.js';

export const FAKE_TOKEN = 'cf-test-token-0123456789abcdef0123';
export const FAKE_ACCOUNT = 'acc0000000000000000000000000001';
export const FAKE_ZONE = 'zone000000000000000000000000001';
export const FAKE_TEAM = 'sam.cloudflareaccess.com';

export interface FakeCloudflare {
  baseUrl: string;
  state: {
    tunnels: Array<{ id: string; name: string; status: string; config?: unknown; deleted_at: string | null }>;
    dns: Array<{ id: string; type: string; name: string; content: string; comment: string | null; proxied: boolean }>;
    policies: Array<{ id: string; name: string; decision: string; include: unknown[] }>;
    apps: Array<{ id: string; name: string; domain: string; aud: string; type: string; policies: Array<{ id: string; precedence: number }> }>;
  };
  /** Withheld permissions: their calls answer 403. */
  deny: Set<CloudflarePermission>;
  /** Fail the next call matching, once. */
  failNext(method: string, path: RegExp, status?: number): void;
  /** How many health reads answer `inactive` before `healthy`. */
  healthyAfter: number;
  /** What the tunnel token call answers instead of a well-formed connector token. */
  connectorToken: string | undefined;
  /** Every call, as "METHOD /path". */
  calls: string[];
  close(): Promise<void>;
}

let seq = 0;
const id = (prefix: string): string => `${prefix}${String(++seq).padStart(28, '0')}`;

function body(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); } });
  });
}

export async function fakeCloudflare(opts: { zones?: string[]; team?: string | null } = {}): Promise<FakeCloudflare> {
  const zones = (opts.zones ?? ['example.com']).map((name, i) => ({ id: i === 0 ? FAKE_ZONE : id('zone'), name, account: { id: FAKE_ACCOUNT, name: 'Sam' } }));
  const state: FakeCloudflare['state'] = { tunnels: [], dns: [], policies: [], apps: [] };
  const deny = new Set<CloudflarePermission>();
  const calls: string[] = [];
  const failures: Array<{ method: string; path: RegExp; status: number }> = [];
  const health = new Map<string, number>();
  const fake = { healthyAfter: 1, connectorToken: undefined } as { healthyAfter: number; connectorToken: string | undefined };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/client\/v4/, '');
    const method = req.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const send = (status: number, result: unknown, errors: Array<{ code: number; message: string }> = []): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: status < 400, errors, messages: [], result }));
    };
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return send(401, null, [{ code: 1000, message: 'Invalid API Token' }]);
    const failure = failures.findIndex((f) => f.method === method && f.path.test(path));
    if (failure >= 0) {
      const [f] = failures.splice(failure, 1);
      return send(f!.status, null, [{ code: 10001, message: 'Internal error' }]);
    }
    const needs = (perm: CloudflarePermission): boolean => {
      if (!deny.has(perm)) return false;
      send(403, null, [{ code: 10000, message: 'Authentication error' }]);
      return true;
    };
    const input = method === 'GET' || method === 'DELETE' ? null : await body(req);
    let m: RegExpMatchArray | null;

    if (path === '/user/tokens/verify') return send(200, { id: 'tok', status: 'active' });
    if (path === '/zones') return needs('dns') ? undefined : send(200, url.searchParams.get('page') === '1' || !url.searchParams.get('page') ? zones : []);
    if ((m = path.match(/^\/accounts\/([^/]+)\/access\/organizations$/))) {
      if (needs('organization')) return;
      if (opts.team === null) return send(404, null, [{ code: 12130, message: 'access.api.error.not_found' }]);
      return send(200, { auth_domain: opts.team ?? FAKE_TEAM, name: 'sam' });
    }
    if ((m = path.match(/^\/accounts\/[^/]+\/cfd_tunnel$/))) {
      if (needs('tunnel')) return;
      if (method === 'GET') {
        const name = url.searchParams.get('name');
        return send(200, state.tunnels.filter((t) => !t.deleted_at && (!name || t.name === name)));
      }
      const t = { id: id('tun'), name: String(input?.name), status: 'inactive', deleted_at: null };
      state.tunnels.push(t);
      return send(200, t);
    }
    if ((m = path.match(/^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)(\/[a-z]+)?$/))) {
      if (needs('tunnel')) return;
      const t = state.tunnels.find((x) => x.id === m![1] && !x.deleted_at);
      if (!t) return send(404, null, [{ code: 1003, message: 'not found' }]);
      const tail = m[2] ?? '';
      if (tail === '/token') return send(200, fake.connectorToken ?? `eyJ-connector-token-for-${t.id}`);
      if (tail === '/configurations') { t.config = input?.config; return send(200, { config: t.config }); }
      if (tail === '/connections') return send(200, null);
      if (method === 'DELETE') { t.deleted_at = new Date().toISOString(); return send(200, t); }
      const reads = (health.get(t.id) ?? 0) + 1;
      health.set(t.id, reads);
      return send(200, { ...t, status: reads > fake.healthyAfter ? 'healthy' : 'inactive' });
    }
    if ((m = path.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/))) {
      if (needs('dns')) return;
      if (method === 'GET') {
        const name = url.searchParams.get('name');
        return send(200, state.dns.filter((r) => !name || r.name === name));
      }
      if (method === 'POST') {
        const r = { id: id('dns'), type: String(input.type), name: String(input.name), content: String(input.content), comment: input.comment ?? null, proxied: input.proxied === true };
        state.dns.push(r);
        return send(200, r);
      }
      if (method === 'DELETE') { state.dns = state.dns.filter((r) => r.id !== m![2]); return send(200, { id: m[2] }); }
    }
    if ((m = path.match(/^\/accounts\/[^/]+\/access\/policies(?:\/([^/]+))?$/))) {
      if (needs('access')) return;
      if (method === 'GET') return send(200, state.policies);
      if (method === 'POST') { const p = { id: id('pol'), name: input.name, decision: input.decision, include: input.include }; state.policies.push(p); return send(200, p); }
      const p = state.policies.find((x) => x.id === m![1]);
      if (!p) return send(404, null, [{ code: 12130, message: 'not found' }]);
      if (method === 'PUT') { Object.assign(p, { name: input.name, decision: input.decision, include: input.include }); return send(200, p); }
      if (method === 'DELETE') {
        if (state.apps.some((a) => a.policies.some((x) => x.id === p.id))) return send(400, null, [{ code: 12130, message: 'policy in use' }]);
        state.policies = state.policies.filter((x) => x !== p);
        return send(200, { id: p.id });
      }
    }
    if ((m = path.match(/^\/accounts\/[^/]+\/access\/apps(?:\/([^/]+))?$/))) {
      if (needs('access')) return;
      if (method === 'GET') return send(200, state.apps);
      if (method === 'POST') {
        const a = { id: id('app'), name: input.name, domain: input.domain, type: input.type, aud: `aud${'0'.repeat(40)}${++seq}`, policies: input.policies ?? [] };
        state.apps.push(a);
        return send(200, a);
      }
      const a = state.apps.find((x) => x.id === m![1]);
      if (!a) return send(404, null, [{ code: 12130, message: 'not found' }]);
      if (method === 'PUT') { Object.assign(a, { name: input.name, domain: input.domain, policies: input.policies ?? [] }); return send(200, a); }
      if (method === 'DELETE') { state.apps = state.apps.filter((x) => x !== a); return send(200, { id: a.id }); }
    }
    return send(404, null, [{ code: 7003, message: `no route ${method} ${path}` }]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(fake, {
    baseUrl: `http://127.0.0.1:${port}/client/v4`,
    state,
    deny,
    calls,
    failNext: (method: string, path: RegExp, status = 500) => { failures.push({ method, path, status }); },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  });
}

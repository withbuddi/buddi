/**
 * The few calls of Cloudflare's REST API (v4) that "Set it up for me" makes
 * (slate jxtBIbNaS-): zones, the Zero Trust organization (the team domain),
 * tunnels and their configuration, DNS records, Access applications and
 * reusable Access policies.
 *
 * Every call goes through the gateway's outbound transport with the owner's
 * API token as a bearer header. The token is never logged, never put in an
 * error, and never echoed: a failure is a `CloudflareApiError` whose sentence
 * is built from what was asked and Cloudflare's own error codes, and names the
 * token permission a 403 says is missing.
 */
import { defaultHttpTransport, type HttpTransport } from '@buddi/runtime';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** The token permissions the setup needs, as Cloudflare's token page names them. */
export const CLOUDFLARE_PERMISSIONS = {
  tunnel: 'Account · Cloudflare Tunnel · Edit',
  access: 'Account · Access: Apps and Policies · Edit',
  organization: 'Account · Access: Organizations, Identity Providers, and Groups · Read',
  dns: 'Zone · DNS · Edit',
} as const;
export type CloudflarePermission = keyof typeof CLOUDFLARE_PERMISSIONS;

/** In the order the form lists them. */
export const CLOUDFLARE_PERMISSION_LINES: readonly string[] = [
  CLOUDFLARE_PERMISSIONS.tunnel,
  CLOUDFLARE_PERMISSIONS.access,
  CLOUDFLARE_PERMISSIONS.organization,
  `${CLOUDFLARE_PERMISSIONS.dns} — on the zone of your hostname`,
];

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Cloudflare's error codes, when it gave any. */
    readonly codes: number[],
    /** The permission a 403 says the token lacks. */
    readonly permission?: CloudflarePermission | undefined,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

export interface CfZone { id: string; name: string; account: { id: string; name?: string } }
export interface CfTunnel { id: string; name: string; status?: string; deleted_at?: string | null }
export interface CfDnsRecord { id: string; type: string; name: string; content: string; comment?: string | null; proxied?: boolean }
export interface CfAccessPolicy { id: string; name: string; decision: string; include?: unknown[] }
export interface CfAccessApp { id: string; name: string; domain: string; aud: string; type?: string; policies?: Array<{ id: string; precedence?: number }> }

export interface CloudflareApi {
  verifyToken(): Promise<'active' | 'inactive' | 'unknown'>;
  zones(): Promise<CfZone[]>;
  teamDomain(accountId: string): Promise<string>;
  findTunnel(accountId: string, name: string): Promise<CfTunnel | null>;
  createTunnel(accountId: string, name: string): Promise<CfTunnel>;
  tunnel(accountId: string, id: string): Promise<CfTunnel>;
  tunnelToken(accountId: string, id: string): Promise<string>;
  putTunnelConfig(accountId: string, id: string, hostname: string, service: string): Promise<void>;
  deleteTunnel(accountId: string, id: string): Promise<void>;
  dnsRecords(zoneId: string, name: string): Promise<CfDnsRecord[]>;
  createCname(zoneId: string, name: string, target: string, comment: string): Promise<CfDnsRecord>;
  deleteDnsRecord(zoneId: string, id: string): Promise<void>;
  policies(accountId: string): Promise<CfAccessPolicy[]>;
  createPolicy(accountId: string, name: string, email: string): Promise<CfAccessPolicy>;
  updatePolicy(accountId: string, id: string, name: string, email: string): Promise<CfAccessPolicy>;
  deletePolicy(accountId: string, id: string): Promise<void>;
  apps(accountId: string): Promise<CfAccessApp[]>;
  createApp(accountId: string, input: { name: string; domain: string; policyId: string }): Promise<CfAccessApp>;
  updateApp(accountId: string, id: string, input: { name: string; domain: string; policyId: string }): Promise<CfAccessApp>;
  deleteApp(accountId: string, id: string): Promise<void>;
}

/** What one call is for, in words, and the permission it needs. */
interface Purpose { doing: string; permission?: CloudflarePermission | undefined }

/** Cloudflare's codes for "this token may not do that". */
const FORBIDDEN_CODES = new Set([9109, 10000]);

function sentenceFor(status: number, codes: number[], purpose: Purpose): { text: string; permission?: CloudflarePermission | undefined } {
  if (status === 401 || codes.includes(1000) || codes.includes(6003) || codes.includes(6111)) {
    return { text: 'Cloudflare doesn’t accept this API token. Check that it was pasted whole and has not expired.' };
  }
  if ((status === 403 || codes.some((c) => FORBIDDEN_CODES.has(c))) && purpose.permission) {
    return {
      text: `The token can’t ${purpose.doing}. Add ${CLOUDFLARE_PERMISSIONS[purpose.permission]} to it in Cloudflare (My Profile → API Tokens → Edit), then try again.`,
      permission: purpose.permission,
    };
  }
  if (status === 429) return { text: `Cloudflare asked buddi to slow down while trying to ${purpose.doing}. Try again in a minute.` };
  if (status >= 500) return { text: `Cloudflare had a problem while buddi tried to ${purpose.doing} (${status}). Try again in a moment.` };
  return { text: `Cloudflare refused to ${purpose.doing} (${status}${codes.length ? `, code ${codes.join(', ')}` : ''}).` };
}

export function createCloudflareApi(deps: {
  token: string;
  transport?: HttpTransport | undefined;
  /** `https://api.cloudflare.com/client/v4`, or a test's fake. */
  baseUrl?: string | undefined;
}): CloudflareApi {
  const transport = deps.transport ?? defaultHttpTransport;
  const base = (deps.baseUrl ?? CLOUDFLARE_API).replace(/\/+$/, '');

  async function call<T>(method: string, path: string, purpose: Purpose, body?: unknown): Promise<T> {
    let res;
    try {
      res = await transport(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${deps.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        idleTimeoutMs: 20_000,
        maxBytes: 4_000_000,
      });
    } catch {
      // A transport error can carry the request; say only what was being done.
      throw new CloudflareApiError(`Cloudflare could not be reached while buddi tried to ${purpose.doing}. Check this computer’s connection.`, 0, []);
    }
    const parsed = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown; errors?: Array<{ code?: unknown }> } | null;
    const codes = (parsed?.errors ?? []).map((e) => Number(e?.code)).filter((c) => Number.isFinite(c));
    if (!res.ok || parsed?.success === false) {
      const said = sentenceFor(res.status, codes, purpose);
      throw new CloudflareApiError(said.text, res.status, codes, said.permission);
    }
    return (parsed?.result ?? null) as T;
  }

  const q = encodeURIComponent;
  const policyBody = (name: string, email: string) => ({
    name,
    decision: 'allow',
    include: [{ email: { email } }],
    session_duration: '24h',
  });
  const appBody = (input: { name: string; domain: string; policyId: string }) => ({
    name: input.name,
    domain: input.domain,
    type: 'self_hosted',
    session_duration: '24h',
    app_launcher_visible: false,
    policies: [{ id: input.policyId, precedence: 1 }],
  });

  return {
    async verifyToken() {
      try {
        const result = await call<{ status?: string } | null>('GET', '/user/tokens/verify', { doing: 'check itself' });
        return result?.status === 'active' ? 'active' : 'inactive';
      } catch (error) {
        // An account-owned token cannot verify itself here; only a flat
        // refusal of the token is an answer.
        if (error instanceof CloudflareApiError && error.status === 401) throw error;
        return 'unknown';
      }
    },
    async zones() {
      const all: CfZone[] = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await call<CfZone[]>('GET', `/zones?per_page=50&page=${page}`, { doing: 'list your domains', permission: 'dns' });
        all.push(...(batch ?? []));
        if (!batch || batch.length < 50) break;
      }
      return all;
    },
    async teamDomain(accountId) {
      const org = await call<{ auth_domain?: string } | null>('GET', `/accounts/${q(accountId)}/access/organizations`, { doing: 'read your Zero Trust team domain', permission: 'organization' });
      return (org?.auth_domain ?? '').trim().toLowerCase();
    },
    async findTunnel(accountId, name) {
      const list = await call<CfTunnel[]>('GET', `/accounts/${q(accountId)}/cfd_tunnel?is_deleted=false&name=${q(name)}`, { doing: 'list tunnels', permission: 'tunnel' });
      return (list ?? []).find((t) => t.name === name && !t.deleted_at) ?? null;
    },
    createTunnel: (accountId, name) =>
      call<CfTunnel>('POST', `/accounts/${q(accountId)}/cfd_tunnel`, { doing: 'create a tunnel', permission: 'tunnel' }, { name, config_src: 'cloudflare' }),
    tunnel: (accountId, id) =>
      call<CfTunnel>('GET', `/accounts/${q(accountId)}/cfd_tunnel/${q(id)}`, { doing: 'read the tunnel', permission: 'tunnel' }),
    async tunnelToken(accountId, id) {
      const token = await call<unknown>('GET', `/accounts/${q(accountId)}/cfd_tunnel/${q(id)}/token`, { doing: 'read the tunnel’s connector token', permission: 'tunnel' });
      if (typeof token !== 'string' || token === '') throw new CloudflareApiError('Cloudflare answered without the tunnel’s connector token.', 200, []);
      return token;
    },
    async putTunnelConfig(accountId, id, hostname, service) {
      await call('PUT', `/accounts/${q(accountId)}/cfd_tunnel/${q(id)}/configurations`, { doing: 'route the hostname through the tunnel', permission: 'tunnel' }, {
        config: { ingress: [{ hostname, service }, { service: 'http_status:404' }] },
      });
    },
    async deleteTunnel(accountId, id) {
      // A tunnel with a connector still attached is refused; its stale
      // connections go first.
      await call('DELETE', `/accounts/${q(accountId)}/cfd_tunnel/${q(id)}/connections`, { doing: 'disconnect the tunnel', permission: 'tunnel' }).catch(() => undefined);
      await call('DELETE', `/accounts/${q(accountId)}/cfd_tunnel/${q(id)}`, { doing: 'delete the tunnel', permission: 'tunnel' });
    },
    async dnsRecords(zoneId, name) {
      return (await call<CfDnsRecord[]>('GET', `/zones/${q(zoneId)}/dns_records?name=${q(name)}&per_page=50`, { doing: 'read your DNS records', permission: 'dns' })) ?? [];
    },
    createCname: (zoneId, name, target, comment) =>
      call<CfDnsRecord>('POST', `/zones/${q(zoneId)}/dns_records`, { doing: 'add a DNS record', permission: 'dns' }, { type: 'CNAME', name, content: target, proxied: true, ttl: 1, comment }),
    async deleteDnsRecord(zoneId, id) {
      await call('DELETE', `/zones/${q(zoneId)}/dns_records/${q(id)}`, { doing: 'delete the DNS record', permission: 'dns' });
    },
    async policies(accountId) {
      return (await call<CfAccessPolicy[]>('GET', `/accounts/${q(accountId)}/access/policies?per_page=100`, { doing: 'list Access policies', permission: 'access' })) ?? [];
    },
    createPolicy: (accountId, name, email) =>
      call<CfAccessPolicy>('POST', `/accounts/${q(accountId)}/access/policies`, { doing: 'create an Access policy', permission: 'access' }, policyBody(name, email)),
    updatePolicy: (accountId, id, name, email) =>
      call<CfAccessPolicy>('PUT', `/accounts/${q(accountId)}/access/policies/${q(id)}`, { doing: 'update the Access policy', permission: 'access' }, policyBody(name, email)),
    async deletePolicy(accountId, id) {
      await call('DELETE', `/accounts/${q(accountId)}/access/policies/${q(id)}`, { doing: 'delete the Access policy', permission: 'access' });
    },
    async apps(accountId) {
      return (await call<CfAccessApp[]>('GET', `/accounts/${q(accountId)}/access/apps?per_page=100`, { doing: 'list Access applications', permission: 'access' })) ?? [];
    },
    createApp: (accountId, input) =>
      call<CfAccessApp>('POST', `/accounts/${q(accountId)}/access/apps`, { doing: 'create Access applications', permission: 'access' }, appBody(input)),
    updateApp: (accountId, id, input) =>
      call<CfAccessApp>('PUT', `/accounts/${q(accountId)}/access/apps/${q(id)}`, { doing: 'update the Access application', permission: 'access' }, appBody(input)),
    async deleteApp(accountId, id) {
      await call('DELETE', `/accounts/${q(accountId)}/access/apps/${q(id)}`, { doing: 'delete the Access application', permission: 'access' });
    },
  };
}

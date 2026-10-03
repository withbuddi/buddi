/**
 * The trusted access providers this gateway runs, and the questions the
 * request handler asks of them (specs/trusted-access.md §3).
 *
 * Order matters only for `matching`: a request is asked of the first provider
 * whose arrival it came by. Today that is Tailscale on the main listener (and
 * only when Serve's header is there) and Cloudflare Access on the ingress
 * listener. The relay (provider 3) slots in with `arrival: 'relay'`.
 */
import type { IncomingMessage } from 'node:http';
import { arrivalOf } from './arrival.js';
import type { AccessConfirmation, AccessIdentifyResult, AccessProvider, AccessProviderId, AccessSessionView } from './provider.js';

export interface AccessRegistry {
  readonly providers: readonly AccessProvider<any>[];
  get(id: AccessProviderId | undefined): AccessProvider<any> | undefined;
  /** The provider's stored setting, parsed. A setting that cannot be read is off. */
  settingOf<S>(provider: AccessProvider<S>): Promise<S>;
  /** The provider this request arrived through, if any. */
  matching(req: IncomingMessage): AccessProvider<any> | undefined;
  /** Who this request is, through whichever provider it arrived by. Null: no provider, or no claim. */
  identify(req: IncomingMessage, now: Date): Promise<{ provider: AccessProvider<any>; result: AccessIdentifyResult } | null>;
  /** Re-check a provider session on this request. A provider that is gone ends it. */
  confirm(session: AccessSessionView, req: IncomingMessage, now: Date): Promise<AccessConfirmation>;
  /** The rate-limit bucket before anything verified, for a request that did not arrive on the main listener. */
  bucketOf(req: IncomingMessage): string | null;
}

export function createAccessRegistry(opts: {
  providers: AccessProvider<any>[];
  readSetting: (key: string) => Promise<unknown>;
}): AccessRegistry {
  const providers = opts.providers;
  const settingOf = async <S>(provider: AccessProvider<S>): Promise<S> =>
    provider.parseSetting(await opts.readSetting(provider.settingKey).catch(() => null));
  const matching = (req: IncomingMessage): AccessProvider<any> | undefined => providers.find((p) => p.matches(req));
  return {
    providers,
    get: (id) => providers.find((p) => p.id === id),
    settingOf,
    matching,
    async identify(req, now) {
      const provider = matching(req);
      if (!provider) return null;
      const result = await provider.identify(req, await settingOf(provider), now);
      return result ? { provider, result } : null;
    },
    async confirm(session, req, now) {
      const provider = providers.find((p) => p.id === session.provider);
      if (!provider) return { answer: 'end' };
      return provider.confirm(session, req, await settingOf(provider), now);
    },
    bucketOf(req) {
      const arrival = arrivalOf(req);
      if (arrival === 'main') return null;
      return providers.find((p) => p.arrival === arrival)?.clientKey(req) ?? `${arrival}:unverified`;
    },
  };
}

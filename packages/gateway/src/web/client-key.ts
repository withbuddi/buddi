/**
 * The bucket a failed sign-in is counted against (specs/trusted-access.md §7.5).
 *
 * Every tunnel on this machine — Tailscale Serve, an SSH forward, cloudflared —
 * reaches the gateway from 127.0.0.1, so keying the lockout on the socket's
 * address alone made one budget for all of them: a stale tab on the tailnet or
 * a stranger behind a tunnel could lock the owner out of the Mac itself. The
 * arrival path picks the bucket instead:
 *
 * - a non-loopback socket: its own address, as before;
 * - loopback with no proxy metadata at all: `loopback`, the owner at the
 *   machine (an SSH forward looks the same and shares it);
 * - loopback with one `X-Forwarded-For` naming a tailnet address (what a
 *   Tailscale Serve hop looks like): that tailnet address;
 * - loopback with any other proxy metadata: one `forwarded` bucket.
 *
 * Headers can only move a request *out* of the loopback bucket, never into
 * it, so nothing arriving through a proxy can spend the direct local budget.
 * Proxy headers a local process makes up only ever earn it a bucket of its
 * own, and a local brute force of a 256-bit token is pointless anyway.
 */
import type { IncomingMessage } from 'node:http';
import { isLoopbackAddress } from './http.js';
import { forwardedAddress, isTailnetAddress } from './tailscale.js';

function proxyMetadata(req: IncomingMessage): boolean {
  return Object.keys(req.headers).some(
    (key) => key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-') || key.startsWith('tailscale-'),
  );
}

export function clientKey(req: IncomingMessage): string {
  const address = req.socket.remoteAddress;
  if (!isLoopbackAddress(address)) return `addr:${address ?? 'unknown'}`;
  if (!proxyMetadata(req)) return 'loopback';
  const tailnet = forwardedAddress(req);
  if (tailnet !== undefined && isTailnetAddress(tailnet)) return `tailnet:${tailnet}`;
  return 'forwarded';
}

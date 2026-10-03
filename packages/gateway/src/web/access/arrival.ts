/**
 * How a request reached the gateway: decided by *where it was accepted*, never
 * by what it says (specs/trusted-access.md §3.3, §7.5).
 *
 * - `main`: the dashboard's own listener (127.0.0.1:4317). Local unless proxy
 *   metadata downgrades it, as it always was. Tailscale Serve points here.
 * - `ingress`: the loopback listener a this-machine proxy other than Tailscale
 *   points at (cloudflared). Everything on it is remote, whatever its headers
 *   or `Host` say, and it never passes a loopback-only check, although its
 *   socket is a loopback one.
 * - `relay`: a request handed over in-process by the withbuddi relay client
 *   (provider 3, not built yet). No socket and no loopback address at all.
 *
 * The tag lives on the socket (or the request) in a WeakMap, set by the code
 * that accepted it. Nothing a client sends can set or clear it.
 */
import type { IncomingMessage } from 'node:http';

export type Arrival = 'main' | 'ingress' | 'relay';

const bySocket = new WeakMap<object, Exclude<Arrival, 'main'>>();
const byRequest = new WeakMap<object, Exclude<Arrival, 'main'>>();

/** Tag every request on this socket. Called from the ingress listener's `connection` event. */
export function markSocketArrival(socket: object, arrival: Exclude<Arrival, 'main'>): void {
  bySocket.set(socket, arrival);
}

/** Tag one request handed to the handler without a socket of its own (the relay). */
export function markRequestArrival(req: object, arrival: Exclude<Arrival, 'main'>): void {
  byRequest.set(req, arrival);
}

export function arrivalOf(req: IncomingMessage): Arrival {
  const tagged = byRequest.get(req);
  if (tagged) return tagged;
  const socket = (req as { socket?: object | null }).socket;
  return (socket && bySocket.get(socket)) || 'main';
}

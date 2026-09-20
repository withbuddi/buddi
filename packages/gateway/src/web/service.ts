/**
 * The dashboard's half of the supervisor's control socket.
 *
 * In a packaged installation the supervisor hands the gateway child
 * `BUDDI_SUPERVISOR_SOCKET`, the path of an owner-only Unix socket in the data
 * directory. Only a process running as the owner can open it, which is exactly
 * who is already behind the dashboard's session and CSRF gate; the routes in
 * `server.ts` add nothing to that, they only forward.
 *
 * `fetch` cannot address a Unix socket at all, so this is `node:http`'s client
 * — one request, no agent, nothing pooled, and never a network origin.
 *
 * The obvious limitation is worth stating where the code is: `stop` and
 * `restart` take down the very gateway that is serving the page. The response
 * to a restart is the *old* process's last word, and the page has to wait for
 * the new one. A gateway that is down cannot be started from a browser tab at
 * all; `buddi` in a terminal is what brings it back.
 */
import { request } from 'node:http';

export interface SupervisorReply {
  status: number;
  body: unknown;
}

export type SupervisorMethod = 'GET' | 'POST' | 'PUT';

export function supervisorCall(socketPath: string, route: string, method: SupervisorMethod, body?: unknown, timeoutMs = 20_000): Promise<SupervisorReply> {
  // A body is small and known here, so it is serialized up front and sent with
  // a length: the supervisor reads one object, never a stream it has to bound.
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: route, method, headers: {
      host: 'localhost',
      ...(payload ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length } : {}),
    }, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        // A supervisor answers in bytes, not megabytes. Anything else is broken.
        if (text.length < 64_000) text += chunk;
      });
      res.on('end', () => {
        let body: unknown = null;
        try {
          body = text === '' ? null : JSON.parse(text);
        } catch {
          return reject(new Error('The supervisor answered with something that is not JSON.'));
        }
        resolve({ status: res.statusCode ?? 502, body });
      });
    });
    req.once('timeout', () => req.destroy(new Error('The supervisor did not answer in time.')));
    req.once('error', reject);
    req.end(payload);
  });
}

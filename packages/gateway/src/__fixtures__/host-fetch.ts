/**
 * `fetch`, but the Host header a test sets is the one sent.
 *
 * The platform `fetch` treats Host as forbidden and quietly writes its own,
 * which hides exactly what a proxy such as Tailscale Serve passes on: the host
 * and port the browser used. The dashboard names its cookies after that port,
 * so a test of a proxied request has to be able to say it.
 */
import { request } from 'node:http';

export function hostFetch(input: string, init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(input);
    const req = request(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: init.method ?? 'GET', headers: init.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
          }
          const status = res.statusCode ?? 0;
          const empty = status === 204 || status === 304 || init.method === 'HEAD';
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }));
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

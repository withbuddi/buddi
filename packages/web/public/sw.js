/*
 * buddi's service worker.
 *
 * One job: when the gateway is out of reach (Tailscale off, the Mac asleep,
 * `buddi serve` stopped), an installed buddi still opens, on its own page that
 * says what to check, rather than the browser's "This site can't be reached".
 *
 * It keeps this build's shell and nothing else: the list is `precache.json`,
 * which the build writes beside it (src/precache.ts). The build id rides in
 * this script's URL (`sw.js?v=<build>`, src/serviceWorker.ts), so a new build
 * is a new worker, a new cache, and the old cache goes on activate.
 *
 * What it never touches: `/api/*`, `/stream`, `/preview/*`, `/_buddi/*` (the
 * restart screen asks `/_buddi/ready` which process answers), and anything that
 * is not a GET. Those go to the network exactly as if it were not here, and
 * nothing buddi knows is ever written to a cache.
 *
 * Plain JS, not bundled, self-contained on purpose.
 */

const BUILD = new URL(self.location.href).searchParams.get('v') || 'unnamed';
const PREFIX = 'buddi-shell-';
const CACHE = PREFIX + BUILD;
/* A sleeping Mac never refuses a connection; it just never answers. */
const NAVIGATION_TIMEOUT_MS = 5000;

/** The page's own paths, resolved against where this worker is mounted. */
const scoped = (path) => new URL(path, self.registration.scope).href;

/** Requests that are none of this worker's business. */
function passThrough(request) {
  if (request.method !== 'GET') return true;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return true;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length - 1);
  return path === '/api' || path.startsWith('/api/') || path === '/stream' || path.startsWith('/stream/') || path.startsWith('/preview/') || path.startsWith('/_buddi/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch(scoped('precache.json'), { cache: 'no-store' });
      if (!response.ok) throw new Error(`precache.json: ${response.status}`);
      const { files } = await response.json();
      const cache = await caches.open(CACHE);
      // Never an API path, whatever the list says.
      await cache.addAll(files.filter((file) => !/^\/?(api|stream|preview)(\/|$)/.test(file)).map(scoped));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/**
 * A page load: the network first, always, so a reload is the current build and
 * the gateway's session rules apply. Only when nobody answers (no response, a
 * server error or a proxy's 502/503, a 429 from a locked-out address, or
 * silence past the timeout) is the kept shell served, and the shell says buddi
 * is out of reach. An empty 429 or 5xx would otherwise be the browser's own
 * "this page isn't working".
 */
async function navigate(request) {
  const cache = await caches.open(CACHE);
  const shell = await cache.match(scoped('index.html'));
  if (!shell) return fetch(request);
  const network = fetch(request);
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([network, late]);
    if (response && response.status !== 429 && response.status < 500) return response;
    return shell;
  } catch {
    return shell;
  } finally {
    clearTimeout(timer);
  }
}

/** A kept file: from the cache when it is there, from the network when it is not. */
async function asset(request) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(request);
  if (kept) return kept;
  try {
    return await fetch(request);
  } catch {
    // The gateway is restarting or away: answer like a server would, so the
    // page sees a failed request rather than a worker that threw.
    return new Response('', { status: 503, statusText: 'buddi is not answering' });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (passThrough(request)) return;
  event.respondWith(request.mode === 'navigate' ? navigate(request) : asset(request));
});

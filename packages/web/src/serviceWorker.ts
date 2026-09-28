/**
 * Registering the service worker (`public/sw.js`).
 *
 * The worker is what lets an installed buddi open when the gateway is out of
 * reach: it keeps this build's shell and hands it over when the network does
 * not answer, and the shell then says what to check. The build id rides in the
 * worker's URL, so a new build is a new worker with a new cache.
 *
 * Not in dev, where Vite serves modules the worker has never heard of, and not
 * under the test runner.
 */
import { WEB_BUILD } from './build';

export function registerWorker(): void {
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    const url = `./sw.js?v=${encodeURIComponent(WEB_BUILD ?? 'unnamed')}`;
    navigator.serviceWorker.register(url, { scope: './' }).catch(() => {
      /* No worker (a plain-http address, a private window): the page works as before. */
    });
  });
}

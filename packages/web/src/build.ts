/**
 * Which build this page is, and whether it runs as an installed app.
 *
 * `__BUDDI_WEB_BUILD__` is written in by Vite at build time (`vite.config.ts`);
 * the gateway reads the same name from the `build.json` it serves beside the
 * page and reports it as `web` on `/api/version`. When the two differ, this
 * page is from before an upgrade and a reload brings the new one.
 */
declare const __BUDDI_WEB_BUILD__: string | undefined;

/** This page's build, or undefined where no build named it (the test runner, the dev server's first load). */
export const WEB_BUILD: string | undefined = typeof __BUDDI_WEB_BUILD__ === 'string' ? __BUDDI_WEB_BUILD__ : undefined;

/** The served build is not this page's. Unknown on either side is never stale. */
export function buildDiffers(served: string | undefined, own: string | undefined = WEB_BUILD): boolean {
  return typeof served === 'string' && served !== '' && typeof own === 'string' && own !== '' && served !== own;
}

/** Running as an installed app: standalone display mode, or iOS's home-screen flag. */
export function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch {
    /* No matchMedia: a plain tab, as far as anyone can tell. */
  }
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

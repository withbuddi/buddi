/**
 * `buddi plugins dev <dir>` — the edit/build/see-it loop, and its limit.
 *
 * **Plugins are loaded once, at start.** `loadPluginsOnce` imports every entry
 * point in `plugins.json` before any registry is built, and `createWiring`
 * builds exactly one `ToolRegistry` whose object is then closed over by the
 * catalog, the delegation tool, the platform tools and every surface. There is
 * no `unregister` on the registry, and Node's module cache is keyed by URL, so
 * re-importing a rebuilt `dist/index.js` returns the module that is already
 * loaded. Reloading in place would therefore mean cache-busting the import
 * (leaking the old module, its timers and its pools), swapping a registry every
 * caller is holding by reference, and re-running the load-order checks against
 * a half-replaced set. That is not a two-hour change and it is not an honest
 * one, so this command does the other thing: it watches, and it says restart.
 *
 * What "restart" means depends on the installation, and that is the only fork
 * here. A packaged install has a service unit, so `buddi service restart` is a
 * real answer and the watcher runs it. A checkout has whatever the developer
 * started by hand, so the watcher prints one line and gets out of the way.
 */
import { execFile } from 'node:child_process';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How long a burst of writes is allowed to settle before it counts as one build. */
export const DEBOUNCE_MS = 400;

export interface DevDeps {
  log: (line: string) => void;
  /** Is a service unit installed *and* running? `buddi service status` answers. */
  serviceRunning: () => Promise<boolean>;
  /** Restart it. Resolves with what the service manager printed. */
  restart: () => Promise<string>;
}

/** `buddi service status` exits 0 only when the unit is installed and running. */
export async function probeService(): Promise<boolean> {
  try {
    await run('buddi', ['service', 'status'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function restartService(): Promise<string> {
  const { stdout } = await run('buddi', ['service', 'restart'], { timeout: 120_000 });
  return stdout.trim();
}

export function defaultDevDeps(): DevDeps {
  return {
    log: (line) => console.log(line),
    serviceRunning: probeService,
    restart: restartService,
  };
}

/**
 * What to do when `dist` changed, decided once per change and said out loud.
 *
 * Separate from the watcher so the decision is testable without a file system
 * event: a supervised installation gets a restart, everything else gets the
 * sentence that tells the developer what to type.
 */
export async function onRebuilt(deps: DevDeps, name: string): Promise<'restarted' | 'told'> {
  if (await deps.serviceRunning()) {
    deps.log(`${name}: dist changed — restarting the service so it loads again…`);
    try {
      const notes = await deps.restart();
      if (notes !== '') deps.log(notes);
      deps.log(`${name}: restarted. \`buddi plugins list\` should show your new version.`);
      return 'restarted';
    } catch (err) {
      deps.log(
        `${name}: \`buddi service restart\` failed (${err instanceof Error ? err.message : String(err)}). ` +
          'Restart buddi yourself; plugins are registered at start.',
      );
      return 'told';
    }
  }
  deps.log(
    `${name}: dist changed. Plugins are loaded once, at start — restart buddi to pick it up ` +
      '(stop `buddi serve` and run it again, or `buddi service restart` on a packaged install).',
  );
  return 'told';
}

export interface DevWatch {
  close: () => void;
}

/**
 * Watch `<dir>/dist` and call `onRebuilt` once per settled burst of writes.
 *
 * `tsc` rewrites several files per build, so the debounce is what turns one
 * build into one message instead of eleven. Returns a handle rather than
 * blocking: the CLI keeps the process alive, a test closes it.
 */
export function watchDist(dir: string, deps: DevDeps, name: string): DevWatch {
  const dist = path.join(dir, 'dist');
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const watcher: FSWatcher = watch(dist, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (running) return;
      running = true;
      void onRebuilt(deps, name).finally(() => {
        running = false;
      });
    }, DEBOUNCE_MS);
  });
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

/** `dist` must exist before anything can watch it: build once first. */
export function assertBuilt(dir: string): string {
  const dist = path.join(dir, 'dist');
  if (!existsSync(dist)) {
    throw new Error(
      `${dist} is not there. buddi installs the *built* package, so build it once first ` +
        '(`pnpm build`) and then run this again.',
    );
  }
  return dist;
}

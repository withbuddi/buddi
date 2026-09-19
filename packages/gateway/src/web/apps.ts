/**
 * The applications installed on this Mac, so the owner can allow one by its
 * name rather than by typing a bundle identifier.
 *
 * Read from the three places macOS puts them, through `plutil`, which is what
 * the OS itself uses to read an Info.plist whether it is XML or binary. The
 * result is cached for a few minutes: the list changes when something is
 * installed, not between two clicks. Nothing here runs an app or reads
 * anything but its manifest.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface InstalledApp {
  /** The bundle identifier, which is what the allow list stores. */
  id: string;
  name: string;
  path: string;
}

const CACHE_MS = 5 * 60_000;
let cache: { at: number; apps: InstalledApp[] } | null = null;

export async function listInstalledApps(now = Date.now()): Promise<InstalledApp[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.apps;
  if (process.platform !== 'darwin') return [];
  const roots = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(homedir(), 'Applications')];
  const found = new Map<string, InstalledApp>();
  for (const root of roots) {
    let entries: string[];
    try { entries = await readdir(root); } catch { continue; }
    await Promise.all(entries.filter((e) => e.endsWith('.app')).map(async (entry) => {
      const app = await readApp(path.join(root, entry));
      if (app && !found.has(app.id)) found.set(app.id, app);
    }));
  }
  const apps = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: now, apps };
  return apps;
}

async function readApp(appPath: string): Promise<InstalledApp | null> {
  try {
    const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], { timeout: 2_000, maxBuffer: 1 << 20 });
    const info = JSON.parse(stdout) as { CFBundleIdentifier?: string; CFBundleDisplayName?: string; CFBundleName?: string };
    if (!info.CFBundleIdentifier) return null;
    const name = info.CFBundleDisplayName || info.CFBundleName || path.basename(appPath, '.app');
    return { id: info.CFBundleIdentifier, name, path: appPath };
  } catch {
    return null;
  }
}


/** One Chromium profile, as Chrome names it to the owner and as it names it on disk. */
export interface BrowserProfile { directory: string; name: string }

const PROFILE_STATE: Record<string, string> = {
  'com.google.Chrome': 'Google/Chrome',
  'org.chromium.Chromium': 'Chromium',
  'com.microsoft.edgemac': 'Microsoft Edge',
  'com.brave.Browser': 'BraveSoftware/Brave-Browser',
};

/**
 * The profiles a Chromium browser keeps, read from its own "Local State" file.
 * Only the names and directories: no history, no cookies, nothing else in it.
 */
export async function listBrowserProfiles(app: string): Promise<BrowserProfile[]> {
  const folder = PROFILE_STATE[app];
  if (!folder || process.platform !== 'darwin') return [];
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(path.join(homedir(), 'Library', 'Application Support', folder, 'Local State'), 'utf8');
    const state = JSON.parse(text) as { profile?: { info_cache?: Record<string, { name?: string; user_name?: string }> } };
    const cache = state.profile?.info_cache ?? {};
    return Object.entries(cache)
      .map(([directory, info]) => ({ directory, name: info.name || directory }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

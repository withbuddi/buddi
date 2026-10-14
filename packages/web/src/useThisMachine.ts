/**
 * How the dashboard names the machine buddi runs on: "this Mac" on macOS,
 * "this computer" anywhere else — the wizard's tagline rule, from the gateway's
 * platform in `/api/session`. Read once per page load and shared.
 *
 * Until the answer arrives (or when an older gateway does not say), it is
 * "this computer": never wrong, where "this Mac" would be on Linux.
 */
import { useEffect, useState } from 'react';
import { api } from './api';

export type ThisMachine = 'this Mac' | 'this computer';

export function machineWords(platform: string | undefined): ThisMachine {
  return platform === 'darwin' ? 'this Mac' : 'this computer';
}

let asked: Promise<{ platform?: string; local: boolean } | undefined> | null = null;

function session(): Promise<{ platform?: string; local: boolean } | undefined> {
  asked ??= Promise.resolve().then(() => api.session()).then(
    (s) => ({ ...(s.platform ? { platform: s.platform } : {}), local: s.signedInThrough === 'local' }),
    () => { asked = null; return undefined; },
  );
  return asked;
}

export function useThisMachine(): ThisMachine {
  const [platform, setPlatform] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void session().then((s) => { if (live) setPlatform(s?.platform); });
    return () => { live = false; };
  }, []);
  return machineWords(platform);
}

/**
 * Whether this dashboard is open on the machine buddi runs on (signed in
 * locally): what "Open in app" needs, as the server's local-only routes do.
 * False until the session says.
 */
export function useOnThisMachine(): boolean {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    let live = true;
    void session().then((s) => { if (live) setLocal(s?.local === true); });
    return () => { live = false; };
  }, []);
  return local;
}

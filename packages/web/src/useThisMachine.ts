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

let asked: Promise<string | undefined> | null = null;

export function useThisMachine(): ThisMachine {
  const [platform, setPlatform] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    asked ??= api.session().then((s) => s.platform, () => { asked = null; return undefined; });
    void asked.then((p) => { if (live) setPlatform(p); });
    return () => { live = false; };
  }, []);
  return machineWords(platform);
}

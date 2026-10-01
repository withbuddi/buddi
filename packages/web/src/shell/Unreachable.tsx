/**
 * When buddi does not answer.
 *
 * Installed as an app on the tailnet address, the window opens whether or not
 * the Mac behind it is there: the service worker (`public/sw.js`) hands it the
 * shell it kept. This is what the shell then says instead of the browser's
 * "This site can't be reached": who is not answering, at which address, and
 * the one thing to check for that address. It asks again every ten seconds and
 * comes back on its own; a build that changed in the meantime is a reload.
 *
 * At boot it takes the whole window. Once the page is open, a link that stays
 * down for thirty seconds is the shell's banner instead (`useLostLink`, read by
 * the banner slot): the page under it is still worth reading.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, UNREACHABLE, api, isUnreachable, linkDownSince, onLinkChange, type VersionView } from '../api';
import { buildDiffers } from '../build';
import { Button } from '../ui';
import { mascotUrl } from '../views/meet/script';

/** How often a page that lost buddi asks again. */
export const RETRY_MS = 10_000;
/** How long the link may be down before the bar says so. */
export const LOST_AFTER_MS = 30_000;
/** How long the boot question waits: a sleeping Mac never says no, it just never answers. */
export const BOOT_TIMEOUT_MS = 6_000;

export const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$|\.localhost$/i;

/** The one thing to check, by the address the page was opened on. */
export function hintFor(hostname: string): ReactNode {
  if (LOOPBACK.test(hostname)) {
    return <>Is buddi running on this Mac? <code>buddi status</code> says.</>;
  }
  return <>Is Tailscale on, and the Mac it runs on awake?</>;
}

type Probe = { up: true; version?: VersionView } | { up: false };

/** One question to the gateway. Any answer but "nobody there" counts as up. */
async function probe(timeoutMs: number): Promise<Probe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(0, UNREACHABLE)), timeoutMs);
  });
  try {
    return { up: true, version: await Promise.race([api.version(), late]) };
  } catch (error) {
    return isUnreachable(error) ? { up: false } : { up: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Back from a gap: a different build being served means this page is stale. */
function returned(result: Probe): boolean {
  if (result.up && buildDiffers(result.version?.web)) {
    window.location.reload();
    return false;
  }
  return result.up;
}

export function Unreachable({ host, onRetry, retrying }: { host: string; onRetry: () => void; retrying: boolean }): JSX.Element {
  return (
    <main className="unreachable" role="alert">
      <span className="ui-blob" data-size="lg" aria-hidden="true">
        <img src={mascotUrl('core')} alt="" />
      </span>
      <h1>buddi isn't answering at {host}.</h1>
      <p>{hintFor(host.replace(/:\d+$/, ''))}</p>
      <div className="unreachable-actions">
        <Button variant="accent" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    </main>
  );
}

/**
 * The shell, once buddi has answered once. Until then nothing is drawn; when
 * nobody answers, the full-page state, asking again every ten seconds.
 */
export function BootGate({ children }: { children: ReactNode }): JSX.Element | null {
  const [state, setState] = useState<'checking' | 'up' | 'down'>('checking');
  const [retrying, setRetrying] = useState(false);
  const busy = useRef(false);

  const ask = useCallback(async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setRetrying(true);
    const result = await probe(BOOT_TIMEOUT_MS);
    busy.current = false;
    setRetrying(false);
    setState((current) => (current === 'checking' ? (result.up ? 'up' : 'down') : returned(result) ? 'up' : 'down'));
  }, []);

  useEffect(() => {
    void ask();
  }, [ask]);

  useEffect(() => {
    if (state !== 'down') return undefined;
    const timer = window.setInterval(() => void ask(), RETRY_MS);
    return () => window.clearInterval(timer);
  }, [state, ask]);

  if (state === 'checking') return null;
  if (state === 'down') return <Unreachable host={window.location.host} onRetry={() => void ask()} retrying={retrying} />;
  return <>{children}</>;
}

/** True once the page's requests have gone unanswered for `after` ms. */
export function useLinkLost(after = LOST_AFTER_MS): boolean {
  const [lost, setLost] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      clearTimeout(timer);
      const since = linkDownSince();
      if (since === null) return setLost(false);
      const left = since + after - Date.now();
      if (left <= 0) setLost(true);
      else timer = setTimeout(check, left);
    };
    check();
    const off = onLinkChange(check);
    return () => { off(); clearTimeout(timer); };
  }, [after]);
  return lost;
}

/**
 * Lost buddi once the page is open: true after thirty seconds unanswered, and
 * while it is, asks again every ten seconds; false the moment anything answers.
 * The shell's banner slot says so.
 */
export function useLostLink(): boolean {
  const lost = useLinkLost();
  useEffect(() => {
    if (!lost) return undefined;
    const timer = window.setInterval(() => {
      void probe(BOOT_TIMEOUT_MS).then(returned);
    }, RETRY_MS);
    return () => window.clearInterval(timer);
  }, [lost]);
  return lost;
}

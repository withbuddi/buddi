/*
 * Downloads an agent's action starts in the owner's Chrome (docs/browser.md,
 * "Downloads").
 *
 * Chrome saves the file where it saves every download; this only notices
 * which ones an agent's click caused and tells buddi where the finished file
 * is, so buddi can copy it into the agent's downloads area and Files. It needs
 * the optional `downloads` permission, which the owner grants from the popup
 * (Chrome only asks from a click in an extension page). Without it nothing
 * here runs and agents' downloads stay in the owner's Downloads folder.
 *
 * A download is the agent's when it starts while an agent command runs in one
 * of that session's tabs, or within a few seconds after, and comes from the
 * same site as one of those tabs. A download the owner starts is not touched:
 * not while no agent acts, not from another site, not one another extension
 * started. Chrome's download item names no tab, so a download the owner starts
 * from the very site the agent is working on in those same seconds would be
 * taken for the agent's; that is the one overlap left.
 */

export interface DownloadItemLike {
  id: number;
  url?: string;
  finalUrl?: string;
  referrer?: string;
  /** The absolute path Chrome saved it at, once it is known. */
  filename?: string;
  mime?: string;
  fileSize?: number;
  totalBytes?: number;
  byExtensionId?: string;
  state?: string;
}

export interface DownloadsApi {
  search(query: { id: number }): Promise<DownloadItemLike[]>;
  onCreated: { addListener(listener: (item: DownloadItemLike) => void): void };
  onChanged: { addListener(listener: (delta: { id: number; state?: { current?: string } }) => void): void };
}

/** The frame buddi reads (`readExtensionDownload` in the gateway). */
export interface DownloadFrame { type: 'download'; session: string; path: string; filename: string; url: string; mime?: string; size?: number }

/** How long after an agent's command a download that starts is still that command's. */
export const DOWNLOAD_GRACE_MS = 15_000;
/** The optional permission this needs, and the one the popup asks for. */
export const DOWNLOADS_PERMISSION = 'downloads';

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    // blob:https://bank.example/uuid has the page's origin; data: has none.
    if (parsed.protocol === 'blob:') return new URL(parsed.pathname).origin;
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch { return undefined; }
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() || 'download';
}

interface Armed { origins: Set<string>; running: number; until: number; at: number }

export class AgentDownloads {
  #armed = new Map<string, Armed>();
  #claimed = new Map<number, string>();
  #api?: DownloadsApi;
  #send: (frame: DownloadFrame) => void;
  #now: () => number;

  constructor(options: { send: (frame: DownloadFrame) => void; now?: () => number }) {
    this.#send = options.send;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Chrome's downloads API, once the owner granted it. Listening starts here, once. */
  attach(api: DownloadsApi | undefined): void {
    if (!api || this.#api) return;
    this.#api = api;
    api.onCreated.addListener((item) => this.created(item));
    api.onChanged.addListener((delta) => { void this.changed(delta).catch(() => undefined); });
  }
  get attached(): boolean { return this.#api !== undefined; }

  /** An agent command starts in this session, whose tabs are on these addresses. */
  begin(session: string, urls: readonly string[]): void {
    const armed = this.#armed.get(session) ?? { origins: new Set<string>(), running: 0, until: 0, at: 0 };
    for (const url of urls) { const origin = originOf(url); if (origin) armed.origins.add(origin); }
    armed.running += 1;
    armed.at = this.#now();
    this.#armed.set(session, armed);
  }

  /** It ended; the tabs may have moved on to these. Downloads still count for a few seconds. */
  end(session: string, urls: readonly string[] = []): void {
    const armed = this.#armed.get(session);
    if (!armed) return;
    for (const url of urls) { const origin = originOf(url); if (origin) armed.origins.add(origin); }
    armed.running = Math.max(0, armed.running - 1);
    armed.until = this.#now() + DOWNLOAD_GRACE_MS;
  }

  /** The session ended or the socket went: nothing more is its. */
  forget(session?: string): void {
    if (session === undefined) { this.#armed.clear(); this.#claimed.clear(); return; }
    this.#armed.delete(session);
    for (const [id, owner] of this.#claimed) if (owner === session) this.#claimed.delete(id);
  }

  /** Which session's command this download belongs to, if any. */
  #owner(item: DownloadItemLike): string | undefined {
    if (item.byExtensionId) return undefined;
    const origin = originOf(item.referrer) ?? originOf(item.finalUrl ?? item.url);
    if (!origin) return undefined;
    const now = this.#now();
    let best: { session: string; at: number } | undefined;
    for (const [session, armed] of this.#armed) {
      if (armed.running === 0 && now > armed.until) continue;
      if (!armed.origins.has(origin)) continue;
      if (!best || armed.at > best.at) best = { session, at: armed.at };
    }
    return best?.session;
  }

  created(item: DownloadItemLike): void {
    const session = this.#owner(item);
    if (session) this.#claimed.set(item.id, session);
  }

  async changed(delta: { id: number; state?: { current?: string } }): Promise<void> {
    const session = this.#claimed.get(delta.id);
    const state = delta.state?.current;
    if (!session || !state) return;
    if (state === 'interrupted') { this.#claimed.delete(delta.id); return; }
    if (state !== 'complete') return;
    this.#claimed.delete(delta.id);
    const [item] = await (this.#api?.search({ id: delta.id }) ?? Promise.resolve([]));
    if (!item?.filename) return;
    const url = item.finalUrl || item.url || '';
    const size = item.fileSize !== undefined && item.fileSize >= 0 ? item.fileSize : item.totalBytes !== undefined && item.totalBytes >= 0 ? item.totalBytes : undefined;
    this.#send({ type: 'download', session, path: item.filename, filename: basename(item.filename), url,
      ...(item.mime ? { mime: item.mime } : {}), ...(size !== undefined ? { size } : {}) });
  }
}

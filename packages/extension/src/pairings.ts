/*
 * One extension, many buddis: the list of buddis this browser is paired with.
 *
 * An owner who runs two buddis on one machine (a release and a checkout, say)
 * used to unpair one to pair the other. Now each buddi is one entry here, with
 * its own address, its own token, its own name and colour, and a switch. The
 * worker opens one socket per enabled entry (link.ts); a tab belongs to exactly
 * one of them (the group registry below).
 *
 * No Chrome in this file beyond the storage seam, so the store, the migration
 * from the single pairing, the naming and the colours are all tested on their
 * own.
 */

/** The colours `chrome.tabGroups` accepts, in the order new buddis get them. */
export const COLOURS = ['blue', 'purple', 'green', 'orange', 'pink', 'cyan', 'red', 'yellow', 'grey'] as const;
export type Colour = (typeof COLOURS)[number];

export const DEFAULT_GATEWAY = 'http://127.0.0.1:4317';

/** One buddi this browser knows. The token is absent until the owner typed the code. */
export interface Pairing {
  /** Stable, local: what the popup and the worker call this entry. Never sent anywhere. */
  id: string;
  /** `http://127.0.0.1:4317`: where this buddi listens, on this machine. */
  origin: string;
  token?: string;
  /** What the buddi calls itself (its handshake), empty until it said. */
  name: string;
  colour: Colour;
  enabled: boolean;
}

export interface Storage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/** Where the list lives in `chrome.storage.local`. */
export const PAIRINGS_KEY = 'pairings';
/** The one pairing this extension held before it could hold several. */
const LEGACY_GATEWAY = 'gateway';
const LEGACY_TOKEN = 'token';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** `http://127.0.0.1:4317`, or null for an address this extension will not talk to. */
export function originOf(address: string): string | null {
  let parsed: URL;
  try { parsed = new URL(address.trim()); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!LOOPBACK.includes(parsed.hostname)) return null;
  return parsed.origin;
}

/** The port a loopback origin listens on, written out even when it is the scheme's default. */
function portOf(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/**
 * Is this the same buddi? `localhost:4317` and `127.0.0.1:4317` are one
 * listener; two ports are two buddis.
 */
export function sameBuddi(a: string, b: string): boolean {
  let x: URL, y: URL;
  try { x = new URL(a); y = new URL(b); } catch { return false; }
  if (!LOOPBACK.includes(x.hostname) || !LOOPBACK.includes(y.hostname)) return false;
  return x.protocol === y.protocol && portOf(x) === portOf(y);
}

/** `127.0.0.1:4317`: what a buddi is called before it said its own name. */
export function hostOf(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

/**
 * What the owner reads in the popup and on the tab groups: the buddi's own
 * name, or its address while it has not said one. Two buddis that call
 * themselves the same get their port beside the name, so two groups never
 * read alike.
 */
export function displayName(entry: Pairing, all: readonly Pairing[]): string {
  const own = entry.name.trim();
  if (!own) return hostOf(entry.origin);
  const twin = all.some((other) => other.id !== entry.id && other.name.trim().toLowerCase() === own.toLowerCase());
  if (!twin) return own;
  try { return `${own} :${portOf(new URL(entry.origin))}`; } catch { return own; }
}

/** The first colour nobody has yet; a tenth buddi shares. */
export function nextColour(all: readonly Pairing[]): Colour {
  const taken = new Set(all.map((entry) => entry.colour));
  return COLOURS.find((colour) => !taken.has(colour)) ?? COLOURS[all.length % COLOURS.length]!;
}

function freshId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One stored entry, read strictly: anything that is not one is left out. */
function readEntry(raw: unknown): Pairing | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const origin = typeof value['origin'] === 'string' ? originOf(value['origin']) : null;
  if (!origin || typeof value['id'] !== 'string' || value['id'] === '') return null;
  const colour = (COLOURS as readonly string[]).includes(String(value['colour'])) ? value['colour'] as Colour : 'grey';
  const token = typeof value['token'] === 'string' && value['token'] !== '' ? value['token'] : undefined;
  return { id: value['id'], origin, ...(token ? { token } : {}), name: typeof value['name'] === 'string' ? value['name'].slice(0, 60) : '',
    colour, enabled: value['enabled'] !== false };
}

/**
 * The list, kept in `chrome.storage.local`.
 *
 * Every change is read, changed and written in one queued step, so two links
 * saving a token and a name at the same moment cannot undo each other.
 */
export class PairingStore {
  #storage: Storage;
  #tail: Promise<unknown> = Promise.resolve();
  #newId: () => string;
  constructor(storage: Storage, options: { id?: () => string } = {}) {
    this.#storage = storage;
    this.#newId = options.id ?? freshId;
  }

  /**
   * Every entry, after the one-time move from the single pairing.
   *
   * An extension that held `gateway` and `token` keeps exactly that buddi, as
   * the first entry, switched on. One that held nothing gets the default
   * address, switched on and unpaired, so a fresh install still knocks on the
   * buddi at 4317 by itself and the dashboard in this browser can pair it
   * without the owner typing anything.
   */
  list(): Promise<Pairing[]> { return this.#queue(async () => this.#load()); }

  async #load(): Promise<Pairing[]> {
    const stored = await this.#storage.get([PAIRINGS_KEY, LEGACY_GATEWAY, LEGACY_TOKEN]);
    const raw = stored[PAIRINGS_KEY];
    if (Array.isArray(raw)) return raw.map(readEntry).filter((entry): entry is Pairing => entry !== null);
    const address = typeof stored[LEGACY_GATEWAY] === 'string' ? originOf(stored[LEGACY_GATEWAY]) : null;
    const token = typeof stored[LEGACY_TOKEN] === 'string' && stored[LEGACY_TOKEN] !== '' ? stored[LEGACY_TOKEN] : undefined;
    const first: Pairing = { id: this.#newId(), origin: address ?? DEFAULT_GATEWAY, ...(token ? { token } : {}), name: '', colour: COLOURS[0], enabled: true };
    await this.#storage.set({ [PAIRINGS_KEY]: [first] });
    await this.#storage.remove([LEGACY_GATEWAY, LEGACY_TOKEN]);
    return [first];
  }

  async #save(entries: Pairing[]): Promise<void> { await this.#storage.set({ [PAIRINGS_KEY]: entries }); }

  #queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  /**
   * Add a buddi by its address, or hand back the entry that already has it
   * (switched on again). Throws the sentence the popup shows for an address
   * that is not on this machine.
   */
  add(address: string): Promise<Pairing> {
    return this.#queue(async () => {
      const origin = originOf(address);
      if (!origin) throw new Error(/^\s*https?:\/\//i.test(address) ? 'A buddi address has to be on this machine.' : 'A buddi address starts with http.');
      const entries = await this.#load();
      const existing = entries.find((entry) => sameBuddi(entry.origin, origin));
      if (existing) {
        existing.enabled = true;
        await this.#save(entries);
        return existing;
      }
      const entry: Pairing = { id: this.#newId(), origin, name: '', colour: nextColour(entries), enabled: true };
      entries.push(entry);
      await this.#save(entries);
      return entry;
    });
  }

  /** Change one entry in place; nothing happens to an entry that is gone. */
  update(id: string, patch: Partial<Pick<Pairing, 'token' | 'name' | 'enabled'>>): Promise<Pairing | undefined> {
    return this.#queue(async () => {
      const entries = await this.#load();
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return undefined;
      if ('token' in patch) { if (patch.token) entry.token = patch.token; else delete entry.token; }
      if (patch.name !== undefined) entry.name = patch.name.slice(0, 60);
      if (patch.enabled !== undefined) entry.enabled = patch.enabled;
      await this.#save(entries);
      return entry;
    });
  }

  /** Forget a buddi: its entry and its token go; its tabs stay, because they are the owner's. */
  remove(id: string): Promise<void> {
    return this.#queue(async () => {
      const entries = await this.#load();
      await this.#save(entries.filter((entry) => entry.id !== id));
    });
  }

  /** The token seam `Protocol` reads and writes, for one entry. */
  tokens(id: string): TokenStore {
    return {
      read: async () => (await this.list()).find((entry) => entry.id === id)?.token ?? null,
      write: async (token) => { await this.update(id, { token }); },
      clear: async () => { await this.update(id, { token: undefined }); },
    };
  }
}

/** Where one link's token is kept. */
export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Which buddi owns which tab group.
 *
 * Every link puts its conversations' tabs in groups of its own; this is the
 * one place that says whose a group is, so a tab in one buddi's group is never
 * claimed by another buddi, and a group id Chrome reuses after one closed is
 * handed to whoever made it last.
 */
export class GroupRegistry {
  #owners = new Map<number, string>();
  /** Record that `instance` made (or re-joined) this group. */
  claim(groupId: number, instance: string): void { if (groupId >= 0) this.#owners.set(groupId, instance); }
  /** Whose group this is, or undefined for a group no buddi made (the owner's own). */
  ownerOf(groupId: number | undefined): string | undefined { return groupId === undefined || groupId < 0 ? undefined : this.#owners.get(groupId); }
  /** May `instance` act in a tab that sits in this group? Only in its own, or in no group at all. */
  allows(groupId: number | undefined, instance: string): boolean {
    const owner = this.ownerOf(groupId);
    return owner === undefined || owner === instance;
  }
  /** A buddi was removed: its groups belong to nobody now (the tabs are the owner's). */
  release(instance: string): void { for (const [groupId, owner] of this.#owners) if (owner === instance) this.#owners.delete(groupId); }
  groupsOf(instance: string): number[] { return [...this.#owners].filter(([, owner]) => owner === instance).map(([groupId]) => groupId); }
}

/** The list of buddis: the move from one pairing, adding, naming, colours, and whose group is whose. */
import { describe, expect, it } from 'vitest';
import { COLOURS, DEFAULT_GATEWAY, GroupRegistry, PairingStore, displayName, nextColour, originOf, sameBuddi, type Pairing } from './pairings.js';

function storage(initial: Record<string, unknown> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => map.has(key)).map((key) => [key, structuredClone(map.get(key))])),
    set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value)); },
    remove: async (keys: string[]) => { for (const key of keys) map.delete(key); },
  };
}
const ids = () => { let n = 0; return () => `id${++n}`; };
const entry = (over: Partial<Pairing>): Pairing => ({ id: 'x', origin: DEFAULT_GATEWAY, name: '', colour: 'blue', enabled: true, ...over });

describe('the move from a single pairing', () => {
  it('keeps the address and the token as the first buddi, switched on, and drops the old keys', async () => {
    const disk = storage({ gateway: 'http://127.0.0.1:4327', token: 'kept' });
    const list = await new PairingStore(disk, { id: ids() }).list();
    expect(list).toEqual([{ id: 'id1', origin: 'http://127.0.0.1:4327', token: 'kept', name: '', colour: COLOURS[0], enabled: true }]);
    expect([...disk.map.keys()]).toEqual(['pairings']);
  });

  it('starts a fresh install on the default address, unpaired, so it still knocks there by itself', async () => {
    expect(await new PairingStore(storage(), { id: ids() }).list()).toEqual([{ id: 'id1', origin: DEFAULT_GATEWAY, name: '', colour: 'blue', enabled: true }]);
  });

  it('moves once: a list that exists, even empty, is the list', async () => {
    const disk = storage({ pairings: [], gateway: 'http://127.0.0.1:4327' });
    expect(await new PairingStore(disk, { id: ids() }).list()).toEqual([]);
  });

  it('reads stored entries strictly, leaving out what is not one', async () => {
    const disk = storage({ pairings: [{ id: 'a', origin: 'http://localhost:4317', name: 'buddi', colour: 'green', enabled: false }, { id: 'b', origin: 'https://example.com' }, 'nonsense', { origin: 'http://127.0.0.1:1' }] });
    expect(await new PairingStore(disk).list()).toEqual([{ id: 'a', origin: 'http://localhost:4317', name: 'buddi', colour: 'green', enabled: false }]);
  });
});

describe('adding, changing and removing', () => {
  it('adds a buddi with the next colour, and the same buddi twice is one entry', async () => {
    const pairings = new PairingStore(storage(), { id: ids() });
    await pairings.list();
    const dev = await pairings.add('http://127.0.0.1:4327/');
    expect(dev).toMatchObject({ id: 'id2', origin: 'http://127.0.0.1:4327', colour: 'purple', enabled: true });
    await pairings.update(dev.id, { enabled: false });
    const again = await pairings.add('http://localhost:4327');
    expect(again.id).toBe('id2');
    expect(again.enabled).toBe(true);
    expect(await pairings.list()).toHaveLength(2);
  });

  it('refuses an address off this machine or not on http', async () => {
    const pairings = new PairingStore(storage(), { id: ids() });
    await expect(pairings.add('https://example.com')).rejects.toThrow('A buddi address has to be on this machine.');
    await expect(pairings.add('ftp://127.0.0.1')).rejects.toThrow('A buddi address starts with http.');
  });

  it('keeps each entry’s token apart, and removing one takes only its token', async () => {
    const pairings = new PairingStore(storage(), { id: ids() });
    const [first] = await pairings.list();
    const second = await pairings.add('http://127.0.0.1:4327');
    await pairings.tokens(first!.id).write('one');
    await pairings.tokens(second.id).write('two');
    expect(await pairings.tokens(first!.id).read()).toBe('one');
    expect(await pairings.tokens(second.id).read()).toBe('two');
    await pairings.tokens(second.id).clear();
    expect(await pairings.tokens(second.id).read()).toBeNull();
    await pairings.remove(first!.id);
    expect((await pairings.list()).map((item) => item.id)).toEqual([second.id]);
  });

  it('two saves at once both land', async () => {
    const pairings = new PairingStore(storage(), { id: ids() });
    const [first] = await pairings.list();
    await Promise.all([pairings.update(first!.id, { name: 'buddi' }), pairings.tokens(first!.id).write('t')]);
    expect(await pairings.list()).toMatchObject([{ name: 'buddi', token: 't' }]);
  });
});

describe('names, colours and addresses', () => {
  it('names a buddi by what it said, by its address before that, and by its port beside a twin', () => {
    const release = entry({ id: 'a', name: 'buddi' });
    const other = entry({ id: 'b', origin: 'http://127.0.0.1:4391', name: 'Buddi' });
    const dev = entry({ id: 'c', origin: 'http://127.0.0.1:4327', name: 'buddi-dev' });
    const fresh = entry({ id: 'd', origin: 'http://127.0.0.1:4400' });
    expect(displayName(dev, [release, dev])).toBe('buddi-dev');
    expect(displayName(fresh, [fresh])).toBe('127.0.0.1:4400');
    expect(displayName(release, [release, other])).toBe('buddi :4317');
    expect(displayName(other, [release, other])).toBe('Buddi :4391');
  });

  it('hands out colours nobody has, then shares', () => {
    expect(nextColour([])).toBe('blue');
    expect(nextColour([entry({ colour: 'blue' }), entry({ colour: 'green' })])).toBe('purple');
    expect(COLOURS).toContain(nextColour(COLOURS.map((colour) => entry({ colour }))));
  });

  it('knows one listener by every loopback name, and two ports as two buddis', () => {
    expect(sameBuddi('http://localhost:4317', 'http://127.0.0.1:4317/')).toBe(true);
    expect(sameBuddi('http://[::1]:4317', 'http://127.0.0.1:4317')).toBe(true);
    expect(sameBuddi('http://127.0.0.1:4317', 'http://127.0.0.1:4327')).toBe(false);
    expect(sameBuddi('https://127.0.0.1:4317', 'http://127.0.0.1:4317')).toBe(false);
    expect(sameBuddi('http://example.com:4317', 'http://127.0.0.1:4317')).toBe(false);
    expect(originOf(' http://127.0.0.1:4317/settings ')).toBe('http://127.0.0.1:4317');
    expect(originOf('http://10.0.0.2:4317')).toBeNull();
  });
});

describe('whose tab group is whose', () => {
  it('lets a buddi act only in its own groups and in tabs in no group', () => {
    const groups = new GroupRegistry();
    groups.claim(7, 'release');
    groups.claim(9, 'dev');
    expect(groups.allows(7, 'release')).toBe(true);
    expect(groups.allows(7, 'dev')).toBe(false);
    expect(groups.allows(9, 'release')).toBe(false);
    expect(groups.allows(-1, 'dev')).toBe(true);
    expect(groups.allows(undefined, 'dev')).toBe(true);
    // A group Chrome hands out again belongs to whoever made it last.
    groups.claim(7, 'dev');
    expect(groups.ownerOf(7)).toBe('dev');
    expect(groups.groupsOf('dev').sort()).toEqual([7, 9]);
    groups.release('dev');
    expect(groups.ownerOf(9)).toBeUndefined();
  });
});

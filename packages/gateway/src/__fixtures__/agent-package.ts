/**
 * Catalogue packages for tests, as the market index carries them (buddi-market
 * `scripts/index.mjs`): `agent.json` plus `persona`, `skills: [{ file, text }]`,
 * `avatar: { url, sha256 }` and `page`, with the integrity written the way
 * the market check writes it. Nothing here reaches the network.
 */
import pngjs from 'pngjs';
import { packageIntegrity, sriSha256 } from '../agents/catalogue-package.js';

export const ORIGIN = 'https://withbuddi.com';

/** A small square PNG of one colour. */
export function png(side = 64, rgba: [number, number, number, number] = [40, 120, 200, 255]): Buffer {
  const image = new pngjs.PNG({ width: side, height: side });
  for (let i = 0; i < image.data.length; i += 4) image.data.set(rgba, i);
  return pngjs.PNG.sync.write(image);
}

/** Researcher, from Scout's files: the fixture the spec names (§11 step 2). */
export const RESEARCHER_PERSONA = [
  'You are Researcher, the owner\'s researcher and second opinion. There is exactly one owner: the person you are talking to. Today is {{today}}.',
  '',
  'You exist for two things: looking things up properly, and thinking a question through from outside.',
  '',
  '## Style',
  '- Plain text, short lines. Name every source.',
].join('\n');

export const RESEARCHER_SKILL = [
  '---',
  'name: answering-with-sources',
  'description: How to turn search results and fetched pages into an answer the owner can check.',
  '---',
  '',
  'An answer from the web is worth exactly as much as the owner\'s ability to check it.',
].join('\n');

export interface FixtureOptions {
  manifest?: Record<string, unknown>;
  persona?: string;
  skills?: Array<{ file: string; text: string }>;
  /** The picture's bytes; null for none. */
  avatar?: Buffer | null;
  /** Leave the integrity as given instead of computing it (a tampered listing). */
  integrity?: string;
}

/** Every picture an entry was made with, by its URL: what the market serves. */
export const PICTURES = new Map<string, Buffer>();

/** One index entry, its integrity computed as the market check would. */
export function agentEntry(name: string, opts: FixtureOptions = {}): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    kind: 'agent',
    name,
    version: '1.0.0',
    handle: name,
    title: name.charAt(0).toUpperCase() + name.slice(1),
    pitch: `The ${name}.`,
    description: `Does what a ${name} does.`,
    about: `A ${name}. It does not do anything else.`,
    category: 'work',
    trust: 'by-buddi',
    author: { name: 'withbuddi', url: 'https://withbuddi.com' },
    license: 'Apache-2.0',
    buddi: '>=0.1.0-pre.1',
    requires: {},
    optional: {},
    needs: [],
    tools: ['memory.*', 'reminder.*', 'owner.notify'],
    missions: [],
    fills: [],
    examples: ['One thing to ask.', 'Another thing to ask.', 'A third thing to ask.'],
    language: 'mirror',
    replaces: [],
    changes: 'First version.',
    ...opts.manifest,
  };
  const persona = opts.persona ?? `You are the ${name}. Today is {{today}}.`;
  const skills = opts.skills ?? [];
  const avatar = opts.avatar === undefined ? png() : opts.avatar;
  const avatarSha256 = avatar ? sriSha256(avatar) : null;
  const { integrity: _i, claims: _c, ...rest } = manifest;
  const integrity = opts.integrity ?? packageIntegrity({ manifest: rest, persona, skills, avatarSha256 });
  if (avatar) PICTURES.set(`${ORIGIN}/plugins/agents/${name}/avatar.png`, avatar);
  return {
    ...rest,
    integrity,
    claims: { tools: [] },
    persona,
    skills,
    ...(avatar ? { avatar: { url: `${ORIGIN}/plugins/agents/${name}/avatar.png`, sha256: avatarSha256 } } : {}),
    page: `${ORIGIN}/plugins/agents/${name}/`,
  };
}

/** A market plugin listing, as `/plugins/index.json` lists it. */
export function pluginListing(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    npm: `@withbuddi/plugin-${name}`,
    version: '1.0.0',
    title: name.charAt(0).toUpperCase() + name.slice(1),
    summary: '',
    category: 'home',
    trust: 'by-buddi',
    pricing: { kind: 'free' },
    integrity: `sha512-${name}`,
    ...over,
  };
}

/**
 * A `fetch` that answers the market index and the pictures from memory. Set
 * `state.offline` to make every request fail as a dropped connection would.
 */
export function marketFetch(state: { index: Record<string, unknown>; pictures: Map<string, Buffer>; offline?: boolean; asked?: string[] }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    state.asked?.push(url);
    if (state.offline) throw new TypeError('fetch failed');
    if (url.endsWith('/plugins/index.json')) {
      return new Response(JSON.stringify(state.index), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const picture = state.pictures.get(url);
    if (picture) return new Response(picture, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

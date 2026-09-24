/**
 * Which accent an agent wears.
 *
 * Every agent wears one accent from the mascot kit (fill, soft, ink): on its
 * face, as a soft wash in its chat header, on the active roster row's marker
 * and on its agent card's top edge. Never as body text, never as a left
 * border. The colours live in `tokens.css`; this file only picks a name.
 *
 * In order: the agent file's own `accent` (a `#rrggbb` it chose), else the
 * palette entry its role names, else the palette entry its granted tool
 * families point at, else Buddi blue for the default agent and the front
 * desk, else a stable hash of its id onto the palette — so an agent nobody
 * gave a colour still keeps the same one from one load to the next.
 */
import type { CSSProperties } from 'react';

/** The entries a hash lands on. Art is left out so no hashed colour moves. */
export const AGENT_PALETTE = ['coding', 'finance', 'mail', 'research', 'calendar', 'files', 'memory'] as const;

export type AccentKey = (typeof AGENT_PALETTE)[number] | 'art' | 'buddi';

/** What wears the accent: a palette entry, or the agent's own colour. */
export type Accent = { key: AccentKey } | { key: 'own'; hex: string };

/**
 * Roles that say what an agent is about. A surface role (`overview`,
 * `recap`, `maker`) says where it answers, not what it does, so it names no
 * colour; `credit` is the finance family's own.
 */
const ROLE_ACCENTS: Readonly<Record<string, AccentKey>> = {
  developer: 'coding',
  coding: 'coding',
  finance: 'finance',
  credit: 'finance',
  mail: 'mail',
  email: 'mail',
  research: 'research',
  calendar: 'calendar',
  files: 'files',
  memory: 'memory',
  'front-desk': 'buddi',
};

/**
 * Tool families that say what an agent does, most specific first: an agent
 * that reads mail and also browses is a mail agent, and one that only
 * remembers is a memory agent. Only the family (the part before the dot) is
 * read, and only to pick a colour — nothing here decides what a tool does.
 * Families every agent tends to carry (host, platform, reminder, …) name none.
 */
const FAMILY_ACCENTS: ReadonlyArray<readonly [AccentKey, readonly string[]]> = [
  ['mail', ['email']],
  ['finance', ['finance']],
  ['coding', ['developer']],
  ['research', ['web', 'browser']],
  ['art', ['image']],
];

function familyAccent(tools: readonly string[]): AccentKey | null {
  const families = new Set(tools.map((tool) => tool.split('.')[0] ?? tool));
  for (const [key, names] of FAMILY_ACCENTS) {
    if (names.some((name) => families.has(name))) return key;
  }
  // Memory only when it is all the agent reaches: nearly everyone remembers.
  if (families.size > 0 && [...families].every((family) => family === 'memory')) return 'memory';
  return null;
}

let defaultAgentId: string | null = null;

/** The shell tells this module who the default agent is, once it knows. */
export function rememberDefaultAgent(id: string | null): void {
  defaultAgentId = id;
}

export interface AccentSource {
  id: string;
  accent?: string | undefined;
  roles?: readonly string[] | undefined;
  /** Its granted tools, resolved: only their families are read. */
  tools?: readonly string[] | undefined;
}

export function accentOf(agent: AccentSource): Accent {
  if (agent.accent && /^#[0-9a-fA-F]{6}$/.test(agent.accent)) return { key: 'own', hex: agent.accent.toLowerCase() };
  for (const role of agent.roles ?? []) {
    const key = ROLE_ACCENTS[role];
    if (key) return { key };
  }
  const family = familyAccent(agent.tools ?? []);
  if (family) return { key: family };
  if (defaultAgentId !== null && agent.id === defaultAgentId) return { key: 'buddi' };
  return { key: AGENT_PALETTE[hashOf(agent.id) % AGENT_PALETTE.length] ?? 'coding' };
}

/** The two attributes an element needs to wear an accent. */
export function accentAttrs(accent: Accent): { 'data-agent': string; style?: CSSProperties } {
  if (accent.key === 'own') return { 'data-agent': 'own', style: { '--agent-fill': accent.hex } as CSSProperties };
  return { 'data-agent': accent.key };
}

function hashOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash;
}

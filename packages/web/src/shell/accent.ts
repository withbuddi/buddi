/**
 * Which accent an agent wears.
 *
 * Every agent wears one accent from the mascot kit (fill, soft, ink): on its
 * face, as a soft wash in its chat header, on the active roster row's marker
 * and on its agent card's top edge. Never as body text, never as a left
 * border. The colours live in `tokens.css`; this file only picks a name.
 *
 * In order: the agent file's own `accent` (a `#rrggbb` it chose), else the
 * palette entry its role names, else Buddi blue for the default agent and the
 * front desk, else a stable hash of its id onto the palette — so an agent
 * nobody gave a colour still keeps the same one from one load to the next.
 */
import type { CSSProperties } from 'react';

export const AGENT_PALETTE = ['coding', 'finance', 'mail', 'research', 'calendar', 'files', 'memory'] as const;

export type AccentKey = (typeof AGENT_PALETTE)[number] | 'buddi';

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

let defaultAgentId: string | null = null;

/** The shell tells this module who the default agent is, once it knows. */
export function rememberDefaultAgent(id: string | null): void {
  defaultAgentId = id;
}

export interface AccentSource {
  id: string;
  accent?: string | undefined;
  roles?: readonly string[] | undefined;
}

export function accentOf(agent: AccentSource): Accent {
  if (agent.accent && /^#[0-9a-fA-F]{6}$/.test(agent.accent)) return { key: 'own', hex: agent.accent.toLowerCase() };
  for (const role of agent.roles ?? []) {
    const key = ROLE_ACCENTS[role];
    if (key) return { key };
  }
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

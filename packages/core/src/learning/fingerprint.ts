/**
 * A proposal's fingerprint: the same thing proposed twice hashes the same.
 *
 * Kind + agent + the payload's *identifying* fields — not the whole payload.
 * A skill is identified by its name, a policy by its plugin, matcher and
 * action, a change by which part of the file it touches and the text it
 * proposes. The agent's sentence about why, and a skill's steps, are left
 * out on purpose: a skill the owner discarded should not come back under a
 * reworded justification or with one step swapped.
 */
import { createHash } from 'node:crypto';
import type { ProposalKind } from './types.js';

/** Case, spacing and punctuation at the ends do not make a different proposal. */
function norm(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^[\s.,;:!?"'`-]+|[\s.,;:!?"'`-]+$/g, '');
}

/** A proposed tool list, as the set of names it declares. */
export function toolSet(value: unknown): string[] {
  const names = String(value ?? '')
    .split(/[,\n]/)
    .map((name) => name.trim().replace(/^[-*]\s+/, '').toLowerCase())
    .filter((name) => name !== '');
  return [...new Set(names)].sort();
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` hash the same. */
function fingerprintJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprintJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${fingerprintJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(typeof value === 'string' ? norm(value) : value ?? null);
}

/** The fields that make two proposals of a kind the same proposal. */
export function identifyingFields(kind: ProposalKind, payload: Record<string, unknown>): unknown {
  switch (kind) {
    case 'skill':
      return { name: norm(payload.name) };
    case 'policy':
      return { plugin: norm(payload.plugin), matcher: payload.matcher ?? null, action: norm(payload.action) };
    case 'change':
      // A tool list is a set: the same grant in another order, or spaced
      // differently, is the same proposal, and a discard must hold for it.
      return payload.part === 'tools'
        ? { part: 'tools', proposed: toolSet(payload.proposed) }
        : { part: norm(payload.part), proposed: norm(payload.proposed) };
  }
}

/**
 * A policy is the plugin's rule, whichever agent's run noticed it: two triage
 * agents seeing the same sender propose one card, and a discard holds for both.
 * So a policy's fingerprint leaves the agent out.
 */
export function proposalFingerprint(kind: ProposalKind, agent: string, payload: Record<string, unknown>): string {
  const who = kind === 'policy' ? '' : norm(agent);
  const basis = fingerprintJson({ kind, agent: who, id: identifyingFields(kind, payload) });
  return createHash('sha256').update(basis).digest('hex');
}

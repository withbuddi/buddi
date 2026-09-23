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
      return { part: norm(payload.part), proposed: norm(payload.proposed) };
  }
}

export function proposalFingerprint(kind: ProposalKind, agent: string, payload: Record<string, unknown>): string {
  const basis = fingerprintJson({ kind, agent: norm(agent), id: identifyingFields(kind, payload) });
  return createHash('sha256').update(basis).digest('hex');
}

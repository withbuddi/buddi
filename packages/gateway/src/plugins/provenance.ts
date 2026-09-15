/**
 * Who proposed this agent, and what has happened to it since.
 *
 * The design question behind the whole feature is one sentence: when a plugin
 * ships an agent and the owner accepts it, **whose file is it?** Two answers
 * were possible and only one of them is safe.
 *
 * If the file stayed owned by the plugin, an upgrade would rewrite it. That
 * file's `tools:` line is the privilege boundary — it is the only thing that
 * decides what the agent can reach — so a plugin that could rewrite it could
 * widen a grant on a Tuesday afternoon with no approval anywhere. And the owner
 * could not change a persona they disliked without losing the change next time.
 *
 * So: **on accept, the file is copied into the owner's own agents directory and
 * it is theirs from that moment.** A plugin upgrade never writes it. It can
 * only propose again — through the same gated `platform.accept_plugin_agent`,
 * with the same preview naming the whole grant — and the owner approves that or
 * does not.
 *
 * What is left is telling the truth about drift, which is what this file
 * records. A small `plugin.json` sits beside `agent.md` with the plugin, the
 * version, a hash of the proposal that was accepted, and a hash of the file as
 * it was written. From those four facts `buddi plugins info` can say, without
 * guessing:
 *
 *   - you have not accepted this one;
 *   - you accepted it and have not touched it, and the plugin still proposes
 *     exactly what you accepted;
 *   - the plugin now proposes something different (here is what changed);
 *   - you have edited your copy (so nothing will be touched, ever).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SuggestedAgent } from '@buddi/core';

/** The sidecar's file name, beside `agent.md` in the agent's own directory. */
export const PROVENANCE_FILE = 'plugin.json';

export interface AgentProvenance {
  /** The plugin that proposed this agent. */
  plugin: string;
  /** The plugin version whose proposal was accepted. */
  version: string;
  /** The suggestion's id inside that plugin. */
  agent: string;
  acceptedAt: string;
  /** sha256 of the canonical proposal — what an upgrade is compared against. */
  proposal: string;
  /** sha256 of `agent.md` as it was written — what an owner edit is measured against. */
  file: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A stable hash of what the plugin proposed.
 *
 * Over the *canonical* fields, not over a serialisation of the object: a
 * reordered literal or a new optional field with no value must not read as "the
 * plugin changed its mind".
 */
export function proposalChecksum(agent: SuggestedAgent): string {
  const canonical = {
    id: agent.id,
    handle: agent.handle,
    name: agent.name,
    description: agent.description,
    persona: agent.persona,
    tools: [...agent.tools],
    roles: [...(agent.roles ?? [])],
    model: agent.model ?? null,
    provider: agent.provider ?? null,
    maxTurns: agent.maxTurns ?? null,
    language: agent.language ?? null,
    skills: (agent.skills ?? []).map((s) => ({ name: s.name, description: s.description, body: s.body })),
  };
  return sha256(JSON.stringify(canonical));
}

export function provenancePath(agentDir: string): string {
  return path.join(agentDir, PROVENANCE_FILE);
}

/** The sidecar, or undefined when this agent was not accepted from a plugin. */
export function readProvenance(agentDir: string): AgentProvenance | undefined {
  const file = provenancePath(agentDir);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AgentProvenance>;
    if (typeof raw.plugin !== 'string' || typeof raw.agent !== 'string') return undefined;
    return {
      plugin: raw.plugin,
      version: raw.version ?? 'unknown',
      agent: raw.agent,
      acceptedAt: raw.acceptedAt ?? 'unknown',
      proposal: raw.proposal ?? '',
      file: raw.file ?? '',
    };
  } catch {
    // A sidecar nobody can read is a missing sidecar: it records provenance,
    // it authorizes nothing, and a broken one must never stop an agent loading.
    return undefined;
  }
}

/** The sidecar's text, for the atomic write that creates the agent directory. */
export function composeProvenance(input: {
  plugin: string;
  version: string;
  agent: string;
  acceptedAt: Date;
  proposal: string;
  file: string;
}): string {
  const record: AgentProvenance = {
    plugin: input.plugin,
    version: input.version,
    agent: input.agent,
    acceptedAt: input.acceptedAt.toISOString(),
    proposal: input.proposal,
    file: sha256(input.file),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Where an accepted agent stands relative to what its plugin proposes today. */
export type DriftState =
  | 'not-accepted'
  | 'up-to-date'
  | 'proposal-changed'
  | 'owner-edited'
  | 'owner-edited-and-proposal-changed'
  | 'gone';

export interface Drift {
  state: DriftState;
  /** One sentence, owner-facing. */
  message: string;
}

/**
 * Compare what is on disk with what the plugin proposes now.
 *
 * Nothing here writes anything, and that is the guarantee: an upgrade calls
 * this, prints what it says, and stops.
 */
export function driftFor(opts: {
  agentDir: string;
  agentFile: string;
  suggestion: SuggestedAgent;
  pluginVersion: string;
}): Drift {
  if (!existsSync(opts.agentFile)) {
    return {
      state: 'not-accepted',
      message: 'you have not accepted this one — ask your agent to accept it and approve the grant',
    };
  }
  const provenance = readProvenance(opts.agentDir);
  if (provenance === undefined) {
    return {
      state: 'owner-edited',
      message:
        `an agent "${opts.suggestion.id}" already exists in your directory and was not accepted from ` +
        'this plugin. It is yours; nothing will touch it.',
    };
  }
  const edited = provenance.file !== '' && provenance.file !== sha256(readFileSync(opts.agentFile, 'utf8'));
  const changed = provenance.proposal !== proposalChecksum(opts.suggestion);
  if (edited && changed) {
    return {
      state: 'owner-edited-and-proposal-changed',
      message:
        `you edited your copy, and ${opts.suggestion.id} also changed in the plugin since you accepted ` +
        `it (you accepted ${provenance.version}, this is ${opts.pluginVersion}). Your file is left exactly ` +
        'as you wrote it. Ask your agent to accept the new proposal if you want to compare it.',
    };
  }
  if (edited) {
    return {
      state: 'owner-edited',
      message: 'you have edited your copy; it is yours and nothing will change it',
    };
  }
  if (changed) {
    return {
      state: 'proposal-changed',
      message:
        `the plugin proposes a different ${opts.suggestion.id} now (you accepted ${provenance.version}, ` +
        `this is ${opts.pluginVersion}). Your copy is untouched — accepting again is an approval you make, ` +
        'grant and all.',
    };
  }
  return {
    state: 'up-to-date',
    message: `accepted from ${provenance.plugin}@${provenance.version}, unchanged on both sides`,
  };
}

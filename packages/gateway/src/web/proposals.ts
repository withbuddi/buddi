/**
 * Settings → Proposals: what the agents learned, waiting for the owner.
 *
 * One read and two writes. Keeping records `kept` and the (possibly
 * corrected) payload, then asks the kind's apply. A skill is written as a
 * versioned file under the agent (learning step 2); a policy is handed to its
 * plugin's own apply, found on the installed manifest (step 3), and a plugin
 * that registered none refuses the keep and leaves the card open; a change
 * answers honestly that nothing was applied yet (step 4). Discarding a policy
 * also tells its plugin, through its revoke.
 *
 * A skill proposal whose name the agent already has a learned skill under is
 * its next version: the view carries the current steps, and the page draws
 * the proposal as a diff against them.
 */
import {
  APPLY,
  appendEvent,
  revokeDiscardedPolicy,
  describeUntrustedSource,
  discardProposal,
  getProposal,
  keepProposal,
  keptNote,
  listClosedProposals,
  listOpenProposals,
  proposalTitle,
  reopenProposal,
  type AgentCatalog,
  type PolicyHandler,
  type Proposal,
  type ToolRegistry,
} from '@buddi/core';
import type { Pool } from 'pg';
import { describeOwnerAgentEdit, PlatformRefusal, readBoundAgentFile, updateAgentFromOwner } from '../agents/platform.js';
import { agentSkillsDirFor, currentLearnedSkill, skillKeepProblem, type CurrentLearnedSkill } from '../agents/learned-skills.js';
import type { WriteDeps, WriteResult } from './write.js';

export interface ProposalView {
  id: string;
  kind: Proposal['kind'];
  agent: string;
  title: string;
  why: string;
  /** The text the owner may correct before keeping: a skill's steps, a change's proposed text. Null for a policy. */
  editable: string | null;
  payload: Record<string, unknown>;
  conversationId: string | null;
  turn: number | null;
  runId: string | null;
  untrusted: boolean;
  /** One line per untrusted source, in the order they entered the run. */
  sources: string[];
  state: Proposal['state'];
  createdAt: string;
  decidedAt: string | null;
  reason: string | null;
  /** For a kept proposal: what keeping did, or when it will. */
  note: string | null;
  /** Sentences of it that also appear in the untrusted text that was in view: the page highlights them. */
  echoes: string[];
  /**
   * A skill proposal: the learned skill of that name the agent has now, when
   * it has one. Open, the proposal is its next version and is drawn as a diff
   * against `steps`; kept, `live` says this proposal is the version loading
   * now, which is the one the fold offers to remove.
   */
  skill: (CurrentLearnedSkill & { live: boolean }) | null;
  /**
   * A change proposal, open: the part of the agent file it replaces as the
   * file says it now, the tools the proposed list adds to the grant, and the
   * refusal keeping it as proposed would meet. Null for the other kinds.
   */
  change: ChangeView | null;
}

export interface ChangeView {
  part: 'instructions' | 'tools';
  /** The persona, or the tool list comma-separated, as the file says it now. Null when it cannot be read. */
  current: string | null;
  /** Tool names the proposed list grants that the agent does not hold now. */
  added: string[];
  /** The sentence keeping it as proposed would be refused with, or null. */
  refusal: string | null;
}

/** What a proposal view can know about the agent file a change is against. */
export interface ProposalChangeLookup {
  view(agent: string, part: 'instructions' | 'tools', proposed: string): ChangeView;
}

/** A proposed tool list, as the names it declares, in its own order. */
export function parseToolList(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((t) => t.trim().replace(/^[-*]\s+/, '')).filter((t) => t !== ''))];
}

/** The edit a kept change is, in `updateAgentFromOwner`'s terms. */
function changeEdit(agent: string, part: 'instructions' | 'tools', text: string) {
  return part === 'tools' ? { id: agent, tools: parseToolList(text) } : { id: agent, persona: text };
}

function refusalText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The lookup over the registry the platform tools are bound to. */
export function registryChangeLookup(registry: ToolRegistry): ProposalChangeLookup {
  return {
    view(agent, part, proposed) {
      const file = readBoundAgentFile(registry, agent);
      const current = file ? (part === 'tools' ? file.tools.join(', ') : file.persona) : null;
      try {
        const { envelope } = describeOwnerAgentEdit(registry, changeEdit(agent, part, proposed), agent);
        return { part, current, added: envelope.added, refusal: null };
      } catch (err) {
        return { part, current, added: [], refusal: refusalText(err) };
      }
    },
  };
}

/** What a proposal view can know about the files a kept skill became. */
export interface ProposalSkillLookup {
  current(agent: string, title: string): CurrentLearnedSkill | null;
}

/** The lookup over a catalog: the agent's own skills directory, read now. */
export function catalogSkillLookup(catalog: AgentCatalog): ProposalSkillLookup {
  return { current: (agent, title) => currentLearnedSkill(catalog, agent, title) };
}

/** The field of the payload the editor writes, per kind. */
function editableField(kind: Proposal['kind']): 'body' | 'proposed' | null {
  return kind === 'skill' ? 'body' : kind === 'change' ? 'proposed' : null;
}

export function toProposalView(p: Proposal, skills?: ProposalSkillLookup, changes?: ProposalChangeLookup): ProposalView {
  const field = editableField(p.kind);
  const current =
    p.kind === 'skill' && skills && (p.state === 'open' || p.state === 'kept')
      ? skills.current(p.agent, String(p.payload.name ?? ''))
      : null;
  return {
    id: p.id,
    kind: p.kind,
    agent: p.agent,
    title: proposalTitle(p),
    why: typeof p.payload.why === 'string' ? p.payload.why : '',
    editable: field && typeof p.payload[field] === 'string' ? (p.payload[field] as string) : null,
    payload: p.payload,
    conversationId: p.provenance.conversation ?? null,
    turn: p.provenance.turn ?? null,
    runId: p.provenance.runId ?? null,
    untrusted: p.untrusted,
    sources: (p.provenance.sources ?? []).map(describeUntrustedSource),
    state: p.state,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    reason: p.reason,
    note: p.state === 'kept' ? keptNote(p.kind) : null,
    echoes: Array.isArray(p.provenance.echoes) ? p.provenance.echoes.filter((e) => typeof e === 'string') : [],
    skill: current ? { ...current, live: current.proposal === p.id } : null,
    change:
      p.kind === 'change' && p.state === 'open' && changes && (p.payload.part === 'tools' || p.payload.part === 'instructions')
        ? changes.view(p.agent, p.payload.part, String(p.payload.proposed ?? ''))
        : null,
  };
}

export async function readProposals(
  pool: Pool,
  now: Date,
  skills?: ProposalSkillLookup,
  changes?: ProposalChangeLookup,
): Promise<{ open: ProposalView[]; closed: ProposalView[] }> {
  const [open, closed] = await Promise.all([listOpenProposals(pool), listClosedProposals(pool, { now })]);
  const view = (p: Proposal): ProposalView => toProposalView(p, skills, changes);
  return { open: open.map(view), closed: closed.map(view) };
}

/** What keeping a skill needs: the catalog it is written under and reloaded into. */
export interface KeepSkillDeps {
  catalog: AgentCatalog;
  reload?: () => void;
  env?: NodeJS.ProcessEnv;
}

/** The installed plugin's policy handler, read off its manifest. */
export function policyHandlerFor(registry: Pick<ToolRegistry, 'manifests'>): (plugin: string) => PolicyHandler | null {
  return (plugin) => registry.manifests().find((m) => m.name === plugin)?.policies ?? null;
}

const DECIDED_ALREADY = 'That proposal was already decided.';

async function notOpen(deps: WriteDeps, id: string): Promise<WriteResult<never>> {
  const existing = await getProposal(deps.pool, id);
  return existing
    ? { ok: false, status: 409, body: { error: DECIDED_ALREADY } }
    : { ok: false, status: 404, body: { error: 'That proposal is no longer here.' } };
}

/**
 * Keep it, optionally with the owner's corrected text. Only the editable
 * field can change: the name, the part, the plugin and the matcher are what
 * the proposal *is*, and the fingerprint is built from them.
 */
export async function keepProposalFromWeb(
  deps: WriteDeps,
  id: string,
  text: string | undefined,
  skills?: KeepSkillDeps,
): Promise<WriteResult<{ proposal: ProposalView; applied: boolean; note: string }>> {
  const current = await getProposal(deps.pool, id);
  if (!current) return notOpen(deps, id);
  if (current.state !== 'open') return notOpen(deps, id);
  if (current.kind === 'skill') {
    // Asked before anything is recorded: a refusal leaves the card open.
    const problem = skills ? skillKeepProblem(skills.catalog, current, skills.env) : 'This process cannot write skill files.';
    if (problem) return { ok: false, status: 409, body: { error: problem } };
  }
  const field = editableField(current.kind);
  let payload: Record<string, unknown> | undefined;
  if (text !== undefined && field) {
    if (text.trim() === '') return { ok: false, status: 400, body: { error: 'The kept version cannot be empty.' } };
    if (text !== current.payload[field]) payload = { ...current.payload, [field]: text, edited: true };
  }
  const now = deps.now();
  const kept = await keepProposal(deps.pool, { id, now, ...(payload ? { payload } : {}) });
  if (!kept) return notOpen(deps, id);
  // What the kept tool list adds, before it is written: the event records it.
  const added =
    kept.kind === 'change' && kept.payload.part === 'tools'
      ? registryChangeLookup(deps.registry).view(kept.agent, 'tools', String(kept.payload.proposed ?? '')).added
      : [];
  const outcome = await APPLY[kept.kind](kept, {
    now,
    db: deps.pool,
    policyHandlerFor: policyHandlerFor(deps.registry),
    applyChange: (agent, change) => applyChangeThroughPlatform(deps.registry, agent, change),
    ...(skills
      ? {
          skillsDirFor: (agent: string) => agentSkillsDirFor(skills.catalog, agent),
          ...(skills.reload ? { reload: skills.reload } : {}),
        }
      : {}),
  });
  if (outcome.failed) {
    // Nothing is on disk: the keep is undone and the card stays, with why.
    await reopenProposal(deps.pool, { id: kept.id, payload: current.payload });
    return { ok: false, status: 409, body: { error: outcome.note } };
  }
  await appendEvent(
    deps.pool,
    'proposal.kept',
    {
      id: kept.id,
      kind: kept.kind,
      agent: kept.agent,
      title: proposalTitle(kept),
      edited: payload !== undefined,
      applied: outcome.applied,
      ...(added.length > 0 ? { added } : {}),
      ...(outcome.file ? { file: outcome.file, version: outcome.version } : {}),
    },
  ).catch(() => undefined);
  const lookup = skills ? catalogSkillLookup(skills.catalog) : undefined;
  return { ok: true, status: 200, body: { proposal: toProposalView(kept, lookup), applied: outcome.applied, note: outcome.note } };
}

/**
 * A kept change, written through the update the owner's own edits and Agent
 * Father's approved ones share. A refusal (an unknown tool, a hand-only tool,
 * a file that would not load, an example the platform ships) is its sentence.
 */
export async function applyChangeThroughPlatform(
  registry: ToolRegistry,
  agent: string,
  change: { part: 'instructions' | 'tools'; text: string },
): Promise<{ ok: true; note: string } | { ok: false; note: string }> {
  try {
    const result = await updateAgentFromOwner(registry, changeEdit(agent, change.part, change.text));
    const what = change.part === 'tools' ? 'tool list' : 'instructions';
    return {
      ok: true,
      note: `Written to ${agent}'s file: its ${what} now read as kept${result.live ? '; it runs with them from its next message.' : ', but the running catalog did not reload; restart buddi.'}`,
    };
  } catch (err) {
    if (err instanceof PlatformRefusal) return { ok: false, note: err.message };
    throw err;
  }
}

export async function discardProposalFromWeb(
  deps: WriteDeps,
  id: string,
  reason: string | undefined,
): Promise<WriteResult<{ proposal: ProposalView }>> {
  const now = deps.now();
  const discarded = await discardProposal(deps.pool, { id, reason: reason ?? null, now });
  if (!discarded) return notOpen(deps, id);
  // A policy's plugin drops whatever it holds for it. The discard stands either way.
  const revoked = await revokeDiscardedPolicy(discarded, { now, db: deps.pool, policyHandlerFor: policyHandlerFor(deps.registry) });
  if (revoked) deps.log?.(`proposal ${discarded.id}: ${revoked}`);
  await appendEvent(
    deps.pool,
    'proposal.discarded',
    { id: discarded.id, kind: discarded.kind, agent: discarded.agent, title: proposalTitle(discarded), reason: discarded.reason },
  ).catch(() => undefined);
  return { ok: true, status: 200, body: { proposal: toProposalView(discarded) } };
}

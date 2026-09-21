/**
 * The three policy tools: read them, write one, take one back.
 *
 * Reading is a read of this plugin's own schema, so `email.list_policies` is
 * `auto`. Writing one is not. A policy is a *standing* instruction — it decides
 * every future message from a sender with no model in the loop, and `ignore`
 * decides them into silence — so `email.set_policy` and `email.revoke_policy`
 * are `gated`, and their `describe` says the sender and the action in the first
 * line, because that is the sentence the owner is actually approving.
 *
 * The gate itself never asks. That is the point of it. Which is exactly why the
 * moment the rule is *written* has to be the moment somebody agrees to it.
 */
import type { EffectDescription, ToolContext, ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import {
  POLICY_ACTIONS,
  POLICY_SCOPES,
  isUnimplementedAction,
  type PolicyRecord,
} from '../policies/gate.js';
import {
  createPolicy,
  findPolicy,
  normalizeMatcher,
  policyStats,
  refusalFor,
  revokePolicy,
  PolicyRefusal,
  POLICY_COLUMNS,
  toPolicy,
} from '../policies/store.js';
import { senderVerdicts } from '../policies/learn.js';
import type { GatedToolDefinition } from '../types.js';
import { UUID } from './shared.js';

/** The shape every policy tool hands back. */
export interface PolicyView {
  id: string;
  scope: string;
  matcher: string;
  action: string;
  params: Record<string, unknown>;
  origin: string;
  proposed: boolean;
  learnedFrom: number;
  runsSaved: number;
  decisions: number;
  createdAt: string | null;
  revokedAt: string | null;
}

export function viewOf(
  policy: PolicyRecord,
  stats?: { runsSaved: number; decisions: number },
): PolicyView {
  return {
    id: policy.id,
    scope: policy.scope,
    matcher: policy.matcher,
    action: policy.action,
    params: policy.params as Record<string, unknown>,
    origin: policy.origin,
    proposed: policy.proposed,
    learnedFrom: policy.createdFrom.length,
    runsSaved: stats?.runsSaved ?? 0,
    decisions: stats?.decisions ?? 0,
    createdAt: policy.createdAt,
    revokedAt: policy.revokedAt,
  };
}

const listInput = z.object({
  includeRevoked: z
    .boolean()
    .optional()
    .describe('Include policies the owner has already taken back. Off by default.'),
});

export const listPolicies: ToolDefinition<z.infer<typeof listInput>, unknown> = {
  name: 'email.list_policies',
  description:
    'The standing decisions about incoming mail: which senders, domains, lists and threads are ignored, notified, drafted, handed to an agent or triaged as usual, where each rule came from, and how many triage runs it has saved. Policies proposed from the owner\'s own history are listed separately and do not decide anything until the owner keeps them.',
  tier: 'auto',
  input: listInput,
  async execute(input, ctx) {
    const { rows } = await ctx.db.query(
      `select ${POLICY_COLUMNS} from email.policies
        where ($1::bool or revoked_at is null)
        order by created_at desc, id desc`,
      [input.includeRevoked ?? false],
    );
    const stats = await policyStats(ctx.db);
    const all = rows.map(toPolicy);
    return {
      applied: all
        .filter((p) => !p.proposed && p.revokedAt === null)
        .map((p) => viewOf(p, stats.get(p.id))),
      proposed: all
        .filter((p) => p.proposed && p.revokedAt === null)
        .map((p) => viewOf(p, stats.get(p.id))),
      revoked: all.filter((p) => p.revokedAt !== null).map((p) => viewOf(p, stats.get(p.id))),
      note: 'A policy decides without a model run. Proposed ones decide nothing until the owner keeps them.',
    };
  },
};

const setInput = z.object({
  scope: z
    .enum(POLICY_SCOPES)
    .describe(
      "What the rule is about: 'sender' (one address), 'domain' (everything from a domain), 'list-id' (one mailing list), 'thread' (one conversation, by its thread key).",
    ),
  matcher: z
    .string()
    .min(1)
    .describe('The address, domain, List-Id or thread key the rule applies to.'),
  action: z
    .enum(POLICY_ACTIONS)
    .describe(
      "What happens to the next message that matches. 'ignore' files it with no model run at all; " +
        "'notify' tells the owner in one line; 'draft' starts a run with the instruction to write a reply; " +
        "'hand-to-agent' gives it to the agent named in agentId; 'wake' is the ordinary triage run. " +
        "'archive' and 'label' are named here but refused: they need to write to the mailbox, which this build cannot do.",
    ),
  agentId: z
    .string()
    .min(1)
    .optional()
    .describe('For hand-to-agent: which agent gets the message.'),
  instruction: z
    .string()
    .min(1)
    .optional()
    .describe('For draft: what the reply should say, in one line.'),
  note: z.string().min(1).optional().describe('For notify: the line the owner gets.'),
  label: z.string().min(1).optional().describe('For label: the label to apply.'),
});

type SetInput = z.infer<typeof setInput>;

export interface PolicyEnvelope {
  scope: string;
  matcher: string;
  action: string;
  params: Record<string, unknown>;
}

function paramsOf(input: SetInput): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (input.agentId) params.agentId = input.agentId.trim();
  if (input.instruction) params.instruction = input.instruction.trim();
  if (input.note) params.note = input.note.trim();
  if (input.label) params.label = input.label.trim();
  if (input.action === 'ignore') {
    params.category = 'promo';
    params.urgency = 'low';
  }
  return params;
}

/** The sentence the owner approves. It names the matcher and the action. */
export function renderPolicyPreview(input: SetInput, verdicts: number): string {
  const matcher = normalizeMatcher(input.scope, input.matcher) || input.matcher;
  const what: Record<string, string> = {
    ignore: 'file it with no triage run and say nothing',
    notify: 'send you one line and stop',
    draft: 'start a run with the instruction to draft a reply',
    'hand-to-agent': `hand it to ${input.agentId ?? '(no agent named)'}`,
    wake: 'run triage as it does today',
    archive: 'archive it in the mailbox',
    label: `label it ${input.label ?? ''}`.trim(),
  };
  const subject =
    input.scope === 'sender'
      ? `mail from ${matcher}`
      : input.scope === 'domain'
        ? `mail from anyone at ${matcher}`
        : input.scope === 'list-id'
          ? `mail from the list ${matcher}`
          : `the thread ${matcher}`;
  const lines = [
    `From now on, ${subject} will ${what[input.action] ?? input.action}.`,
    'This decides every future message that matches, with no model run and nothing to approve each time.',
  ];
  if (verdicts > 0) {
    lines.push(`${verdicts} earlier message${verdicts === 1 ? '' : 's'} from this sender ${verdicts === 1 ? 'has' : 'have'} been triaged.`);
  }
  if (input.action === 'ignore') {
    lines.push('You can take it back in one tap under Settings → Email → Policies.');
  }
  return lines.join('\n');
}

export const setPolicy: GatedToolDefinition<SetInput, unknown, PolicyEnvelope> = {
  name: 'email.set_policy',
  description:
    'Write a standing decision about incoming mail: what should happen, from now on, to messages from one sender, domain, mailing list or thread. It replaces whatever rule covered the same thing before. Use it when the owner says what they want done with a correspondent, not to record a one-off judgement about a single message.',
  tier: 'gated',
  input: setInput,

  async describe(input, _ctx: ToolContext): Promise<EffectDescription & { envelope: PolicyEnvelope }> {
    const matcher = normalizeMatcher(input.scope, input.matcher);
    const verdicts =
      input.scope === 'sender' ? (await senderVerdicts(_ctx.db, matcher, 20)).length : 0;
    return {
      envelope: {
        scope: input.scope,
        matcher,
        action: input.action,
        params: paramsOf(input),
      },
      preview: renderPolicyPreview(input, verdicts),
    };
  },

  async execute(input, ctx) {
    const refusal = refusalFor({
      scope: input.scope,
      matcher: input.matcher,
      action: input.action,
      params: paramsOf(input),
    });
    if (refusal) throw new PolicyRefusal(refusal);
    const policy = await createPolicy(
      ctx.db,
      {
        scope: input.scope,
        matcher: input.matcher,
        action: input.action,
        params: paramsOf(input),
        origin: 'owner',
        proposed: false,
      },
      ctx.now(),
    );
    return { policy: viewOf(policy), applied: true };
  },
};

const revokeInput = z.object({
  policyId: UUID.describe('The policy to take back, by the id email.list_policies gave you.'),
});

export const revokeEmailPolicy: GatedToolDefinition<
  z.infer<typeof revokeInput>,
  unknown,
  { policyId: string; scope: string; matcher: string; action: string }
> = {
  name: 'email.revoke_policy',
  description:
    'Take back a standing decision about incoming mail. The rule stops deciding anything from now on; the record that it once existed is kept, and messages already handled by it are not revisited.',
  tier: 'gated',
  input: revokeInput,

  async describe(input, ctx: ToolContext) {
    const policy = await findPolicy(ctx.db, input.policyId);
    if (!policy) throw new Error(`unknown policy: ${input.policyId}`);
    const stats = (await policyStats(ctx.db)).get(policy.id);
    const saved = stats?.runsSaved ?? 0;
    return {
      envelope: {
        policyId: policy.id,
        scope: policy.scope,
        matcher: policy.matcher,
        action: policy.action,
      },
      preview: [
        `The rule "${policy.action} ${policy.scope} ${policy.matcher}" will stop deciding anything.`,
        saved > 0
          ? `It has skipped ${saved} triage run${saved === 1 ? '' : 's'} so far; from now on those messages are triaged again.`
          : 'Messages it would have handled are triaged as usual from now on.',
      ].join('\n'),
    };
  },

  async execute(input, ctx) {
    const policy = await revokePolicy(ctx.db, input.policyId, ctx.now());
    if (!policy) throw new Error(`unknown policy: ${input.policyId}`);
    return { policy: viewOf(policy), revoked: true };
  },
};

/** Exported for the settings route: the two lists and their counts. */
export async function policiesView(db: Parameters<typeof policyStats>[0]): Promise<{
  applied: PolicyView[];
  proposed: PolicyView[];
}> {
  const { rows } = await db.query(
    `select ${POLICY_COLUMNS} from email.policies where revoked_at is null
      order by created_at desc, id desc`,
  );
  const stats = await policyStats(db);
  const all = rows.map(toPolicy);
  return {
    applied: all.filter((p) => !p.proposed).map((p) => viewOf(p, stats.get(p.id))),
    proposed: all.filter((p) => p.proposed).map((p) => viewOf(p, stats.get(p.id))),
  };
}

export { isUnimplementedAction };

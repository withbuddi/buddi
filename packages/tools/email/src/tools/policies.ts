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
import type { EffectDescription, ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import {
  ARRIVAL_KINDS,
  arrivalWords,
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
import { normalizeAddress } from '../mail.js';
import type { GatedToolDefinition } from '../types.js';
import { ACCOUNT_ARG, UUID, accountScope, requireOneAccount } from './shared.js';

/** The shape every policy tool hands back. */
export interface PolicyView {
  id: string;
  /**
   * The mailbox this rule belongs to, or null for one that covers all of them.
   * A policy belongs to an account (docs/email.md §2 and §5): "ignore this
   * newsletter" is a statement about one inbox, and the same sender may be
   * worth reading on another.
   */
  accountId: string | null;
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
  /** When the owner kept it from Settings → Proposals, or null. */
  keptAt: string | null;
}

export function viewOf(
  policy: PolicyRecord,
  stats?: { runsSaved: number; decisions: number },
): PolicyView {
  return {
    id: policy.id,
    accountId: policy.accountId,
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
    keptAt: policy.keptAt ?? null,
  };
}

const listInput = z.object({
  account: ACCOUNT_ARG.optional(),
  includeRevoked: z
    .boolean()
    .optional()
    .describe('Include policies the owner has already taken back. Off by default.'),
});

export const listPolicies: ToolDefinition<z.infer<typeof listInput>, unknown> = {
  name: 'email.list_policies',
  description:
    'The standing decisions about incoming mail: which senders, domains, lists and threads are ignored, notified, drafted, handed to an agent or triaged as usual, where each rule came from, and how many triage runs it has saved. Rules learned from the owner\'s own history are proposed on Settings → Proposals and decide nothing until the owner keeps them there.',
  tier: 'auto',
  input: listInput,
  async execute(input, ctx) {
    // Scoped like every other read tool: a named account sees its own rules and
    // the installation-wide ones, and saying nothing sees them all.
    const scope = await accountScope(ctx.buddi!.db, input.account);
    const { rows } = await ctx.buddi!.db.query(
      `select ${POLICY_COLUMNS} from email.policies
        where ($1::bool or revoked_at is null)
          and (account_id is null or account_id = any($2::uuid[]))
        order by created_at desc, id desc`,
      [input.includeRevoked ?? false, scope.ids],
    );
    const stats = await policyStats(ctx.buddi!.db);
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
  account: ACCOUNT_ARG.optional(),
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
        "'archive' and 'label' are named here but refused as actions: to archive matching mail as it arrives, pick one of the others and set onArrival.",
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
  onArrival: z
    .enum(ARRIVAL_KINDS)
    .optional()
    .describe(
      "Also act in the owner's mailbox itself the moment a matching message arrives: 'archive' (out of the inbox), 'mark-read', or 'move' to an existing folder named in `folder`. Recorded on the undo trail; the owner undoes it from Recent changes on the Mail page or with email.undo.",
    ),
  folder: z
    .string()
    .min(1)
    .optional()
    .describe("For onArrival 'move': the folder or Gmail label, by its name. It must already exist."),
  sender: z
    .string()
    .min(1)
    .optional()
    .describe(
      'For thread and list-id: the address this conversation or list is with. A thread key and a List-Id are headers the sender writes, so an `ignore` on one only ever silences the sender recorded here — without it, the rule cannot silence anything on its own.',
    ),
});

type SetInput = z.infer<typeof setInput>;

export interface PolicyEnvelope {
  accountId: string;
  account: string;
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
  if (input.onArrival) {
    params.onArrival = input.onArrival === 'move'
      ? { kind: 'move', folder: (input.folder ?? '').trim() }
      : { kind: input.onArrival };
  }
  if (input.action === 'ignore') {
    params.category = 'promo';
    params.urgency = 'low';
  }
  // The sender a thread or list rule was created about. See `gate.ts`: an
  // `ignore` carried by one of those scopes fires for this address alone.
  if (input.sender && (input.scope === 'thread' || input.scope === 'list-id')) {
    params.sender = normalizeAddress(input.sender);
  }
  return params;
}

/** The sentence the owner approves. It names the matcher and the action. */
export function renderPolicyPreview(input: SetInput, verdicts: number, account?: string): string {
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
    `From now on, ${subject}${account ? ` arriving at ${account}` : ''} will ${what[input.action] ?? input.action}.`,
    'This decides every future message that matches, with no model run and nothing to approve each time.',
  ];
  const onArrival = arrivalWords(
    input.onArrival ? { kind: input.onArrival, ...(input.folder ? { folder: input.folder.trim() } : {}) } : null,
  );
  if (onArrival) {
    lines.push(
      `When one arrives, buddi will also ${onArrival} — a change on your mail server, recorded under Recent changes on the Mail page, where Undo puts it back.`,
    );
  }
  if (verdicts > 0) {
    lines.push(`${verdicts} earlier message${verdicts === 1 ? '' : 's'} from this sender ${verdicts === 1 ? 'has' : 'have'} been triaged.`);
  }
  if (input.action === 'ignore' && (input.scope === 'thread' || input.scope === 'list-id')) {
    lines.push(
      input.sender
        ? `A ${input.scope} is named by a header the sender writes, so this silences ${normalizeAddress(input.sender)} alone; anyone else quoting it is triaged as usual.`
        : `A ${input.scope} is named by a header the sender writes, so with no address recorded this silences nothing on its own — it applies only to a sender you already have a rule about.`,
    );
  }
  if (input.action === 'ignore') {
    lines.push('You can take it back in one tap under Settings → Email → Policies.');
  }
  return lines.join('\n');
}

/**
 * A rule that moves mail on arrival must name a folder that exists. Checked
 * against the folders the poll discovered (no connection needed); an account
 * whose folders were never listed is let through, and the move refuses at
 * arrival if the folder is not there.
 */
async function checkArrivalFolder(
  db: Parameters<typeof policyStats>[0],
  accountId: string,
  address: string,
  input: { onArrival?: string | undefined; folder?: string | undefined },
): Promise<void> {
  if (input.onArrival !== 'move') return;
  const wanted = (input.folder ?? '').trim();
  if (wanted === '') throw new PolicyRefusal('moving on arrival needs the folder to move to');
  const { rows } = await db.query(`select name from email.folders where account_id = $1 order by name`, [accountId]);
  const names = rows.map((r: Record<string, any>) => String(r.name));
  if (names.length <= 1) return;
  const lower = wanted.toLowerCase();
  if (names.some((n) => n.toLowerCase() === lower || n.toLowerCase().split(/[/.]/).pop() === lower)) return;
  throw new PolicyRefusal(
    `${address} has no folder called "${wanted}", and buddi creates none. Its folders are: ${names.join(', ')}.`,
  );
}

export const setPolicy: GatedToolDefinition<SetInput, unknown, PolicyEnvelope> = {
  name: 'email.set_policy',
  description:
    "Write a standing decision about incoming mail: what should happen, from now on, to messages from one sender, domain, mailing list or thread — and, optionally, what buddi also does in the mailbox when one arrives (`onArrival`: archive, mark-read, or move to an existing folder). It replaces whatever rule covered the same thing before. Use it when the owner says what they want done with a correspondent, not to record a one-off judgement about a single message; to clean up mail already there, use email.select_messages and the mailbox tools.",
  tier: 'gated',
  input: setInput,

  async describe(input, _ctx: ToolContext): Promise<EffectDescription & { envelope: PolicyEnvelope }> {
    const matcher = normalizeMatcher(input.scope, input.matcher);
    // Which mailbox this rule is about is part of the sentence being approved:
    // "ignore this sender" reads differently for work mail than for personal.
    const account = await requireOneAccount(_ctx.buddi!.db, input.account);
    await checkArrivalFolder(_ctx.buddi!.db, account.id, account.address, input);
    const verdicts =
      input.scope === 'sender'
        ? (await senderVerdicts(_ctx.buddi!.db, account.id, matcher, 20)).length
        : 0;
    return {
      envelope: {
        accountId: account.id,
        account: account.address,
        scope: input.scope,
        matcher,
        action: input.action,
        params: paramsOf(input),
      },
      preview: renderPolicyPreview(input, verdicts, account.address),
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
    const account = await requireOneAccount(ctx.buddi!.db, input.account);
    const policy = await createPolicy(
      ctx.buddi!.db,
      {
        accountId: account.id,
        scope: input.scope,
        matcher: input.matcher,
        action: input.action,
        params: paramsOf(input),
        origin: 'owner',
        proposed: false,
      },
      ctx.buddi!.clock.now(),
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
    const policy = await findPolicy(ctx.buddi!.db, input.policyId);
    if (!policy) throw new Error(`unknown policy: ${input.policyId}`);
    const stats = (await policyStats(ctx.buddi!.db)).get(policy.id);
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
    const policy = await revokePolicy(ctx.buddi!.db, input.policyId, ctx.buddi!.clock.now());
    if (!policy) throw new Error(`unknown policy: ${input.policyId}`);
    return { policy: viewOf(policy), revoked: true };
  },
};

/**
 * One conversation, as the settings page offers it for a `thread` rule.
 *
 * The page cannot ask an owner for a thread *id*, and it must not ask for a
 * thread *key* — a Message-ID off the wire is not something a person has. So
 * the rule form picks a conversation by its subject and sends the id, which is
 * what the gate matches (`gate.ts`).
 */
export interface ThreadChoice {
  id: string;
  accountId: string;
  subject: string;
  state: string;
  participants: string[];
  lastAt: string | null;
}

/** How many conversations the rule form offers. The most recent ones. */
export const THREAD_CHOICES = 50;

/**
 * The two lists, and what each rule has done.
 *
 * Split from `policiesView` because the settings page wants exactly this and
 * nothing else: the conversation picker is a second question, asked by the
 * form that needs it, and running its window function on every settings load
 * is work nobody was looking at.
 */
export async function policyLists(db: Parameters<typeof policyStats>[0]): Promise<{
  applied: PolicyView[];
  proposed: PolicyView[];
}> {
  const { rows } = await db.query(
    // Most recently kept or added first: a rule kept a minute ago is the one
    // the owner is looking for, not one more line under the day it was learned.
    `select ${POLICY_COLUMNS} from email.policies where revoked_at is null
      order by coalesce(kept_at, created_at) desc, id desc`,
  );
  const stats = await policyStats(db);
  const all = rows.map(toPolicy);
  return {
    applied: all.filter((p) => !p.proposed).map((p) => viewOf(p, stats.get(p.id))),
    proposed: all.filter((p) => p.proposed).map((p) => viewOf(p, stats.get(p.id))),
  };
}

/**
 * The conversations a `thread` rule may be about, newest first.
 *
 * Named by subject rather than by thread key, because a Message-ID off the
 * wire is not something an owner has (`gate.ts`). Scoped to one mailbox when
 * one is chosen: a conversation lives in exactly one of them, and offering a
 * busy mailbox's threads for a rule meant for a quiet one is how a rule ends
 * up about the wrong conversation.
 */
export async function threadChoices(
  db: Parameters<typeof policyStats>[0],
  accountId?: string,
): Promise<ThreadChoice[]> {
  const { rows: threads } = accountId
    ? await db.query(
        `select id, account_id, subject, state, participants, last_at from email.threads
          where account_id = $1::uuid
          order by last_at desc nulls last, id desc limit $2`,
        [accountId, THREAD_CHOICES],
      )
    : await db.query(
        `select id, account_id, subject, state, participants, last_at
           from (
             select id, account_id, subject, state, participants, last_at,
                    row_number() over (partition by account_id order by last_at desc nulls last, id desc) as rn
               from email.threads
           ) per_account
          where rn <= $1
          order by last_at desc nulls last, id desc`,
        [THREAD_CHOICES],
      );
  return threads.map((row: Record<string, any>) => ({
    id: String(row.id),
    accountId: String(row.account_id),
    subject: row.subject ?? '',
    state: row.state,
    participants: Array.isArray(row.participants) ? row.participants : [],
    lastAt: row.last_at instanceof Date ? row.last_at.toISOString() : (row.last_at ?? null),
  }));
}

/** Both halves at once, for a caller that draws them together. */
export async function policiesView(db: Parameters<typeof policyStats>[0], accountId?: string): Promise<{
  applied: PolicyView[];
  proposed: PolicyView[];
  threads: ThreadChoice[];
}> {
  return { ...(await policyLists(db)), threads: await threadChoices(db, accountId) };
}

export { isUnimplementedAction };

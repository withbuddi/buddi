/**
 * The owner's own hands on the standing decisions (docs/specs/email.md §5).
 *
 * `email.set_policy` and `email.revoke_policy` are gated, and rightly so: a
 * *model* proposing a rule that decides every future message from a sender is
 * exactly the thing an owner must agree to first. These three are the other
 * side of that — the owner, on their own settings page, ticking rules they are
 * looking at. There is no approval card between a person and their own
 * decision, which is what the routes under `/api/email/policies` did and what
 * these `ownerOnly` tools do now, over the very same store functions.
 *
 * Two rules the page cannot state and these tools must:
 *
 *  - **A policy says which mailbox it is about.** Either a mailbox, by its
 *    address, or "for every mailbox", ticked. An omitted account used to mean
 *    "all of them", which is a decision nobody made.
 *  - **A selection is one decision.** Keep and revoke take a *list*, and it
 *    lands in one transaction (`bulkPolicies`): what the owner ticked either
 *    holds or it does not. A row's own button is the same tool with one id, so
 *    there is one implementation of what keeping a rule means.
 */
import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { normalizeAddress } from '../mail.js';
import { POLICY_ACTIONS, POLICY_SCOPES, type PolicyParams } from '../policies/gate.js';
import { bulkPolicies, createPolicy, refusalFor, PolicyRefusal } from '../policies/store.js';

/** How many rules one act may carry. The page holds seventy-odd proposals. */
export const BULK_POLICY_LIMIT = 500;

/** A refusal the owner reads on the page, in their own words. */
export class RuleRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleRefusal';
  }
}

const ruleInput = z
  .object({
    scope: z.enum(POLICY_SCOPES),
    matcher: z.string().min(1),
    action: z.enum(POLICY_ACTIONS),
    /** The mailbox, by address. Empty when "for every mailbox" is ticked. */
    mailbox: z.string().optional(),
    allAccounts: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
    sender: z.string().optional(),
    instruction: z.string().optional(),
    note: z.string().optional(),
    agentId: z.string().optional(),
  })
  .strict();

export type RuleInput = z.infer<typeof ruleInput>;

function ticked(value: RuleInput['allAccounts']): boolean {
  return value === true || value === 'true';
}

/** `Them <THEM@x.test>` -> `them@x.test`, so what is sent is what was shown. */
export function bareAddress(raw: string): string {
  const trimmed = raw.trim();
  const angled = /<([^>]+)>/.exec(trimmed);
  return (angled?.[1] ?? trimmed).trim().toLowerCase();
}

/**
 * Write a rule the owner typed.
 *
 * Every refusal below is the sentence the route answered with, kept word for
 * word: they are the ones that explain what to do next.
 */
export function createAddRuleTool(): ToolDefinition<RuleInput, unknown> {
  return {
    name: 'email.add_rule',
    description:
      "The owner's own path to a standing decision about incoming mail, from their settings page: which mailbox it is about, what it matches, and what happens next.",
    tier: 'auto',
    ownerOnly: true,
    input: ruleInput,
    async execute(input, ctx) {
      const matcher = input.matcher.trim();
      const params: PolicyParams = {};
      if (input.agentId?.trim()) params.agentId = input.agentId.trim();
      if (input.instruction?.trim()) params.instruction = input.instruction.trim();
      if (input.note?.trim()) params.note = input.note.trim();
      if (input.action === 'ignore') {
        params.category = 'promo';
        params.urgency = 'low';
      }
      // A thread or a list is named by a header its sender writes, so an
      // `ignore` on one silences only the address recorded with it (`gate.ts`).
      if (input.sender?.trim() && (input.scope === 'thread' || input.scope === 'list-id')) {
        params.sender = normalizeAddress(bareAddress(input.sender));
      }

      const refusal = refusalFor({ scope: input.scope, matcher, action: input.action, params });
      if (refusal) throw new RuleRefusal(refusal);

      /*
       * Which mailbox, said out loud or not at all. A policy with no account
       * applies to *every* account on this installation (`gate.ts`), and the
       * same sender is worth different things in different inboxes.
       */
      const allAccounts = ticked(input.allAccounts);
      const mailbox = (input.mailbox ?? '').trim().toLowerCase();
      if (allAccounts && mailbox !== '') {
        throw new RuleRefusal('Choose one mailbox, or "for every mailbox" — not both.');
      }
      let accountId: string | null = null;
      if (!allAccounts) {
        if (mailbox === '') {
          throw new RuleRefusal(
            'Say which mailbox this rule is for, or tick "for every mailbox". The same sender can matter in one inbox and not in another.',
          );
        }
        const { rows } = await ctx.db.query<{ id: string }>(
          `select id from email.accounts where address = $1`,
          [mailbox],
        );
        if (rows.length === 0) throw new RuleRefusal('That mailbox is not one of yours.');
        accountId = String(rows[0]!.id);
      }

      /*
       * A `thread` rule names a conversation this installation holds. The page
       * sends the conversation's id — the one in its address — because that is
       * what the gate matches and a Message-ID is not something an owner has.
       */
      if (input.scope === 'thread') {
        const { rows } = await ctx.db
          .query<{ account_id: string }>(`select account_id from email.threads where id = $1::uuid`, [
            matcher.toLowerCase(),
          ])
          .catch(() => ({ rows: [] as Array<{ account_id: string }> }));
        const owner = rows[0]?.account_id ? String(rows[0].account_id) : null;
        if (!owner) throw new RuleRefusal('That conversation is not one of yours.');
        if (!allAccounts && owner !== accountId) {
          throw new RuleRefusal('That conversation is in a different mailbox from the one you chose.');
        }
      }

      try {
        const policy = await createPolicy(
          ctx.db,
          {
            accountId,
            scope: input.scope,
            matcher,
            action: input.action,
            params,
            origin: 'owner',
          },
          ctx.now(),
        );
        return { added: true, policyId: policy.id };
      } catch (err) {
        if (err instanceof PolicyRefusal) throw new RuleRefusal(err.message);
        throw err;
      }
    },
  };
}

/**
 * A list of rules, always — one of them, or seventy.
 *
 * A row's own button and the bulk action above it are the same act, so they
 * are the same tool: the row carries its id as a one-element `ids` array (the
 * query builds it), and the selection carries the ticked ones. One
 * implementation of what keeping a rule means, and one transaction.
 */
const idsInput = z
  .object({
    ids: z
      .array(z.string().uuid('Every id must be a policy id.'))
      .min(1)
      .max(BULK_POLICY_LIMIT, `That is more than ${BULK_POLICY_LIMIT} rules at once. Do it in a few passes.`),
  })
  .strict();

export type PolicyIdsInput = z.infer<typeof idsInput>;

function idsTool(
  name: string,
  action: 'keep' | 'revoke',
  description: string,
): ToolDefinition<PolicyIdsInput, unknown> {
  return {
    name,
    description,
    tier: 'auto',
    ownerOnly: true,
    input: idsInput,
    async execute(input, ctx) {
      const result = await bulkPolicies(ctx.db, action, input.ids, ctx.now());
      /*
       * A selection that touched nothing is a refusal, not a success.
       *
       * The page reloads after every act, so the usual way to get here is a
       * rule somebody revoked in another tab while this list was on screen —
       * and "Revoke" that quietly did nothing is indistinguishable from one
       * that worked. The old route answered 404 with this sentence.
       */
      const touched = result.kept + result.revoked;
      if (touched === 0) throw new RuleRefusal('That policy is no longer there.');
      const word = action === 'keep' ? 'kept' : 'revoked';
      return {
        ...result,
        // Partly done is said out loud too: what is on screen was older than
        // the table, and the owner is told which half landed.
        note:
          result.missing === 0
            ? `${touched} ${touched === 1 ? 'rule' : 'rules'} ${word}.`
            : `${touched} ${touched === 1 ? 'rule' : 'rules'} ${word}; ${result.missing} ${
                result.missing === 1 ? 'was' : 'were'
              } no longer there.`,
      };
    },
  };
}

/** Turn proposals on. They start deciding straight away, with no model run. */
export function createKeepPoliciesTool(): ToolDefinition<PolicyIdsInput, unknown> {
  return idsTool(
    'email.keep_policies',
    'keep',
    "The owner keeping rules buddi proposed from their own mail, from their settings page. They start deciding straight away, with no model run.",
  );
}

/** Take rules back. They stop deciding anything from now on. */
export function createRevokePoliciesTool(): ToolDefinition<PolicyIdsInput, unknown> {
  return idsTool(
    'email.revoke_policies',
    'revoke',
    "The owner taking rules back from their settings page. Each one stops deciding anything from now on; messages it would have handled are triaged as usual again.",
  );
}

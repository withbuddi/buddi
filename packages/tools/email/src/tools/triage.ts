/**
 * Recording what triage decided.
 *
 * The decision is a *record*, not a side effect: it writes one row in this
 * plugin's own schema, keyed by the processing version, so an intentional
 * re-triage under a new policy lands beside the old decision instead of erasing
 * it. Nothing about it reaches the world, so the tier is `auto`.
 */
import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { toTriage } from '../rows.js';
import { CATEGORIES, PROCESSING_VERSION, requireMessage, URGENCIES, UUID } from './shared.js';

const triageRecordInput = z.object({
  messageId: UUID.describe('The message being triaged, by the id the tools gave you.'),
  category: z
    .enum(CATEGORIES)
    .describe(
      "What kind of mail this is: 'bill' (something to pay), 'bank-notice' (a bank or lender telling you something), 'payment-failed' (a payment was refused or cancelled), 'statement' (a periodic statement), 'receipt' (proof of something already paid), 'personal' (a human writing to the owner), 'promo' (marketing), 'other'.",
    ),
  urgency: z
    .enum(URGENCIES)
    .describe(
      "'urgent' only when the owner would want to be woken for it — money is about to be lost, a deadline is inside a day or two, a payment failed. 'normal' for something that matters this week. 'low' for anything that can wait or be ignored.",
    ),
  summary: z
    .string()
    .min(1)
    .describe('One sentence saying what the message is, in the owner\'s own terms.'),
  actionNeeded: z
    .string()
    .min(1)
    .optional()
    .describe('What the owner would have to do, in one line. Omit when nothing is needed.'),
});

export const triageRecord: ToolDefinition<z.infer<typeof triageRecordInput>, unknown> = {
  name: 'email.triage_record',
  description:
    'Record what you decided about one message: its category, how urgent it is, a one-sentence summary, and what the owner would have to do about it. Call this exactly once per message you triage, before you say anything about it.',
  tier: 'auto',
  input: triageRecordInput,
  async execute(input, ctx) {
    // Fail closed on an id that names nothing: a triage row for a message that
    // does not exist would be a decision about nothing.
    const message = await requireMessage(ctx.db, input.messageId);
    const { rows } = await ctx.db.query(
      `insert into email.triage
         (message_id, processing_version, category, urgency, summary, action_needed, decided_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (message_id, processing_version) do update
         set category = excluded.category,
             urgency = excluded.urgency,
             summary = excluded.summary,
             action_needed = excluded.action_needed,
             decided_at = excluded.decided_at
       returning message_id, processing_version, category, urgency, summary, action_needed, decided_at`,
      [
        message.id,
        PROCESSING_VERSION,
        input.category,
        input.urgency,
        input.summary,
        input.actionNeeded ?? null,
        ctx.now(),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('email.triage_record: insert returned no row');
    return { ...toTriage(row), subject: message.subject, from: message.from };
  },
};

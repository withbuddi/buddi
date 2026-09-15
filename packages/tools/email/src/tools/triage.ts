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
      'What kind of thing this is to the owner. ' +
        "'reply-needed' (a person is waiting on an answer or a decision from him); " +
        "'relationship' (a working or client relationship changes — a counterpart leaves, a new contact is named, an organisation reorganises); " +
        "'opportunity' (work, a client, an invitation or a proposal offered to him personally); " +
        "'obligation' (something the owner has to do, with or without a date on it — a document to file, collect or sign, a form to return, a renewal, an appointment, a legal or administrative notice, a step in an application waiting on him; an errand with no deadline is still an errand, not 'other'); " +
        "'security' (an account or security event, or something claiming to be one); " +
        "'bill' (something to pay); 'payment-failed' (a payment refused, returned or cancelled); " +
        "'bank-notice' (a bank or lender telling him something); 'statement' (a periodic statement); " +
        "'receipt' (proof of something already paid); " +
        "'service-notice' (a service he uses telling him something operational — a price change, a plan ending, an outage, new terms); " +
        "'personal' (a human writing to him with nothing waiting on him); 'promo' (marketing); 'other'.",
    ),
  urgency: z
    .enum(URGENCIES)
    .describe(
      "Judged by consequence to the owner, not by how the message is written, and not by whether money is involved. " +
        "'urgent' — something is lost, missed or damaged if he does not see this within about a day: a person he works with is waiting and the answer stops being worth anything, a relationship or a standing is at stake, an opportunity closes, a deadline lands within a day or two, a security event is happening now, money is about to be lost or has been. This is the only level that interrupts him. " +
        "'normal' — it matters this week: something is expected of him, or something changed that he will want to know, but nothing is lost by Friday. " +
        "'low' — nothing is lost if he never reads it: marketing, newsletters, notifications about nothing. " +
        'If you are about to write a real sentence into actionNeeded, it is not low — something he still has to do sits at normal until it is done. ' +
        'A stranger selling something is never urgent however loudly the message says it is.',
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

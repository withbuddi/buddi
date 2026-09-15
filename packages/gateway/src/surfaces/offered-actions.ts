/**
 * "An agent that ends a live turn at a decision can hand the owner the buttons."
 *
 * Offered actions shipped for *unattended* runs: `mission.report` may attach a
 * few next moves, they are stored in `core.offers`, and a surface draws them as
 * buttons where it has them. Nothing offered them in a conversation. So the
 * owner asked @postman to draft a reply to a client, read the whole draft, and
 * the turn ended with the sentence "It hasn't been sent. Want me to send it
 * now?" — a decision, in prose, with nothing to tap. That is the exact moment a
 * button is worth having.
 *
 * This is the interactive half, and it is deliberately the *same* half: the
 * same table, the same `off:<uuid>` callback, the same claim-once update, the
 * same rule that taking one authorizes nothing. All that is new is a way for a
 * turn to declare what it is offering, which is the sibling of
 * `conversation.ask`: registered per interactive run into a copy of the base
 * registry, with a policy line in the turn's system suffix.
 *
 * ## It authorizes nothing
 *
 * Worth saying twice, because convenience is where this would quietly break. A
 * tapped action carries an **id**. What runs is the prompt the agent itself
 * wrote, as an ordinary run of that agent, with the tools, the tiers and the
 * approvals it always had. A tapped "Send it" still reaches `email.send`, and
 * `email.send` still stops the run and shows the owner every recipient and the
 * whole body before a byte leaves the machine. There is no second path.
 *
 * ## It is meant to be rare
 *
 * Three chips at the end of every turn is worse than none: the owner stops
 * reading them, and then misses the one that mattered. So the restraint is
 * written into the tool description and into the policy — not left to a
 * persona, which only some agents have — and the shape of the rule is: offer
 * only when the turn genuinely ends at a decision that is the owner's to make,
 * at most three, each a real next step, and never a synonym for "ok".
 *
 * ## An offer belongs to the turn that made it
 *
 * See `withdrawOffers` in core. The conversation's next turn withdraws what the
 * previous turn offered, so a button cannot still fire hours and three subjects
 * later; the tap then gets the ordinary "that option has expired" instead.
 */
import {
  MAX_OFFERS,
  MAX_OFFER_LABEL,
  MAX_OFFER_PROMPT,
  offerActions,
  withdrawOffers,
  type Offer,
  type OfferedAction,
  type PluginManifest,
  type Queryable,
  type ToolDefinition,
} from '@buddi/core';
import { z } from 'zod';

/**
 * Plugin family name for the interactive-turn offer tool.
 *
 * Separate from `conversation` (the ask tool's manifest) only because the
 * registry allows one manifest per name and these two modules each own theirs.
 * The *tool* the model sees keeps the `conversation.` family: it is one more
 * thing a turn may declare about how it ended.
 */
export const OFFER_PLUGIN = 'conversation-offers';

/** The one tool: "this turn ends at a decision, and here are the moves." */
export const OFFER_TOOL = 'conversation.offer';

/** Added to an agent's tool list for an interactive turn, and only there. */
export const OFFER_TOOLS: readonly string[] = [OFFER_TOOL];

/** Where the tool records what this turn offered. One per run. */
export interface OfferSink {
  offered?: OfferedAction[];
}

const offerInput = z.object({
  actions: z
    .array(
      z.object({
        label: z
          .string()
          .min(1)
          .max(MAX_OFFER_LABEL)
          .describe(
            'What the owner reads on the button, in their own words: "Send it", "Edit the draft". Two or three words, and a real move — never "OK", "Yes" or "Sounds good".',
          ),
        prompt: z
          .string()
          .min(1)
          .max(MAX_OFFER_PROMPT)
          .describe(
            "What you are asked when the owner takes it, written as the owner would ask you and naming the thing concretely (\"send the reply I drafted to Dorothée\"). It starts an ordinary run of you: it authorizes nothing, and anything that leaves the machine still needs the owner's approval exactly as it would have.",
          ),
      }),
    )
    .min(1)
    .max(MAX_OFFERS)
    .describe(
      `The ${MAX_OFFERS} or fewer moves that are genuinely on the table. Each must be a different next step, not the same one worded twice.`,
    ),
});

export type OfferResult = { offered: number };

/**
 * The `conversation.offer` manifest, bound to one run's sink.
 *
 * Registered per run into a copy of the base registry, exactly as the mission
 * tools and `conversation.ask` are: nothing outside an interactive turn can
 * call it, and two chats never share a sink. Calling it twice replaces what was
 * declared rather than adding to it — a turn offers one set.
 */
export function createOfferManifest(sink: OfferSink): PluginManifest {
  const offer: ToolDefinition<z.infer<typeof offerInput>, OfferResult> = {
    name: OFFER_TOOL,
    description:
      'Offer the owner the two or three things they could do next, as buttons where this surface has them and as a short list of sentences where it does not. Call it once, as you finish, and only when your reply genuinely ends at a decision that is theirs to make and that you already know how to carry out — a draft waiting to be sent, a choice between two real options. Do not call it to say "ok" in button form, to offer to keep talking, or when reading the reply is all there is to do; a turn with nothing to decide should offer nothing, and that is the normal case. It sends nothing and authorizes nothing: taking one asks you the sentence you wrote here, and anything with an effect still stops at the owner\'s approval exactly as it would have.',
    tier: 'auto',
    input: offerInput,
    async execute(input) {
      sink.offered = input.actions.map((action) => ({
        label: action.label.trim(),
        prompt: action.prompt.trim(),
      }));
      return { offered: sink.offered.length };
    },
  };

  return {
    name: OFFER_PLUGIN,
    version: '0.1.0',
    // No schema of its own: the offers this tool declares are written to
    // `core.offers` by the surface, through the store core already owns.
    schema: 'core',
    migrationsDir: '',
    tools: [offer],
  };
}

/** The instruction block that tells an interactive turn the tool exists. */
export const OFFER_POLICY_SUFFIX = [
  `When a turn of yours ends at a decision the owner has to make, and you already know how to carry out each way it could go, call ${OFFER_TOOL} as you finish with at most ${MAX_OFFERS} of them.`,
  'Each one is a label they read and the sentence you are asked if they choose it.',
  'This is rare. Most turns end with nothing to decide, and they offer nothing — buttons under every answer are noise, and then the owner stops reading the one that mattered.',
  'Never offer a synonym for "ok", an offer to keep talking, or two wordings of the same move; if you cannot name a real next step, do not call it.',
  'It delivers nothing and authorizes nothing: taking one asks you what you wrote, and anything that leaves this machine still goes through the approval the owner would have seen anyway.',
].join(' ');

/* ------------------------------------------------------------------ *
 * What a surface does with it
 * ------------------------------------------------------------------ */

/**
 * Retire what the previous turn of this conversation offered.
 *
 * Called at the start of every interactive turn, before the run: by the time
 * the owner has said the next thing, the previous turn's buttons describe a
 * decision that is no longer the live one.
 *
 * Never allowed to fail a turn — a conversation that cannot reach the offers
 * table is a conversation that still gets its answer.
 */
export async function withdrawTurnOffers(
  pool: Queryable,
  conversationId: string,
  now: Date,
  log?: (line: string) => void,
): Promise<number> {
  try {
    return await withdrawOffers(pool, { conversationId, now });
  } catch (err) {
    log?.(`offers: withdrawing the previous turn's offers failed: ${errorText(err)}`);
    return 0;
  }
}

/**
 * Store what this turn declared, and hand back the rows a surface binds.
 *
 * Returns `[]` when the turn declared nothing, which is the normal case and the
 * one that must stay byte-for-byte what it was: no rows, no controls, and not a
 * word added to the reply.
 *
 * Never allowed to fail a turn either. A turn whose offers could not be stored
 * is a turn with no buttons — never a button bound to a row that is not there.
 */
export async function storeTurnOffers(
  pool: Queryable,
  input: {
    sink: OfferSink;
    agentId: string;
    conversationId: string;
    now: Date;
    log?: (line: string) => void;
  },
): Promise<Offer[]> {
  const declared = input.sink.offered ?? [];
  if (declared.length === 0) return [];
  try {
    return await offerActions(pool, {
      agentId: input.agentId,
      conversationId: input.conversationId,
      actions: declared,
      now: input.now,
    });
  } catch (err) {
    input.log?.(`offers: storing what this turn offered failed: ${errorText(err)}`);
    return [];
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

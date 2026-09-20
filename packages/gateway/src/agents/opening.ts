/**
 * What an agent the wizard writes says before the owner has said anything.
 *
 * An agent file may carry its own opening — `intro`, one sentence in its own
 * voice, and up to three `starters`, example requests the chat offers as
 * drafts. The shipped examples write theirs by hand. The one agent nobody
 * writes by hand is the owner's first, so its opening lives here: one constant,
 * used by the wizard that creates it, rather than a sentence invented inside a
 * route.
 *
 * It is deliberately generic. The wizard's first agent has memory, the clock,
 * the owner's profile and the roster-reading tools and nothing else
 * (`FIRST_AGENT_TOOLS`), so a starter naming a domain — an inbox, a balance —
 * would be an opening that promises what the grant cannot do. What it offers
 * instead is the three things that agent can actually do on day one: be told
 * something, be asked what it is, and be asked what else is possible.
 *
 * This module holds no state and reaches no service: it is the vocabulary two
 * callers share, kept out of both of their files.
 */

/** The opening written into the first agent's file. */
export const FIRST_AGENT_OPENING: {
  readonly intro: string;
  readonly starters: readonly string[];
} = {
  intro: 'I am your assistant: ask me anything, tell me what to remember, and I will say when something is beyond what I can reach.',
  starters: [
    'Remember that I prefer short answers',
    'What can you do for me right now?',
    'What would it take to give you more?',
  ],
};

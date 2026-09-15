/**
 * The surface contract: what a surface *is*, as data.
 *
 * Before this file, how a reply gets rendered was communicated to the model by
 * whichever surface happened to care, as a hand-written sentence appended to
 * the system prompt — Telegram said "plain text only", the terminal said
 * nothing, a scheduled run said something overlapping — and then every surface
 * post-processed the answer anyway to undo what the model still did. The
 * stripping was doing the work the prompt was supposed to do.
 *
 * A `SurfaceProfile` is the honest description a surface declares about itself:
 * its id, a name the agent may say out loud, and capability facts. Facts only.
 * The *rules* that follow from the facts ("no markdown means express structure
 * in words") live in the shared `writing-for-the-surface` skill, which is a file
 * the owner can read and change — not a string in TypeScript that silently wins
 * over it. `surfaceSection` turns a profile into the generated paragraph that
 * sits in the system prompt next to the generated tool list, for the same
 * reason the tool list is generated: a surface can never claim a capability it
 * does not have, and cannot go stale when it gains one.
 *
 * With a canvas on the web, this stopped being cosmetic. An agent that can put
 * a chart on a canvas should say so on the dashboard and must never claim it in
 * Telegram; `canvas: boolean` is the only thing standing between those two.
 */

/** Which surface this is. The four shipped ids, open for a fifth. */
export type SurfaceId = 'telegram' | 'cli' | 'web' | 'scheduled' | (string & {});

/**
 * What a surface declares about itself. Every field is a *fact* that some
 * sentence of the generated paragraph is derived from; nothing here is a
 * preference, a style or a policy, and nothing is added that no sentence reads.
 */
export interface SurfaceProfile {
  id: SurfaceId;
  /** How the agent names this place out loud: "Telegram", "the terminal". */
  name: string;
  /** Does markdown render, or are the characters shown as typed? */
  markdown: boolean;
  /** Do pipe tables survive as a grid? */
  tables: boolean;
  /** Hard per-message character limit, or null when there is none. */
  maxMessageChars: number | null;
  /** Can a file be sent here? */
  attachments: boolean;
  /** Can the owner tap a button — approve an action without typing? */
  buttons: boolean;
  /** Is there a canvas: a surface that can hold a chart or a document? */
  canvas: boolean;
  /** Is a person there *right now* to answer a question? */
  interactive: boolean;
}

/** Telegram: plain text, a hard message cap, buttons, a person reading. */
export const TELEGRAM_SURFACE: SurfaceProfile = {
  id: 'telegram',
  name: 'Telegram',
  markdown: false,
  tables: false,
  // The gateway splits at this width; a longer answer arrives in pieces.
  maxMessageChars: 4000,
  attachments: true,
  buttons: true,
  canvas: false,
  interactive: true,
};

/** `buddi chat`: markdown is rendered, nothing to tap, no canvas. */
export const CLI_SURFACE: SurfaceProfile = {
  id: 'cli',
  name: 'the terminal',
  markdown: true,
  tables: true,
  maxMessageChars: null,
  attachments: true,
  buttons: false,
  canvas: false,
  interactive: true,
};

/** The dashboard: the only surface with a canvas. */
export const WEB_SURFACE: SurfaceProfile = {
  id: 'web',
  name: 'the dashboard',
  markdown: true,
  tables: true,
  maxMessageChars: null,
  attachments: true,
  buttons: true,
  canvas: true,
  interactive: true,
};

/**
 * An unattended scheduled run. Its text is delivered as a notification, so it
 * inherits Telegram's rendering — and the one fact that changes everything:
 * nobody is there. `buttons: false` follows from that, not from the transport:
 * an approval request posted later is a different message, not this one.
 */
export const SCHEDULED_SURFACE: SurfaceProfile = {
  id: 'scheduled',
  name: 'a scheduled run delivered as a notification',
  markdown: false,
  tables: false,
  maxMessageChars: 1500,
  attachments: false,
  buttons: false,
  canvas: false,
  interactive: false,
};

/** Every profile this repository ships, for tests and for enumeration. */
export const SURFACE_PROFILES: readonly SurfaceProfile[] = [
  TELEGRAM_SURFACE,
  CLI_SURFACE,
  WEB_SURFACE,
  SCHEDULED_SURFACE,
];

/** The heading the generated surface paragraph carries. */
export const SURFACE_SECTION_HEADING = '## Your surface (generated, authoritative)';

/**
 * The generated surface paragraph, derived entirely from the profile.
 *
 * Deliberately only facts, and one sentence per fact: there is no per-surface
 * prose in this function, and adding a special case for one surface here would
 * be the same mistake the hand-written hints were. What the agent should *do*
 * about a fact is the `writing-for-the-surface` skill's business.
 */
export function surfaceSection(profile: SurfaceProfile): string {
  const lines = [
    `- You are answering on ${profile.name}.`,
    profile.markdown
      ? '- Markdown is rendered here: headings, bold, bullets and code fences display as formatting.'
      : '- Markdown is not rendered here: every asterisk, hash, backtick and pipe is shown to the owner exactly as you type it.',
    profile.tables
      ? '- Tables render here as a grid.'
      : '- Tables do not render here.',
    profile.maxMessageChars === null
      ? '- There is no limit on how long one message may be here.'
      : `- One message holds at most ${profile.maxMessageChars} characters here.`,
    profile.attachments
      ? '- Files can be sent and received here.'
      : '- No file can be sent or received here.',
    profile.buttons
      ? '- The owner can tap a button here to approve something without typing.'
      : '- There is no button to tap here.',
    profile.canvas
      ? '- There is a canvas here: a panel beside the conversation that can hold a chart, a table or a document you build.'
      : '- There is no canvas here: you have nowhere to draw, chart or display anything.',
    profile.interactive
      ? '- The owner is here now and can answer you.'
      : '- Nobody is here: this text is delivered as a notification and cannot be answered.',
  ];
  return `${SURFACE_SECTION_HEADING}\n${lines.join('\n')}`;
}

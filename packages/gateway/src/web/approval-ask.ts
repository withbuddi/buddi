/**
 * The heading of an approval card: what is being asked, in the owner's words,
 * never the dotted tool id (that stays in the envelope).
 *
 * An approval carries no title of its own. What it does carry, written by the
 * tool before anyone was asked, is the preview, whose first line is the
 * effect in a sentence ("Add to Work (Google)", "Generate one square image
 * with …"). That line is the ask. When the tool declared no `describe`, the
 * registry's fallback preview is the id and the JSON arguments, which is no
 * sentence; then the tool's own description's first sentence, and last a
 * plain line naming the plugin.
 */

import { RUNTIMES_TOOL, SECRETS_TOOL } from '@buddi/core';
import { USE_CHROME_ANSWERS, USE_CHROME_TOOL } from '../missions/chrome-scope.js';

/** A card's two answers when they are not Approve and Reject. */
export interface ApprovalAnswers { approve: string; reject: string }

/**
 * Core's own asks that read better as a question than an approval: "Let the
 * PNC pull use your Chrome?" is answered Allow or Not now. Keyed by core's
 * tool names only, never read from an envelope, so no plugin can relabel a
 * button. Absent: Approve and Reject.
 */
const ANSWERS: Readonly<Record<string, ApprovalAnswers>> = {
  [USE_CHROME_TOOL]: USE_CHROME_ANSWERS,
};

export function approvalAnswers(tool: string): ApprovalAnswers | undefined {
  return ANSWERS[tool];
}

/**
 * Core's asks whose preview opens with the question in the owner's words
 * ("Download the Whisper base model (135 MB)…?", "Let speech use …?"): the
 * notification and Telegram head with that line, never "needs your approval
 * to run runtimes.download". Core's tool names only.
 */
const OWN_WORDS: ReadonlySet<string> = new Set([USE_CHROME_TOOL, RUNTIMES_TOOL, SECRETS_TOOL]);

/** Whether this card's heading is its own ask (`approvalAsk`) rather than the tool's name. */
export function asksInOwnWords(tool: string): boolean {
  return OWN_WORDS.has(tool);
}

/** The longest ask drawn as is; a longer line is cut at a word. */
export const ASK_MAX = 120;

function clip(text: string): string {
  if (text.length <= ASK_MAX) return text;
  const cut = text.slice(0, ASK_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > ASK_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether a line reads as a sentence rather than an id or a JSON dump. */
function sentence(line: string, tool: string): boolean {
  if (line.length < 3) return false;
  if (/^[[{"]/.test(line)) return false;
  if (line === tool || line.startsWith(`${tool} `) || line.startsWith(`${tool}(`)) return false;
  // A dotted id alone ("mail.send") is no sentence either.
  if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(line)) return false;
  return /[a-z]/i.test(line);
}

export function approvalAsk(tool: string, preview: string, description?: string): string {
  const first = (preview ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  // "Double one number. — npm install reaches the network.": the reason the
  // registry appends stays in the body.
  const head = first.split(' — ')[0]!.trim().replace(/:$/, '');
  if (sentence(head, tool)) return clip(capital(head));
  const said = (description ?? '').trim().split(/(?<=[.!?])\s|\n/)[0]?.trim().replace(/\.$/, '') ?? '';
  if (sentence(said, tool)) return clip(capital(said));
  const plugin = tool.includes('.') ? tool.slice(0, tool.indexOf('.')) : tool;
  return `A ${plugin.replace(/[_-]+/g, ' ')} action needs your approval`;
}

/**
 * The browser's owner moments, on every interactive surface (docs/browser.md).
 *
 * Two small seams. `askInto` turns a tool's `ctx.ask` into the same question
 * card `conversation.ask` records, so the browser's Look? / Keep going? /
 * Sign in / Human check and the Stop's Resume are drawn by the dashboard, the
 * corner chat and Telegram exactly like any other question with choices.
 * `touchBrowser` tells the browser runtime the owner spoke in a conversation:
 * budgets renew, and a waiting card is answered by the tap that sent it.
 */
import { MAX_QUESTION_LABEL, MAX_QUESTION_OPTIONS, type CoreToolContext } from '@buddi/core';
import { CARD_LABELS, type BrowserController, type BrowserTouch } from '@buddi/tool-browser';
import { DECLINE_LABEL, requestQuestion, signInCardFor } from './secret-request.js';
import { MAX_QUESTION_CHARS, type AskSink } from './pending-question.js';

/** The browser card's choices the sign-in card replaces: Take over is "I'll sign in myself", Save a login is the card itself. */
const FOLDED = new Set<string>([CARD_LABELS.takeOver, CARD_LABELS.saveLogin]);

/**
 * `ctx.ask` for one run, writing into that run's ask sink. The first question
 * wins: one moment, one card — so a browser login wall and the agent's own
 * `secret.request` never both stand for the same page.
 *
 * A login wall (`signIn`) is the sign-in card of docs/owner-secrets.md §6:
 * the fields as inputs, Save and fill, with the browser's other choices
 * that still apply ("Use my Chrome") as secondary actions. A code page keeps
 * the browser's card, with the sign-in card opening in place from its "Save a
 * login for next time" instead of a link to Settings.
 */
export function askInto(sink: AskSink, opts: { agentName?: string | undefined } = {}): NonNullable<CoreToolContext['ask']> {
  return (question) => {
    if (sink.asked) return;
    const options = question.options.slice(0, MAX_QUESTION_OPTIONS).map((option) => ({
      label: option.label.slice(0, MAX_QUESTION_LABEL),
      hint: option.hint ?? null,
      recommended: option.recommended === true,
    }));
    const card = question.signIn ? signInCardFor(question.signIn, opts.agentName) : null;
    if (card && question.signIn?.kind === 'sign-in') {
      const choices = options.filter((option) => !FOLDED.has(option.label)).map((option) => ({ ...option, recommended: false }));
      sink.asked = {
        question: requestQuestion(card),
        options: [...choices, { label: DECLINE_LABEL, hint: null, recommended: false }],
        allowOther: false,
        request: { ...card, ...(choices.length > 0 ? { choices: choices.map((option) => option.label) } : {}) },
      };
      return;
    }
    sink.asked = {
      question: question.question.slice(0, MAX_QUESTION_CHARS),
      options,
      allowOther: question.allowOther,
      ...(card ? { request: { ...card, expand: true } } : {}),
    };
  };
}

/** The owner spoke or tapped in this conversation. Never costs the owner their turn. */
export async function touchBrowser(
  browser: Partial<Pick<BrowserController, 'touch'>> | undefined,
  input: BrowserTouch,
  log?: (line: string) => void,
): Promise<string | undefined> {
  if (!browser?.touch) return undefined;
  try {
    const result = await browser.touch(input);
    return result && 'answered' in result ? result.answered : undefined;
  } catch (err) {
    log?.(`browser: touch failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

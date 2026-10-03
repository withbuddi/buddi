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
import type { BrowserController, BrowserTouch } from '@buddi/tool-browser';
import { MAX_QUESTION_CHARS, type AskSink } from './pending-question.js';

/** `ctx.ask` for one run, writing into that run's ask sink. The first question wins: one moment, one card. */
export function askInto(sink: AskSink): NonNullable<CoreToolContext['ask']> {
  return (question) => {
    if (sink.asked) return;
    sink.asked = {
      question: question.question.slice(0, MAX_QUESTION_CHARS),
      options: question.options.slice(0, MAX_QUESTION_OPTIONS).map((option) => ({
        label: option.label.slice(0, MAX_QUESTION_LABEL),
        hint: option.hint ?? null,
        recommended: option.recommended === true,
      })),
      allowOther: question.allowOther,
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

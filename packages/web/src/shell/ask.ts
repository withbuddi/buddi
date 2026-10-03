/**
 * Open the corner buddi with a request written in, from anywhere on the page
 * (host API 1.28: an event sheet's "Move or change…"). The owner reads it,
 * edits it and sends it; nothing is sent by itself. Answers whether a corner
 * buddi took it — there is none on Home, in the chat, during first run, or
 * before a front desk exists.
 */
export const ASK_EVENT = 'buddi:ask';

export interface AskDetail {
  text: string;
  handled: boolean;
}

export function askInCorner(text: string): boolean {
  const detail: AskDetail = { text, handled: false };
  window.dispatchEvent(new CustomEvent<AskDetail>(ASK_EVENT, { detail }));
  return detail.handled;
}

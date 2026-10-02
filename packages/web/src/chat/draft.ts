/**
 * A sentence one page leaves for an agent's chat: the composer picks it up
 * when the chat opens on that agent, once, and forgets it. Never sent.
 */
export const DRAFT_KEY = 'buddi.chatDraft';

/** Leave a sentence for an agent; the chat picks it up when it opens on that agent. */
export function leaveDraft(agentId: string, text: string): void {
  try { window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ agentId, text })); } catch { /* a private window forgets */ }
}

export function takeDraft(agentId: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { agentId?: string; text?: string };
    if (parsed.agentId !== agentId || typeof parsed.text !== 'string') return null;
    window.sessionStorage.removeItem(DRAFT_KEY);
    return parsed.text;
  } catch {
    return null;
  }
}

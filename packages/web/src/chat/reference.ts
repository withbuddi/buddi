/** A removable reference carried from a plugin page; never sent on arrival. */
export interface ChatReference { title: string; text: string; suggestions: string[] }
const key = (agent: string): string => `buddi.chatReference.${agent}`;
export function leaveReference(agent: string, reference: ChatReference): void {
  try { sessionStorage.setItem(key(agent), JSON.stringify(reference)); } catch { /* storage unavailable */ }
}
export function readReference(agent: string): ChatReference | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(agent)) ?? 'null') as ChatReference | null;
    return value && typeof value.title === 'string' && typeof value.text === 'string'
      && Array.isArray(value.suggestions) && value.suggestions.every((s) => typeof s === 'string') ? value : null;
  } catch { return null; }
}
export function clearReference(agent: string): void {
  try { sessionStorage.removeItem(key(agent)); } catch { /* storage unavailable */ }
}
export function withReference(text: string, reference: ChatReference | null): string {
  return reference ? `${text}\n\nReference: ${reference.title}\n${reference.text}` : text;
}

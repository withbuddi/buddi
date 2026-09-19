const KEY = 'buddi.dismissedTabs';
export function readDismissedTabs(): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, ids]) => Array.isArray(ids) && ids.every(id => typeof id === 'string')));
  } catch { return {}; }
}
export function storeDismissedTabs(value: Record<string, string[]>): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(value).slice(-100)))); } catch { /* Local-only UI preference. */ }
}

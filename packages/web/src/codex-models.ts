/**
 * Which ChatGPT model a new subscription account starts on, and which one the
 * picker suggests once the account's own list is in.
 *
 * A new account starts on `gpt-5.5`, which every plan serves: starting on a
 * newer model answered 400 on plans without it. When the list ChatGPT itself
 * returned (not the built-in one) has `gpt-6.1-sol`, the picker offers it as
 * the suggested default — chosen in the picker, saved only when the owner
 * saves.
 */
export const CODEX_STARTING_MODEL = 'gpt-5.5';
export const CODEX_SUGGESTED_MODEL = 'gpt-6.1-sol';

export function codexSuggestion(list: { models: Array<{ id: string }>; source?: 'provider' | 'built-in' }): string | null {
  if (list.source !== 'provider') return null;
  return list.models.some((m) => m.id === CODEX_SUGGESTED_MODEL) ? CODEX_SUGGESTED_MODEL : null;
}

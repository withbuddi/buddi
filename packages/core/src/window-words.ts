/**
 * Whose a context window is, in the words the dashboard's Providers page and
 * `buddi accounts show` both say beside the number. Its own subpath, with no
 * imports, so the web bundle can share it.
 */

/** Where the window shown for an account's default model came from. */
export type WindowSource = 'provider' | 'table' | 'default' | 'mlxh';

/** The prompt limit under which a long conversation rolls over early. */
export const MLXH_LONG_CONVERSATION_TOKENS = 40_960;

/** Beside an mlxh window: whose number it is, and how to raise it when small. */
export function mlxhWindowNote(tokens: number | undefined): string {
  return (tokens ?? 0) < MLXH_LONG_CONVERSATION_TOKENS
    ? `mlxh’s max_prompt_tokens; raise it with \`mlxh config max_prompt_tokens ${MLXH_LONG_CONVERSATION_TOKENS}\` for long conversations`
    : 'mlxh’s max_prompt_tokens';
}

/**
 * The provider's (ChatGPT's) own number, buddi's table for a model it knows,
 * mlxh's prompt limit, or assumed — only the 128k default is a guess.
 */
export function windowSourceWords(kind: string, source: WindowSource | undefined, tokens?: number): string {
  if (source === 'mlxh') return mlxhWindowNote(tokens);
  if (source === 'provider') return kind === 'codex' ? 'from ChatGPT' : 'from the provider';
  if (source === 'table') return 'known model';
  return 'assumed';
}

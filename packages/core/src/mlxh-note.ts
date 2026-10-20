/**
 * What mlxh's prompt limit means for a conversation, in the words the
 * dashboard's Providers page and `buddi accounts show` both say beside the
 * window. Its own subpath, with no imports, so the web bundle can share it.
 */

/** The prompt limit under which a long conversation rolls over early. */
export const MLXH_LONG_CONVERSATION_TOKENS = 40_960;

/** Beside an mlxh window: whose number it is, and how to raise it when small. */
export function mlxhWindowNote(tokens: number | undefined): string {
  return (tokens ?? 0) < MLXH_LONG_CONVERSATION_TOKENS
    ? `mlxh’s max_prompt_tokens; raise it with \`mlxh config max_prompt_tokens ${MLXH_LONG_CONVERSATION_TOKENS}\` for long conversations`
    : 'mlxh’s max_prompt_tokens';
}

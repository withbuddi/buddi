/**
 * Where the thinking switch is real.
 *
 * On Anthropic and OpenAI, "on" and "off" are request parameters and the
 * answer changes. On an OpenAI-compatible host it is up to the model: Ollama
 * Cloud ignores both flags for some models and reasons anyway, a local Ollama
 * honours them for some and not others. A switch that may do nothing is worse
 * than none, so the pages show it only where it is honoured; elsewhere buddi
 * still keeps whatever the model wrote out of the answer.
 */
export function thinkingIsHonoured(providerKind: string | null | undefined): boolean {
  return providerKind === 'anthropic' || providerKind === 'openai';
}

export const THINKING_UP_TO_MODEL = 'Thinking is up to this model. What it writes while thinking is shown apart and kept out of the answer.';

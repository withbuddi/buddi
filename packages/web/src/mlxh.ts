/**
 * mlxh, the local MLX model server: which of its models a new account starts
 * on, and how the page tells an mlxh account apart. The address is the
 * gateway's to say (`api.mlxh()`), never this bundle's.
 */
import type { MlxhProbe, ProviderAccount } from './api';

/**
 * Image models mlxh can serve, by name, for a model whose worker is not loaded
 * yet (mlxh only knows a model's kind once it is). FLUX Schnell and Klein, Qwen
 * Image: the families its README names.
 */
const IMAGE_NAME = /(flux|klein|schnell|qwen[-_]?image|image)/i;

/** An image model: mlxh said so, or, before it is loaded, its name does. */
export function isMlxhImageModel(model: MlxhProbe['models'][number]): boolean {
  return model.kind === 'image' || (model.kind === undefined && IMAGE_NAME.test(model.id));
}

/** The models worth thinking with: language ones, loaded ones first (no wait for the first answer). */
export function mlxhBrains(probe: Pick<MlxhProbe, 'models'> | null | undefined): string[] {
  const brains = (probe?.models ?? []).filter((m) => !isMlxhImageModel(m));
  return [...brains.filter((m) => m.loaded), ...brains.filter((m) => !m.loaded)].map((m) => m.id);
}

/** The model a new mlxh account starts on, or undefined when it serves no language model. */
export function firstMlxhModel(probe: Pick<MlxhProbe, 'models'> | null | undefined): string | undefined {
  return mlxhBrains(probe)[0];
}

/** An account the gateway recognised as mlxh's: its window comes from mlxh's limit. */
export function isMlxhAccount(account: Pick<ProviderAccount, 'detectedContextWindowSource'> | null | undefined): boolean {
  return account?.detectedContextWindowSource === 'mlxh';
}

/** What mlxh's prompt limit means for a conversation, beside the window. */
export function mlxhWindowNote(tokens: number | undefined): string {
  return (tokens ?? 0) < 40_960
    ? 'mlxh’s max_prompt_tokens; raise it with `mlxh config max_prompt_tokens 40960` for long conversations'
    : 'mlxh’s max_prompt_tokens';
}

/** Said when nothing answers where mlxh should: the host and port come from the probe's address. */
export function mlxhNotAnswering(baseUrl: string): string {
  let where = baseUrl;
  try { where = new URL(baseUrl).host; } catch { /* the address as given */ }
  return `mlxh is not answering on ${where}. Start it with \`mlxh serve\`, or \`mlxh service install\` to keep it running.`;
}

/** Beside a model the probe says is an image model. */
export const MLXH_IMAGE_MODEL = 'an image model; pick it in the Image plugin, not here';

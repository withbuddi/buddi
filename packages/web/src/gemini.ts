/**
 * Gemini through Google's OpenAI-compatible endpoint: which of its models a
 * new account starts on.
 *
 * The newest Pro, read from the ids themselves (`gemini-3.1-pro-preview`
 * beats `gemini-2.5-pro`), because a list of thirty has no "the" model and
 * Google flags none as its default. Image, speech and live variants are not
 * brains and are passed over. No Pro at all: the first `gemini-` model. The
 * owner can change it under "That works" or in Settings.
 */

/** The model a Gemini account starts on when the list could not be read. */
export const GEMINI_FALLBACK_MODEL = 'gemini-2.5-pro';

/** Google's listing may say `models/gemini-…`; the bare id is what buddi speaks. */
export function bareGeminiId(id: string): string {
  return id.replace(/^models\//, '');
}

const NOT_A_BRAIN = /(image|tts|audio|live|embedding|vision|robotics|transcribe)/;

export function pickGeminiModel(ids: readonly string[]): string | undefined {
  const bare = ids.map(bareGeminiId);
  let best: { id: string; version: number[]; preview: boolean } | undefined;
  for (const id of bare) {
    const match = /^gemini-(\d+(?:\.\d+)*)-pro(?:-(.+))?$/.exec(id);
    if (!match || NOT_A_BRAIN.test(match[2] ?? '')) continue;
    const version = match[1]!.split('.').map(Number);
    const preview = (match[2] ?? '') !== '';
    if (!best || newer(version, best.version) > 0 || (newer(version, best.version) === 0 && best.preview && !preview)) {
      best = { id, version, preview };
    }
  }
  return best?.id ?? bare.find((id) => id.startsWith('gemini-'));
}

/** Positive when `a` is the newer version. */
function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Whether an account points at Google's endpoint, whatever trailing slash it was saved with. */
export function isGeminiAccount(account: { kind: string; baseUrl: string }, geminiBaseUrl: string | undefined): boolean {
  if (!geminiBaseUrl || account.kind !== 'openai-compatible') return false;
  const trim = (url: string): string => url.replace(/\/+$/, '');
  return trim(account.baseUrl) === trim(geminiBaseUrl);
}

export interface ProviderDiagnostic {
  state: string;
  message: string;
  httpStatus: number | null;
  retryAt: string | null;
}

/** Who answered and what was asked for, so the sentence can name both. */
export interface DiagnosticContext {
  /** The provider in the owner's words: "Google", "Anthropic", an account label. */
  provider?: string | undefined;
  model?: string | undefined;
  /** The account is Gemini through Google's OpenAI-compatible address. */
  gemini?: boolean | undefined;
}

/**
 * Why a Gemini key with a paid Google AI plan still has no Pro: the plan pays
 * for the Gemini app, the key bills its own Cloud project.
 */
export const GEMINI_PRO_ADVICE = 'Your Google AI plan covers the Gemini app, not this key. The key’s Google Cloud project has no billing, so Pro models aren’t included: pick a Flash model, or enable billing on that project at aistudio.google.com.';

/** A Pro model id, as Google names them: `gemini-3.1-pro`, `gemini-2.5-pro-preview`. */
const PRO = /(^|[-/])pro($|-)/;

/**
 * One or two sentences about the key and the model, in the owner's words.
 * Never expose provider error bodies: they may echo credentials or
 * conversation data. The body is read only to choose between our sentences.
 */
export function providerDiagnostic(error: unknown, context: DiagnosticContext = {}): ProviderDiagnostic {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? value.status : null;
  const retryAt = typeof value.retryAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.retryAt) && Number.isFinite(Date.parse(value.retryAt)) ? value.retryAt : null;
  const name = context.provider?.trim() || undefined;
  const Who = name ?? 'The provider';
  const who = name ?? 'the provider';
  const model = context.model?.trim() || undefined;
  const it = model ?? 'this model';
  const body = typeof value.message === 'string' ? value.message : '';
  let state = 'unavailable', message = `Could not reach ${who}. Check the address, the key and this computer’s network.`;
  if (status === 401) { state = 'authentication-error'; message = `${Who} did not accept this key. Check it or paste a new one; a subscription account may need to sign in again.`; }
  else if (status === 403) { state = 'access-denied'; message = `${Who} says this key may not use ${it}. Check the key’s permissions, or pick another model.`; }
  else if (status === 429 && value.type === 'insufficient_quota') {
    state = 'quota-exhausted'; message = `${Who} says this account is out of credit. Add credit or raise its spending limit, then try again.`;
  } else if (status === 429 && context.gemini && model && PRO.test(model) && (body === '' || /quota|limit/i.test(body))) {
    state = 'rate-limited'; message = `Google says this key has no allowance for ${model}. ${GEMINI_PRO_ADVICE}`;
  } else if (status === 429 && dailyLimit(value.limit)) {
    const limit = value.limit as { limit?: unknown; freeTier?: unknown; unit?: unknown };
    const size = typeof limit.limit === 'number' ? ` (${limit.limit} ${limit.unit === 'tokens' ? 'tokens' : 'requests'} a day${limit.freeTier === true ? ' on the free tier' : ''})` : '';
    state = 'rate-limited'; message = `${Who} says this key has used up today’s allowance${size}. It works again after the reset${context.gemini && limit.freeTier === true ? ', or turn on billing at aistudio.google.com' : ''}.`;
  } else if (status === 429) {
    state = 'rate-limited'; message = `${Who} says this key has reached its limit${model ? ` for ${model}` : ''}. Wait a little, or pick another model.`;
  } else if (status === 404) { state = 'not-found'; message = model ? `${Who} does not know ${model} at this address. Pick another model, or check the address.` : `${Who} found nothing at this address. Check the address.`; }
  else if (status !== null && status >= 500) { state = 'provider-unavailable'; message = `${Who} is having trouble right now. Try again in a few minutes.`; }
  return { state, message, httpStatus: status, retryAt };
}

function dailyLimit(limit: unknown): boolean {
  return typeof limit === 'object' && limit !== null && (limit as { scope?: unknown }).scope === 'day';
}

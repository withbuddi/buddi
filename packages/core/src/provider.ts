/**
 * Provider port (v1: Anthropic only).
 *
 * Invariants (ARCHITECTURE.md, "Runtime provider port"):
 *  - Provider + credential source + wire are ONE choice (discriminated union), so
 *    "subscription login + custom base URL" is hard to express by accident.
 *  - Resolution is a result union; there is never a half-usable provider.
 *  - No ambient credentials: the caller passes `env` explicitly. Core never reads
 *    `process.env` implicitly and never mutates it.
 *  - Fail closed: a missing or empty secret is a typed problem, not a warning.
 */

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export type AnthropicCredential =
  /** Raw API key, sent as the `x-api-key` header. */
  | { kind: 'api-key'; env: string }
  /** `claude setup-token` subscription token, sent as `Authorization: Bearer`. */
  | { kind: 'subscription-token'; env: string };

export type ProviderRef = {
  kind: 'anthropic';
  baseUrl?: string;
  credential: AnthropicCredential;
  model: string;
};

export type ProviderProblem = {
  code: 'missing-credential' | 'empty-credential' | 'unsupported';
  message: string;
};

export type ResolvedProvider = {
  kind: 'anthropic';
  baseUrl: string;
  credentialKind: AnthropicCredential['kind'];
  secret: string;
  model: string;
};

export type ProviderResolution =
  | { ok: true; provider: ResolvedProvider }
  | { ok: false; problem: ProviderProblem };

export function resolveProvider(
  ref: ProviderRef,
  env: NodeJS.ProcessEnv,
): ProviderResolution {
  if (ref.kind !== 'anthropic') {
    return {
      ok: false,
      problem: {
        code: 'unsupported',
        message: `unsupported provider kind: ${String((ref as { kind: unknown }).kind)}`,
      },
    };
  }

  const credential = ref.credential;
  if (credential.kind !== 'api-key' && credential.kind !== 'subscription-token') {
    return {
      ok: false,
      problem: {
        code: 'unsupported',
        message: `unsupported credential kind: ${String(
          (credential as { kind: unknown }).kind,
        )}`,
      },
    };
  }

  if (!ref.model || ref.model.trim() === '') {
    return {
      ok: false,
      problem: { code: 'unsupported', message: 'provider ref has no model pinned' },
    };
  }

  const varName = credential.env;
  if (!varName || varName.trim() === '') {
    return {
      ok: false,
      problem: {
        code: 'missing-credential',
        message: 'credential does not name an environment variable',
      },
    };
  }

  if (!Object.prototype.hasOwnProperty.call(env, varName) || env[varName] === undefined) {
    return {
      ok: false,
      problem: {
        code: 'missing-credential',
        message: `environment variable ${varName} is not set`,
      },
    };
  }

  const raw = env[varName] as string;
  const secret = raw.trim();
  if (secret === '') {
    return {
      ok: false,
      problem: {
        code: 'empty-credential',
        message: `environment variable ${varName} is empty`,
      },
    };
  }

  return {
    ok: true,
    provider: {
      kind: 'anthropic',
      baseUrl: ref.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL,
      credentialKind: credential.kind,
      secret,
      model: ref.model,
    },
  };
}

/** Auth headers for a resolved provider. Credential kind decides the wire form. */
export function providerAuthHeaders(
  provider: ResolvedProvider,
): Record<string, string> {
  return provider.credentialKind === 'api-key'
    ? { 'x-api-key': provider.secret }
    : { authorization: `Bearer ${provider.secret}` };
}

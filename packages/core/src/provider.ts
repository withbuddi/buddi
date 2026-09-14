/**
 * Provider port (Anthropic + OpenAI).
 *
 * Invariants (ARCHITECTURE.md, "Runtime provider port"):
 *  - Provider + credential source + wire are ONE choice (discriminated union), so
 *    "subscription login + custom base URL" is hard to express by accident.
 *    `PROVIDER_CREDENTIAL_INVARIANT` names it; `resolveProvider` enforces it even
 *    for callers who reach it from JavaScript with the types erased.
 *  - Resolution is a result union; there is never a half-usable provider.
 *  - No ambient credentials: the caller passes `env` explicitly. Core never reads
 *    `process.env` implicitly and never mutates it. OpenAI in particular has no
 *    subscription-token analogue and no discovery path: one named API-key
 *    variable, or nothing.
 *  - Fail closed: a missing or empty secret is a typed problem, not a warning.
 *  - **A model never migrates between providers.** The catalogue validates a
 *    model *within* the pinned provider; a model the pinned provider does not
 *    serve is a configuration problem, never a quiet re-route to whoever does
 *    serve it. An endpoint is a data destination, i.e. an authorization
 *    decision, and a footnote after the fact is not consent.
 */

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** OpenAI's base already carries the version segment; Anthropic's does not. */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** The environment variable each provider's API key is read from by default. */
export const DEFAULT_ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const DEFAULT_ANTHROPIC_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
export const DEFAULT_OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';

export type ProviderKind = 'anthropic' | 'openai';

/** Every provider this build can talk to, in a shape a message can list. */
export const PROVIDER_KINDS: readonly ProviderKind[] = ['anthropic', 'openai'];

/**
 * The invariant, named so a test can quote it (codex review, "Wire formats and
 * budgets": *name the invariant as a constant; assert it in tests*).
 */
export const PROVIDER_CREDENTIAL_INVARIANT =
  'a custom base URL may only be paired with an explicit api-key credential: ' +
  'a subscription token belongs to its issuer’s own origin, and pointing one at ' +
  'another host is exfiltration, not configuration';

export type AnthropicCredential =
  /** Raw API key, sent as the `x-api-key` header. */
  | { kind: 'api-key'; env: string }
  /** `claude setup-token` subscription token, sent as `Authorization: Bearer`. */
  | { kind: 'subscription-token'; env: string };

/**
 * OpenAI has exactly one credential kind. There is no subscription-token
 * analogue (a ChatGPT login is not an API credential) and nothing is discovered
 * from the environment implicitly — the ref names the variable it wants.
 */
export type OpenAiCredential = { kind: 'api-key'; env: string };

export type AnthropicProviderRef = {
  kind: 'anthropic';
  baseUrl?: string;
  credential: AnthropicCredential;
  model: string;
};

export type OpenAiProviderRef = {
  kind: 'openai';
  baseUrl?: string;
  credential: OpenAiCredential;
  model: string;
};

export type ProviderRef = AnthropicProviderRef | OpenAiProviderRef;

export type CredentialKind = AnthropicCredential['kind'] | OpenAiCredential['kind'];

/** Which credential kinds each provider accepts. Nothing else resolves. */
export const PROVIDER_CREDENTIAL_KINDS: Record<ProviderKind, readonly CredentialKind[]> = {
  anthropic: ['api-key', 'subscription-token'],
  openai: ['api-key'],
};

export type ProviderProblem = {
  code:
    | 'missing-credential'
    | 'empty-credential'
    /** The ref names a provider this build has no adapter for. */
    | 'unknown-provider'
    /** A credential kind that does not belong to the pinned provider. */
    | 'credential-mismatch'
    /** The pinned provider does not serve this model. Never a fallback. */
    | 'unknown-model'
    /** Base URL paired with a credential that may not leave its own origin. */
    | 'base-url-not-allowed'
    | 'unsupported';
  message: string;
};

export type ResolvedProvider = {
  kind: ProviderKind;
  baseUrl: string;
  credentialKind: CredentialKind;
  secret: string;
  model: string;
};

export type ProviderResolution =
  | { ok: true; provider: ResolvedProvider }
  | { ok: false; problem: ProviderProblem };

/* ------------------------------------------------------------------ *
 * Model catalogue — validates within a provider, never across one
 * ------------------------------------------------------------------ */

/**
 * The catalogue is a prefix rule per provider rather than a list of exact
 * names: a list goes stale the week a model ships, and a stale list would make
 * the *fail-closed* path fire on a perfectly good pin. What it must never do is
 * accept a name the pinned provider does not serve — that is the migration this
 * design withdraws.
 */
export const MODEL_PREFIXES: Record<ProviderKind, readonly string[]> = {
  anthropic: ['claude-'],
  openai: ['gpt-', 'o1', 'o3', 'o4', 'chatgpt-', 'ft:'],
};

/** Does this model name belong to this provider's catalogue? */
export function modelBelongsTo(kind: ProviderKind, model: string): boolean {
  const name = model.trim();
  return (MODEL_PREFIXES[kind] ?? []).some((prefix) => name.startsWith(prefix));
}

/** The provider a model name belongs to, or undefined when none claims it. */
export function providerForModel(model: string): ProviderKind | undefined {
  return PROVIDER_KINDS.find((kind) => modelBelongsTo(kind, model));
}

/**
 * The catalogue's verdict on `(provider, model)`, as a sentence or `undefined`
 * when the pin is good. Shared by `resolveProvider` and the agent-file parser so
 * one rule is stated in one place.
 */
export function modelProblem(kind: ProviderKind, model: string): string | undefined {
  const name = model.trim();
  if (name === '') return 'provider ref has no model pinned';
  if (modelBelongsTo(kind, name)) return undefined;
  const elsewhere = providerForModel(name);
  return elsewhere
    ? `model "${name}" is a ${elsewhere} model and provider "${kind}" is pinned; ` +
        'pin the matching provider explicitly — a model is never migrated for you'
    : `model "${name}" is not in the ${kind} catalogue (expected one of: ` +
        `${MODEL_PREFIXES[kind].map((p) => `${p}…`).join(', ')})`;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

function fail(code: ProviderProblem['code'], message: string): ProviderResolution {
  return { ok: false, problem: { code, message } };
}

export function resolveProvider(
  ref: ProviderRef,
  env: NodeJS.ProcessEnv,
): ProviderResolution {
  const kind = (ref as { kind: ProviderKind }).kind;
  if (!PROVIDER_KINDS.includes(kind)) {
    return fail(
      'unknown-provider',
      `unknown provider kind: ${String(kind)} (known: ${PROVIDER_KINDS.join(', ')})`,
    );
  }

  const credential = ref.credential as { kind: string; env: string } | undefined;
  if (!credential || typeof credential.kind !== 'string') {
    return fail('missing-credential', `provider "${kind}" ref carries no credential`);
  }

  const accepted = PROVIDER_CREDENTIAL_KINDS[kind];
  if (!accepted.includes(credential.kind as CredentialKind)) {
    return fail(
      'credential-mismatch',
      `credential kind "${credential.kind}" does not belong to provider "${kind}" ` +
        `(accepted: ${accepted.join(', ')})`,
    );
  }

  // The named invariant, enforced rather than merely documented: an explicit
  // base URL is only ever paired with an api-key credential.
  if (ref.baseUrl !== undefined && credential.kind !== 'api-key') {
    return fail(
      'base-url-not-allowed',
      `provider "${kind}": ${PROVIDER_CREDENTIAL_INVARIANT} ` +
        `(credential kind is "${credential.kind}")`,
    );
  }

  const modelIssue = modelProblem(kind, ref.model ?? '');
  if (modelIssue !== undefined) {
    return fail(
      (ref.model ?? '').trim() === '' ? 'unsupported' : 'unknown-model',
      modelIssue,
    );
  }

  const varName = credential.env;
  if (!varName || varName.trim() === '') {
    return fail(
      'missing-credential',
      'credential does not name an environment variable',
    );
  }

  if (!Object.prototype.hasOwnProperty.call(env, varName) || env[varName] === undefined) {
    return fail('missing-credential', `environment variable ${varName} is not set`);
  }

  const secret = (env[varName] as string).trim();
  if (secret === '') {
    return fail('empty-credential', `environment variable ${varName} is empty`);
  }

  return {
    ok: true,
    provider: {
      kind,
      baseUrl:
        ref.baseUrl ??
        (kind === 'openai' ? DEFAULT_OPENAI_BASE_URL : DEFAULT_ANTHROPIC_BASE_URL),
      credentialKind: credential.kind as CredentialKind,
      secret,
      model: ref.model.trim(),
    },
  };
}

/**
 * Auth headers for a resolved provider. Provider *and* credential kind decide
 * the wire form: Anthropic's api-key rides in `x-api-key`, everything else is a
 * bearer token (OpenAI has only that form).
 */
export function providerAuthHeaders(
  provider: ResolvedProvider,
): Record<string, string> {
  return provider.kind === 'anthropic' && provider.credentialKind === 'api-key'
    ? { 'x-api-key': provider.secret }
    : { authorization: `Bearer ${provider.secret}` };
}

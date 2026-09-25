/**
 * Where a secret can go: the destinations plugins register
 * (docs/owner-secrets.md §3).
 *
 * One table per process, keyed by kind. A plugin registers only kinds in its
 * own namespace (`email.account` is email's), so no plugin can stand up a
 * destination that receives values bound to another's; registering the same
 * kind again from the same plugin replaces it, which is what a re-register in
 * a test or a reloaded plugin does.
 */
import type { SecretDestination, SecretRule } from '../host/types.js';

/** Strictest first: a use runs under the stricter of the binding's rule and the kind's `maxRule`. */
export const SECRET_RULES: readonly SecretRule[] = ['every-time', 'first-time', 'pre-approved'];

export function isSecretRule(value: unknown): value is SecretRule {
  return typeof value === 'string' && (SECRET_RULES as readonly string[]).includes(value);
}

/** The stricter of two rules. */
export function stricterRule(a: SecretRule, b: SecretRule): SecretRule {
  return SECRET_RULES.indexOf(a) <= SECRET_RULES.indexOf(b) ? a : b;
}

const KIND_RE = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*$/;

export function isSecretKind(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && KIND_RE.test(value);
}

/**
 * An account kind (`<plugin>.account`): the plugin's process holds the value
 * for as long as its connection lives — the stated exception to "never held"
 * (owner-secrets §4), recorded as `held` on every use.
 */
export function isAccountKind(kind: string): boolean {
  return kind.endsWith('.account');
}

/** A destination, with the plugin that registered it. */
export interface RegisteredDestination extends SecretDestination {
  plugin: string;
}

const destinations = new Map<string, RegisteredDestination>();

/** Register one of `plugin`'s destinations. Throws, naming both, on a kind outside its namespace. */
export function registerSecretDestination(plugin: string, destination: SecretDestination): void {
  const { kind } = destination;
  if (!isSecretKind(kind)) {
    throw new Error(`plugin ${plugin}: secret destination kind ${JSON.stringify(kind)} is not <plugin>.<what>`);
  }
  if (!kind.startsWith(`${plugin}.`)) {
    throw new Error(`plugin ${plugin} may register secret destinations only as ${plugin}.<what>, not ${kind}`);
  }
  if (!isSecretRule(destination.maxRule)) {
    throw new Error(`plugin ${plugin}: secret destination ${kind} has no valid maxRule`);
  }
  for (const fn of ['checkTarget', 'describe', 'deliver'] as const) {
    if (typeof destination[fn] !== 'function') {
      throw new Error(`plugin ${plugin}: secret destination ${kind} has no ${fn}`);
    }
  }
  destinations.set(kind, { ...destination, plugin });
}

/** The destination registered for `kind`, or undefined. */
export function secretDestination(kind: string): RegisteredDestination | undefined {
  return destinations.get(kind);
}

/** Every registered destination. */
export function secretDestinations(): RegisteredDestination[] {
  return [...destinations.values()];
}

/** Forget them all. Tests only. */
export function resetSecretDestinations(): void {
  destinations.clear();
}

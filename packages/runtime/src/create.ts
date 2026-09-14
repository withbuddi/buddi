/**
 * One call that turns a *resolved* provider into an adapter.
 *
 * Composition roots should never branch on provider kind themselves: that is
 * how a second provider leaks into every entry point, and how one of them ends
 * up forgetting the branch and sending an agent's traffic to the wrong vendor.
 * The dispatch lives here, once, and it dispatches on the resolution — which
 * already fails closed — rather than on anything ambient.
 */
import type { ResolvedProvider } from '@buddi/core';
import { createAnthropicProvider, type RuntimeProvider } from './anthropic.js';
import { createOpenAiProvider } from './openai.js';

export interface CreateProviderOptions {
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  maxTokens?: number;
}

export function createProvider(
  resolved: ResolvedProvider,
  options: CreateProviderOptions = {},
): RuntimeProvider {
  switch (resolved.kind) {
    case 'anthropic':
      return createAnthropicProvider(resolved, options);
    case 'openai':
      return createOpenAiProvider(resolved, options);
    default:
      // Unreachable through `resolveProvider`, which rejects unknown kinds with
      // a typed problem. A defect here is a defect, and says so.
      throw new Error(
        `createProvider: no adapter for provider kind "${String(
          (resolved as { kind: unknown }).kind,
        )}"`,
      );
  }
}

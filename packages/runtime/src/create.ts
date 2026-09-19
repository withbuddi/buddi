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
import {
  createAnthropicProvider,
  type RetryNotice,
  type RuntimeProvider,
} from './anthropic.js';
import { createOpenAiProvider } from './openai.js';
import type { HttpTransport } from './transport.js';

export interface CreateProviderOptions {
  /**
   * Injected for tests. Defaults to the adapters' own transport — `node:https`
   * with connection reuse off, never the global `fetch`. See `transport.ts`.
   */
  fetch?: HttpTransport;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called before each backoff, with the whole cause chain of the attempt that
   * failed. Wired to the process log by the composition root: a failure that
   * healed on the second attempt is the evidence that names the fault, and
   * before this existed it was thrown away.
   */
  onRetry?: (notice: RetryNotice) => void;
  maxTokens?: number;
  /** Zero for owner-triggered connection probes: report a rate limit promptly. */
  maxStatusRetries?: number;
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

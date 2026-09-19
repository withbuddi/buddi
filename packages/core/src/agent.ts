import type { ProviderRef } from './provider.js';

export interface AgentDefinition {
  id: string;
  name: string;
  systemPrompt: string;
  /** Tool names this agent may call; the registry still enforces tiers. */
  tools: string[];
  /** Pinned per agent — provider choice is an authorization decision. */
  provider: ProviderRef;
  maxTurns: number;
  /**
   * Whether the model reasons before it answers. `on` and `off` are sent to
   * the provider; absent leaves the model's own default alone.
   */
  thinking?: ThinkingSetting;
}

export type ThinkingSetting = 'on' | 'off';

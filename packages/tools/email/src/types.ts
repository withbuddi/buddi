/**
 * Contract extensions this plugin codes against.
 *
 * There are none left. Both halves of the plugin contract now live in core:
 * `ToolDefinition` carries `describe(input, ctx)` and `timeoutMs`,
 * `PluginManifest` carries `sources`, `ToolContext` carries the approved
 * `actionId` a gated execute runs under, and `Source`/`SourceContext` are
 * core's own types. So this file re-exports them and adds exactly one thing: a
 * `gated` tool definition narrowed to *require* the `describe` that the owner's
 * preview is rendered from.
 */
import type { EffectDescription, ToolContext, ToolDefinition } from '@buddi/core';

export type { EffectDescription, OwnerChoice, Source, SourceContext, ToolContext } from '@buddi/core';

/**
 * An effect tool: tier `gated`, with the `describe` the Executor renders from.
 *
 * `describe` is optional on `ToolDefinition` — the registry falls back to the
 * canonical arguments — but an effect that leaves this machine owes the owner a
 * preview it wrote itself, so here it is required.
 */
export interface GatedToolDefinition<I = unknown, O = unknown, E = unknown>
  extends ToolDefinition<I, O> {
  tier: 'gated';
  describe(input: I, ctx: ToolContext): Promise<EffectDescription & { envelope: E }>;
  timeoutMs?: number;
}

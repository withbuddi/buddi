/**
 * Tool registry — the only thing core knows about tools.
 *
 * Fail-closed rules (ARCHITECTURE.md, "Trust model"):
 *  - Unknown tool          -> refuse ('unknown-tool')
 *  - Invalid arguments     -> refuse ('invalid-args'), zod decides
 *  - Tier other than 'auto'-> refuse ('tier-not-executable'); the action/approval
 *                             machinery does not exist yet, so nothing else runs.
 *  - Tool threw            -> 'tool-error'; defects never surface as success.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { PluginManifest, Tier, ToolContext, ToolDefinition } from './tools.js';

/** Tiers this build can execute without human approval machinery. */
export const EXECUTABLE_TIERS: readonly Tier[] = ['auto'];

export type ToolSpec = {
  name: string;
  description: string;
  tier: Tier;
  /** JSON Schema derived from the tool's zod input schema. */
  inputSchema: Record<string, unknown>;
};

export type InvokeResult<O = unknown> =
  | { ok: true; output: O }
  | {
      ok: false;
      reason: 'unknown-tool' | 'invalid-args' | 'tier-not-executable' | 'tool-error';
      message: string;
    };

type Entry = { tool: ToolDefinition<any, any>; plugin: string };

export class ToolRegistry {
  readonly #tools = new Map<string, Entry>();
  readonly #manifests = new Map<string, PluginManifest>();

  register(manifest: PluginManifest): void {
    if (this.#manifests.has(manifest.name)) {
      throw new Error(`plugin already registered: ${manifest.name}`);
    }
    for (const tool of manifest.tools) {
      const existing = this.#tools.get(tool.name);
      if (existing) {
        throw new Error(
          `tool name collision: ${tool.name} (${existing.plugin} and ${manifest.name})`,
        );
      }
    }
    this.#manifests.set(manifest.name, manifest);
    for (const tool of manifest.tools) {
      this.#tools.set(tool.name, { tool, plugin: manifest.name });
    }
  }

  manifests(): PluginManifest[] {
    return [...this.#manifests.values()];
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Tool specs for the model, in registration order. */
  list(): ToolSpec[] {
    return [...this.#tools.values()].map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      tier: tool.tier,
      inputSchema: zodToJsonSchema(tool.input, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    }));
  }

  async invoke(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<InvokeResult> {
    const entry = this.#tools.get(name);
    if (!entry) {
      return { ok: false, reason: 'unknown-tool', message: `unknown tool: ${name}` };
    }
    const { tool } = entry;

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-args',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      };
    }

    if (!EXECUTABLE_TIERS.includes(tool.tier)) {
      return {
        ok: false,
        reason: 'tier-not-executable',
        message: `tool ${name} is tier '${tool.tier}'; only ${EXECUTABLE_TIERS.join(
          ', ',
        )} executes in this build`,
      };
    }

    try {
      const output = await tool.execute(parsed.data, ctx);
      return { ok: true, output };
    } catch (err) {
      return {
        ok: false,
        reason: 'tool-error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

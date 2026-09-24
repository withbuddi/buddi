/**
 * The approval behind a secret's use (docs/specs/owner-secrets.md §2).
 *
 * When a use needs the owner's yes, `use.ts` records an ordinary action for
 * this tool — the existing approvals path, so the card reaches every surface
 * the owner decides on. Approving runs `execute`, which records the grant: the
 * binding's first approval under `first-time`, or, under `every-time`, the
 * approved action itself, consumed by the next use. The value is never
 * delivered from here; the plugin's next `use` does that.
 *
 * `ownerOnly`, so no model is ever shown it and no agent can call it: the only
 * way it runs is from an approved action.
 */
import { z } from 'zod';
import type { CoreToolContext, EffectDescription, PluginManifest, ToolDefinition } from '../tools.js';
import { secretDestination } from './destinations.js';

export const SECRETS_PLUGIN = 'secrets';
export const SECRETS_TOOL = 'secrets.use';
export const SECRETS_TOOL_VERSION = '1.0.0';

const input = z
  .object({
    bindingId: z.string().uuid(),
    secret: z.string(),
    kind: z.string(),
    target: z.unknown(),
    plugin: z.string(),
    rule: z.enum(['every-time', 'first-time']),
  })
  .strict();

export type SecretUseApproval = z.infer<typeof input>;

/**
 * The card: which plugin, which secret, and where — in the destination's own
 * words, read again when the approval executes, so a destination that is gone
 * or describes the target differently voids the approval.
 */
export function describeSecretUse(args: SecretUseApproval): EffectDescription {
  const destination = secretDestination(args.kind)?.describe(args.target) ?? args.kind;
  return {
    envelope: {
      secret: args.secret,
      kind: args.kind,
      target: args.target,
      destination,
      plugin: args.plugin,
      rule: args.rule,
    },
    preview:
      `${args.plugin} asks to use your secret "${args.secret}" for ${destination}. ` +
      (args.rule === 'every-time'
        ? 'This use only: every use of it there asks you.'
        : 'Approve once, and later uses of it there go ahead without asking.'),
  };
}

const useTool: ToolDefinition<SecretUseApproval, unknown> = {
  name: SECRETS_TOOL,
  description: "Record the owner's approval for a plugin to use one of their secrets. Runs only from an approved action.",
  tier: 'gated',
  ownerOnly: true,
  input,
  describe: (args) => describeSecretUse(args),
  async execute(args, ctx: CoreToolContext) {
    if (args.rule === 'first-time') {
      await ctx.db.query(
        `update core.secret_bindings set first_approved_at = coalesce(first_approved_at, $2) where id = $1`,
        [args.bindingId, ctx.now()],
      );
    }
    return {
      approved: true,
      secret: args.secret,
      note:
        args.rule === 'first-time'
          ? `Approved: ${args.plugin} may use "${args.secret}" there from now on.`
          : `Approved: ${args.plugin} may use "${args.secret}" there once.`,
    };
  },
};

/** Core's own manifest for the approval tool. Registered by the gateway beside the other core families. */
export function createSecretsManifest(): PluginManifest {
  return {
    name: SECRETS_PLUGIN,
    version: SECRETS_TOOL_VERSION,
    schema: 'core',
    migrationsDir: '',
    tools: [useTool],
  };
}

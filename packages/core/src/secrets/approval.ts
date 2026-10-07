/**
 * The approval behind a secret's use (docs/owner-secrets.md §2).
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
import { SECRETS_QUERIES, SECRETS_SETTINGS_TOOLS } from './settings.js';

export const SECRETS_PLUGIN = 'secrets';
export const SECRETS_TOOL = 'secrets.use';
export const SECRETS_TOOL_VERSION = '1.0.0';
/**
 * The approval for a set saved together (a sign-in's username and password):
 * one card for the whole set, the first time its secrets are filled on their
 * site. Approving records the first approval of every binding in it.
 */
export const SECRETS_SET_TOOL = 'secrets.use_set';

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
      // The ask on a line of its own: it is the card's heading on Telegram and in notifications.
      `${args.plugin} asks to use your secret "${args.secret}" for ${destination}.\n` +
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

const setInput = z
  .object({
    site: z.string().min(1).max(253),
    plugin: z.string(),
    items: z.array(z.object({
      bindingId: z.string().uuid(),
      /** Its other bindings on the same site (the page, the site, `*.` the site): approved with it. */
      alsoBindingIds: z.array(z.string().uuid()).max(20).optional(),
      secret: z.string(),
      kind: z.string(),
      /** The page field it goes into, as the agent's card named it ("Username"). */
      field: z.string().max(80).optional(),
    }).strict()).min(1).max(12),
  })
  .strict();

export type SecretSetApproval = z.infer<typeof setInput>;

/** "Wikipedia username and Wikipedia password" — the names, quoted, as one phrase. */
function namesPhrase(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length < 3 ? quoted.join(' and ') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** The set's card: which secrets, into which fields, on which site. */
export function describeSecretSetUse(args: SecretSetApproval): EffectDescription {
  return {
    envelope: {
      site: args.site,
      plugin: args.plugin,
      secrets: args.items.map((item) => ({ secret: item.secret, kind: item.kind, ...(item.field ? { field: item.field } : {}) })),
      rule: 'first-time',
    },
    preview:
      `${args.plugin} asks to fill your saved sign-in for ${args.site}: ${namesPhrase(args.items.map((item) => item.secret))}.\n` +
      'Approve once, and later uses of them there go ahead without asking.',
  };
}

const useSetTool: ToolDefinition<SecretSetApproval, unknown> = {
  name: SECRETS_SET_TOOL,
  description: "Record the owner's approval to fill a set of their secrets saved together on one site. Runs only from an approved action.",
  tier: 'gated',
  ownerOnly: true,
  input: setInput,
  describe: (args) => describeSecretSetUse(args),
  async execute(args, ctx: CoreToolContext) {
    for (const item of args.items) {
      await ctx.db.query(
        `update core.secret_bindings set first_approved_at = coalesce(first_approved_at, $2) where id = any($1::uuid[])`,
        [[item.bindingId, ...(item.alsoBindingIds ?? [])], ctx.now()],
      );
    }
    return {
      approved: true,
      secrets: args.items.map((item) => item.secret),
      note: `Approved: ${args.plugin} may fill ${namesPhrase(args.items.map((item) => item.secret))} on ${args.site} from now on.`,
    };
  },
};

/** Core's own manifest for the approval tool and the Keys and secrets page. Registered by the gateway beside the other core families. */
export function createSecretsManifest(): PluginManifest {
  return {
    name: SECRETS_PLUGIN,
    version: SECRETS_TOOL_VERSION,
    schema: 'core',
    migrationsDir: '',
    tools: [useTool, useSetTool, ...SECRETS_SETTINGS_TOOLS],
    queries: SECRETS_QUERIES,
  } as PluginManifest;
}

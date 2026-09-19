/**
 * The `owner.*` tools — what the agent uses to conduct a first run.
 *
 * A new installation's first contact is a *conversation*, not a form. Code
 * decides only when it happens (the surfaces) and stores what came out of it
 * (core); the questions, their order, and what to do when the owner answers
 * something else entirely belong to the agent and its `first-run` skill. These
 * four tools are the whole seam between the two.
 *
 * Everything here is tier `auto` and deliberately so: nothing it does is
 * irreversible, nothing leaves the machine, and an approval prompt in the
 * middle of "what should I call you?" would be the opposite of the experience
 * this exists to create. The one edit that touches a file — `rename_me` —
 * refuses far more than it accepts: an example the repository ships is never
 * rewritten, a handle another agent answers to is never taken, and the body of
 * the persona is never touched (core's `updateAgentFrontmatter` re-parses the
 * result and refuses anything that would not load).
 *
 * The catalog arrives through `bindOwnerTools`, for the same reason delegation
 * does: agent files are resolved *against* the registry, so the registry cannot
 * be handed a catalog at construction.
 */
import {
  HANDLE,
  HANDLE_MAX,
  HANDLE_MIN,
  AgentEditError,
  type ToolRegistry,
  completeOnboarding,
  getOnboarding,
  getOwnerProfile,
  isKnownTimezone,
  markStepDone,
  setOwnerProfile,
  updateAgentFrontmatter,
  type PluginManifest,
  type ToolDefinition,
} from '@buddi/core';
import path from 'node:path';
import { z } from 'zod';
import { EXAMPLES_AGENTS_DIR } from './catalog.js';
import type { AgentCatalog } from '../telegram/types.js';

/** Plugin family name. One manifest, four tools, no tables of its own. */
export const OWNER_PLUGIN = 'owner';

/**
 * The sentence every description here ends with.
 *
 * It is repeated rather than stated once somewhere central because a model
 * reads one tool description at a time: the rule has to be in front of it at
 * the moment it decides to call the thing, not in a preamble it saw earlier.
 */
const INTERVIEW_RULES =
  'Ask one thing at a time and wait for the answer — never send a list of questions. ' +
  'Never invent or record a preference the owner did not actually state.';

/** The surface a completion is attributed to when the caller did not say. */
const UNKNOWN_SURFACE = 'agent';

export interface OwnerToolsBinding {
  /** Every agent installed here — for the rename: the file, and the handles. */
  catalog: AgentCatalog;
  /** Which surface this process is; recorded when onboarding completes. */
  surface?: string;
}

const bindings = new WeakMap<ToolRegistry, OwnerToolsBinding>();

/** Wire a registry's owner tools once the catalog exists. */
export function bindOwnerTools(registry: ToolRegistry, binding: OwnerToolsBinding): void {
  bindings.set(registry, binding);
}

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

/**
 * Renaming an agent means rewriting its file, and the files in `examples/` are
 * the platform's, not the owner's: an installation that edits them loses the
 * change on the next pull and gets a dirty tree in the bargain. So the refusal
 * names the fix instead of doing it.
 */
export const EXAMPLES_TREE_REFUSAL =
  'I cannot rename myself yet: my persona is one of the examples this repository ships, ' +
  'and those files belong to the platform rather than to you — an edit here would be ' +
  'overwritten the next time you update buddi. Run `buddi init` and take the private ' +
  'configuration step: it copies the examples into your own directory, which is never ' +
  'committed and overrides them. After that I can rename myself.';

/** `@ledger` however the owner or the model spelled it. */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').toLowerCase();
}

/**
 * A handle that is not kebab-case, too short, or too long.
 *
 * Case is normalized before the check rather than refused: a model that writes
 * "Ada" for a handle means `@ada`, and the catalog matches handles
 * case-insensitively anyway. Everything else is a refusal — a handle with a
 * space in it is not a handle the owner could type.
 */
export function handleShapeProblem(handle: string): string | undefined {
  const raw = normalizeHandle(handle);
  if (raw.length < HANDLE_MIN) return `a handle needs at least ${HANDLE_MIN} characters`;
  if (raw.length > HANDLE_MAX) return `a handle can be at most ${HANDLE_MAX} characters`;
  if (!HANDLE.test(raw)) {
    return 'a handle is lower case letters, digits and hyphens, starting with a letter — ' +
      'like @ledger or @night-desk';
  }
  return undefined;
}

/**
 * Is this agent file one of the shipped examples?
 *
 * Compared as a path prefix with a separator, so a private directory that
 * merely *starts* with the same characters (`examples-of-mine/`) is not caught
 * by it.
 */
export function insideExamples(file: string, examplesDir: string = EXAMPLES_AGENTS_DIR): boolean {
  const relative = path.relative(path.resolve(examplesDir), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/* ------------------------------------------------------------------ *
 * The tools
 * ------------------------------------------------------------------ */

const setProfileInput = z
  .object({
    preferredName: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('What the owner said to call them, exactly as they said it. Only what they stated.'),
    timezone: z
      .string()
      .min(1)
      .optional()
      .describe(
        'An IANA zone name such as America/New_York or Europe/Paris. This is the day every ' +
          'agent means by "today", so write it only when the owner confirmed it.',
      ),
    language: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe('The language they want to be answered in, if they said one. Never guessed from their spelling.'),
    about: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('A short line about themselves in their own words — how to address them, what they do, how they like answers — only when they offer it as something every agent should know.'),
  })
  .strict();

const renameInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('The display name the owner chose for you, e.g. "Ada".'),
    handle: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The handle they will type to address you, without the @: lower case, letters, digits and ' +
          'hyphens. Derive it from the name unless the owner asked for something else.',
      ),
  })
  .strict();

/**
 * The four tools. No state of its own: the profile and the state machine are
 * core's rows, and the agent file is the one the catalog loaded.
 */
export function createOwnerManifest(registry: ToolRegistry): PluginManifest {
  const bound = (): OwnerToolsBinding | undefined => bindings.get(registry);

  const getProfile: ToolDefinition<Record<string, never>, unknown> = {
    name: 'owner.get_profile',
    description:
      'What you already know about the owner: the name they asked to be called, their timezone, ' +
      'the language they want, and which parts of the first-run conversation are already done. ' +
      'Call this before you ask anything — a question about something already recorded is the ' +
      'one mistake a first conversation cannot afford. ' +
      INTERVIEW_RULES,
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, ctx) {
      const [profile, onboarding] = await Promise.all([
        getOwnerProfile(ctx.db),
        getOnboarding(ctx.db),
      ]);
      return {
        preferredName: profile.preferredName,
        timezone: profile.timezone,
        language: profile.language,
        onboarding: onboarding.state,
        stepsDone: onboarding.stepsDone,
        detectedTimezone: ctx.timezone,
      };
    },
  };

  const setProfile: ToolDefinition<z.infer<typeof setProfileInput>, unknown> = {
    name: 'owner.set_profile',
    description:
      'Record what the owner just told you about themselves: what to call them, their timezone, ' +
      'the language they want to be answered in. Write a field only when they actually said it, ' +
      'in this same conversation — this is their profile, not your inference. Pass only the ' +
      'fields that changed. ' +
      INTERVIEW_RULES,
    tier: 'auto',
    input: setProfileInput,
    async execute(input, ctx) {
      if (input.timezone !== undefined && !isKnownTimezone(input.timezone)) {
        return {
          ok: false,
          reason: 'unknown-timezone',
          message:
            `"${input.timezone}" is not a timezone I know. Ask the owner which city they are in ` +
            'and try again; nothing was recorded.',
        };
      }
      const profile = await setOwnerProfile(ctx.db, input);
      // The steps the shipped skill records. Free-form strings in core, so an
      // owner's own first-run skill is free to record something else entirely.
      if (input.preferredName !== undefined) await markStepDone(ctx.db, 'name');
      if (input.timezone !== undefined) await markStepDone(ctx.db, 'timezone');
      return { ok: true, ...profile };
    },
  };

  const renameMe: ToolDefinition<z.infer<typeof renameInput>, unknown> = {
    name: 'owner.rename_me',
    description:
      'Rename YOURSELF, because the owner chose a name for you. Your name and handle are a ' +
      'default the platform shipped, not an identity — say so, offer it once, and call this only ' +
      'if they take you up on it. It rewrites your own configuration file: the name is what you ' +
      'are called, the handle is what they type to reach you, and the two should match. ' +
      INTERVIEW_RULES,
    tier: 'auto',
    input: renameInput,
    async execute(input, ctx) {
      if (input.name === undefined && input.handle === undefined) {
        return { ok: false, reason: 'nothing-to-do', message: 'give a name, a handle, or both' };
      }
      const agentId = ctx.agentId ?? '';
      const binding = bound();
      if (!binding) {
        return {
          ok: false,
          reason: 'unavailable',
          message: 'this process has no agent catalog bound, so no file can be found to rewrite',
        };
      }
      const self = agentId === '' ? undefined : binding.catalog.get(agentId);
      if (!self) {
        return {
          ok: false,
          reason: 'unknown-self',
          message: 'I cannot tell which agent file is mine in this run, so I will not rewrite one',
        };
      }
      if (insideExamples(self.file)) {
        return { ok: false, reason: 'examples-tree', message: EXAMPLES_TREE_REFUSAL };
      }

      let handle: string | undefined;
      if (input.handle !== undefined) {
        const problem = handleShapeProblem(input.handle);
        if (problem !== undefined) {
          return { ok: false, reason: 'bad-handle', message: `${problem}; nothing was changed` };
        }
        handle = normalizeHandle(input.handle);
        const taken = binding.catalog.byHandle(handle);
        if (taken && taken.id !== self.id) {
          return {
            ok: false,
            reason: 'handle-taken',
            message:
              `@${handle} is already ${taken.name}. Ask the owner for another one; nothing was changed.`,
          };
        }
      }

      try {
        updateAgentFrontmatter(self.file, {
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(handle === undefined ? {} : { handle }),
        });
      } catch (err) {
        if (err instanceof AgentEditError) {
          return { ok: false, reason: err.code, message: err.message };
        }
        throw err;
      }

      await markStepDone(ctx.db, 'agent-name');
      const now = handle ?? self.handle;
      return {
        ok: true,
        name: input.name?.trim() ?? self.name,
        handle: now,
        message:
          `Written. The running surfaces still hold the old catalog, so @${now} starts working ` +
          'after a restart (`buddi service restart`) — tell the owner that, and that you can carry ' +
          'on talking right now in the meantime.',
      };
    },
  };

  const finish: ToolDefinition<Record<string, never>, unknown> = {
    name: 'owner.finish_onboarding',
    description:
      'Mark the first conversation finished, once the owner has what they need — or the moment ' +
      'they say to skip it. Nothing asks them again afterwards, on this surface or any other. ' +
      'Call it before you offer them the first real thing you can do for them, not after. ' +
      INTERVIEW_RULES,
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, ctx) {
      const onboarding = await completeOnboarding(ctx.db, bound()?.surface ?? UNKNOWN_SURFACE);
      const profile = await getOwnerProfile(ctx.db);
      return {
        ok: true,
        configured: {
          preferredName: profile.preferredName,
          timezone: profile.timezone,
          language: profile.language,
        },
        stepsDone: onboarding.stepsDone,
        message:
          'Recorded. Any of it can be changed later just by saying so — there is no settings screen.',
      };
    },
  };

  return {
    name: OWNER_PLUGIN,
    version: '0.1.0',
    // The rows are core's (migration 013): this manifest only exposes them.
    schema: 'core',
    migrationsDir: '',
    tools: [getProfile, setProfile, renameMe, finish],
  };
}

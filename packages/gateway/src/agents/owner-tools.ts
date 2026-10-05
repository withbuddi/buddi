/**
 * The `owner.*` tools — what the agent uses to conduct a first run.
 *
 * A new installation's first contact is a *conversation*, not a form. Code
 * decides only when it happens (the surfaces) and stores what came out of it
 * (core); the questions, their order, and what to do when the owner answers
 * something else entirely belong to the agent and its `first-run` skill. These
 * tools are the whole seam between the two.
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
import type { CoreToolContext } from '@buddi/core';
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
  listOwnerPlaces,
  OWNER_DATE_FORMATS,
  OWNER_TIME_FORMATS,
  PLACE_ADDRESS_MAX,
  PLACE_LABEL_MAX,
  AGENT_ACTION_MAX,
  AGENT_TEXT_MAX,
  AGENT_TITLE_MAX,
  checkAgentLink,
  notifyFromAgent,
  markStepDone,
  updateAgentFrontmatter,
  type HttpArea,
  type PluginManifest,
  type ToolDefinition,
} from '@buddi/core';
import path from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { EXAMPLES_AGENTS_DIR } from './catalog.js';
import {
  ASKED_PREFERENCE,
  DONT_ASK_PREFERENCE,
  PROFILE_FIELDS,
  PROFILE_GAP_REASONS,
  applyProfileEdit,
  checkPlaceEdits,
  checkProfilePatch,
  profileGaps,
} from '../owner-profile-edit.js';
import type { AgentCatalog } from '../telegram/types.js';

/** Plugin family name. One manifest, six tools, no tables of its own. */
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
  /** The geocoder's road for places; a test hands in a stub. Default: Settings → Profile's. */
  placesHttp?: HttpArea;
  log?: (line: string) => void;
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
      .max(80)
      .optional()
      .describe('The language they want to be answered in, if they said one. Never guessed from their spelling.'),
    about: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('A short line about themselves in their own words — how to address them, what they do, how they like answers — only when they offer it as something every agent should know.'),
    fullName: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Their full name, for letters, forms and bookings, as they said it. preferredName stays what you call them.'),
    pronouns: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe('Their pronouns, as they wrote them ("she/her"). Only when they said.'),
    birthday: z
      .object({
        day: z.number().int().min(1).max(31),
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(1900).max(2100).optional(),
      })
      .optional()
      .describe('Their birthday, when they said it: day and month, the year only if they gave it. Their team greets them on the day.'),
    timeFormat: z
      .enum(OWNER_TIME_FORMATS)
      .optional()
      .describe('How they read times: "12h" (2:05 PM) or "24h" (14:05). Only when they said.'),
    dateFormat: z
      .enum(OWNER_DATE_FORMATS)
      .optional()
      .describe('How they read dates: "short" (Thu, Oct 1), "long" (Thursday, 1 October) or "iso" (2026-10-01). Only when they said.'),
    places: z
      .array(
        z
          .object({
            label: z.string().min(1).max(PLACE_LABEL_MAX).describe('What they call it: "Home", "Work", "Mum\'s".'),
            address: z
              .string()
              .min(2)
              .max(PLACE_ADDRESS_MAX)
              .describe('Where it is, as they said it: a street address or just the town ("Lyon", "12 rue Neuve, Lyon").'),
          })
          .strict(),
      )
      .max(5)
      .optional()
      .describe(
        'Places they told you about. Each address is looked up the way Settings → Profile does it and saved with ' +
          'the town and its timezone; a place already called that is changed, not added twice. The answer says which ' +
          'town it matched: tell them, so they can correct it.',
      ),
    removePlaces: z
      .array(z.string().min(1).max(PLACE_LABEL_MAX))
      .max(5)
      .optional()
      .describe('Labels of places they asked you to forget ("Work").'),
    clear: z
      .array(z.enum(PROFILE_FIELDS))
      .max(PROFILE_FIELDS.length)
      .optional()
      .describe('Fields they asked you to forget. A cleared timeFormat or dateFormat goes back to Auto.'),
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

/** The one tool here an agent uses after the first run: telling the owner something now. */
export const NOTIFY_TOOL = 'owner.notify';

const notifyInput = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_TITLE_MAX)
      .describe('One line, what the owner sees first: "The parcel was delivered".'),
    text: z
      .string()
      .max(AGENT_TEXT_MAX)
      .optional()
      .describe('A few plain lines under the title, when the title is not enough. No markdown.'),
    urgency: z
      .enum(['now', 'today'])
      .optional()
      .describe('"now" (the default) reaches them at once; "today" waits for their end-of-day message.'),
    link: z
      .string()
      .optional()
      .describe('A dashboard route to open, like "#/chat/<agent>/<conversation>". Never an outside address.'),
    action: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_ACTION_MAX)
      .optional()
      .describe(
        'Only when the owner has to do something: the step or the question, in a few words ("Confirm with the bank?", ' +
          '"Pick a time for Thursday"). With it the message waits in Needs you on their dashboard until they deal with it. ' +
          'Leave it out for news: plain information is delivered the same way but does not ask for them.',
      ),
    key: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('Your own name for this message, so a retry or a loop sends it once: "parcel-delivered".'),
  })
  .strict();

/**
 * Is the owner in the conversation that called the tool? An owner request is
 * stamped only at an authenticated owner input boundary — a line typed on the
 * dashboard, on Telegram or at the terminal, or an approval they decided —
 * and never on a mission, a watcher, a source or a reminder. A delegate runs
 * in another conversation, so it does not count.
 */
export function interactiveTurn(ctx: CoreToolContext): boolean {
  return Boolean(
    ctx.ownerRequest &&
      ctx.ownerRequest.expiresAt > Date.now() &&
      ctx.conversationId &&
      (ctx.delegationDepth ?? 0) === 0,
  );
}

/**
 * The "knowing you" record, from the two memory preferences the front desk
 * keeps it in: which fields it already asked about (and when it last did),
 * and which the owner said not to ask about. Shared or the caller's own; a
 * database without memory answers nothing recorded.
 */
async function knowingYouRecord(ctx: CoreToolContext): Promise<{ asked: string | null; askedAt: Date | null; dontAsk: string | null }> {
  try {
    const { rows } = await ctx.db.query(
      `select key, value, created_at from memory.preferences
        where key = any($1::text[]) and superseded_at is null
          and (agent_scope is null or agent_scope = $2)
        order by created_at desc`,
      [[ASKED_PREFERENCE, DONT_ASK_PREFERENCE], ctx.agentId ?? ''],
    );
    const of = (key: string) => (rows as Array<{ key: string; value: unknown; created_at: unknown }>).filter((r) => r.key === key);
    const asked = of(ASKED_PREFERENCE);
    const dontAsk = of(DONT_ASK_PREFERENCE);
    const at = asked[0]?.created_at;
    return {
      asked: asked.length > 0 ? asked.map((r) => String(r.value)).join(', ') : null,
      askedAt: at ? new Date(at as string) : null,
      dontAsk: dontAsk.length > 0 ? dontAsk.map((r) => String(r.value)).join(', ') : null,
    };
  } catch {
    return { asked: null, askedAt: null, dontAsk: null };
  }
}

/**
 * The six tools. No state of its own: the profile and the state machine are
 * core's rows, and the agent file is the one the catalog loaded.
 */
export function createOwnerManifest(registry: ToolRegistry): PluginManifest {
  const bound = (): OwnerToolsBinding | undefined => bindings.get(registry);

  const getProfile: ToolDefinition<Record<string, never>, unknown> = {
    name: 'owner.get_profile',
    description:
      'What you already know about the owner: the name they asked to be called, their full name, ' +
      'pronouns, timezone, language, birthday, time and date formats, their places, and which parts ' +
      'of the first-run conversation are already done. ' +
      'Call this before you ask anything — a question about something already recorded is the ' +
      'one mistake a first conversation cannot afford. ' +
      INTERVIEW_RULES,
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, ctx: CoreToolContext) {
      const [profile, onboarding, places] = await Promise.all([
        getOwnerProfile(ctx.db),
        getOnboarding(ctx.db),
        listOwnerPlaces(ctx.db).catch(() => []),
      ]);
      return {
        preferredName: profile.preferredName,
        timezone: profile.timezone,
        language: profile.language,
        fullName: profile.fullName,
        pronouns: profile.pronouns,
        birthday: profile.birthday,
        timeFormat: profile.timeFormat,
        dateFormat: profile.dateFormat,
        about: profile.about,
        places: places.map((p) => ({ label: p.label, address: p.address, matched: p.name, timezone: p.timezone })),
        onboarding: onboarding.state,
        stepsDone: onboarding.stepsDone,
        detectedTimezone: ctx.timezone,
      };
    },
  };

  const setProfile: ToolDefinition<z.infer<typeof setProfileInput>, unknown> = {
    name: 'owner.set_profile',
    description:
      'Record what the owner just told you about themselves: what to call them, their full name, pronouns, ' +
      'timezone, language, birthday, how they read times and dates, a line about them, and their places ' +
      '(Home, Work, others). Write a field only when they actually said it, in this same conversation — this ' +
      'is their profile, not your inference: never fill one from an email signature, a display name or a ' +
      'guess. Pass only the fields that changed. Every agent reads it from its next turn. ' +
      INTERVIEW_RULES,
    tier: 'auto',
    input: setProfileInput,
    async execute(input, ctx: CoreToolContext) {
      if (input.timezone !== undefined && !isKnownTimezone(input.timezone)) {
        return {
          ok: false,
          reason: 'unknown-timezone',
          message:
            `"${input.timezone}" is not a timezone I know. Ask the owner which city they are in ` +
            'and try again; nothing was recorded.',
        };
      }
      const { places, removePlaces, clear, ...fields } = input;
      const body: Record<string, unknown> = { ...fields };
      for (const field of clear ?? []) {
        if (body[field] !== undefined) {
          return { ok: false, reason: 'conflict', message: `${field} is both given and cleared; nothing was recorded.` };
        }
        body[field] = null;
      }
      // Settings → Profile's own checks and sentences.
      const checked = checkProfilePatch(body);
      if (!checked.ok) {
        const reason = checked.error.startsWith('The birthday') ? 'unknown-day' : 'invalid';
        return { ok: false, reason, message: `${checked.error} Ask the owner again; nothing was recorded.` };
      }
      const placeEdits = checkPlaceEdits(places ?? [], removePlaces ?? []);
      if (!placeEdits.ok) {
        return { ok: false, reason: 'invalid-place', message: `${placeEdits.error} Nothing was recorded.` };
      }
      if (Object.keys(checked.patch).length === 0 && placeEdits.places.length === 0 && placeEdits.remove.length === 0) {
        return { ok: false, reason: 'nothing-to-do', message: 'Say which field changed; nothing was recorded.' };
      }
      const binding = bound();
      // The zone applies at once and schedules kept in the old one move with
      // it; the birthday greeting follows a new day at once.
      const outcome = await applyProfileEdit(
        {
          pool: ctx.db as unknown as Pool,
          log: binding?.log ?? (() => undefined),
          ...(binding?.placesHttp ? { http: binding.placesHttp } : {}),
        },
        { patch: checked.patch, places: placeEdits.places, remove: placeEdits.remove },
      );
      // The steps the shipped skill records. Free-form strings in core, so an
      // owner's own first-run skill is free to record something else entirely.
      if (input.preferredName !== undefined) await markStepDone(ctx.db, 'name');
      if (input.timezone !== undefined) await markStepDone(ctx.db, 'timezone');
      const changes = outcome.placeChanges;
      return {
        ok: true,
        ...outcome.profile,
        ...(changes
          ? {
              places: outcome.places.map((p) => ({ label: p.label, address: p.address, matched: p.name, timezone: p.timezone })),
              placesSaved: changes.saved,
              ...(changes.notSaved.length > 0 ? { placesNotSaved: changes.notSaved } : {}),
              ...(changes.removed.length > 0 ? { placesRemoved: changes.removed } : {}),
              ...(changes.notFound.length > 0 ? { placesNotFound: changes.notFound } : {}),
            }
          : {}),
        message: 'Recorded. Every agent uses it from its next turn.',
      };
    },
  };

  const profileGapsTool: ToolDefinition<Record<string, never>, unknown> = {
    name: 'owner.profile_gaps',
    description:
      "Which useful parts of the owner's profile are still empty, each with one line on why it matters " +
      '(fullName: letters, forms and bookings; places.work: "how long to work?"). Each gap says whether it was ' +
      `already asked in a "knowing you" question (the ${ASKED_PREFERENCE} preference) or declined (${DONT_ASK_PREFERENCE}); ` +
      'nudge names the one field a weekly "knowing you" question may ask now, or null. A read: it asks nothing. ' +
      'Ask for a gap only when the task in hand needs it, or as that one weekly question, never mid-task. ' +
      INTERVIEW_RULES,
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, ctx: CoreToolContext) {
      const [profile, places, record] = await Promise.all([
        getOwnerProfile(ctx.db),
        listOwnerPlaces(ctx.db).catch(() => []),
        knowingYouRecord(ctx),
      ]);
      const gaps = profileGaps(profile, places, record, ctx.now());
      return { ...gaps, filled: PROFILE_GAP_REASONS.length - gaps.gaps.length, of: PROFILE_GAP_REASONS.length };
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
    async execute(input, ctx: CoreToolContext) {
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
    async execute(_input, ctx: CoreToolContext) {
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

  const notify: ToolDefinition<z.infer<typeof notifyInput>, unknown> = {
    name: NOTIFY_TOOL,
    description:
      'Tell the owner something now, on the channel they chose (usually Telegram): when they ask to be ' +
      'pinged, messaged or told on their phone, or when something they asked to hear about happens in the ' +
      'middle of your run. Never use it to repeat what your reply already says. It answers where the message ' +
      'went, in a sentence you can repeat to the owner as it is. Plain text only; it is shown as ' +
      '"@you: title". Limits: 6 urgent messages an hour (more wait for the end of the day) and 20 a day.',
    tier: 'auto',
    sideEffect: true,
    input: notifyInput,
    async execute(input, ctx: CoreToolContext) {
      const agentId = ctx.agentId ?? '';
      if (agentId === '') {
        return { ok: false, reason: 'unknown-self', delivered: 'not sent: this run does not say which agent it is' };
      }
      if (input.link) {
        const problem = checkAgentLink(input.link);
        if (problem) return { ok: false, reason: 'invalid-link', delivered: `not sent: ${problem}` };
      }
      const handle = bound()?.catalog.get(agentId)?.handle;
      const result = await notifyFromAgent(ctx.db, { now: ctx.now, timezone: ctx.timezone }, {
        agentId,
        ...(handle ? { agentHandle: handle } : {}),
        title: input.title,
        ...(input.text ? { text: input.text } : {}),
        urgency: input.urgency ?? 'now',
        ...(input.link ? { link: input.link } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.key ? { key: input.key } : {}),
        interactive: interactiveTurn(ctx),
      });
      return {
        ok: result.ok,
        ...(result.ok ? {} : { reason: result.outcome }),
        delivered: result.delivered,
        ...(result.updated ? { updated: true } : {}),
      };
    },
  };

  return {
    name: OWNER_PLUGIN,
    version: '0.1.0',
    // The rows are core's (migrations 013 and 043): this manifest only exposes them.
    schema: 'core',
    migrationsDir: '',
    tools: [getProfile, setProfile, profileGapsTool, renameMe, finish, notify],
  };
}

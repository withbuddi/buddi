/**
 * A mission and the owner's Chrome (docs/browser.md, "Your Chrome for a
 * mission"; docs/architecture.md, "Reminders and agent-proposed schedules").
 *
 * An unattended run never gets the owner's signed-in Chrome unless he said
 * so, for that mission. He says so in one of three places, each a decision
 * he can see:
 *
 *  - **When it is proposed**: a schedule (`schedule.propose`) or an agent
 *    package whose mission needs his Chrome carries one line on its card,
 *    "Runs every day at 07:00, using your Chrome for PNC", and approving the
 *    card grants it. Never silently.
 *  - **When a run needed it and could not have it**: the run stops, reports
 *    nothing, and the owner gets one approval, "Let the PNC pull use your
 *    Chrome?", with Allow and Not now. Allow (`schedule.use_chrome`, run by
 *    the executor only after his yes) grants it and runs the mission once now;
 *    Not now leaves the mission as it was.
 *  - **On Missions**: the row's "Uses your Chrome" switch, both ways.
 */
import {
  OWNER_AGENT_ID,
  getMission,
  getActiveSchedule,
  listPendingActionsForTool,
  ownerDate,
  setMissionBrowser,
  type CoreToolContext,
  type Mission,
  type MissionBrowser,
  type ToolDefinition,
} from '@buddi/core';
import type { Pool } from 'pg';
import { z } from 'zod';

/** The approval a refused run raises: Allow grants the owner's Chrome and runs the mission once now. */
export const USE_CHROME_TOOL = 'schedule.use_chrome';

/** The button words on that approval's card, everywhere it is drawn (web, chat, Telegram). */
export const USE_CHROME_ANSWERS = { approve: 'Allow', reject: 'Not now' } as const;

/** A site as the owner says it: `pnc.com` → `PNC`, `onlinebanking.chase.com` → `Chase`. */
export function siteLabel(site: string | undefined | null): string | undefined {
  if (!site) return undefined;
  const labels = site.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length === 0) return undefined;
  if (labels.length === 1) return labels[0];
  const short = labels.length >= 3 && /^(co|com|net|org|gov|ac|edu)$/.test(labels[labels.length - 2]!)
    ? labels[labels.length - 3]!
    : labels[labels.length - 2]!;
  // Three letters or fewer reads as initials (PNC, BBC); longer as a name (Chase).
  return short.length <= 3 ? short.toUpperCase() : short.charAt(0).toUpperCase() + short.slice(1);
}

/**
 * The first site the plan names that needs the owner's sign-in: an address
 * (`pnc.com`, `https://www.pnc.com/...`) under a listed site, or the site's
 * name as a word ("Pull the PNC balances" for `pnc.com`). Undefined when the
 * plan names none of them.
 */
export function signInSiteIn(text: string, sites: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  const hosts = [...lower.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/g)].map((m) => m[1]!.replace(/^www\./, ''));
  for (const raw of sites) {
    const site = raw.toLowerCase().replace(/^www\./, '');
    if (hosts.some((host) => host === site || host.endsWith(`.${site}`))) return site;
    const name = siteLabel(site)?.toLowerCase();
    if (name && name.length >= 3 && new RegExp(`\\b${name.replace(/[^a-z0-9]/g, '')}\\b`).test(lower)) return site;
  }
  return undefined;
}

/** "PNC pull" stays; "Morning brief" reads "morning brief" inside a sentence. */
function inSentence(name: string): string {
  const first = name.split(/\s+/)[0] ?? '';
  return first.length > 1 && first === first.toUpperCase() ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * The one line a proposal's card carries when the mission will use the
 * owner's Chrome: "Runs every day at 07:00, using your Chrome for PNC."
 * `cadence` is `describeCadence`'s words, or null when there is no schedule.
 */
export function chromeLine(cadence: string | null, site?: string | null): string {
  const label = siteLabel(site ?? undefined) ?? (site?.trim() || undefined);
  const using = `using your Chrome${label ? ` for ${label}` : ''}`;
  return cadence ? `Runs ${cadence}, ${using}.` : `It runs while you are away, ${using}.`;
}

/** The ask's heading, also the preview's first line: "Let the PNC pull use your Chrome?". */
export function useChromeAsk(missionName: string): string {
  return `Let the ${inSentence(missionName.trim())} use your Chrome?`;
}

/** When the mission last brought the owner something (a delivered report), if ever. */
async function lastDelivered(pool: Pool, missionId: string): Promise<Date | null> {
  try {
    const { rows } = await pool.query<{ at: Date | null }>(
      `select max(created_at) as at from core.events where kind = 'mission.delivered' and payload->>'missionId' = $1`,
      [missionId],
    );
    return rows[0]?.at ?? null;
  } catch {
    return null;
  }
}

export interface UseChromeEnvelope {
  tool: typeof USE_CHROME_TOOL;
  missionId: string;
  missionName: string;
  agentId: string;
  /** The host the run needed, when the browser knew it. */
  site?: string;
  /** When it last delivered something (ISO), for the reassurance line. */
  lastDelivered?: string;
  answers: typeof USE_CHROME_ANSWERS;
}

export function renderUseChromePreview(envelope: UseChromeEnvelope, timezone: string): string {
  const label = siteLabel(envelope.site);
  const since = envelope.lastDelivered ? ` What it last brought you is still from ${ownerDate(new Date(envelope.lastDelivered), timezone)}.` : '';
  return [
    useChromeAsk(envelope.missionName),
    '',
    `Its scheduled run needed your signed-in Chrome${label ? ` for ${label}` : ''} and stopped there: nothing was read or changed.${since}`,
    `Allow lets it use your Chrome while you are away and runs it once now; Not now leaves it as it is. Missions has the switch either way.`,
  ].join('\n');
}

const useChromeInput = z.object({
  missionId: z.string().min(1).describe('The mission that needed your Chrome.'),
  site: z.string().max(253).optional().describe('The site it needed, a host like pnc.com.'),
}).strict();

/** The mission's own agent, or the owner himself (the dashboard, MCP). */
function mayAsk(ctx: CoreToolContext, mission: Mission): boolean {
  return !ctx.agentId || ctx.agentId === OWNER_AGENT_ID || ctx.agentId === mission.agentId;
}

/** Queue one run now: a pending occurrence the scheduler picks up like any other. */
async function runOnceNow(pool: Pool, mission: Mission, now: Date): Promise<string | null> {
  const spec = await getActiveSchedule(pool, mission.id);
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.occurrences (mission_id, schedule_revision, scheduled_at, state)
     values ($1, $2, $3, 'pending')
     on conflict (mission_id, schedule_revision, scheduled_at) do nothing
     returning id`,
    [mission.id, spec?.revision ?? 0, now.toISOString()],
  );
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * `schedule.use_chrome`: gated, so only the owner's Allow runs it. The
 * mission executor raises it for a run that needed his Chrome; an agent may
 * also ask it for one of its own missions. It never runs for a mission of
 * another agent.
 */
export function createUseChromeTool(): ToolDefinition<z.infer<typeof useChromeInput>, unknown> {
  return {
    name: USE_CHROME_TOOL,
    description:
      "Ask the owner to let one of your missions use their signed-in Chrome while they are away (a bank or a site that needs their sign-in). " +
      'They see one card, "Let the … use your Chrome?", with Allow and Not now; Allow also runs the mission once now. Only for your own missions.',
    tier: 'gated',
    input: useChromeInput,
    async describe(input, ctx: CoreToolContext) {
      const mission = await getMission(ctx.db as Pool, input.missionId);
      if (!mission) throw new Error(`no mission ${input.missionId}`);
      if (!mayAsk(ctx, mission)) throw new Error(`${input.missionId} is not one of your missions`);
      if (mission.browser === 'owner') throw new Error(`${mission.name} may already use the owner's Chrome`);
      const last = await lastDelivered(ctx.db as Pool, mission.id);
      const envelope: UseChromeEnvelope = {
        tool: USE_CHROME_TOOL,
        missionId: mission.id,
        missionName: mission.name,
        agentId: mission.agentId,
        ...(input.site?.trim() ? { site: input.site.trim().toLowerCase() } : {}),
        ...(last ? { lastDelivered: last.toISOString() } : {}),
        answers: USE_CHROME_ANSWERS,
      };
      return { envelope, preview: renderUseChromePreview(envelope, ctx.timezone) };
    },
    async execute(input, ctx: CoreToolContext) {
      const pool = ctx.db as Pool;
      const mission = await getMission(pool, input.missionId);
      if (!mission) throw new Error(`no mission ${input.missionId}`);
      if (!mayAsk(ctx, mission)) throw new Error(`${input.missionId} is not one of your missions`);
      const updated = await setMissionBrowser(pool, mission.id, 'owner');
      const occurrenceId = await runOnceNow(pool, updated ?? mission, ctx.now());
      return { missionId: mission.id, browser: 'owner' satisfies MissionBrowser, ...(occurrenceId ? { rerun: occurrenceId } : {}) };
    },
  };
}

/** The approval already waiting for this mission, so a second refused run does not ask twice. */
export async function pendingUseChrome(pool: Pool, missionId: string, now: Date): Promise<string | null> {
  const pending = await listPendingActionsForTool(pool, USE_CHROME_TOOL, { now });
  const found = pending.find((action) => (action.canonicalArgs as { missionId?: unknown } | null)?.missionId === missionId);
  return found?.id ?? null;
}

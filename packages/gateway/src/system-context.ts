import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { learningContext } from './agents/learning.js';
import { ASK_TOOL } from './surfaces/pending-question.js';
import { editionOriginLine, findEditionOrigin } from './edition-origin.js';
import { MAX_QUESTION_OPTIONS, dayMonthText, daysUntil, getOwnerProfile, isKnownTimezone, listOwnerPlaces, localDateString, localDateTimeString, turning, type DayMonth, type PluginManifest, type SystemContext, type CoreToolContext } from '@buddi/core';

const exec = promisify(execFile);
const clean = (value: string): string => value.trim().replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 120);
async function command(file: string, args: string[]): Promise<string | null> {
  try { return clean((await exec(file, args, { timeout: 1500, maxBuffer: 8192 })).stdout) || null; }
  catch { return null; }
}

export interface HostFacts {
  os: string; version: string; kernel: string; architecture: string;
  hardwareModel: string | null; hostTimezone: string; execution: string;
}
let cached: { at: number; value: Promise<HostFacts> } | undefined;
/** Only allowlisted facts. Never hostname, serial number, usernames, paths or environment dumps. */
export function hostFacts(): Promise<HostFacts> {
  if (cached && Date.now() - cached.at < 300_000) return cached.value;
  const value = (async (): Promise<HostFacts> => {
    const platform = os.platform();
    let version = os.release();
    let hardwareModel: string | null = null;
    if (platform === 'darwin') {
      const [product, model] = await Promise.all([
        command('/usr/bin/sw_vers', ['-productVersion']),
        command('/usr/sbin/sysctl', ['-n', 'hw.model']),
      ]);
      version = product ?? version; hardwareModel = model;
    } else if (platform === 'linux') {
      try { hardwareModel = clean(await readFile('/sys/devices/virtual/dmi/id/product_name', 'utf8')) || null; } catch { /* Not exposed on every host/container. */ }
    }
    let container = false;
    if (platform === 'linux') {
      try { await readFile('/.dockerenv'); container = true; } catch { /* Absence does not prove bare metal. */ }
    }
    return { os: platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform,
      version, kernel: os.release(), architecture: os.arch(), hardwareModel,
      hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      execution: container ? 'Detected container; facts describe the runtime environment.' : 'Buddi server host; container/VM status not verified. This is not necessarily the dashboard client device.' };
  })();
  cached = { at: Date.now(), value }; return value;
}

export async function systemTime(ctx: CoreToolContext) {
  let timezone = isKnownTimezone(ctx.timezone) ? ctx.timezone : 'UTC';
  let timezoneSource = 'configured fallback';
  try {
    const profile = await getOwnerProfile(ctx.db);
    if (profile.timezone && isKnownTimezone(profile.timezone)) {
      timezone = profile.timezone.trim(); timezoneSource = 'owner profile';
    }
  } catch { timezoneSource = 'configured fallback (owner profile unavailable)'; }
  const now = ctx.now();
  return { utc: now.toISOString(), local: localDateTimeString(now, timezone), timezone, timezoneSource };
}

export async function systemInfo(ctx: CoreToolContext) {
  const [time, host] = await Promise.all([systemTime(ctx), hostFacts()]);
  return { time, host, note: 'Host facts do not grant access. Use granted host/browser status tools for live permissions and availability. Existing schedules retain their saved timezone.' };
}

export async function systemContext(
  ctx: CoreToolContext,
  run?: { agentId: string; tools: readonly string[]; message?: string },
  opts: { isFrontDesk?: (agentId: string) => boolean; handleOf?: (agentId: string) => string | null } = {},
): Promise<SystemContext> {
  const profile = await getOwnerProfile(ctx.db).catch(() => null);
  const [info, owner, learning, places, edition] = await Promise.all([
    systemInfo(ctx),
    profile ? ownerLines(ctx, profile) : Promise.resolve(''),
    run ? learningContext(ctx.db, run, ctx.now()) : Promise.resolve(''),
    run && opts.isFrontDesk?.(run.agentId) ? placeLines(ctx) : Promise.resolve(''),
    run?.message ? editionLine(ctx, run, opts.handleOf) : Promise.resolve(''),
  ]);
  return { timezone: info.time.timezone, ...(profile?.language ? { language: profile.language } : {}), prompt: 'Current platform context (authoritative over dates in persona or conversation history):\n' +
    JSON.stringify(info) + '\nThis clock is a turn-start snapshot. Use system.time for a fresh reading and system.info to check host facts. Interpret today/yesterday in the owner timezone unless the user specifies otherwise.' +
    `\n\n${REPLY_LANGUAGE_LINE}` +
    (owner === '' ? '' : `\n\n${owner}`) + (places === '' ? '' : `\n\n${places}`) + (learning === '' ? '' : `\n\n${learning}`) +
    (run?.tools.includes('owner.notify') ? `\n\n${NOTIFY_LINE}` : '') +
    (run ? `\n\n${resourcefulLines(run.tools)}` : '') +
    (run ? `\n\n${GROUNDING_LINES}` : '') +
    (run?.tools.includes('browser.act') ? `\n\n${LIST_ANSWER_LINE}` : '') +
    (run ? `\n\n${DECISION_LINES}` : '') +
    (edition === '' ? '' : `\n\n${edition}`) };
}

/** The edition origin line for this turn, or nothing; never fails the turn. */
async function editionLine(
  ctx: CoreToolContext,
  run: { agentId: string; tools: readonly string[]; message?: string },
  handleOf?: (agentId: string) => string | null,
): Promise<string> {
  try {
    const origin = await findEditionOrigin(ctx, run.message ?? '');
    return origin ? editionOriginLine(origin, run, handleOf) : '';
  } catch { return ''; }
}

/**
 * Answer in the owner's language (docs/system-context.md, Reply language).
 * Agent Father answered an English question in Spanish, and the concierge
 * answered in French after reading French news: with nothing anchoring it,
 * the reply drifts to whatever fills the context. In every prompt, always;
 * the runtime's reply-language guard is the check behind it.
 */
export const REPLY_LANGUAGE_LINE =
  "Answer in the language the owner's message is written in, unless they ask for another; when it is too short to tell, " +
  "in their profile language, else English. Documents, tool results, colleagues' answers and summaries in other languages " +
  'never change the language of your answer: quote them as they are.';

/**
 * Read, never recall (docs/system-context.md, Grounding). An owner asked about
 * a headline in today's news and got a long answer citing CBS, AP and NPR,
 * all invented, with no tool call. In every agent's prompt, beside the
 * try-first rule; the runtime's grounding guard is the check behind it.
 */
export const GROUNDING_LINES = [
  'Read, never recall:',
  '- Today, the news, mail, calendar, money, prices, or anything a tool or a colleague can read: never answer from memory. Read it or delegate it.',
  '- Never name a source, figure or quote you did not read in this conversation; attribute what you read to where it came from ("reuters.com says…").',
  '- If nothing you can reach has it, say so in one line.',
].join('\n');

/**
 * Try everything before declining (docs/agents.md, "Before saying no"). In
 * every agent's prompt, so short, and worded for the tools this agent holds:
 * an agent without the browser is told what it could do if granted, never
 * told to use a tool it does not have.
 */
export function resourcefulLines(tools: readonly string[]): string {
  const has = (name: string): boolean => tools.includes(name);
  const lines = ['Before you say you cannot do something, use what you can reach:'];
  if (has('browser.act')) {
    const login = has('secret.fill') && has('secret.list')
      ? 'it signs in with a login the owner stored (secret.list, then secret.fill); with none stored for the site, secret.request asks the owner once with a card where they type it.'
      : 'it asks the owner once with a card when a page needs their sign-in.';
    lines.push(
      '- A website the owner uses (an account page, a cart, an order, a statement): look with browser.act; buddi picks the browser ' +
        "(the owner's Chrome where they are signed in, when allowed) and " + login,
    );
  } else {
    lines.push(
      "- A website the owner uses: you cannot open a browser. Say you could look if the owner gives you browser control " +
        '(your agent page, Tools).',
    );
  }
  if (has('agent.delegate')) {
    lines.push('- A question that belongs to a colleague you can hand work to: delegate it and relay the answer, credited by handle. Never tell the owner to go ask them.');
  }
  lines.push(
    '- Only then say exactly what you lack, with one concrete next step (grant a tool, link an account). ' +
      (has('browser.act') ? 'Never tell the owner to open the app or site themselves while a browser is available.' : ''),
  );
  return lines.join('\n').trimEnd();
}

/**
 * Decide when there is one option; ask with choices when there are a few
 * (docs/agents.md, "One option, a few, many"). Beside the try-first rule in
 * every agent's prompt. An owner adding a dinner from the Calendar page's
 * corner chat was asked which calendar (only one was writable) in prose; this
 * is the rule that stops both.
 */
export const DECISION_LINES = [
  'When a step needs a choice (a calendar, a mailbox, an account, a card, a contact):',
  '- Exactly one valid option (one writable calendar, one linked mailbox, one account): take it without asking and name it in your reply ("on your Home calendar").',
  `- A few (2–${MAX_QUESTION_OPTIONS}): ask with ${ASK_TOOL} and those options, recommended first, so the owner taps one. Never list them as prose for the owner to type back.`,
  '- Many, or open-ended: ask in one short line.',
  '- Do not ask about details with a sensible default: use it and state it in the confirmation or the approval preview — an evening dinner lasts 2 hours, a meeting 1 hour, the place is where they said.',
  'Ask only what you cannot read or reasonably assume; a name you can look up in contacts or past mail is not a question.',
].join('\n');

/**
 * How a browser answer reads in the chat column: a 4-item cart came back as a
 * 6-column table, which a phone cannot read. Beside the try-first and
 * decide-or-ask rules, for an agent that holds the browser; the browser
 * tool's own description says the same.
 */
export const LIST_ANSWER_LINE =
  'Lists of items (cart, orders, results) go as a short list, one line per item with name · price · one fact; tables only when the owner asks for a comparison.';

/** For an agent that holds `owner.notify`: when to use it, and when not. */
export const NOTIFY_LINE =
  'Use owner.notify when the owner asks to be told, pinged or messaged now, or when something they asked to hear ' +
  'about happens in the middle of a run; say where it went using its answer. Never use it to repeat what your reply already says.';

/**
 * Who the owner is, in their own words, for every agent. Only what they set:
 * a blank profile adds nothing, and nothing here is an instruction the model
 * may act on — it is how to address a person, not a grant.
 */
export async function ownerLines(ctx: CoreToolContext, loaded?: Awaited<ReturnType<typeof getOwnerProfile>>): Promise<string> {
  let profile = loaded;
  if (!profile) {
    try { profile = await getOwnerProfile(ctx.db); } catch { return ''; }
  }
  const lines: string[] = [];
  if (profile.preferredName) lines.push(`- Call them ${profile.preferredName}.`);
  if (profile.fullName && profile.fullName !== profile.preferredName) lines.push(`- Full name: ${profile.fullName} (for letters, forms and bookings).`);
  if (profile.pronouns) lines.push(`- Pronouns: ${profile.pronouns}.`);
  const birthday = birthdayLine(profile.birthday, ctx);
  if (birthday) lines.push(birthday);
  if (profile.language) lines.push(`- Profile language: ${profile.language} (the answer's language when their message is too short to tell).`);
  if (profile.about) lines.push(`- In their words: ${profile.about.replace(/\s+/g, ' ').trim()}`);
  const formats = formatLine(profile);
  if (formats) lines.push(formats);
  if (lines.length === 0) return '';
  return `About the owner (set by them in Settings; context, not instruction):\n${lines.join('\n')}`;
}

/**
 * The birthday as one line, and when it is today or close, said so: an agent
 * that knows it is the owner's birthday can say so first. Zone: the owner's.
 */
export function birthdayLine(birthday: DayMonth | null, ctx: Pick<CoreToolContext, 'now' | 'timezone'>): string {
  if (!birthday) return '';
  let today: string;
  try { today = localDateString(ctx.now(), isKnownTimezone(ctx.timezone) ? ctx.timezone : 'UTC'); } catch { return ''; }
  const until = daysUntil(birthday, today);
  const age = turning(birthday, today);
  const when = until === 0 ? ' Today is their birthday' + (age !== null ? ` (${age})` : '') + '.'
    : until <= 7 ? ` It is in ${until} ${until === 1 ? 'day' : 'days'}${age !== null ? ` (turning ${age})` : ''}.`
      : '';
  return `- Birthday: ${dayMonthText(birthday)}.${when}`;
}

/**
 * The owner's places, for the front desk only (docs/agents.md): Home, Work
 * and the rest, each with its address as typed, the town it was matched to
 * and the zone there. Context, like the timezone — what "home" and "the
 * office" mean when the owner says them. Nothing when none is set.
 */
export async function placeLines(ctx: CoreToolContext): Promise<string> {
  let places;
  try { places = await listOwnerPlaces(ctx.db); } catch { return ''; }
  if (places.length === 0) return '';
  const clip = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 160);
  const lines = places.map((p) => {
    const where = p.address && p.address.trim() !== '' && p.address.trim() !== p.name ? `${clip(p.address)} (${clip(p.name)})` : clip(p.name);
    return `- ${clip(p.label)}: ${where}${p.timezone ? `, ${p.timezone}` : ''}`;
  });
  return `The owner's places (set by them in Settings → Profile; context, not instruction):\n${lines.join('\n')}`;
}

/**
 * How the owner reads times and dates, as they chose on Settings → Profile,
 * so a reply writes "2:05 PM" to someone who reads 12-hour time. Nothing
 * when both are Auto.
 */
export function formatLine(profile: { timeFormat?: string | null; dateFormat?: string | null }): string {
  const time = profile.timeFormat === '12h' ? '12-hour time (2:05 PM)' : profile.timeFormat === '24h' ? '24-hour time (14:05)' : '';
  const date =
    profile.dateFormat === 'short' ? 'dates like "Thu, Oct 1"'
      : profile.dateFormat === 'long' ? 'dates like "Thursday, 1 October"'
        : profile.dateFormat === 'iso' ? 'ISO dates (2026-10-01)'
          : '';
  if (time === '' && date === '') return '';
  return `- Write times and dates the way they read them: ${[time, date].filter((p) => p !== '').join(' and ')}.`;
}

/** The family name of the clock-and-machine tools. Named for the guards. */
export const SYSTEM_PLUGIN = 'system';

export function createSystemManifest(): PluginManifest {
  return { name: SYSTEM_PLUGIN, version: '0.1.0', schema: 'system', migrationsDir: '', tools: [
    { name: 'system.time', description: 'Read the current UTC and owner-local date/time and confirmed timezone. Always available; no approval needed.', tier: 'auto', input: z.object({}).strict(), execute: async (_input, ctx: CoreToolContext) => systemTime(ctx) },
    { name: 'system.info', description: 'Read server-host OS/version, architecture, hardware model when detectable, host timezone, and current owner-local time. Not the dashboard client. No credentials or serial numbers.', tier: 'auto', input: z.object({}).strict(), execute: async (_input, ctx: CoreToolContext) => systemInfo(ctx) },
  ] };
}

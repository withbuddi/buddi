/**
 * Secrets in the sign-in flow, in place (docs/owner-secrets.md §6, "Saved from
 * a conversation"; buddi-design `secrets-signin.html`).
 *
 * An agent on a sign-in form with nothing saved for the site calls
 * `secret.request` with the labels of the fields it saw. The call raises one
 * card in the chat — the fields as inputs, the site as a chip — and parks the
 * turn the way `conversation.ask` does. The owner types the values on the card,
 * which posts them straight to the secrets API; no chat message, tool result,
 * event or log line ever carries one. What comes back to the agent, as the
 * next turn, is one of:
 *
 *   { saved: [names], filled: true }    Save and fill: saved, and buddi filled the page
 *   { saved: [names], filled: false }   Save only: saved, and the owner holds the page
 *   { declined: 'sign-in-myself' }      the owner signs in on the page themselves
 *   { declined: 'cancelled' }           the owner turned the card down (Telegram's Decline)
 *
 * The site defaults to the page the agent is on; a site that is neither that
 * page's nor one the owner named in this conversation is refused.
 */
import type { Pool } from 'pg';
import {
  OWNER_INTERJECTION_SPEAKER,
  ToolRefusal,
  type CoreToolContext,
  type PluginManifest,
  type SecretRequestCard,
  type SecretRequestField,
  type ToolDefinition,
} from '@buddi/core';
import { canonicalOrigin, isPublicSuffix, siteName, type BrowserController } from '@buddi/tool-browser';
import { z } from 'zod';
import type { AskSink } from './pending-question.js';

/** The tool. */
export const SECRET_REQUEST_TOOL = 'secret.request';
/** Added to an interactive turn's tools when the agent may fill secrets (`secret.fill`). */
export const SECRET_REQUEST_TOOLS: readonly string[] = [SECRET_REQUEST_TOOL];

/** Whether an agent's tool list grants `secret.fill`, so `secret.request` comes with it. */
export function grantsSecretRequest(tools: readonly string[]): boolean {
  return tools.some((tool) => tool === 'secret.fill' || tool === 'secret.*' || tool === '*');
}

/** The most fields one card asks for. */
export const MAX_REQUEST_FIELDS = 8;

const FIELD_KINDS = ['username', 'password', 'totp', 'other'] as const;
export type SecretRequestKind = (typeof FIELD_KINDS)[number];

const requestInput = z.object({
  site: z.string().min(1).max(253).optional()
    .describe("The site the sign-in is for, as the owner knows it (\"wikipedia.org\"). Defaults to the page you have open. Only that page's site, or a site the owner named in this conversation."),
  fields: z.array(z.object({
    label: z.string().min(1).max(60).describe('The field\'s label as the page shows it: "Username", "Password", "Email".'),
    kind: z.enum(FIELD_KINDS).describe('username, password, totp (an authenticator seed) or other.'),
    ref: z.string().min(1).max(40).optional().describe('The field\'s ref in the latest page, so buddi can fill it right after the owner saves.'),
  }).strict()).min(1).max(MAX_REQUEST_FIELDS),
  reason: z.string().max(200).optional().describe('One short line on why, when the page does not make it obvious.'),
}).strict();

export type SecretRequestInput = z.infer<typeof requestInput>;

/** What the tool answers at once. The owner's choice comes back as the next turn. */
export interface SecretRequestPending { pending: true; message: string }

/** What a decided card hands the agent: names and a flag, never a value. */
export type SecretRequestOutcome =
  | { saved: string[]; filled: boolean }
  | { declined: 'sign-in-myself' | 'cancelled' };

/**
 * A label that looks like something no sign-in should hold: shown on the card,
 * and the field is never filled by itself. Plain patterns, documented in
 * owner-secrets.md §6; a miss only means no warning line.
 */
const SENSITIVE: ReadonlyArray<{ test: RegExp; what: string }> = [
  { test: /\b(cvv2?|cvc2?|csc|card\s*(security|verification)\s*(code|value)?|security\s*code)\b/i, what: 'a card security code' },
  { test: /\b(card\s*(number|no\.?|#)|credit\s*card|debit\s*card|cc\s*(number|num|no\.?))\b|\bpan\b/i, what: 'a card number' },
  { test: /\b(ssn|social\s*security|national\s*insurance|tax\s*(id|number)|\btin\b|sin\s*number)\b/i, what: 'a social security number' },
  { test: /\b(one[-\s]?time|otp|verification\s*code|sms\s*code|2fa|two[-\s]?factor|authentication\s*code|auth\s*code|passcode)\b/i, what: 'a one-time code' },
];

/** What a field's label looks like, when it looks like something sensitive. */
export function sensitiveLabel(label: string, kind: SecretRequestKind): string | undefined {
  // An authenticator seed is asked for by kind, and the card says what it is.
  if (kind === 'totp') return undefined;
  return SENSITIVE.find((entry) => entry.test.test(label))?.what;
}

/** The card's warning line for one field. */
export function warningLine(agentName: string, what: string, site: string): string {
  return `${agentName} asked for something that looks like ${what}; buddi keeps it only on ${site}`;
}

/**
 * A site as the owner reads it: lower case, no scheme, path, port or `www.`.
 * Undefined for anything that is not a host of at least two labels, or is a
 * public suffix (`co.uk`, `github.io`) — nobody's sign-in lives there.
 */
export function normalizeSite(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let text = raw.trim().toLowerCase();
  if (text === '') return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
  let host: string;
  try {
    host = new URL(text).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return undefined;
  if (host.split('.').some((label) => label === '' || label.startsWith('-') || label.endsWith('-'))) return undefined;
  if (/^\d+(\.\d+){3}$/.test(host)) return undefined;
  if (isPublicSuffix(host)) return undefined;
  return host;
}

/** The site a page's host belongs to: the label before its public suffix, with it. */
export function siteOfHost(host: string): string {
  const labels = host.replace(/^www\./, '').split('.');
  for (let take = 2; take <= labels.length; take += 1) {
    const candidate = labels.slice(-take).join('.');
    if (!isPublicSuffix(candidate)) return candidate;
  }
  return labels.join('.');
}

/** Whether `host` is the site itself or under it. */
export function hostUnder(host: string, site: string): boolean {
  const bare = host.replace(/^www\./, '');
  return bare === site || bare.endsWith(`.${site}`);
}

/**
 * Where the values may go: the page the agent is on when it belongs to the
 * site, and the site itself and every host under it (`https://*.site`).
 */
export function requestOrigins(site: string, pageOrigin: string | undefined): string[] {
  const origins = new Set<string>();
  if (pageOrigin) {
    try {
      if (hostUnder(new URL(pageOrigin).hostname, site)) origins.add(pageOrigin);
    } catch {
      // not an address; nothing to add
    }
  }
  origins.add(`https://${site}`);
  origins.add(`https://*.${site}`);
  return [...origins];
}

/**
 * Whether the owner named this site in the conversation: the address, or its
 * name as a word ("Wikipedia" for wikipedia.org), in their own words — text
 * the owner typed, never a tool result, a page or an agent's reply.
 */
export async function ownerNamedSite(pool: Pick<Pool, 'query'>, conversationId: string, site: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select content from core.messages
      where conversation_id = $1 and role = 'user' and (speaker is null or speaker = 'owner' or speaker = $2)
      order by created_at desc limit 60`,
    [conversationId, OWNER_INTERJECTION_SPEAKER],
  );
  const name = (siteName(site) ?? '').toLowerCase();
  const word = name.length >= 3 ? new RegExp(`(^|[^a-z0-9])${name.replace(/[^a-z0-9]/g, '')}([^a-z0-9]|$)`, 'i') : null;
  for (const row of rows as Array<{ content: unknown }>) {
    const blocks = Array.isArray(row.content) ? row.content as Array<Record<string, unknown>> : [];
    for (const block of blocks) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const text = block.text.toLowerCase();
      if (text.includes(site)) return true;
      if (word && word.test(text)) return true;
    }
  }
  return false;
}

export interface SecretRequestDeps {
  pool: Pick<Pool, 'query'>;
  /** The page this conversation is on, read from the browser host. */
  browser?: Pick<BrowserController, 'status'> | undefined;
  /** The calling agent's display name, for the card ("Scout never sees them"). */
  agentName?: (agentId: string) => string | undefined;
}

/** "Wikipedia username": the site's name and the field's label, as Keys and secrets lists it. */
export function secretNameFor(site: string, label: string): string {
  const name = siteName(site) ?? site;
  const field = label.trim().replace(/\s+/g, ' ');
  return `${name} ${field.charAt(0).toLowerCase()}${field.slice(1)}`.slice(0, 120);
}

/**
 * The card one call raises, checked: the site, where the values may go, the
 * fields with any warning. Throws a refusal the agent reads when the site is
 * not one it may ask for.
 */
export async function buildRequestCard(deps: SecretRequestDeps, input: SecretRequestInput, ctx: Pick<CoreToolContext, 'agentId' | 'conversationId'>): Promise<SecretRequestCard> {
  const conversationId = ctx.conversationId;
  const agentId = ctx.agentId;
  if (!conversationId || !agentId) throw new ToolRefusal('secret.request works in a conversation with the owner, not here.');
  const status = deps.browser?.status({ agentId, conversationId });
  const pageUrl = status?.page?.url;
  const pageOrigin = canonicalOrigin(pageUrl);
  const pageHost = pageOrigin ? new URL(pageOrigin).hostname : undefined;
  const site = input.site !== undefined ? normalizeSite(input.site) : pageHost ? siteOfHost(pageHost) : undefined;
  if (input.site !== undefined && site === undefined) {
    throw new ToolRefusal(`"${input.site}" is not a site buddi can keep a sign-in for. Name it like wikipedia.org.`);
  }
  if (site === undefined) {
    throw new ToolRefusal('There is no page open in this conversation to ask a sign-in for. Open the sign-in page with browser.act first, or name the site the owner asked about.');
  }
  const onPage = pageHost !== undefined && hostUnder(pageHost, site);
  if (!onPage && !(await ownerNamedSite(deps.pool, conversationId, site))) {
    throw new ToolRefusal(pageHost
      ? `${site} is not the page you have open (${pageHost}), and the owner has not named it in this conversation. Ask only for the site you are on, or the one the owner asked about.`
      : `The owner has not named ${site} in this conversation, and no page of it is open. Ask only for the site you are on, or the one the owner asked about.`);
  }
  const agentName = deps.agentName?.(agentId) ?? 'The agent';
  const seen = new Set<string>();
  const fields: SecretRequestField[] = [];
  const warnings: string[] = [];
  for (const field of input.fields) {
    const label = field.label.trim().replace(/\s+/g, ' ');
    if (label === '' || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const what = sensitiveLabel(label, field.kind);
    const warning = what ? warningLine(agentName, what, site) : undefined;
    if (warning) warnings.push(warning);
    fields.push({ label, kind: field.kind, ...(field.ref && onPage ? { ref: field.ref } : {}), ...(warning ? { warning } : {}) });
  }
  if (fields.length === 0) throw new ToolRefusal('Name at least one field the page asks for.');
  return {
    kind: 'secret.request',
    site,
    origins: requestOrigins(site, onPage ? pageOrigin : undefined),
    ...(onPage && pageUrl ? { page: { url: pageUrl, ...(status?.page?.title ? { title: String(status.page.title).slice(0, 200) } : {}) } } : {}),
    fields,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    agentName,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The one button a surface that cannot hold the card draws (Telegram). */
export const DECLINE_LABEL = 'Decline';

/**
 * Telegram is not a place to type a password: the card there says where to
 * save it instead — the dashboard, at this conversation — with Decline.
 */
export function telegramRequestLine(card: Pick<SecretRequestCard, 'site'>, link?: string): string {
  return `Open the dashboard to save the sign-in for ${card.site}${link ? `: ${link}` : '.'}`;
}

/** A Telegram answer that ended on a sign-in card: the agent's words, then where to save it. */
export function telegramSignInReply(said: string, card: Pick<SecretRequestCard, 'site'>, link?: string): string {
  return [said.trim(), telegramRequestLine(card, link)].filter(Boolean).join('\n\n');
}

/** The dashboard address of one conversation, for a surface that links to it. */
export function conversationLink(publicOrigin: string | undefined, agentId: string, conversationId: string): string | undefined {
  if (!publicOrigin) return undefined;
  return `${publicOrigin.replace(/\/$/, '')}/#/chat/${encodeURIComponent(agentId)}/${encodeURIComponent(conversationId)}`;
}

/** The question line the card stands on: what Telegram and the agent rail read. */
export function requestQuestion(card: Pick<SecretRequestCard, 'site'>): string {
  return `No saved sign-in for ${card.site}`;
}

/**
 * The `secret.request` manifest, bound to one run's ask sink. Registered per
 * interactive run, like `conversation.ask`: nothing unattended can call it, and
 * the card is the run's one question.
 */
export function createSecretRequestManifest(sink: AskSink, deps: SecretRequestDeps): PluginManifest {
  const request: ToolDefinition<SecretRequestInput, SecretRequestPending> = {
    name: SECRET_REQUEST_TOOL,
    description:
      "Ask the owner to save a sign-in for the site you are on, when secret.list has nothing for it or secret.fill said nothing is saved. Input { fields: [{ label, kind, ref }], site?, reason? }: each field the form asks for, its label as the page shows it, its kind (username, password, totp, other) and its ref from the latest page. The owner types the values on a card in the chat — never in a message, and you never see them — and buddi saves them for this site only. Call it, write one short sentence that you need their sign-in, and stop. The answer comes back as the next turn: { saved: [names], filled: true } (buddi filled the form: carry on), { saved, filled: false } (saved; the owner is signing in on the page now, so wait for it back), or { declined: 'sign-in-myself' | 'cancelled' }. Never ask for a password, a card number or a code in chat instead.",
    tier: 'auto',
    waitsForOwner: true,
    input: requestInput,
    async execute(input, ctx) {
      if (sink.asked) throw new ToolRefusal('You already asked the owner something this turn. Wait for that answer first.');
      const card = await buildRequestCard(deps, input, ctx as CoreToolContext);
      // Decline is the one choice a surface without the card (Telegram) offers as a button.
      sink.asked = { question: requestQuestion(card), options: [{ label: DECLINE_LABEL, hint: null, recommended: false }], allowOther: false, request: card };
      return {
        pending: true,
        message: `The owner has a card to save the sign-in for ${card.site}. Say in one short sentence that you need it, and stop; you are told what they did.`,
      };
    },
  };
  return {
    name: 'secret-request',
    version: '0.1.0',
    schema: 'core',
    migrationsDir: '',
    tools: [request],
  };
}

/**
 * The turn that carries the outcome back to the agent, said as a tool result
 * delivered late — the way a decided approval comes back. Names and flags
 * only: there is no value anywhere in it.
 */
export function outcomeTurnText(outcome: SecretRequestOutcome, opts: { filling?: boolean } = {}): string {
  return `tool result (deferred) for ${SECRET_REQUEST_TOOL}: ${JSON.stringify(outcome)}\n${outcomeAdvice(outcome, opts.filling === true)}`;
}

function outcomeAdvice(outcome: SecretRequestOutcome, filling: boolean): string {
  if ('declined' in outcome) {
    return outcome.declined === 'sign-in-myself'
      ? 'The owner is signing in on the page themselves and holds it now. Say in one short line that you will carry on when they give it back, and stop.'
      : 'The owner did not save a sign-in. Do not ask again for it; say what you can do without it, or stop.';
  }
  if (outcome.filled) return 'The sign-in is filled on the page. Carry on with the task: submit the form and continue.';
  return filling
    ? 'Saved, and the owner approved filling them here, but buddi could not fill every field. Fill the rest with secret.fill by these names (no card is asked now), then carry on.'
    : 'Saved for next time. The owner is signing in on the page themselves and holds it now. Say in one short line that you will carry on when they give it back, and stop.';
}

/**
 * The quiet line the thread shows for that turn instead of its words: "Filled
 * username and password on wikipedia.org". The model still reads the outcome.
 */
export function outcomeStamp(outcome: SecretRequestOutcome, site: string, fields: readonly string[]): string {
  if ('declined' in outcome) return outcome.declined === 'sign-in-myself' ? `You’re signing in on ${site} yourself` : `No sign-in saved for ${site}`;
  const what = phrase(fields.map((label) => label.toLowerCase()));
  return outcome.filled ? `Filled ${what} on ${site}` : `Saved ${what} for ${site}`;
}

function phrase(items: readonly string[]): string {
  if (items.length === 0) return 'the sign-in';
  return items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The speaker that turn is stamped with (`stamp:<line>`): a reader draws the line, not a bubble. */
export const STAMP_TURN_SPEAKER_PREFIX = 'stamp:';

export function stampTurnSpeaker(line: string): string {
  return `${STAMP_TURN_SPEAKER_PREFIX}${line.trim()}`;
}

export function stampTurnLabel(speaker: string | null | undefined): string | null {
  if (typeof speaker !== 'string' || !speaker.startsWith(STAMP_TURN_SPEAKER_PREFIX)) return null;
  const line = speaker.slice(STAMP_TURN_SPEAKER_PREFIX.length).trim();
  return line === '' ? null : line;
}

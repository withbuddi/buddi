import type { RouteCommand, RoutePage, RouteProvider } from '@buddi/core/plugin';
import type { RouteKind, RoutePin } from './settings.js';
import { BrowserPreconditionError, type BrowserCommand, type BrowserDriver, type Observation } from './types.js';

/**
 * Picking where an agent looks, per task (docs/browser.md, "Routes").
 *
 * Pure: the controller hands in what the settings allow, what is healthy now,
 * the pins, and what the task looks like; the answer is a route and why. A
 * pin narrows or orders and never allows what the switches forbid. Nothing
 * here is a refusal: a route that cannot serve falls back to the own browser,
 * except for an app job, which has no other route.
 */
export type RouteReason =
  | 'default' | 'pin' | 'prefer' | 'sign-in' | 'sign-in-fallback' | 'app' | 'unattended'
  | 'chrome-unavailable' | 'apps-unavailable' | 'continuing';

export interface RouteChoice {
  route: RouteKind | undefined;
  reason: RouteReason;
  fallbackFrom?: RouteKind;
}

export interface RouteInput {
  command: Pick<BrowserCommand, 'action'>;
  prefer?: 'own' | 'yours' | undefined;
  pins: { conversation?: RoutePin | undefined; agent?: RoutePin | undefined; global?: RoutePin | undefined };
  /** The owner's switches: own is always true. */
  allowed: Record<RouteKind, boolean>;
  /** Healthy now: installed, connected, permitted. */
  available: Record<RouteKind, boolean>;
  /** The site is in the owner's "needs my sign-in" list, or buddi learned it from a login wall. */
  signInSite: boolean;
  /** No owner is behind this run (a mission): the own browser only, never the owner's Chrome. */
  unattended?: boolean;
  /**
   * With `unattended`: the owner let this mission use their signed-in Chrome
   * (`browser: owner`). Chrome is then chosen as for the owner's own run;
   * apps never are.
   */
  unattendedChrome?: boolean;
}

const usable = (input: RouteInput, route: RouteKind): boolean => input.allowed[route] && input.available[route];

export function chooseRoute(input: RouteInput): RouteChoice {
  if (input.command.action === 'open') {
    if (input.unattended) return { route: undefined, reason: 'unattended' };
    return usable(input, 'apps') ? { route: 'apps', reason: 'app' } : { route: undefined, reason: 'apps-unavailable' };
  }
  if (input.unattended && !input.unattendedChrome) return { route: 'own', reason: 'unattended' };
  const pin = [input.pins.conversation, input.pins.agent, input.pins.global].find((value) => value !== undefined && value !== 'auto');
  if (pin === 'own' || input.prefer === 'own') return { route: 'own', reason: pin === 'own' ? 'pin' : 'prefer' };
  if (pin === 'apps') {
    if (usable(input, 'apps') && !input.unattended) return { route: 'apps', reason: 'pin' };
    return { route: 'own', reason: 'apps-unavailable', fallbackFrom: 'apps' };
  }
  const wantsChrome = pin === 'chrome' || input.prefer === 'yours' || input.signInSite;
  if (wantsChrome) {
    const reason: RouteReason = pin === 'chrome' ? 'pin' : input.prefer === 'yours' ? 'prefer' : 'sign-in';
    if (usable(input, 'chrome')) return { route: 'chrome', reason };
    return { route: 'own', reason: 'chrome-unavailable', fallbackFrom: 'chrome' };
  }
  return { route: 'own', reason: 'default' };
}

/** The site a page or an address belongs to, for notes, sign-in lists and locks: the host without `www.`. */
export function siteOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, '') || undefined;
  } catch { return undefined; }
}

/** The origin two agents must never act on at once, in the owner's Chrome. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined; } catch { return undefined; }
}

/** Is `site` (or a parent of it) in the list? `amazon.com` covers `smile.amazon.com`. */
export function siteListed(site: string | undefined, list: Iterable<string>): boolean {
  if (!site) return false;
  for (const entry of list) {
    const bare = entry.toLowerCase().replace(/^www\./, '');
    if (site === bare || site.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** A site as a person says it: `amazon.com` → `Amazon`, `smile.amazon.co.uk` → `Amazon`. */
export function siteName(site: string | undefined): string | undefined {
  if (!site) return undefined;
  const labels = site.split('.').filter(Boolean);
  if (labels.length < 2) return site;
  // The label before the public suffix, guessed: `co.uk`, `com.au` and the like take two.
  const short = labels.length >= 3 && /^(co|com|net|org|gov|ac|edu)$/.test(labels[labels.length - 2]!) ? labels[labels.length - 3]! : labels[labels.length - 2]!;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/**
 * Why the owner's Chrome could not serve, as the owner sees it in Settings:
 * no pairing with this buddi, paired but not connected (Chrome closed), or
 * turned off for agents.
 */
export type ChromeLink = 'unpaired' | 'closed' | 'connected';
export type ChromeMiss = 'unpaired' | 'closed' | 'off';

/** The one chat line, only when the route is not the own browser or changed mid-task. */
export function routeNote(route: RouteKind, reason: RouteReason, site: string | undefined, appName?: string, chrome?: ChromeMiss): string | undefined {
  const where = site ?? 'this site';
  if (route === 'chrome') {
    if (reason === 'sign-in' || reason === 'sign-in-fallback') return `I used your Chrome because ${siteName(site) ?? 'this site'} needs your sign-in.`;
    if (reason === 'prefer') return `I used your Chrome for ${where}, as you asked.`;
    if (reason === 'pin') return `I used your Chrome for ${where}, as you set it.`;
    return `I used your Chrome for ${where}.`;
  }
  if (route === 'apps') return appName ? `I opened ${appName} because the task needs it.` : 'I used your apps for this.';
  if (reason === 'chrome-unavailable') {
    if (chrome === 'unpaired') return "Your Chrome isn't connected to this buddi, so I looked in my own browser.";
    if (chrome === 'closed') return "Your Chrome isn't open right now, so I looked in my own browser.";
    if (chrome === 'off') return "Your Chrome is turned off for agents in Settings, so I looked in my own browser.";
    return `Your Chrome isn't connected, so I used my own browser for ${where}.`;
  }
  if (reason === 'apps-unavailable') return `Your apps aren't available, so I used my own browser for ${where}.`;
  return undefined;
}

/* ---------------- walls: a sign-in, a code, a human check ---------------- */

const LOGIN_PATH = /\/(?:ap\/)?(?:sign[-_]?in|log[-_]?in|login|signin|logon|auth(?:enticate)?|sso|session\/new|oauth2?\/authorize|accounts?\/login|identifier)\b/i;
const LOGIN_TITLE = /\b(?:sign[- ]?in|log[- ]?in|login|connexion|se connecter|anmelden|iniciar sesi[oó]n)\b/i;
const PASSWORD = /\b(?:password|passcode|mot de passe|passwort|contrase[nñ]a)\b/i;
const CODE = /\b(?:one[- ]time (?:code|password)|verification code|security code|enter (?:the|your) code|2-step|two[- ]factor|authenticator app|otp)\b/i;
const HUMAN = /\b(?:captcha|recaptcha|hcaptcha|verify (?:that )?you(?:'re| are) (?:a )?human|i'?m not a robot|are you a robot|press (?:and|&) hold|unusual traffic from your|confirm you are human)\b/i;

export type Wall = 'sign-in' | 'code' | 'human';

/**
 * Does this page stand between the agent and the task? Read from the
 * observation only: a captcha anywhere is a human check; a page whose
 * address or title says sign-in, with a password or code field or a sign-in
 * form, is a sign-in. A login box in a sidebar of an ordinary page is not.
 */
export function detectWall(page: Pick<Observation, 'url' | 'title' | 'tree' | 'targets'> | undefined): Wall | undefined {
  if (!page) return undefined;
  const head = `${page.title}\n${page.tree.slice(0, 6000)}`;
  if (HUMAN.test(head) || (page.targets ?? []).some((target) => HUMAN.test(target.name))) return 'human';
  let pathname = '';
  try { pathname = new URL(page.url).pathname; } catch { /* an app window */ }
  const looksLogin = LOGIN_PATH.test(pathname) || LOGIN_TITLE.test(page.title);
  if (!looksLogin) return undefined;
  const fields = (page.targets ?? []).filter((target) => ['textbox', 'searchbox', 'spinbutton'].includes(target.role));
  if (fields.some((field) => CODE.test(field.name)) || (CODE.test(head) && fields.length > 0)) return 'code';
  if (fields.some((field) => PASSWORD.test(field.name)) || PASSWORD.test(head)) return 'sign-in';
  // An identifier-first page (an email box on /signin): a sign-in all the same.
  // Google's says "Sign in" in its heading under a title of "Gmail".
  if (!LOGIN_PATH.test(pathname)) return undefined;
  return LOGIN_TITLE.test(page.title) || (fields.length > 0 && LOGIN_TITLE.test(page.tree.slice(0, 1500))) ? 'sign-in' : undefined;
}

/* ---------------- a page that renders signed out ---------------- */

/** A sign-in call to action that stands out: "Sign in to see your cart", or a button that only says Sign in. */
const SIGN_IN_TO = /\b(?:sign|log)[- ]?in\s+to\b|\b(?:sign|log)[- ]?in\s+(?:now\s+)?(?:to|for)\s+(?:see|view|access|continue|manage|check)\b/i;
const SIGN_IN_WORDS = /^(?:sign[- ]?in|log[- ]?in|login|sign[- ]?in\s*(?:\/|or)\s*(?:register|sign[- ]?up|create account))$/i;
const SIGNED_OUT_TEXT = /\b(?:you(?:'re| are) (?:not )?signed out|you(?:'re| are) not (?:signed|logged) in|sign in to (?:see|view|access|continue|manage|check)|log in to (?:see|view|access|continue|manage|check))\b/i;
/** Addresses that hold the owner's own data. */
const ACCOUNT_PATH = /\/(?:cart|basket|bag|checkout|orders?|order-history|your-orders|purchases|account|my-?account|myaccount|profile|inbox|mail|messages|dashboard|settings|preferences|billing|subscriptions?|wishlist|bookings|reservations|trips|statements?|library)(?:[\/?#._-]|$)/i;
/** Words in the owner's ask that point at their own account. */
const ACCOUNT_WORDS = /\b(?:my|our)\s+(?:\w+\s+)?(?:cart|basket|bag|orders?|order history|purchases|account|profile|inbox|e-?mails?|mail|messages|dashboard|settings|subscriptions?|wish ?list|bookings?|reservations?|trips?|statements?|balance|library)\b|\b(?:in|from|to) (?:the )?cart\b|\border history\b/i;

/**
 * A page that renders, but signed out where the task needs the owner's
 * account: an Amazon cart showing "Sign in to your account". Strong signals
 * only, both of them: a prominent sign-in call to action (a "Sign in to …"
 * link or line, or a button that only says Sign in) and an account context
 * (the address is a cart, orders, account, inbox, dashboard or settings page,
 * the owner's ask is about their own cart or orders or inbox, or the site is
 * on the sign-in list). A news front page with a Sign in link in its header
 * is neither.
 */
export function detectSignedOut(page: Pick<Observation, 'url' | 'title' | 'tree' | 'targets'> | undefined, context: { task?: string | undefined; signInSite?: boolean } = {}): boolean {
  if (!page) return false;
  const targets = page.targets ?? [];
  const head = page.tree.slice(0, 8000);
  const prominent = targets.some((target) => (target.role === 'button' || target.role === 'link') && SIGN_IN_TO.test(target.name))
    || targets.some((target) => target.role === 'button' && SIGN_IN_WORDS.test(target.name.trim()))
    || SIGNED_OUT_TEXT.test(head);
  if (!prominent) return false;
  let pathname = '';
  try { pathname = new URL(page.url).pathname; } catch { return false; }
  return context.signInSite === true || ACCOUNT_PATH.test(pathname) || ACCOUNT_WORDS.test(context.task ?? '');
}

/* ---------------- the owner's four moments, and the Stop ---------------- */

export type CardKind = 'uncertain' | 'budget' | 'sign-in' | 'code' | 'human' | 'stopped';
export interface OwnerCard {
  kind: CardKind;
  /**
   * What every surface shows: the card's title, a newline, then one line of
   * why and what happens next. Telegram sends it as is; the dashboard draws
   * the title bold and the line under it (`title` and `line`, the same words).
   */
  question: string;
  title: string;
  line: string;
  options: Array<{ label: string; hint?: string; recommended?: boolean }>;
  site?: string;
}

/** The card's labels, which the owner's tap comes back as. */
export const CARD_LABELS = {
  look: 'Look', carryOn: 'Carry on', keepGoing: 'Keep going', stopHere: 'Stop here',
  takeOver: 'Take over', useChrome: 'Use my Chrome', openChrome: 'Use Chrome when it\u2019s open',
  saveLogin: 'Save a login for next time', skip: 'Skip this site', resume: 'Resume', leaveStopped: 'Keep paused',
} as const;

/** Labels an older card carried: a tap on one still answers it. */
const OLD_LABELS = { openChrome: "Open Chrome and I'll use it there", skip: 'Skip it', leaveStopped: 'Leave it stopped' } as const;

const card = (kind: CardKind, title: string, line: string, options: OwnerCard['options'], site?: string): OwnerCard =>
  ({ kind, question: `${title}\n${line}`, title, line, options, ...(site ? { site } : {}) });

export interface CardFacts {
  site?: string | undefined;
  chrome?: 'usable' | 'offline' | 'none';
  storedLogin?: boolean;
  /** The Stop's start and end, already in the owner's clock (`10:12`). */
  since?: string;
  until?: string;
  /** How long ago the Stop began, when no clock time is at hand. */
  stoppedAgo?: string;
}

/** The four moments and the Stop, in the words of the kit (buddi-design Browser.jsx). */
export function ownerCard(kind: CardKind, facts: CardFacts = {}): OwnerCard {
  const site = facts.site;
  const name = siteName(site) ?? 'This page';
  switch (kind) {
    case 'uncertain':
      return card(kind, 'I\u2019m not sure that went through. Look?', 'The page didn\u2019t change the way I expected after my last step.', [
        { label: CARD_LABELS.look, hint: 'Take over the page and check it yourself', recommended: true },
        { label: CARD_LABELS.carryOn, hint: 'I look again and judge from the page' }], site);
    case 'budget':
      return card(kind, 'Keep going?', 'This has taken its hour or its steps. What I found so far is above; I can keep going.', [
        { label: CARD_LABELS.keepGoing, hint: 'Another 200 steps and an hour', recommended: true },
        { label: CARD_LABELS.stopHere, hint: 'I stop and tell you where I got to' }], site);
    case 'sign-in':
    case 'code': {
      const options: OwnerCard['options'] = [{ label: CARD_LABELS.takeOver, hint: kind === 'code' ? 'Enter the code yourself, then give it back' : 'Sign in yourself, then give it back', recommended: true }];
      if (facts.chrome === 'usable') options.push({ label: CARD_LABELS.useChrome, hint: 'Where you are already signed in' });
      if (facts.chrome === 'offline') options.push({ label: CARD_LABELS.openChrome, hint: 'I wait for Chrome, where you are signed in' });
      if (!facts.storedLogin) options.push({ label: CARD_LABELS.saveLogin, hint: 'Keys and secrets, with the site filled in' });
      const first = kind === 'code' ? 'Enter the code on the page and give it back, and I carry on.' : 'Sign in on the page and give it back, and I carry on.';
      const chrome = facts.chrome === 'usable' ? ' Or let me use your Chrome, where you\u2019re signed in.'
        : facts.chrome === 'offline' ? ' Or open Chrome, where you\u2019re signed in, and I use that.' : '';
      return card(kind, kind === 'code' ? `${name} asks for a code` : `${name} needs your sign-in`, `${first}${chrome}`, options, site);
    }
    case 'human':
      return card(kind, 'This page asks for a human', `${site ?? 'This page'} wants a \u201cnot a robot\u201d check. Take over, answer it and give it back; I carry on.`, [
        { label: CARD_LABELS.takeOver, hint: 'Do the check yourself, then give it back', recommended: true },
        { label: CARD_LABELS.skip, hint: 'I leave this page' }], site);
    case 'stopped': {
      const when = facts.since ? ` since ${facts.since}` : facts.stoppedAgo ? ` (${facts.stoppedAgo})` : '';
      const until = facts.until ? `, until ${facts.until}` : ', until you resume it';
      const need = site ? ` I need one page: ${site}.` : ' I need to look at a page.';
      return card(kind, `Browsing is paused${when}`, `You paused agents\u2019 browsing from the Canvas${until}.${need}`, [
        { label: CARD_LABELS.resume, recommended: true },
        { label: CARD_LABELS.leaveStopped }], site);
    }
  }
}

/** Which card option an owner message answers, read loosely: a tap sends the label, a typed answer is close to it. */
export function cardAnswer(card: OwnerCard, text: string): 'takeover' | 'continue' | 'chrome' | 'resume' | 'decline' | undefined {
  const said = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (said === '') return undefined;
  const is = (...words: string[]) => words.some((word) => said === word.toLowerCase() || said.startsWith(`${word.toLowerCase()} `));
  switch (card.kind) {
    case 'uncertain': return is(CARD_LABELS.look, 'take over') ? 'takeover' : is(CARD_LABELS.carryOn, 'continue', 'go on') ? 'continue' : undefined;
    case 'budget': return is(CARD_LABELS.keepGoing, 'continue', 'go on', 'yes') ? 'continue' : is(CARD_LABELS.stopHere, 'stop', 'no') ? 'decline' : undefined;
    case 'sign-in': case 'code': case 'human':
      return is(CARD_LABELS.takeOver, 'look') ? 'takeover' : is(CARD_LABELS.useChrome, CARD_LABELS.openChrome, OLD_LABELS.openChrome, 'use chrome', 'in my chrome') ? 'chrome' : is(CARD_LABELS.skip, OLD_LABELS.skip, 'skip') ? 'decline' : undefined;
    case 'stopped': return is(CARD_LABELS.resume, 'yes') ? 'resume' : is(CARD_LABELS.leaveStopped, OLD_LABELS.leaveStopped, 'no') ? 'decline' : undefined;
  }
}

/** An instant on the owner's clock, `10:12`; UTC with its name when the zone is unknown. */
export function ownerClock(at: number, timezone?: string): string {
  try {
    if (timezone) return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }).format(new Date(at));
  } catch { /* an unknown zone: UTC below */ }
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

/** How long ago, said the way the Stop card says it. */
export function agoText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/* ---------------- a provided route, as a driver ---------------- */

/**
 * A plugin's `RouteProvider` driven as a page: `do` acts, `look` answers.
 * A provided route has no remote hand: take-over pauses it (`takeover` /
 * `resume`) and the Canvas says where the owner takes over instead
 * (`handMessage`). Native typing (`secret.type`) passes through when the
 * route declares it. Apps are the owner's, so their windows are kept.
 */
export class RouteProviderDriver implements BrowserDriver {
  #picture?: Buffer;
  readonly supportsHand = false;
  readonly handMessage: string;
  readonly preservesWindows: boolean;
  focusedBundleId?: () => Promise<string | undefined>;
  nativeType?: (value: string) => Promise<void>;
  constructor(readonly provider: RouteProvider, readonly session: string) {
    this.handMessage = provider.handMessage ?? `Take over at the computer for ${provider.label}.`;
    this.preservesWindows = provider.kind === 'apps';
    if (provider.focused && provider.typeSecret) {
      this.focusedBundleId = () => provider.focused!(session);
      this.nativeType = (value: string) => provider.typeSecret!(session, value);
    }
  }
  async takeover(): Promise<void> { this.#picture = undefined; await this.provider.takeover?.(this.session); }
  resume(): void { void Promise.resolve(this.provider.resume?.(this.session)).catch(() => undefined); }
  async start(): Promise<void> {
    const health = await this.provider.health();
    if (!health.ok) throw new Error(health.message ?? `${this.provider.label} is not available.`);
  }
  async perform(command: BrowserCommand): Promise<void> {
    if (command.action === 'observe') return;
    try { await this.provider.do(this.session, command as RouteCommand); }
    catch (error) {
      if ((error as { precondition?: boolean }).precondition === true && !(error instanceof BrowserPreconditionError)) throw new BrowserPreconditionError((error as Error).message);
      throw error;
    }
  }
  async observe(): Promise<Observation> {
    let page: RoutePage;
    try { page = await this.provider.look(this.session); }
    catch (error) {
      if ((error as { precondition?: boolean }).precondition === true && !(error instanceof BrowserPreconditionError)) throw new BrowserPreconditionError((error as Error).message);
      throw error;
    }
    const { screenshot, ...rest } = page;
    this.#picture = screenshot ? Buffer.from(screenshot) : undefined;
    return rest;
  }
  async screenshot(): Promise<Buffer | undefined> { return this.#picture; }
  async close(): Promise<void> { this.#picture = undefined; await this.provider.release?.(this.session); }
}

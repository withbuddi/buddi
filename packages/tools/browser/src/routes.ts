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
}

const usable = (input: RouteInput, route: RouteKind): boolean => input.allowed[route] && input.available[route];

export function chooseRoute(input: RouteInput): RouteChoice {
  if (input.command.action === 'open') {
    if (input.unattended) return { route: undefined, reason: 'unattended' };
    return usable(input, 'apps') ? { route: 'apps', reason: 'app' } : { route: undefined, reason: 'apps-unavailable' };
  }
  if (input.unattended) return { route: 'own', reason: 'unattended' };
  const pin = [input.pins.conversation, input.pins.agent, input.pins.global].find((value) => value !== undefined && value !== 'auto');
  if (pin === 'own' || input.prefer === 'own') return { route: 'own', reason: pin === 'own' ? 'pin' : 'prefer' };
  if (pin === 'apps') {
    if (usable(input, 'apps')) return { route: 'apps', reason: 'pin' };
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

/** The one chat line, only when the route is not the own browser or changed mid-task. */
export function routeNote(route: RouteKind, reason: RouteReason, site: string | undefined, appName?: string): string | undefined {
  const where = site ?? 'this site';
  if (route === 'chrome') {
    if (reason === 'sign-in' || reason === 'sign-in-fallback') return `I used your Chrome for ${where} (sign-in).`;
    if (reason === 'prefer') return `I used your Chrome for ${where}, as you asked.`;
    if (reason === 'pin') return `I used your Chrome for ${where} (pinned).`;
    return `I used your Chrome for ${where}.`;
  }
  if (route === 'apps') return appName ? `I used ${appName} on your computer.` : 'I used your apps for this.';
  if (reason === 'chrome-unavailable') return `Your Chrome isn't connected, so I used my own browser for ${where}.`;
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
  return LOGIN_PATH.test(pathname) && LOGIN_TITLE.test(page.title) ? 'sign-in' : undefined;
}

/* ---------------- the owner's four moments, and the Stop ---------------- */

export type CardKind = 'uncertain' | 'budget' | 'sign-in' | 'code' | 'human' | 'stopped';
export interface OwnerCard {
  kind: CardKind;
  question: string;
  options: Array<{ label: string; hint?: string; recommended?: boolean }>;
  site?: string;
}

/** The card's labels, which the owner's tap comes back as. */
export const CARD_LABELS = {
  look: 'Look', carryOn: 'Carry on', keepGoing: 'Keep going', stopHere: 'Stop here',
  takeOver: 'Take over', useChrome: 'Use my Chrome', openChrome: "Open Chrome and I'll use it there",
  saveLogin: 'Save a login for next time', skip: 'Skip it', resume: 'Resume', leaveStopped: 'Leave it stopped',
} as const;

export function ownerCard(kind: CardKind, facts: { site?: string | undefined; chrome?: 'usable' | 'offline' | 'none'; storedLogin?: boolean; stoppedAgo?: string; until?: string } = {}): OwnerCard {
  const site = facts.site;
  const named = site ?? 'This page';
  switch (kind) {
    case 'uncertain':
      return { kind, question: "I'm not sure that went through. Look?", options: [
        { label: CARD_LABELS.look, hint: 'Take over the page and check it yourself', recommended: true },
        { label: CARD_LABELS.carryOn, hint: 'I look again and judge from the page' }], ...(site ? { site } : {}) };
    case 'budget':
      return { kind, question: "I've used this task's steps and time. Keep going?", options: [
        { label: CARD_LABELS.keepGoing, hint: 'Another 200 steps and an hour', recommended: true },
        { label: CARD_LABELS.stopHere, hint: 'I stop and tell you where I got to' }], ...(site ? { site } : {}) };
    case 'sign-in':
    case 'code': {
      const options: OwnerCard['options'] = [{ label: CARD_LABELS.takeOver, hint: kind === 'code' ? 'Enter the code yourself, then give it back' : 'Sign in yourself, then give it back', recommended: true }];
      if (facts.chrome === 'usable') options.push({ label: CARD_LABELS.useChrome, hint: 'Where you are already signed in' });
      if (facts.chrome === 'offline') options.push({ label: CARD_LABELS.openChrome });
      if (!facts.storedLogin) options.push({ label: CARD_LABELS.saveLogin, hint: 'Keys and secrets, with the site filled in' });
      return { kind, question: kind === 'code' ? `${named} asks for a code.` : `${named} needs your sign-in.`, options, ...(site ? { site } : {}) };
    }
    case 'human':
      return { kind, question: `${named} asks for a human.`, options: [
        { label: CARD_LABELS.takeOver, hint: 'Do the check yourself, then give it back', recommended: true },
        { label: CARD_LABELS.skip, hint: 'I leave this page' }], ...(site ? { site } : {}) };
    case 'stopped':
      return { kind, question: `Browsing is stopped (by you${facts.stoppedAgo ? `, ${facts.stoppedAgo}` : ''}${facts.until ? `, until ${facts.until}` : ''}). Resume?`, options: [
        { label: CARD_LABELS.resume, recommended: true },
        { label: CARD_LABELS.leaveStopped }] };
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
      return is(CARD_LABELS.takeOver, 'look') ? 'takeover' : is(CARD_LABELS.useChrome, CARD_LABELS.openChrome, 'use chrome', 'in my chrome') ? 'chrome' : is(CARD_LABELS.skip) ? 'decline' : undefined;
    case 'stopped': return is(CARD_LABELS.resume, 'yes') ? 'resume' : is(CARD_LABELS.leaveStopped, 'no') ? 'decline' : undefined;
  }
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

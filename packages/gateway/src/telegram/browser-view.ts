/**
 * What the dashboard's Browser panel looks like, said on Telegram.
 *
 * The phone already gets approvals; it did not get *sight*. An agent driving
 * the owner's screen sent a line of prose and nothing to look at, and there
 * was no way in from the phone to stop it or take the wheel. Both halves live
 * here, and both are presentation over facts the gateway already holds:
 *
 *  - **A photo per step.** After every `browser.act` the surface asks the host
 *    controller for the observation it just recorded and sends that screenshot
 *    with a caption — the page's title, the action in words, how far through
 *    the step budget it is, and why it failed when it did. One photo per step,
 *    and none at all when the page did not change, which is what an `observe`
 *    of a page already sent would be.
 *  - **A "Take over" button** under it, whose URL is this conversation's
 *    Browser tab on the dashboard.
 *
 * **Nothing is sent that the owner's own allow lists would not let the agent
 * see.** A screenshot is page content, and Telegram is a third party's server:
 * a picture of a host outside `BUDDI_BROWSER_HOSTS`, or of a native app that is
 * not in the owner's `allowedApps`, is dropped rather than sent. The drivers
 * already refuse to *go* there, so this is belt to their braces — an observation
 * recorded before a setting changed, or a page that redirected under the agent.
 */
import type { BrowserController, BrowserStatus } from '@buddi/tool-browser';
import type { InlineKeyboardMarkup, TelegramApi } from './api.js';

/** The tool whose every result is a step on the owner's screen. */
export const BROWSER_ACT = 'browser.act';

/** The button under the photo, and the one thing it is for. */
export const TAKE_OVER_LABEL = 'Take over';

/**
 * The line that saves a tap on a dead link.
 *
 * With no public origin configured the only address this installation has is
 * loopback, which is meaningless on the phone reading the message. The link is
 * still sent — it is the right address *somewhere* — with the sentence that
 * says where.
 */
export const LOOPBACK_CAPTION = 'open this on the computer buddi runs on';

/** Titles are written by the page. Kept short, and never treated as prose. */
const MAX_TITLE = 120;
const MAX_REASON = 300;

/** The agent's verb, in the owner's words. */
const ACTIONS: Record<string, string> = {
  navigate: 'Opened',
  open: 'Opened',
  observe: 'Looked at the page',
  click: 'Clicked',
  fill: 'Filled in a field',
  select: 'Chose an option',
  press: 'Pressed a key',
  scroll: 'Scrolled',
  tab: 'Switched tab',
  close: 'Let go of the screen',
};

/** What the agent asked for, as far as it can be said without quoting a value. */
export interface StepCall {
  action?: string;
  /** Where it went, or which app it opened. Never a typed value. */
  where?: string;
  /** Which element it touched, by its visible name. Never a typed value. */
  target?: string;
}

/** The arguments of one `browser.act`, reduced to what a caption may say. */
export function stepCall(input: unknown): StepCall {
  if (input === null || typeof input !== 'object') return {};
  const value = input as Record<string, unknown>;
  const target = value['target'] as Record<string, unknown> | undefined;
  const name = target && typeof target['name'] === 'string' ? target['name'] : undefined;
  const ref = target && typeof target['ref'] === 'string' ? target['ref'] : undefined;
  let where: string | undefined;
  if (typeof value['url'] === 'string' && value['url'] !== '') {
    // The host, not the address: a caption is not the place for a one-time
    // token in a query string.
    try { where = new URL(value['url']).hostname; } catch { where = undefined; }
  } else if (typeof value['appId'] === 'string') where = value['appId'];
  return {
    ...(typeof value['action'] === 'string' ? { action: value['action'] } : {}),
    ...(where ? { where } : {}),
    ...(name ?? ref ? { target: (name ?? ref)!.slice(0, 80) } : {}),
  };
}

/** `Clicked “Sign in”`, `Opened example.com`, `Scrolled`. */
export function actionWords(call: StepCall): string {
  const verb = ACTIONS[call.action ?? ''] ?? 'Acted on the page';
  if (call.action === 'navigate' || call.action === 'open') {
    return call.where ? `${verb} ${call.where}` : verb;
  }
  return call.target ? `${verb} “${call.target}”` : verb;
}

/**
 * Whether this observation may be photographed and sent to Telegram.
 *
 * The same two lists the drivers enforce, read here from the status the
 * dashboard reads: the owner's allowed hosts, and — in computer mode, where a
 * screenshot is a picture of a whole application window — the owner's allowed
 * bundle IDs. Fails closed: an unparseable address, or a computer-mode
 * observation whose settings did not arrive, is not sent.
 */
export function screenshotAllowed(
  status: BrowserStatus,
  allowedHosts: readonly string[] = [],
): boolean {
  const page = status.page;
  if (!page || !status.hasScreenshot) return false;
  if (page.appId !== undefined) {
    return status.settings?.allowedApps?.includes(page.appId) === true;
  }
  if (allowedHosts.length === 0) return true;
  try {
    return allowedHosts.includes(new URL(page.url).hostname.toLowerCase());
  } catch { return false; }
}

/** The words under the picture. */
export function stepCaption(input: {
  title?: string;
  url?: string;
  call: StepCall;
  steps: number;
  maxSteps: number;
  error?: string;
  loopback: boolean;
}): string {
  const where = (input.title ?? '').trim() || input.url || 'The screen';
  return [
    where.slice(0, MAX_TITLE),
    actionWords(input.call),
    `Step ${input.steps} of ${input.maxSteps}`,
    input.error ? `It failed: ${input.error.slice(0, MAX_REASON)}` : '',
    input.loopback ? LOOPBACK_CAPTION : '',
  ].filter(Boolean).join('\n');
}

export function takeOverKeyboard(url: string): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: TAKE_OVER_LABEL, url }]] };
}

export interface BrowserPhotoDeps {
  api: Pick<TelegramApi, 'sendPhoto'>;
  browser: Pick<BrowserController, 'status' | 'screenshot'>;
  /** This conversation's Browser tab on the dashboard, and how to describe it. */
  link: (agentId: string, conversationId: string) => { url: string; loopback: boolean };
  /** `BUDDI_BROWSER_HOSTS`, already split. Empty means "no host list is set". */
  allowedHosts?: readonly string[];
  log?: (line: string) => void;
}

/**
 * One photo per step, per conversation.
 *
 * The only state it keeps is the page id it last sent for a conversation,
 * which is what makes an `observe` of a page the owner has already seen cost
 * nothing. Every failure is swallowed: a picture that cannot be sent must
 * never cost the owner their answer.
 */
export class BrowserPhotos {
  readonly #sent = new Map<string, string>();
  readonly #calls = new Map<string, StepCall>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BrowserPhotoDeps) {}

  /** What the agent asked for, remembered until its result comes back. */
  noteCall(conversationId: string, input: unknown): void {
    this.#calls.set(conversationId, stepCall(input));
  }

  /** The conversation ended: stop remembering what its screen looked like. */
  forget(conversationId: string): void {
    this.#sent.delete(conversationId);
    this.#calls.delete(conversationId);
  }

  /**
   * A `browser.act` has answered. Queued rather than awaited, so a run never
   * waits on Telegram, and serialized, so two steps cannot arrive out of order.
   */
  step(input: { chatId: string; agentId: string; conversationId: string; error?: string }): Promise<void> {
    const next = this.#tail.then(
      () => this.#send(input),
      () => this.#send(input),
    ).catch((err) => {
      this.deps.log?.(`telegram: browser photo failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.#tail = next;
    return next;
  }

  async #send(input: { chatId: string; agentId: string; conversationId: string; error?: string }): Promise<void> {
    const { agentId, conversationId } = input;
    const status = this.deps.browser.status({ agentId, conversationId });
    const session = status.session;
    // Somebody else's screen, or none: a photo is only ever this
    // conversation's own evidence.
    if (!session || session.agentId !== agentId || session.conversationId !== conversationId) return;
    const page = status.page;
    if (!page) return;
    // The same page as the last photo: an observe of what the owner has
    // already been shown is not a step worth a second picture.
    if (this.#sent.get(conversationId) === page.id) return;
    if (!screenshotAllowed(status, this.deps.allowedHosts)) {
      this.deps.log?.(`telegram: browser screenshot withheld (outside the owner's allow list)`);
      return;
    }
    const bytes = this.deps.browser.screenshot(session.id);
    if (!bytes) return;
    const link = this.deps.link(agentId, conversationId);
    // Recorded before the send, not after: a retry that duplicates the photo
    // is worse than a step the owner has to read about in words.
    this.#sent.set(conversationId, page.id);
    await this.deps.api.sendPhoto(input.chatId, bytes, {
      caption: stepCaption({
        ...(page.title ? { title: page.title } : {}),
        url: page.url,
        call: this.#calls.get(conversationId) ?? { ...(status.lastAction ? { action: status.lastAction } : {}) },
        steps: session.steps,
        maxSteps: session.maxSteps,
        ...(input.error ? { error: input.error } : {}),
        loopback: link.loopback,
      }),
      // The extension captures PNG through the debugger; the other two encode JPEG.
      ...(status.mode === 'extension'
        ? { contentType: 'image/png', filename: 'screen.png' }
        : { contentType: 'image/jpeg', filename: 'screen.jpg' }),
      replyMarkup: takeOverKeyboard(link.url),
    });
  }
}

/* ---- /browser, /browser stop|resume|release ---- */

/** The words the command understands. Anything else is answered with them. */
export type BrowserCommandWord = 'status' | 'stop' | 'resume' | 'release';

export const BROWSER_COMMAND_HELP =
  'Send /browser for where the screen stands, /browser stop to revoke access, /browser resume to give it back, or /browser release to end this conversation’s control.';

/** `/browser`, `/browser stop` — the word, or undefined when it is not ours. */
export function parseBrowserCommand(text: string): BrowserCommandWord | 'unknown' | undefined {
  const match = /^\/browser(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text.trim());
  if (!match) return undefined;
  const word = (match[1] ?? 'status').toLowerCase();
  return word === 'status' || word === 'stop' || word === 'resume' || word === 'release'
    ? word : 'unknown';
}

/** The state of the screen, in the sentences the dashboard's panel uses. */
export function browserStatusText(status: BrowserStatus): string {
  if (!status.enabled) {
    return 'The host browser is unavailable. Start buddi serve on a machine with a desktop session.';
  }
  const computer = status.mode === 'computer';
  const what = computer ? 'Computer control' : status.mode === 'extension' ? 'Your own Chrome' : 'Browser control';
  const lines = [`${what} — ${status.state}${status.busy ? ', working' : ''}.`];
  if (status.state === 'stopped') {
    lines.push('Access is stopped: no agent can drive the screen until you resume it. Send /browser resume.');
  }
  lines.push(status.session
    ? `${status.session.agentId} is driving, ${status.session.steps} of ${status.session.maxSteps} steps, on the task “${status.session.task.slice(0, 200)}”.`
    : computer
      ? 'No agent is driving. Ask an agent granted browser.* to open a website or an allowed native app.'
      : 'No agent is driving. Ask an agent granted browser.* to open a website.');
  if (status.page?.url) lines.push(`Last seen: ${status.page.url}`);
  if (status.message) lines.push(status.message);
  lines.push(BROWSER_COMMAND_HELP);
  return lines.join('\n');
}

/** What each control says once it has happened. The dashboard's own words. */
export function browserControlText(word: 'stop' | 'resume' | 'release', status: BrowserStatus): string {
  const computer = status.mode === 'computer';
  if (word === 'stop') {
    return `${computer
      ? 'Computer control stopped: native input is interrupted and access is revoked.'
      : 'All browsers stopped: every session is closed and access is revoked until you resume.'
    } Actions already submitted cannot be undone. Send /browser resume to give it back.`;
  }
  if (word === 'resume') {
    return `Access resumed. ${status.message ?? 'Ready. Send a new message to the agent to continue.'}`;
  }
  return computer
    ? 'Control released. This conversation no longer drives the screen; your apps are left open.'
    : 'Released. This conversation’s tabs are closed and it no longer drives the browser.';
}

/**
 * Run one `/browser …` word against the host controller.
 *
 * Exactly the dashboard's `/api/browser/{stop,resume,release}` path, with the
 * same controller and no take-over: driving by hand needs a canvas, which is
 * what the Take over button's link is for.
 */
export async function runBrowserCommand(
  browser: Pick<BrowserController, 'status' | 'control'>,
  word: BrowserCommandWord,
): Promise<string> {
  if (word === 'status') return browserStatusText(browser.status());
  try {
    return browserControlText(word, await browser.control(word));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

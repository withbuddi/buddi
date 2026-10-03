import { describe, expect, it } from 'vitest';
import { cardAnswer, chooseRoute, detectWall, ownerCard, routeNote, siteListed, siteOf, type RouteInput } from './routes.js';
import { STOP_CAUSES, summarize, telemetryLines, BrowserTelemetry } from './telemetry.js';

const all = { own: true, chrome: true, apps: true };
const base = (over: Partial<RouteInput> = {}): RouteInput => ({ command: { action: 'navigate' }, pins: {}, allowed: { ...all }, available: { ...all }, signInSite: false, ...over });

describe('chooseRoute', () => {
  it('own browser by default; Chrome for a sign-in site, the agent\'s ask, or a pin; apps only for app jobs', () => {
    expect(chooseRoute(base())).toEqual({ route: 'own', reason: 'default' });
    expect(chooseRoute(base({ signInSite: true }))).toEqual({ route: 'chrome', reason: 'sign-in' });
    expect(chooseRoute(base({ prefer: 'yours' }))).toEqual({ route: 'chrome', reason: 'prefer' });
    expect(chooseRoute(base({ pins: { global: 'chrome' } }))).toEqual({ route: 'chrome', reason: 'pin' });
    expect(chooseRoute(base({ command: { action: 'open' } }))).toEqual({ route: 'apps', reason: 'app' });
    expect(chooseRoute(base({ prefer: 'own', signInSite: true }))).toEqual({ route: 'own', reason: 'prefer' });
  });
  it('the most specific pin wins, and a pin cannot allow a forbidden route', () => {
    expect(chooseRoute(base({ pins: { conversation: 'own', agent: 'chrome', global: 'chrome' } }))).toMatchObject({ route: 'own' });
    expect(chooseRoute(base({ pins: { agent: 'chrome', global: 'own' } }))).toMatchObject({ route: 'chrome' });
    expect(chooseRoute(base({ pins: { conversation: 'auto', agent: 'chrome' } }))).toMatchObject({ route: 'chrome' });
    expect(chooseRoute(base({ pins: { conversation: 'chrome' }, allowed: { ...all, chrome: false } }))).toEqual({ route: 'own', reason: 'chrome-unavailable', fallbackFrom: 'chrome' });
    expect(chooseRoute(base({ pins: { conversation: 'apps' }, available: { ...all, apps: false } }))).toEqual({ route: 'own', reason: 'apps-unavailable', fallbackFrom: 'apps' });
  });
  it('an app job with no apps route has no fallback; an unattended run is own-browser only', () => {
    expect(chooseRoute(base({ command: { action: 'open' }, allowed: { ...all, apps: false } }))).toEqual({ route: undefined, reason: 'apps-unavailable' });
    expect(chooseRoute(base({ unattended: true, signInSite: true }))).toEqual({ route: 'own', reason: 'unattended' });
    expect(chooseRoute(base({ unattended: true, command: { action: 'open' } }))).toMatchObject({ route: undefined });
  });
});

describe('sites, notes and walls', () => {
  it('reads a site without www., matches parents, and says the note only off the default', () => {
    expect(siteOf('https://www.amazon.com/cart')).toBe('amazon.com');
    expect(siteListed('smile.amazon.com', ['amazon.com'])).toBe(true);
    expect(siteListed('notamazon.com', ['amazon.com'])).toBe(false);
    expect(routeNote('chrome', 'sign-in', 'amazon.com')).toBe('I used your Chrome for amazon.com (sign-in).');
    expect(routeNote('own', 'default', 'amazon.com')).toBeUndefined();
  });
  it('detects a login wall, a code and a captcha, and not a login box on an ordinary page', () => {
    expect(detectWall({ url: 'https://www.amazon.com/ap/signin', title: 'Amazon Sign-In', tree: '- textbox "Email"', targets: [{ ref: 'e1', frame: 0, role: 'textbox', name: 'Email' }] })).toBe('sign-in');
    expect(detectWall({ url: 'https://bank.test/login', title: 'Log in', tree: '- textbox "Password"', targets: [{ ref: 'e1', frame: 0, role: 'textbox', name: 'Password' }] })).toBe('sign-in');
    expect(detectWall({ url: 'https://bank.test/login', title: 'Verify', tree: 'Enter the code we sent', targets: [{ ref: 'e1', frame: 0, role: 'textbox', name: 'Verification code' }] })).toBe('code');
    expect(detectWall({ url: 'https://shop.test/', title: 'Shop', tree: '- iframe "reCAPTCHA"' })).toBe('human');
    expect(detectWall({ url: 'https://news.test/', title: 'News', tree: '- textbox "Password"\n- button "Log in"' })).toBeUndefined();
  });
});

describe('the cards and their answers', () => {
  it('each moment is one card with its own labels, and a tap or a typed answer is read back', () => {
    const look = ownerCard('uncertain');
    expect(cardAnswer(look, 'Look')).toBe('takeover');
    expect(cardAnswer(look, 'carry on.')).toBe('continue');
    expect(cardAnswer(look, 'what happened?')).toBeUndefined();
    expect(cardAnswer(ownerCard('budget'), 'Keep going')).toBe('continue');
    expect(cardAnswer(ownerCard('sign-in', { chrome: 'usable' }), 'Use my Chrome')).toBe('chrome');
    expect(cardAnswer(ownerCard('human'), 'Take over')).toBe('takeover');
    expect(cardAnswer(ownerCard('stopped', { stoppedAgo: '2 days ago' }), 'Resume')).toBe('resume');
    expect(ownerCard('stopped', { stoppedAgo: '2 days ago' }).question).toBe('Browsing is stopped (by you, 2 days ago). Resume?');
    for (const kind of ['uncertain', 'budget', 'sign-in', 'code', 'human', 'stopped'] as const) {
      for (const option of ownerCard(kind, { chrome: 'offline' }).options) expect(option.label.length).toBeLessThanOrEqual(48);
    }
  });
});

describe('the stop causes', () => {
  it('count the spec\'s paths: 10 removed, 6 retried, 4 cards', () => {
    const by = (outcome: string, ids: string[]) => ids.every((id) => (STOP_CAUSES as Record<string, { outcome: string }>)[id]?.outcome === outcome);
    expect(by('removed', ['start-with-navigate', 'slot-limit', 'mode-lock', 'controls-changing', 'access-changed-opening', 'request-ended', 'never-switch-modes', 'status-first', 'owner-watching', 'route-unavailable'])).toBe(true);
    expect(by('retry', ['page-not-answered', 'observation-failures', 'stale-ref', 'redirect', 'stale-observation', 'not-connected'])).toBe(true);
    expect(by('card', ['uncertain-input', 'budget', 'sign-in', 'human-check'])).toBe(true);
  });
  it('summarizes a week for buddi doctor browser', () => {
    const telemetry = new BrowserTelemetry(undefined, () => Date.parse('2026-10-03T12:00:00Z'));
    telemetry.record({ type: 'browser.route', chosen: 'own', reason: 'default' });
    telemetry.record({ type: 'browser.route', chosen: 'chrome', reason: 'sign-in' });
    telemetry.stop('page-not-answered', { route: 'own' });
    telemetry.stop('sign-in', { route: 'own' });
    const summary = summarize(telemetry.events, Date.parse('2026-10-03T12:00:00Z'));
    expect(summary).toMatchObject({ tasks: 2, stops: 2, cards: 1, stopsPerTask: 1, routes: { own: 1, chrome: 1 } });
    expect(telemetryLines(summary)[0]).toBe('Browser, last 7 days: 2 tasks, 2 stops (1 per task), 1 card.');
  });
});

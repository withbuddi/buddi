import { describe, expect, it } from 'vitest';
import { cardAnswer, chooseRoute, detectSignedOut, detectWall, ownerCard, signInFields, routeNote, siteListed, siteName, siteOf, type RouteInput } from './routes.js';
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
    expect(routeNote('chrome', 'sign-in', 'amazon.com')).toBe('I used your Chrome because Amazon needs your sign-in.');
    expect(siteName('smile.amazon.co.uk')).toBe('Amazon');
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
    expect(ownerCard('stopped', { since: '10:12', until: '11:12', site: 'amazon.com' }).question).toBe('Browsing is paused since 10:12\nYou paused agents\u2019 browsing from the Canvas, until 11:12. I need one page: amazon.com.');
    expect(ownerCard('sign-in', { site: 'amazon.com', chrome: 'usable' })).toMatchObject({ title: 'Amazon needs your sign-in', line: 'Sign in on the page and give it back, and I carry on. Or let me use your Chrome, where you\u2019re signed in.' });
    // A tap on a label an older card carried still answers it.
    expect(cardAnswer(ownerCard('human'), 'Skip it')).toBe('decline');
    expect(cardAnswer(ownerCard('stopped'), 'Leave it stopped')).toBe('decline');
    for (const kind of ['uncertain', 'budget', 'sign-in', 'code', 'human', 'stopped'] as const) expect(ownerCard(kind, { site: 'www.some-long-shop-name.example.co.uk', chrome: 'offline', since: '10:12', until: '11:12' }).question.length).toBeLessThanOrEqual(300);
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

/* Pages as the observation reads them (title, tree, targets), from the real sites. */
const AMAZON_CART_SIGNED_OUT = {
  url: 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart', title: 'Amazon.com Shopping Cart',
  tree: '- link "Amazon"\n- link "Hello, sign in Account & Lists"\n- link "Returns & Orders"\n- link "0 items in cart"\n- heading "Your Amazon Cart is empty"\n- link "Shop today\'s deals"\n- button "Sign in to your account"\n- button "Sign up now"',
  targets: [
    { ref: 'e1', frame: 0, role: 'link', name: 'Hello, sign in Account & Lists' },
    { ref: 'e2', frame: 0, role: 'link', name: 'Returns & Orders' },
    { ref: 'e3', frame: 0, role: 'button', name: 'Sign in to your account' },
    { ref: 'e4', frame: 0, role: 'button', name: 'Sign up now' },
  ],
};
const AMAZON_HOME = {
  url: 'https://www.amazon.com/', title: 'Amazon.com. Spend less. Smile more.',
  tree: '- link "Hello, sign in Account & Lists"\n- searchbox "Search Amazon"\n- heading "Today\'s deals"',
  targets: [{ ref: 'e1', frame: 0, role: 'link', name: 'Hello, sign in Account & Lists' }, { ref: 'e2', frame: 0, role: 'searchbox', name: 'Search Amazon' }],
};
const HN_FRONT = {
  url: 'https://news.ycombinator.com/', title: 'Hacker News',
  tree: '- link "Hacker News"\n- link "new"\n- link "past"\n- link "login"\n- link "Show HN: A tiny database"\n- link "48 comments"',
  targets: [{ ref: 'e1', frame: 0, role: 'link', name: 'new' }, { ref: 'e2', frame: 0, role: 'link', name: 'login' }, { ref: 'e3', frame: 0, role: 'link', name: 'Show HN: A tiny database' }],
};
const NEWS_HOME = {
  url: 'https://www.nytimes.com/', title: 'The New York Times - Breaking News',
  tree: '- button "Sections"\n- link "Log in"\n- button "Subscribe"\n- heading "Top stories"',
  targets: [{ ref: 'e1', frame: 0, role: 'link', name: 'Log in' }, { ref: 'e2', frame: 0, role: 'button', name: 'Subscribe' }],
};
const GMAIL_LOGIN = {
  url: 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&service=mail', title: 'Gmail',
  tree: '- heading "Sign in"\n- text "to continue to Gmail"\n- textbox "Email or phone"\n- button "Forgot email?"\n- button "Next"',
  targets: [{ ref: 'e1', frame: 0, role: 'textbox', name: 'Email or phone' }, { ref: 'e2', frame: 0, role: 'button', name: 'Next' }],
};

describe('a page that renders signed out', () => {
  it('is a sign-in when a prominent Sign in meets an account page, ask or listed site', () => {
    expect(detectWall(AMAZON_CART_SIGNED_OUT)).toBeUndefined();
    expect(detectSignedOut(AMAZON_CART_SIGNED_OUT)).toBe(true);
    // The same page under an address that says nothing: the owner's ask, or the sign-in list, says it.
    const anywhere = { ...AMAZON_CART_SIGNED_OUT, url: 'https://www.amazon.com/gp/aw/c' };
    expect(detectSignedOut(anywhere)).toBe(false);
    expect(detectSignedOut(anywhere, { task: "What's in my Amazon cart?" })).toBe(true);
    expect(detectSignedOut(anywhere, { signInSite: true })).toBe(true);
  });
  it('leaves front pages with a Sign in link in the header alone', () => {
    expect(detectSignedOut(HN_FRONT)).toBe(false);
    expect(detectSignedOut(HN_FRONT, { task: "What's on Hacker News today?" })).toBe(false);
    expect(detectSignedOut(NEWS_HOME, { task: 'Read me the headlines' })).toBe(false);
    // A link that only says Sign in is not prominent, even on a site the owner signs in to.
    expect(detectSignedOut(AMAZON_HOME, { task: 'Find a kettle under $40', signInSite: true })).toBe(false);
  });
  it('a full login page stays the login wall it was', () => {
    expect(detectWall(GMAIL_LOGIN)).toBe('sign-in');
    expect(detectWall(HN_FRONT)).toBeUndefined();
  });
  it('says why the owner\'s Chrome could not serve, in one line', () => {
    expect(routeNote('own', 'chrome-unavailable', 'amazon.com', undefined, 'unpaired')).toBe("Your Chrome isn't connected to this buddi, so I looked in my own browser.");
    expect(routeNote('own', 'chrome-unavailable', 'amazon.com', undefined, 'closed')).toBe("Your Chrome isn't open right now, so I looked in my own browser.");
    expect(routeNote('own', 'chrome-unavailable', 'amazon.com', undefined, 'off')).toBe('Your Chrome is turned off for agents in Settings, so I looked in my own browser.');
  });
});

describe('signInFields', () => {
  it('reads the username and password boxes a login page shows, with their refs, in the card\'s words', () => {
    const targets = [
      { ref: 'e1', frame: 0, role: 'searchbox', name: 'Search Wikipedia' },
      { ref: 'e3', frame: 0, role: 'textbox', name: 'Enter your username' },
      { ref: 'e4', frame: 0, role: 'textbox', name: 'Enter your password' },
      { ref: 'e5', frame: 0, role: 'button', name: 'Log in' },
    ];
    expect(signInFields({ targets }, 'sign-in')).toEqual([
      { label: 'Username', kind: 'username', ref: 'e3', name: 'Enter your username' },
      { label: 'Password', kind: 'password', ref: 'e4', name: 'Enter your password' },
    ]);
    expect(signInFields({ targets: [{ ref: 'e2', frame: 0, role: 'textbox', name: 'Email address' }] }, 'sign-in')).toEqual([
      { label: 'Email', kind: 'username', ref: 'e2', name: 'Email address' },
      { label: 'Password', kind: 'password' },
    ]);
  });

  it('on a page shaped like Wikipedia\'s (the sidebar\'s radios first), takes only the text boxes', () => {
    const targets = [
      { ref: 'e3', frame: 0, role: 'radio', name: 'Standard' },
      { ref: 'e4', frame: 0, role: 'radio', name: 'Wide' },
      { ref: 'e5', frame: 0, role: 'checkbox', name: 'Keep me logged in (for up to one year)' },
      { ref: 'e8', frame: 0, role: 'textbox', name: 'Username' },
      { ref: 'e9', frame: 0, role: 'textbox', name: 'Password' },
    ];
    expect(signInFields({ targets }, 'sign-in')).toEqual([
      { label: 'Username', kind: 'username', ref: 'e8', name: 'Username' },
      { label: 'Password', kind: 'password', ref: 'e9', name: 'Password' },
    ]);
  });

  it('passes no ref it is not sure of: two password boxes, or no box naming a user', () => {
    const fields = signInFields({ targets: [
      { ref: 'e1', frame: 0, role: 'textbox', name: 'Choose a password' },
      { ref: 'e2', frame: 0, role: 'textbox', name: 'Confirm password' },
      { ref: 'e3', frame: 0, role: 'textbox', name: 'Nickname' },
    ] }, 'sign-in');
    expect(fields.every((field) => field.ref === undefined)).toBe(true);
  });

  it('asks for a username and a password on a page with no boxes yet, and on a code page fills nothing by itself', () => {
    expect(signInFields({ targets: [] }, 'sign-in')).toEqual([{ label: 'Username', kind: 'username' }, { label: 'Password', kind: 'password' }]);
    expect(signInFields({ targets: [{ ref: 'e9', frame: 0, role: 'textbox', name: 'Verification code' }] }, 'code').every((field) => field.ref === undefined)).toBe(true);
  });
});

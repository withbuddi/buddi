/**
 * The tips, as data (docs/dashboard.md, Home).
 *
 * One entry per tip. Adding a tip is adding an entry here and a case to
 * `RULE_CASES` in `rules.test.ts`, which fails for a rule without one. Each is
 * one sentence in buddi's voice and one action; the engine (`engine.ts`)
 * decides which, if any, Home shows today.
 */
import type { Facts } from './facts.js';

export interface TipAction {
  label: string;
  /** A dashboard hash, `#/…`. */
  route: string;
}

export interface TipRule {
  id: string;
  /** Whether the tip applies now. */
  when: (facts: Facts) => boolean;
  /** How many days `when` must have held before the tip may show. */
  holdsForDays: number;
  /** One sentence; a function when it names something from the facts (a plugin). */
  text: string | ((facts: Facts) => string);
  action: TipAction | ((facts: Facts) => TipAction);
  /** Days before a tip shown, or put off with ×, may show again. */
  cooldownDays: number;
  /**
   * The plugin the tip is about. A tip about a plugin that is not installed
   * never shows, unless `installs` says its action is the way to install it.
   */
  plugin?: string;
  installs?: boolean;
}

/** The plugins the market's Recommended shelf offers; the tip is quiet once any is here. */
export const RECOMMENDED_PLUGINS = ['finance', 'image', 'speech', 'weather', 'calendar'] as const;

/** The Computer plugin's market link: its install card, the same two yeses as any install. */
export const COMPUTER_PLUGIN_ROUTE = '#/settings/plugins?install=@withbuddi/plugin-computer';

export const TIPS: readonly TipRule[] = [
  {
    // Computer control left core for a plugin (pre.38): an owner who used his
    // apps is told once, before anything else, how to keep them. × or the
    // install ends it; installing the plugin makes it false anyway.
    id: 'computer-plugin',
    when: (f) => f.appsWithoutPlugin,
    holdsForDays: 0,
    text: 'Computer control is now a plugin — install it to keep using your apps.',
    action: { label: 'Install the Computer plugin', route: COMPUTER_PLUGIN_ROUTE },
    cooldownDays: 36_500,
    plugin: 'computer',
    installs: true,
  },
  {
    // The upgrade path for a zero-key first run: first in the list, so it is
    // the tip Home shows while it holds, and it comes back until it is acted on.
    id: 'local-brain',
    when: (f) => f.localBrain,
    holdsForDays: 0,
    text: 'Your assistant thinks with a small model on this computer: private, but slower and weaker at long plans. A cloud brain would answer better.',
    action: { label: 'Add a stronger brain', route: '#/settings/accounts' },
    cooldownDays: 5,
  },
  {
    id: 'second-agent',
    when: (f) => f.agents < 2 && f.daysSinceInstall >= 3,
    holdsForDays: 1,
    text: 'I am doing everything on my own so far. A teammate can take one whole job, your research or your day, off my desk.',
    action: { label: 'Add a teammate', route: '#/agents' },
    cooldownDays: 7,
  },
  {
    id: 'make-group',
    when: (f) => f.agents >= 3 && f.groups === 0,
    holdsForDays: 1,
    text: 'You have three agents now. Put them in a group and they work one question together, each on the part they know.',
    action: { label: 'Make a group', route: '#/chat?group=new' },
    cooldownDays: 7,
  },
  {
    id: 'mail-triage',
    when: (f) => f.mailboxSet && !f.mailAgent,
    holdsForDays: 1,
    text: 'Your mailbox is connected, but nobody reads it yet. Mail Triage would, and bring you only what needs you.',
    action: { label: 'Meet Mail Triage', route: '#/settings/p.email.settings' },
    cooldownDays: 7,
    plugin: 'email',
  },
  {
    id: 'voice-note',
    when: (f) => f.speechInstalled && !f.voiceUsed,
    holdsForDays: 1,
    text: 'You can talk to me instead of typing. Press the microphone in any chat and just say it.',
    action: { label: 'Send a voice note', route: '#/chat' },
    cooldownDays: 7,
    plugin: 'speech',
  },
  {
    id: 'morning-brief',
    when: (f) => f.missions === 0 && f.daysSinceInstall >= 7 && f.agentIds.has('planner'),
    holdsForDays: 1,
    text: 'Nothing runs on its own yet. Planner can have your day waiting for you every morning.',
    action: { label: 'Ask Planner for a morning brief', route: '#/chat/planner' },
    cooldownDays: 7,
  },
  {
    id: 'open-website',
    when: (f) => !f.browserUsed && f.daysSinceInstall >= 2,
    holdsForDays: 1,
    text: 'I can open a website, read it and tell you what matters. Try it with one you check every day.',
    action: { label: 'Ask buddi to open a website', route: '#/chat' },
    cooldownDays: 7,
    plugin: 'browser',
  },
  {
    id: 'plugin-setup',
    when: (f) => f.needsSetup.length > 0,
    holdsForDays: 1,
    text: (f) => {
      const first = f.needsSetup[0];
      if (!first) return 'A plugin you installed cannot do anything yet. Its row on the Plugins page says what it needs.';
      return `The ${first.plugin} plugin is installed, but it cannot do anything yet. ${first.note ?? 'It needs setting up first.'}`;
    },
    action: (f) => {
      const first = f.needsSetup[0];
      return first?.route ? { label: `Set up ${first.plugin}`, route: first.route } : { label: 'See what it needs', route: '#/settings/plugins' };
    },
    cooldownDays: 3,
  },
  {
    // Once there is something worth locking: a second device signed in, a
    // mailbox or money connected, or a week of use. × silences it for good.
    id: 'lock-pin',
    when: (f) => !f.pinSet && (f.secondDevice || f.mailboxSet || f.financeConnected || f.daysSinceInstall >= 7),
    holdsForDays: 0,
    text: 'Anyone at a screen you signed in on can open me, your mail and money included. A PIN locks me when you step away.',
    action: { label: 'Lock buddi with a PIN', route: '#/settings/lock' },
    cooldownDays: 36_500,
  },
  {
    id: 'recommended-plugins',
    when: (f) => f.daysSinceInstall >= 0 && !RECOMMENDED_PLUGINS.some((name) => f.plugins.has(name)),
    holdsForDays: 0,
    text: 'I can do more with a plugin or two: weather and your calendar for the morning, your money, a voice. Each one is read before it is installed.',
    action: { label: 'Browse plugins', route: '#/settings/plugins?tab=browse' },
    cooldownDays: 14,
  },
];

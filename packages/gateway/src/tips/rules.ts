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
  text: string;
  action: TipAction;
  /** Days before a tip shown, or put off with ×, may show again. */
  cooldownDays: number;
  /**
   * The plugin the tip is about. A tip about a plugin that is not installed
   * never shows, unless `installs` says its action is the way to install it.
   */
  plugin?: string;
  installs?: boolean;
}

export const TIPS: readonly TipRule[] = [
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
];

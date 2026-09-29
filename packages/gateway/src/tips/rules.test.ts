/**
 * Every tip has copy, an action, and a case that makes it fire and one that
 * keeps it quiet. A rule added to `TIPS` without an entry in `RULE_CASES`
 * fails here, so a tip cannot ship untested.
 */
import { describe, expect, it } from 'vitest';
import type { Facts } from './facts.js';
import { TIPS } from './rules.js';
import { facts } from '../__fixtures__/tip-facts.js';

const RULE_CASES: Record<string, { fires: Partial<Facts>; quiet: Partial<Facts> }> = {
  'second-agent': {
    fires: { agents: 1, agentIds: new Set(['concierge']), daysSinceInstall: 3 },
    quiet: { agents: 1, agentIds: new Set(['concierge']), daysSinceInstall: 2 },
  },
  'make-group': {
    fires: { agents: 3, groups: 0 },
    quiet: { agents: 3, groups: 1 },
  },
  'mail-triage': {
    fires: { mailboxSet: true, mailAgent: false },
    quiet: { mailboxSet: true, mailAgent: true },
  },
  'voice-note': {
    fires: { speechInstalled: true, voiceUsed: false },
    quiet: { speechInstalled: false, voiceUsed: false },
  },
  'morning-brief': {
    fires: { missions: 0, daysSinceInstall: 7 },
    quiet: { missions: 0, daysSinceInstall: 6 },
  },
  'recommended-plugins': {
    fires: { plugins: new Set(['browser', 'email']), speechInstalled: false },
    quiet: { plugins: new Set(['browser', 'email', 'weather']) },
  },
  'open-website': {
    fires: { browserUsed: false, toolsUsed: new Set() },
    quiet: { browserUsed: true },
  },
};

describe('TIPS', () => {
  it('has a case for every rule, and no case for a rule that is gone', () => {
    const ids = TIPS.map((rule) => rule.id);
    expect(ids.filter((id) => !(id in RULE_CASES))).toEqual([]);
    expect(Object.keys(RULE_CASES).filter((id) => !ids.includes(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is quiet on a settled installation', () => {
    expect(TIPS.filter((rule) => rule.when(facts())).map((rule) => rule.id)).toEqual([]);
  });

  for (const rule of TIPS) {
    describe(rule.id, () => {
      const cases = RULE_CASES[rule.id];
      it('has one sentence or two of copy and one action', () => {
        expect(rule.text.trim()).toMatch(/^[A-Z].*[.!?]$/);
        expect(rule.text.length).toBeLessThanOrEqual(140);
        expect(rule.action.label.trim()).not.toBe('');
        expect(rule.action.route).toMatch(/^#\//);
        expect(rule.holdsForDays).toBeGreaterThanOrEqual(0);
        expect(rule.cooldownDays).toBeGreaterThan(0);
      });
      it('fires', () => {
        expect(cases, `RULE_CASES has no case for "${rule.id}"`).toBeDefined();
        expect(rule.when(facts(cases!.fires))).toBe(true);
      });
      it('stays quiet', () => {
        expect(cases, `RULE_CASES has no case for "${rule.id}"`).toBeDefined();
        expect(rule.when(facts(cases!.quiet))).toBe(false);
      });
    });
  }
});

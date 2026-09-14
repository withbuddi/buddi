/**
 * The sentinel contract — core's, re-exported so this plugin's modules import
 * it from one place.
 *
 * A sentinel is the deterministic half of an unattended watch: pure SQL and
 * TypeScript, no model, no clock of its own. It answers one question — "is
 * something true right now that the owner would want to know about?" — and
 * returns findings. Waking an agent, deduplicating a finding and deciding
 * whether the owner is disturbed are all core's job; a sentinel never speaks.
 *
 * `key` is the identity of a finding, not a description of it: the same
 * condition on the same day must produce the same key so a watch that runs
 * every six hours does not report the same breach four times. That is why
 * every key below carries the date the condition is anchored to.
 */
export type { Finding, Sentinel, SentinelContext, Severity } from '@buddi/core';

/** Readable names for the cadences the finance sentinels use. */
export const EVERY_6H = 6 * 60 * 60;
export const EVERY_12H = 12 * 60 * 60;
export const DAILY = 24 * 60 * 60;

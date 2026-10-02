/**
 * Which schedules buddi itself made without naming a zone — the provenance
 * `settleScheduleZones` needs to let a schedule from before
 * `timezone_explicit` follow the owner. Nothing in the rows records who made
 * a schedule, so the proof is the declaration: the mission id (and cron) a
 * plugin's default suggestion without a timezone, the learning digest, the
 * first-run arc, or a starter's or plugin agent's declared mission would have
 * written. A schedule that matches none — schedule.propose, the dashboard, an
 * agent naming a zone, a mission whose suggestion names one — stays explicit.
 */
import type { OwnerFollowingDeclaration, PluginManifest } from '@buddi/core';
import { LEARNING_DIGEST_ID } from '../agents/learning-digest.js';
import { starterMission, starterProposals } from '../agents/starter-team.js';
import { GETTING_STARTED_CRON, GETTING_STARTED_ID } from './getting-started.js';
import { agentMissionId, slugify } from './reminders.js';

export function ownerFollowingDeclarations(
  manifests: readonly PluginManifest[],
  agentIds: readonly string[],
): OwnerFollowingDeclaration[] {
  const out: OwnerFollowingDeclaration[] = [
    { missionId: LEARNING_DIGEST_ID, cron: null },
    { missionId: GETTING_STARTED_ID, cron: GETTING_STARTED_CRON },
  ];
  for (const m of manifests) {
    for (const mission of m.missions ?? []) {
      if (!mission.timezone) out.push({ missionId: mission.id, cron: mission.cron });
    }
  }
  // An accepted agent's missions run in the owner's zone of the moment (no
  // proposal names one), under `agent:<agent id>:<slug>`.
  const proposals = [
    ...manifests.flatMap((m) => (m.agents ?? []).map((agent) => ({ plugin: m.name, agent }))),
    ...starterProposals().map((p) => ({ plugin: p.plugin, agent: p.agent })),
  ];
  const slugs: Array<{ slug: string; cron: string }> = [];
  for (const { plugin, agent } of proposals) {
    const starter = starterMission(plugin, agent.id);
    if (starter) slugs.push({ slug: slugify(starter.name), cron: starter.cron });
    for (const mission of agent.missions ?? []) slugs.push({ slug: mission.id.trim(), cron: mission.cron });
  }
  for (const agentId of agentIds) {
    for (const { slug, cron } of slugs) out.push({ missionId: agentMissionId(agentId, slug), cron });
  }
  return out;
}

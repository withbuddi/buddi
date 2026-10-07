import type { CoreToolContext, Mission, ToolRegistry } from '@buddi/core';

/** The owner selected narration for this edition, not unrestricted Speech for the agent. */
export async function editionVoiceConsent(
  registry: Pick<ToolRegistry, 'callExportAsCore'>,
  mission: Pick<Mission, 'context'>,
  ctx: CoreToolContext,
  tool: string,
): Promise<boolean> {
  const source = mission.context;
  if (tool !== 'speech.say' || source?.plugin !== 'news' || source.export !== 'edition_material') return false;
  const edition = source.args?.['edition'];
  if (edition !== 'morning' && edition !== 'midday' && edition !== 'evening') return false;
  try {
    // Re-read the setting at each call; a model's supplied material is never consent.
    const result = await registry.callExportAsCore('news', 'edition_voice', { edition }, ctx);
    return result !== null && typeof result === 'object' && (result as { enabled?: unknown }).enabled === true;
  } catch {
    // Older or unavailable News keeps Speech's normal approval rule.
    return false;
  }
}

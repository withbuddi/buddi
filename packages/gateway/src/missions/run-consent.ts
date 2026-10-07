/**
 * A mission run's context plugin vouching for a tool in that run (host API
 * 1.33). The mission's `context` names the plugin the run was started from;
 * that plugin, and no other, is asked through its `consent_for_run` export
 * whether `tool` may run on the owner's standing settings, each time the
 * tool's own plugin asks (`ctx.buddi.approvals.configuredForRun`). Core names
 * no tool and no plugin here: what is vouched for is the plugin's decision,
 * and whether to honour it is the tool's plugin's.
 */
import { RUN_CONSENT_EXPORT, type CoreToolContext, type Mission, type RunConsentRequest, type ToolRegistry } from '@buddi/core';

const TOOL = /^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_]{0,63}$/;

export async function runConsent(
  registry: Pick<ToolRegistry, 'callExportAsCore'>,
  mission: Pick<Mission, 'context'>,
  ctx: CoreToolContext,
  tool: string,
): Promise<boolean> {
  const context = mission.context;
  if (!context || !TOOL.test(tool)) return false;
  const request: RunConsentRequest = { tool, export: context.export, args: context.args ?? {} };
  try {
    // Asked at each call, so a setting the owner turned off since the run began counts.
    return (await registry.callExportAsCore(context.plugin, RUN_CONSENT_EXPORT, request, ctx)) === true;
  } catch {
    // No such export, a refusal, a timeout: the tool's normal approval rule stands.
    return false;
  }
}

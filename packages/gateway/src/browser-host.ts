/**
 * The browser plugin's one controller, as the composition root builds it.
 *
 * The plugin imports only `@buddi/core/plugin`, so what it cannot reach there
 * is handed in: its `dir` area (the same one `ctx.buddi.dir` is) and core's
 * address guard for Playwright mode's proxy. Every caller in the gateway goes
 * through here, so the first one to build the controller builds it whole.
 */
import { guardedLookup, pluginDir } from '@buddi/core';
import { hostBrowser, type ExtensionBridge, type HostController } from '@buddi/tool-browser';

export function browserHost(
  env: NodeJS.ProcessEnv = process.env,
  options: { extensionBridge?: () => ExtensionBridge } = {},
): HostController {
  return hostBrowser(pluginDir('browser', env), env, {
    ...options,
    lookup: (policy) => guardedLookup(undefined, policy),
  });
}

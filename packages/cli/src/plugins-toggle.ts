/**
 * `buddi plugins disable|enable` through the running gateway, so the change
 * takes effect there at once (its tools, pages and watchers stop or start)
 * rather than at its next restart. Nothing answering means nothing is
 * running, and the next start reads the record the CLI writes itself.
 */
import type { ToggleInGateway } from '@buddi/gateway';
import { gatewayFromEnvironment, GatewayError, GatewayUnavailable } from './mcp/gateway-client.js';

export function toggleInGateway(env: NodeJS.ProcessEnv = process.env): ToggleInGateway {
  return async (name, enabled) => {
    const gateway = gatewayFromEnvironment(env);
    if ('off' in gateway) return { unreachable: gateway.off };
    try {
      const { body } = await gateway.post<{ notes?: string[] }>(
        `/api/plugins/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`,
        {},
      );
      return { notes: Array.isArray(body?.notes) ? body.notes : [enabled ? 'Enabled.' : 'Disabled.'] };
    } catch (err) {
      if (err instanceof GatewayUnavailable) return { notRunning: true };
      if (err instanceof GatewayError && err.status === 409) return { refused: err.message };
      return { unreachable: err instanceof Error ? err.message : String(err) };
    }
  };
}

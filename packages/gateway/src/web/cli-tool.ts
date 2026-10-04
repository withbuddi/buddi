/**
 * Settings → System's "Install Command Line Tool": buddi.app's `buddi` on PATH.
 *
 * The supervisor does it (packages/install/src/cli-shim.ts), with the same
 * code the app's menu item runs; this forwards. Outside buddi.app (npm, a
 * checkout) the command is already on PATH and the row says so.
 */
import { supervisorSocket, type RouteReply } from './backups.js';
import { supervisorCall } from './service.js';

export const CLI_ELSEWHERE = 'This buddi did not come from buddi.app, and its buddi command is already on your PATH.';

export async function cliToolRoute(env: NodeJS.ProcessEnv, method: 'GET' | 'POST'): Promise<RouteReply> {
  const socket = supervisorSocket(env);
  if (!socket) {
    return method === 'GET'
      ? { status: 200, body: { available: false, installed: [], reason: CLI_ELSEWHERE } }
      : { status: 409, body: { error: CLI_ELSEWHERE } };
  }
  try {
    // The administrator prompt waits for the owner: give it two minutes and more.
    const reply = await supervisorCall(socket, '/cli', method, method === 'POST' ? {} : undefined, method === 'POST' ? 150_000 : 10_000);
    return { status: reply.status, body: reply.body };
  } catch {
    return { status: 503, body: { error: 'The supervisor is not answering on its control socket. Run buddi in a terminal.' } };
  }
}

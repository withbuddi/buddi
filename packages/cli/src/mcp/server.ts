/**
 * `buddi mcp`: buddi as an MCP server over stdio (docs/specs/mcp.md).
 *
 * The client launches this process; it reaches the running gateway on
 * loopback (`gateway-client.ts`) and publishes the tools in `tools.ts`. Every
 * result passes through `redact` on its way out, and every write waits for the
 * owner. stdout belongs to the protocol: nothing else may write to it.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GatewayError, GatewayUnavailable, gatewayFromEnvironment, type Gateway } from './gateway-client.js';
import { knownSecrets, redact, redactText } from './secrets.js';
import { DECISION_WAIT_MS, POLL_MS, TOOLS, ToolRefusal, type ToolRuntime } from './tools.js';

export const MCP_SERVER_NAME = 'buddi';
export const MCP_SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  "This is the owner's buddi, a personal agent platform running on this Mac.",
  'Reads (buddi.overview, buddi.agents_list, buddi.tools_list, …) answer at once.',
  'Every write (buddi.agent_update, buddi.agent_engine, buddi.default_agent, buddi.page_act, buddi.proposal_decide, buddi.memory_edit) becomes an approval card the owner decides on the dashboard or Telegram; the call waits up to ten minutes and then returns { pending: <action id> }.',
  'To create an agent, buddi.ask the maker agent (Agent Father); its own approvals apply.',
].join(' ');

export interface McpServerOptions {
  /** The gateway, or why there is none (the dashboard is turned off). */
  gateway: Gateway | { off: string };
  /** Secret values to cut by value from every result. */
  secrets?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
}

function text(value: unknown, secrets: readonly string[], isError = false): CallToolResult {
  const body = typeof value === 'string' ? redactText(value, secrets) : JSON.stringify(redact(value, secrets), null, 2);
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

export function createMcpServer(opts: McpServerOptions): Server {
  const secrets = opts.secrets ?? [];
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object'; properties?: Record<string, object> },
      annotations: t.write ? { readOnlyHint: false, destructiveHint: false } : { readOnlyHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return text(`There is no tool ${req.params.name} here.`, secrets, true);
    if ('off' in opts.gateway) return text(opts.gateway.off, secrets, true);

    const token = req.params._meta?.progressToken;
    let step = 0;
    const runtime: ToolRuntime = {
      gateway: opts.gateway,
      client: () => server.getClientVersion()?.name?.trim() || 'unknown client',
      progress: async (message) => {
        if (token === undefined) return;
        step += 1;
        await extra
          .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: step, message: redactText(message, secrets) } })
          .catch(() => undefined);
      },
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      waitMs: opts.waitMs ?? DECISION_WAIT_MS,
      pollMs: opts.pollMs ?? POLL_MS,
      signal: extra.signal,
    };
    try {
      return text(await tool.run((req.params.arguments ?? {}) as Record<string, unknown>, runtime), secrets);
    } catch (err) {
      if (err instanceof GatewayUnavailable || err instanceof ToolRefusal) return text(err.message, secrets, true);
      if (err instanceof GatewayError) return text(err.message, secrets, true);
      return text(`buddi could not do that: ${err instanceof Error ? err.message : String(err)}`, secrets, true);
    }
  });

  return server;
}

/** Connect a server to a transport. Split out so a test can use an in-memory pair. */
export async function serve(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
}

/**
 * The subcommand. Anything that would print to stdout — a library's notice, a
 * stray `console.log` — is sent to stderr first, because on stdout it would be
 * read as a protocol frame.
 */
export async function runMcp(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = console.log;
  const server = createMcpServer({ gateway: gatewayFromEnvironment(env), secrets: knownSecrets(env) });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
  });
  await serve(server, transport);
  await closed;
  return 0;
}

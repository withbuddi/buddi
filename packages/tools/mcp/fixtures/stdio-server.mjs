#!/usr/bin/env node
/**
 * A tiny MCP server over stdio for the connections tests (program.test.ts,
 * service.stdio.db.test.ts). The SDK's own server and StdioServerTransport.
 *
 *   FIXTURE_FAIL=1       write a few lines to stderr and exit 3 before answering
 *   FIXTURE_EXTRA_TOOL=1 list one more tool (a changed list)
 */
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

process.stderr.write('fixture: starting\n');
if (process.env.FIXTURE_FAIL === '1') {
  for (let i = 1; i <= 25; i += 1) process.stderr.write(`fixture: line ${i}\n`);
  process.stderr.write(`fixture: cannot reach ${process.env.FIXTURE_TOKEN ?? 'nothing'}\n`);
  process.exit(3);
}

const tools = [
  { name: 'echo', description: 'Say the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'read_env', description: 'The value of one environment variable.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, annotations: { readOnlyHint: true } },
  { name: 'env_keys', description: 'The names of every environment variable.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'where', description: 'The process id, group and working directory.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'spawn_child', description: 'Start a long-lived child and give its pid.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'crash', description: 'Write to stderr and exit.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
];
if (process.env.FIXTURE_EXTRA_TOOL === '1') {
  tools.push({ name: 'extra', description: 'Only sometimes.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });
}

const server = new Server({ name: 'fixture-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });
  switch (request.params.name) {
    case 'echo': return text(`echo: ${args.text}`);
    case 'read_env': return text(process.env[String(args.name)] ?? '(unset)');
    case 'env_keys': return text(Object.keys(process.env).sort().join(','));
    case 'where': return text(JSON.stringify({ pid: process.pid, cwd: process.cwd(), path: process.env.PATH }));
    case 'spawn_child': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      return text(String(child.pid));
    }
    case 'crash':
      process.stderr.write('fixture: about to crash\n');
      setTimeout(() => process.exit(7), 10);
      return text('crashing');
    default: return { content: [{ type: 'text', text: 'no such tool' }], isError: true };
  }
});
await server.connect(new StdioServerTransport());

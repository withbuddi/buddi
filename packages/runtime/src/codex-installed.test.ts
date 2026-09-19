/** Opt-in contract check against the installed binary, with a loopback fake model.
 * No real login, credentials, API call or model charge. Never emit an executable tool.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { createCodexRpc, type CodexRpc } from './codex-rpc.js';
import { CODEX_EXPERIMENT_CONFIG, codexConfigArgs } from './codex-policy.js';
import { createCodexAppServerAdapter } from './codex-app-server.js';

it.skipIf(process.env.BUDDI_TEST_CODEX !== '1').each(['text', 'tool', 'skills-list', 'skills-executor', 'skills-read', 'native-shell'] as const)('installed Codex offline %s contract and native-tool inventory', async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'buddi-codex-contract-'));
  const profileDir = join(dir, 'profile');
  const cwd = join(dir, 'workspace');
  await mkdir(profileDir, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  const sentinel = join(dir, 'outside-workspace.txt');
  await writeFile(sentinel, 'BUDDI_PRIVATE_SENTINEL_NOT_FOR_MODEL');
  const skillDir = join(cwd, '.agents', 'skills', 'private-fixture');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: private-fixture\ndescription: BUDDI_PRIVATE_SKILL_NOT_FOR_MODEL\n---\nPrivate test instruction.\n');
  let received: Record<string, unknown> | undefined;
  let requestCount = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
      received = JSON.parse(body);
      requestCount++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const item = mode !== 'text' && requestCount === 1
        ? mode === 'tool'
          ? { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'buddi_time', arguments: '{}' }
          : mode === 'native-shell' ? { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'exec_command', arguments: JSON.stringify({ cmd: `cat ${sentinel}` }) }
          : { type: 'function_call', id: 'fc_test', call_id: 'call_test', namespace: 'skills',
            name: mode === 'skills-read' ? 'read' : 'list',
            arguments: JSON.stringify(mode === 'skills-read' ? { package: sentinel } : { authority: { kind: mode === 'skills-executor' ? 'executor' : 'orchestrator' } }) }
        : { type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text: 'Offline contract test.' }] };
      for (const event of [
        { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const args = codexConfigArgs({
    ...CODEX_EXPERIMENT_CONFIG,
    cli_auth_credentials_store: 'ephemeral',
    model: 'gpt-5', model_provider: 'buddi_offline_test',
    'model_providers.buddi_offline_test.name': 'Offline test',
    'model_providers.buddi_offline_test.base_url': baseUrl,
    'model_providers.buddi_offline_test.wire_api': 'responses',
    'model_providers.buddi_offline_test.requires_openai_auth': false,
    'model_providers.buddi_offline_test.supports_websockets': false,
  });
  const clients: CodexRpc[] = [];
  const connect = () => {
    const child = spawn('codex', ['app-server', ...args], { cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: profileDir }, stdio: 'pipe' });
    const rpc = createCodexRpc(child);
    clients.push(rpc);
    return rpc;
  };
  try {
    const adapter = createCodexAppServerAdapter({ model: 'gpt-5', cwd, connect, timeoutMs: 10_000 });
    const toolsForModel = [{ name: 'buddi_time', description: 'Read the clock.', input_schema: { type: 'object', properties: {} } }];
    const result = await adapter.complete({ system: 'Offline contract test.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], tools: toolsForModel });
    if (mode !== 'tool') expect(result.content).toEqual([{ type: 'text', text: 'Offline contract test.' }]);
    else {
      expect(result.content).toEqual([{ type: 'tool_use', id: 'call_test', name: 'buddi_time', input: {} }]);
      expect(requestCount).toBe(1); // Codex cannot continue/execute the proposal itself.
      const continuation = await adapter.complete({ system: 'Offline contract test.', tools: toolsForModel,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
          { role: 'assistant', content: result.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_test', content: '2026-09-18T12:00:00Z' }] },
        ],
      });
      expect(continuation.content).toEqual([{ type: 'text', text: 'Offline contract test.' }]);
      expect(received?.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'call_test', name: 'buddi_time' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_test', output: '2026-09-18T12:00:00Z' }),
      ]));
    }
    if (mode.startsWith('skills')) {
      const outputs = (received?.input as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output');
      expect(JSON.stringify(outputs).includes('BUDDI_PRIVATE_SENTINEL_NOT_FOR_MODEL')).toBe(false);
      if (mode === 'skills-read') expect(outputs[0]?.output).toBe('skill package is not available');
      else expect(JSON.parse(String(outputs[0]?.output))).toMatchObject({ skills: [] });
    }
    if (mode === 'native-shell') {
      const outputs = (received?.input as Array<Record<string, unknown>>).filter(item => item.type === 'function_call_output');
      expect(JSON.stringify(outputs).includes('BUDDI_PRIVATE_SENTINEL_NOT_FOR_MODEL')).toBe(false);
      expect(String(outputs[0]?.output)).toMatch(/unsupported|unknown|not found|not available/i);
    }
    const tools = received?.tools as Array<{ type: string; name?: string }>;
    expect(JSON.stringify(received).includes('BUDDI_PRIVATE_SKILL_NOT_FOR_MODEL')).toBe(false);
    // This inventory is NOT the desired allowlist. It records why the live
    // adapter remains gated: disabling host features does not remove skills.
    expect(tools.map((tool) => tool.name ?? tool.type)).toEqual(['request_user_input', 'skills', 'buddi_time']);
  } finally {
    for (const rpc of clients) await rpc.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

import { expect, it, vi } from 'vitest';
import { assertCodexIsolation, CODEX_EXPERIMENT_CONFIG } from './codex-policy.js';
import type { CodexRpc } from './codex-rpc.js';
const config = { config: { sandbox_mode: 'read-only', web_search: 'disabled', features: Object.fromEntries(Object.entries(CODEX_EXPERIMENT_CONFIG).filter(([key]) => key.startsWith('features.')).map(([key, value]) => [key.slice(9), value])) } };

it('disables discovered skills in the private profile and checks again before model use', async () => {
  const request = vi.fn().mockResolvedValueOnce(config).mockResolvedValueOnce({ data: [{ skills: [{ path: '/fake/SKILL.md', enabled: true }], errors: [] }] })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ data: [{ skills: [{ path: '/fake/SKILL.md', enabled: false }], errors: [] }] });
  await assertCodexIsolation({ request } as unknown as CodexRpc, '/fake/workspace');
  expect(request).toHaveBeenNthCalledWith(3, 'skills/config/write', { path: '/fake/SKILL.md', enabled: false });
});
it('fails closed when a native skill remains enabled or the catalog is malformed', async () => {
  for (const result of [{}, { data: [{ skills: [], errors: ['failed'] }] }, { data: [{ skills: [{ path: '/fake/SKILL.md', enabled: true }], errors: [] }] }]) {
    await expect(assertCodexIsolation({ request: vi.fn(async (method: string) => method === 'config/read' ? config : result) } as unknown as CodexRpc, '/fake')).rejects.toThrow('isolation');
  }
});
it('rejects changed effective permissions or a configured MCP server before skill discovery', async () => {
  for (const changed of [{ ...config.config, sandbox_mode: 'danger-full-access' }, { ...config.config, mcp_servers: { leaked: {} } }, { ...config.config, features: { ...config.config.features, shell_tool: true } }]) {
    const request = vi.fn(async () => ({ config: changed }));
    await expect(assertCodexIsolation({ request } as unknown as CodexRpc, '/fake')).rejects.toThrow('isolation');
    expect(request).toHaveBeenCalledTimes(1);
  }
});

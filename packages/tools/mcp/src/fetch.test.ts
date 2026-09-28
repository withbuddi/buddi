import { describe, expect, it, vi } from 'vitest';
import { checkServerUrl, connectionFetch, STDIO_REFUSAL } from './fetch.js';
import { reply } from './testing/fake.js';

describe('connectionFetch', () => {
  it('talks only to the connection\'s own https origin', async () => {
    const transport = vi.fn(async () => reply(200, '{}'));
    const fetch = connectionFetch({ url: 'https://mcp.example.test/mcp', transport });
    await expect(fetch('https://evil.example.test/mcp', { method: 'POST', body: '{}' })).rejects.toThrow(/only to mcp\.example\.test/);
    await expect(fetch('http://mcp.example.test/mcp', { method: 'POST', body: '{}' })).rejects.toThrow(/refusing/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('puts the vault\'s token in the header and drops whatever the caller wrote', async () => {
    const transport = vi.fn(async () => reply(200, '{}'));
    const fetch = connectionFetch({ url: 'https://mcp.example.test/mcp', transport, token: async () => 'tok' });
    await fetch('https://mcp.example.test/mcp', { method: 'POST', headers: { Authorization: 'Bearer stolen', 'content-type': 'application/json' }, body: '{}' });
    const [, init] = transport.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(Object.keys(init.headers).filter((k) => k.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it('answers the standing GET stream itself, and reports a 401', async () => {
    const onUnauthorized = vi.fn();
    const transport = vi.fn(async () => reply(401, '', { 'www-authenticate': 'Bearer realm="x"' }));
    const fetch = connectionFetch({ url: 'https://mcp.example.test/mcp', transport, onUnauthorized });
    expect((await fetch('https://mcp.example.test/mcp', { method: 'GET' })).status).toBe(405);
    expect(transport).not.toHaveBeenCalled();
    expect((await fetch('https://mcp.example.test/mcp', { method: 'POST', body: '{}' })).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledWith('Bearer realm="x"');
  });

  it('refuses local programs and plain http with the spec\'s sentence', () => {
    expect(() => checkServerUrl('npx -y @modelcontextprotocol/server-github')).toThrow(STDIO_REFUSAL);
    expect(() => checkServerUrl('https://127.0.0.1:3000/mcp')).toThrow(STDIO_REFUSAL);
    expect(() => checkServerUrl('http://mcp.example.test/mcp')).toThrow(/https/);
    expect(() => checkServerUrl('https://user:pw@mcp.example.test/')).toThrow(/name and password/);
    expect(checkServerUrl(' https://mcp.example.test/mcp#x ').toString()).toBe('https://mcp.example.test/mcp');
  });
});

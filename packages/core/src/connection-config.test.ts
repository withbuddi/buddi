/** "I have a config": the blocks other MCP clients take, read into the connect screens. */
import { describe, expect, it } from 'vitest';
import { CONFIG_REFUSALS, parseConnectionConfig } from './connection-config.js';

describe('parseConnectionConfig', () => {
  it('reads the mcpServers shape: address, name, and the header as a token with its prefix', () => {
    const config = parseConnectionConfig(JSON.stringify({
      mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer abc123' } } },
    }));
    expect(config).toEqual({
      url: 'https://api.githubcopilot.com/mcp/', name: 'github',
      header: { name: 'Authorization', prefix: 'Bearer ', value: 'abc123' }, dropped: [], placeholder: false,
    });
  });

  it('reads a bare server, Basic, a header with no prefix, and says which headers were left out', () => {
    expect(parseConnectionConfig('{ "url": "https://x.test/mcp", "headers": { "authorization": "basic dXNlcjpwdw==" } }').header)
      .toEqual({ name: 'authorization', prefix: 'Basic ', value: 'dXNlcjpwdw==' });
    const keyed = parseConnectionConfig('{ "url": "https://x.test/mcp", "headers": { "X-API-Key": "k1", "X-Team": "t" } }');
    expect(keyed.header).toEqual({ name: 'X-API-Key', prefix: '', value: 'k1' });
    expect(keyed.dropped).toEqual(['X-Team']);
    expect(parseConnectionConfig('{ "url": "https://x.test/mcp" }')).toEqual({ url: 'https://x.test/mcp', dropped: [], placeholder: false });
  });

  it('keeps the header but not a placeholder where the token goes', () => {
    const config = parseConnectionConfig('{ "url": "https://x.test/mcp", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }');
    expect(config.header).toEqual({ name: 'Authorization', prefix: 'Bearer ', value: '' });
    expect(config.placeholder).toBe(true);
  });

  it('refuses a program, an SSE-only server, several servers, no url, and what is not JSON', () => {
    expect(() => parseConnectionConfig('{ "mcpServers": { "gh": { "command": "npx", "args": [] } } }')).toThrow(CONFIG_REFUSALS.command);
    expect(() => parseConnectionConfig('{ "type": "sse", "url": "https://x.test/sse" }')).toThrow(CONFIG_REFUSALS.sse);
    expect(() => parseConnectionConfig('{ "mcpServers": { "a": { "url": "https://a.test" }, "b": { "url": "https://b.test" } } }')).toThrow(/Paste one at a time/);
    expect(() => parseConnectionConfig('{ "mcpServers": {} }')).toThrow(CONFIG_REFUSALS.empty);
    expect(() => parseConnectionConfig('{ "headers": {} }')).toThrow(CONFIG_REFUSALS.url);
    expect(() => parseConnectionConfig('url: https://x.test')).toThrow(CONFIG_REFUSALS.json);
  });
});

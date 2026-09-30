/** "I have a config": the blocks other MCP clients take, read into the connect screens. */
import { describe, expect, it } from 'vitest';
import { CONFIG_REFUSALS, PROGRAM_REFUSALS, parseClaudeMcpAdd, parseConnectionConfig, parsePastedServer, shellWords } from './connection-config.js';

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

describe('parsePastedServer: a program on this computer', () => {
  it('reads an mcpServers entry with command, args and env, secrets switched on by their names', () => {
    const pasted = parsePastedServer(JSON.stringify({
      mcpServers: { trokky: { command: 'npx', args: ['-y', '@trokky/mcp@3'], env: { TROKKY_URL: 'https://t.example', TROKKY_TOKEN: 'abc', API_KEY: '${API_KEY}' } } },
    }));
    expect(pasted).toEqual({
      kind: 'program',
      program: {
        name: 'trokky', command: 'npx', args: ['-y', '@trokky/mcp@3'],
        env: [
          { name: 'TROKKY_URL', value: 'https://t.example', secret: false, placeholder: false },
          { name: 'TROKKY_TOKEN', value: 'abc', secret: true, placeholder: false },
          { name: 'API_KEY', value: '', secret: true, placeholder: true },
        ],
      },
    });
  });

  it('reads a bare server, and hands a url block to the remote reader', () => {
    expect(parsePastedServer('{ "command": "uvx", "args": ["mcp-server-time"] }')).toEqual({
      kind: 'program', program: { command: 'uvx', args: ['mcp-server-time'], env: [] },
    });
    const remote = parsePastedServer('{ "mcpServers": { "gh": { "url": "https://x.test/mcp" } } }');
    expect(remote).toEqual({ kind: 'remote', config: { url: 'https://x.test/mcp', name: 'gh', dropped: [], placeholder: false } });
    expect(() => parsePastedServer('{ "command": "" }')).toThrow(PROGRAM_REFUSALS.command);
    expect(() => parsePastedServer('not json')).toThrow(CONFIG_REFUSALS.json);
  });
});

describe('parseClaudeMcpAdd', () => {
  it('reads name, --env and -e pairs, --scope, and the command after --', () => {
    const pasted = parsePastedServer('claude mcp add trokky --env TROKKY_URL=https://t.example -e TROKKY_TOKEN=xyz --scope user -- npx -y @trokky/mcp@3');
    expect(pasted).toEqual({
      kind: 'program',
      program: {
        name: 'trokky', command: 'npx', args: ['-y', '@trokky/mcp@3'],
        env: [
          { name: 'TROKKY_URL', value: 'https://t.example', secret: false, placeholder: false },
          { name: 'TROKKY_TOKEN', value: 'xyz', secret: true, placeholder: false },
        ],
      },
    });
  });

  it('takes quotes, a continued line, options before the name, and placeholders', () => {
    const line = "claude mcp add -s project -e 'GREETING=hello world' -e SECRET_THING=<your-secret> files \\\n  -- node \"/opt/my server/index.js\" --root '/tmp/a b'";
    expect(parseClaudeMcpAdd(line)).toEqual({
      kind: 'program',
      program: {
        name: 'files', command: 'node', args: ['/opt/my server/index.js', '--root', '/tmp/a b'],
        env: [
          { name: 'GREETING', value: 'hello world', secret: false, placeholder: false },
          { name: 'SECRET_THING', value: '', secret: true, placeholder: true },
        ],
      },
    });
    expect(shellWords(`a "b \\" c" 'd\\e'`)).toEqual(['a', 'b " c', 'd\\e']);
  });

  it('reads the command without --, an http transport as a remote server, and refuses what it cannot read', () => {
    expect(parseClaudeMcpAdd('claude mcp add time uvx mcp-server-time --local-timezone UTC')).toEqual({
      kind: 'program', program: { name: 'time', command: 'uvx', args: ['mcp-server-time', '--local-timezone', 'UTC'], env: [] },
    });
    expect(parseClaudeMcpAdd('claude mcp add --transport http linear https://mcp.linear.app/mcp -H "Authorization: Bearer k"')).toEqual({
      kind: 'remote',
      config: { url: 'https://mcp.linear.app/mcp', name: 'linear', header: { name: 'Authorization', prefix: 'Bearer ', value: 'k' }, dropped: [], placeholder: false },
    });
    expect(() => parseClaudeMcpAdd('claude mcp add')).toThrow(PROGRAM_REFUSALS.claude);
    expect(() => parseClaudeMcpAdd('claude mcp add x -e nope -- npx')).toThrow(PROGRAM_REFUSALS.env);
    expect(() => parseClaudeMcpAdd("claude mcp add x -- node 'open")).toThrow(PROGRAM_REFUSALS.quote);
  });
});

/**
 * `buddi connections` against a fake gateway: every write is one of the
 * dashboard's routes, a sign-in on the service's page is a CLI consent the
 * command waits for, a token is never printed, and nothing running is exit 3.
 */
import { describe, expect, it } from 'vitest';
import { parseConnectionsArgs, UsageError } from './args.js';
import { OPEN_IN_BROWSER, openInBrowser, runConnections, type ConnectionView, type ConnectionsGateway, type ConnectionsIo } from './connections-cmd.js';
import { GatewayError, GatewayUnavailable, NOT_RUNNING } from './mcp/gateway-client.js';

const ID = '11111111-2222-3333-4444-555555555555';
const SECRET = 'ghp_not-a-real-token-123';

function view(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: ID, slug: null, name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', host: 'api.githubcopilot.com',
    state: 'pending-review', authKind: 'oauth', signedIn: false, toolCount: 0, grant: null, unreachableSince: null,
    heldTools: 0, agents: [], ...over,
  };
}

const CATALOG = [
  { id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', clientIdRequired: true, auth: { recommended: 'token', tokenPage: 'https://github.com/settings/tokens' } },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: { recommended: 'oauth' } },
];
const AGENTS = [
  { id: 'buddi', name: 'Buddi', handle: '@buddi', frontDesk: true },
  { id: 'ledger', name: 'Ledger', handle: '@ledger', frontDesk: false },
];
const REVIEW = {
  slug: 'github', slugEditable: true, host: 'api.githubcopilot.com', hash: 'h1', annotatedNothing: false, changes: null,
  tools: [
    { name: 'search', fullName: 'mcp.github.search', description: 'Search.', tier: 'auto', destructive: false, annotated: true, problem: null, change: null },
    { name: 'delete_repo', fullName: 'mcp.github.delete_repo', description: 'Delete a repository.', tier: 'gated', destructive: true, annotated: true, problem: null, change: null },
  ],
};

interface Call { method: string; path: string; body?: unknown }

function fakeGateway(handlers: Record<string, (body?: unknown) => unknown>): ConnectionsGateway & { calls: Call[] } {
  const calls: Call[] = [];
  const answer = (method: string, path: string, body?: unknown): unknown => {
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const handler = handlers[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(body);
  };
  return {
    calls,
    baseUrl: 'http://127.0.0.1:4317',
    get: async <T>(path: string) => answer('GET', path) as T,
    post: async <T>(path: string, body: unknown) => ({ status: 200, body: answer('POST', path, body) as T }),
    delete: async <T>(path: string) => ({ status: 200, body: answer('DELETE', path) as T }),
  };
}

function io(over: Partial<ConnectionsIo> = {}): ConnectionsIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  let clock = 0;
  return {
    lines, errors,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    interactive: false,
    confirm: async () => false,
    ask: async () => '',
    secret: async () => '',
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    enter: () => ({ pressed: new Promise<boolean>(() => {}), cancel: () => {} }),
    openUrl: () => {},
    readStdin: async () => '',
    ...over,
  };
}

const listing = (connections: ConnectionView[] = []) => ({ connections, catalog: CATALOG, agents: AGENTS, callbackPath: '/connections/callback' });

describe('parseConnectionsArgs', () => {
  it('reads a program after --, with --env and --secret, flags after -- belonging to the program', () => {
    expect(parseConnectionsArgs(['add', 'trokky', '--env', 'URL=https://t.example', '--secret', 'TOKEN', '--', 'npx', '-y', '@trokky/mcp@3', '--json', '--env'])).toEqual({
      action: 'add', address: 'trokky', token: false, tokenStdin: false, keep: false,
      program: { command: 'npx', args: ['-y', '@trokky/mcp@3', '--json', '--env'], env: [{ name: 'URL', value: 'https://t.example' }], secrets: ['TOKEN'] },
    });
    expect(() => parseConnectionsArgs(['add', 'x', '--'])).toThrow(UsageError);
    expect(() => parseConnectionsArgs(['add', 'x', '--env', 'NOPE'])).toThrow('--env takes NAME=value');
    expect(() => parseConnectionsArgs(['add', 'x', '--secret', 'T=v', '--', 'npx'])).toThrow(/--secret takes a variable name/);
    expect(() => parseConnectionsArgs(['add', 'x', '--token', '--', 'npx'])).toThrow(/not a program/);
    expect(() => parseConnectionsArgs(['add', '--', 'npx'])).toThrow(/one name before --/);
  });

  it('reads each verb and its flags', () => {
    expect(parseConnectionsArgs([])).toEqual({ action: 'list' });
    expect(parseConnectionsArgs(['add', 'github', '--token', '--keep', '--to', 'buddi,ledger'])).toEqual({
      action: 'add', address: 'github', token: true, tokenStdin: false, keep: true, to: ['buddi', 'ledger'],
    });
    expect(parseConnectionsArgs(['add', '--json', '{"url":"https://x.test"}', '--to', 'nobody'])).toMatchObject({ config: '{"url":"https://x.test"}', to: [] });
    expect(parseConnectionsArgs(['give', 'github', '--to=ledger'])).toEqual({ action: 'give', name: 'github', to: ['ledger'] });
    expect(parseConnectionsArgs(['remove', 'github', '-y'])).toEqual({ action: 'remove', name: 'github', yes: true });
  });

  it('refuses what does not fit', () => {
    expect(() => parseConnectionsArgs(['add'])).toThrow(UsageError);
    expect(() => parseConnectionsArgs(['add', 'github', '--token', '--client-id', 'x'])).toThrow(/one way to sign in/);
    expect(() => parseConnectionsArgs(['give', 'github'])).toThrow(/--to/);
    expect(() => parseConnectionsArgs(['remove', 'github', '--keep'])).toThrow(/unknown option/);
    expect(() => parseConnectionsArgs(['frob'])).toThrow(/unknown connections action/);
  });
});

describe('buddi connections', () => {
  it('says buddi is not running, and exits 3', async () => {
    const out = io();
    const gateway = fakeGateway({ 'GET /api/connections': () => { throw new GatewayUnavailable(); } });
    expect(await runConnections({ action: 'list' }, { gateway, json: false, io: out })).toBe(3);
    expect(out.errors).toEqual([NOT_RUNNING]);
    const off = io();
    expect(await runConnections({ action: 'list' }, { gateway: { off: 'The dashboard is off.' }, json: false, io: off })).toBe(3);
  });

  it('lists each connection with its state, tools and agents; --json too', async () => {
    const connected = view({ slug: 'github', state: 'connected', signedIn: true, authKind: 'token', toolCount: 2, agents: ['buddi'] });
    const gateway = fakeGateway({ 'GET /api/connections': () => listing([connected]) });
    const text = io();
    expect(await runConnections({ action: 'list' }, { gateway, json: false, io: text })).toBe(0);
    expect(text.lines[0]).toMatch(/^github {2}GitHub \(api\.githubcopilot\.com\) {2}connected {2}2 tools {2}given to Buddi$/);
    const json = io();
    await runConnections({ action: 'list' }, { gateway, json: true, io: json });
    expect(JSON.parse(json.lines.join('\n'))).toEqual([expect.objectContaining({ slug: 'github', tools: 2, agents: ['buddi'], state: 'connected' })]);
  });

  it('adds a card with a token: typed unseen, tried by the gateway, reviewed, kept and given', async () => {
    const signed = view({ authKind: 'token', signedIn: true });
    const gateway = fakeGateway({
      'GET /api/connections': () => listing(),
      'POST /api/connections': () => ({ connection: view(), signIn: 'manual' }),
      [`POST /api/connections/${ID}/token`]: () => ({ connection: signed }),
      [`GET /api/connections/${ID}/review`]: () => ({ ...REVIEW, connection: signed }),
      [`POST /api/connections/${ID}/review`]: () => view({ slug: 'github', state: 'connected', signedIn: true }),
      [`POST /api/connections/${ID}/grant`]: (body) => ({ granted: (body as { agents: string[] }).agents, failed: [] }),
    });
    const questions: string[] = [];
    const out = io({
      interactive: true,
      secret: async () => SECRET,
      confirm: async (q) => { questions.push(q); return true; },
      ask: async (q) => { questions.push(q); return ''; },
    });
    const code = await runConnections(
      { action: 'add', address: 'github', token: false, tokenStdin: false, keep: false },
      { gateway, json: false, io: out },
    );
    expect(code).toBe(0);
    expect(gateway.calls.find((c) => c.path.endsWith('/token'))?.body).toEqual({ token: SECRET });
    expect(gateway.calls.find((c) => c.path === '/api/connections' && c.method === 'POST')?.body).toEqual({ url: CATALOG[0]!.url, name: 'GitHub' });
    expect(out.lines.join('\n')).toContain('GitHub recommends a token.');
    expect(out.lines.join('\n')).toMatch(/mcp\.github\.delete_repo +asks every time/);
    expect(out.lines.join('\n')).toMatch(/mcp\.github\.search +runs on its own/);
    expect(questions[0]).toBe('Keep these tools as mcp.github.*?');
    // The front desk is the default answer.
    expect(gateway.calls.find((c) => c.path.endsWith('/grant'))?.body).toEqual({ agents: ['buddi'] });
    expect(out.lines.at(-1)).toBe('Gave mcp.github.* to Buddi.');
    expect([...out.lines, ...out.errors].join('\n')).not.toContain(SECRET);
  });

  it('signs in on the service\'s page through a CLI consent, and waits for it', async () => {
    let asked = 0;
    const gateway = fakeGateway({
      'GET /api/connections': () => listing(),
      'POST /api/connections': () => ({ connection: view({ name: 'Notion', host: 'mcp.notion.com' }), signIn: 'dynamic' }),
      [`POST /api/connections/${ID}/consent`]: () => ({ authorizeUrl: 'https://auth.notion.test/authorize?state=s', redirectUri: 'http://127.0.0.1:4317/connections/callback' }),
      [`GET /api/connections/${ID}`]: () => (++asked < 3 ? view({ name: 'Notion' }) : view({ name: 'Notion', signedIn: true })),
      [`GET /api/connections/${ID}/review`]: () => ({ ...REVIEW, slug: 'notion', tools: [], connection: view({ name: 'Notion', signedIn: true }) }),
      [`POST /api/connections/${ID}/review`]: () => view({ name: 'Notion', slug: 'notes', state: 'connected', signedIn: true }),
    });
    const out = io();
    const code = await runConnections(
      { action: 'add', address: 'notion', token: false, tokenStdin: false, keep: true, slug: 'notes', to: [] },
      { gateway, json: false, io: out, pollMs: 1000 },
    );
    expect(code).toBe(0);
    expect(gateway.calls.find((c) => c.path.endsWith('/consent'))?.body).toEqual({ cli: true });
    expect(out.lines).toContain('  https://auth.notion.test/authorize?state=s');
    expect(out.lines).toContain(OPEN_IN_BROWSER);
    expect(asked).toBe(3);
    expect(gateway.calls.find((c) => c.method === 'POST' && c.path.endsWith('/review'))?.body).toEqual({ hash: 'h1', slug: 'notes' });
    expect(gateway.calls.some((c) => c.path.endsWith('/grant'))).toBe(false);
  });

  it('adds GitHub with a code: prints it and the address, opens it on Enter, waits for the approval', async () => {
    const deviceListing = { ...listing(), catalog: [{ ...CATALOG[0]!, auth: { recommended: 'device', device: { clientId: 'Ov23' }, tokenPage: 'https://github.com/settings/tokens' } }] };
    const device = { state: 'waiting' as const, userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: new Date(15 * 60_000).toISOString() };
    let asked = 0;
    const gateway = fakeGateway({
      'GET /api/connections': () => deviceListing,
      'POST /api/connections': () => ({ connection: view(), signIn: 'manual' }),
      [`POST /api/connections/${ID}/device`]: () => ({ userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt, interval: 5 }),
      [`GET /api/connections/${ID}`]: () => (++asked < 3 ? view({ device }) : view({ authKind: 'token', signedIn: true, device: { ...device, state: 'done' } })),
      [`GET /api/connections/${ID}/review`]: () => ({ ...REVIEW, connection: view({ signedIn: true }) }),
      [`POST /api/connections/${ID}/review`]: () => view({ slug: 'github', state: 'connected', signedIn: true }),
    });
    const opened: string[] = [];
    let cancelled = false;
    const out = io({
      interactive: true,
      enter: (question) => { out.lines.push(question); return { pressed: Promise.resolve(true), cancel: () => { cancelled = true; } }; },
      openUrl: (url) => { opened.push(url); },
    });
    const code = await runConnections(
      { action: 'add', address: 'github', token: false, tokenStdin: false, keep: true, to: [] },
      { gateway, json: false, io: out, pollMs: 2000 },
    );
    expect(code).toBe(0);
    expect(out.lines).toContain('  WDJB-MJHT');
    expect(out.lines).toContain('Type it at https://github.com/login/device and say yes there.');
    expect(out.lines).toContain('Press Enter to open it in your browser, or open it yourself. ');
    expect(opened).toEqual(['https://github.com/login/device']);
    expect(cancelled).toBe(true);
    expect(out.lines).toContain('Signed in to GitHub.');
    expect(asked).toBe(3);
    expect(gateway.calls.some((c) => c.path.endsWith('/token'))).toBe(false);

    // --token still forces the token path.
    const forced = io({ secret: async () => SECRET, interactive: true });
    const tokenGateway = fakeGateway({
      'GET /api/connections': () => deviceListing,
      'POST /api/connections': () => ({ connection: view(), signIn: 'manual' }),
      [`POST /api/connections/${ID}/token`]: () => ({ connection: view({ authKind: 'token', signedIn: true }) }),
      [`GET /api/connections/${ID}/review`]: () => ({ ...REVIEW, connection: view({ signedIn: true }) }),
      [`POST /api/connections/${ID}/review`]: () => view({ slug: 'github', state: 'connected', signedIn: true }),
    });
    expect(await runConnections({ action: 'add', address: 'github', token: true, tokenStdin: false, keep: true, to: [] }, { gateway: tokenGateway, json: false, io: forced })).toBe(0);
    expect(tokenGateway.calls.some((c) => c.path.endsWith('/device'))).toBe(false);
  });

  it('says why a code sign-in ended, and what to do when this build has no app', async () => {
    const deviceListing = { ...listing(), catalog: [{ ...CATALOG[0]!, auth: { recommended: 'device', device: { clientId: 'Ov23' } } }] };
    const device = { state: 'failed' as const, userCode: 'AAAA-BBBB', verificationUri: 'https://github.com/login/device', expiresAt: new Date(60_000).toISOString(), reason: 'The sign-in was declined on GitHub. Start again.' };
    const gateway = fakeGateway({
      'GET /api/connections': () => deviceListing,
      'POST /api/connections': () => ({ connection: view(), signIn: 'manual' }),
      [`POST /api/connections/${ID}/device`]: () => ({ ...device, interval: 5 }),
      [`GET /api/connections/${ID}`]: () => view({ device }),
    });
    const out = io();
    expect(await runConnections({ action: 'add', address: 'github', token: false, tokenStdin: false, keep: true }, { gateway, json: false, io: out })).toBe(1);
    expect(out.errors[0]).toBe('The sign-in was declined on GitHub. Start again.');

    const none = fakeGateway({
      'GET /api/connections': () => deviceListing,
      'POST /api/connections': () => ({ connection: view(), signIn: 'manual' }),
      [`POST /api/connections/${ID}/device`]: () => { throw new GatewayError(409, 'buddi has no GitHub app id in this build yet.', { code: 'device-unavailable' }); },
    });
    const refused = io();
    expect(await runConnections({ action: 'add', address: 'github', token: false, tokenStdin: false, keep: true }, { gateway: none, json: false, io: refused })).toBe(1);
    expect(refused.errors[0]).toBe('buddi has no GitHub app id in this build yet. Run again with --token to sign in with a token instead.');
  });

  it('opens an address with the platform opener, and never fails when there is none', () => {
    expect(() => openInBrowser('https://github.com/login/device', 'win32')).not.toThrow();
  });

  it('gives up on a sign-in after ten minutes', async () => {
    const gateway = fakeGateway({
      'GET /api/connections': () => listing(),
      'POST /api/connections': () => ({ connection: view({ name: 'Notion' }), signIn: 'dynamic' }),
      [`POST /api/connections/${ID}/consent`]: () => ({ authorizeUrl: 'https://auth.test/a', redirectUri: 'x' }),
      [`GET /api/connections/${ID}`]: () => view({ name: 'Notion' }),
    });
    const out = io();
    expect(await runConnections({ action: 'add', address: 'notion', token: false, tokenStdin: false, keep: true }, { gateway, json: false, io: out, pollMs: 60_000 })).toBe(1);
    expect(out.errors[0]).toMatch(/within ten minutes/);
  });

  it('reads a config that runs a program into a program, asking for a placeholder secret', async () => {
    const program = view({ name: 'gh', host: 'this computer', authKind: 'none', signedIn: true, transport: 'stdio' });
    const gateway = fakeGateway({
      'POST /api/connections': () => ({ connection: program, signIn: 'none' }),
      [`GET /api/connections/${ID}/review`]: () => ({ ...REVIEW, connection: program, program: { line: 'npx x', env: [] } }),
    });
    const out = io({ interactive: false, readStdin: async () => `${SECRET}\n` });
    const config = JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['x'], env: { GH_TOKEN: '${GH_TOKEN}', MODE: 'fast' } } } });
    expect(await runConnections({ action: 'add', config, token: false, tokenStdin: false, keep: false }, { gateway, json: false, io: out })).toBe(0);
    expect(gateway.calls[0]).toEqual({ method: 'POST', path: '/api/connections', body: {
      transport: 'stdio', name: 'gh', command: 'npx', args: ['x'],
      env: [{ name: 'MODE', value: 'fast', secret: false }, { name: 'GH_TOKEN', value: SECRET, secret: true }],
    } });
    expect(out.lines.join('\n')).not.toContain(SECRET);
    expect(out.lines).toContain('gh runs on this computer as you: npx x');
  });

  it('adds a program: the line in full, each --secret asked with the echo off, reviewed, kept and given', async () => {
    const program = view({ name: 'Trokky', host: 'this computer', authKind: 'none', signedIn: true, transport: 'stdio' });
    const kept = { ...program, slug: 'trokky', state: 'connected' as const, grant: 'mcp.trokky.*' };
    const gateway = fakeGateway({
      'POST /api/connections': () => ({ connection: program, signIn: 'none' }),
      [`GET /api/connections/${ID}/review`]: () => ({ ...REVIEW, slug: 'trokky', connection: program, program: { line: 'npx -y @trokky/mcp@3', env: [] } }),
      [`POST /api/connections/${ID}/review`]: () => kept,
      'GET /api/connections': () => listing([kept]),
      [`POST /api/connections/${ID}/grant`]: () => ({ granted: ['buddi'], failed: [] }),
    });
    const asked: string[] = [];
    const out = io({ interactive: true, secret: async (label) => { asked.push(label); return SECRET; } });
    const command = parseConnectionsArgs(['add', 'Trokky', '--env', 'TROKKY_URL=https://t.example', '--secret', 'TROKKY_TOKEN', '--keep', '--to', 'buddi', '--', 'npx', '-y', '@trokky/mcp@3']);
    expect(await runConnections(command, { gateway, json: false, io: out })).toBe(0);
    expect(asked).toEqual(['TROKKY_TOKEN (not shown): ']);
    expect(gateway.calls[0]!.body).toEqual({
      transport: 'stdio', name: 'Trokky', command: 'npx', args: ['-y', '@trokky/mcp@3'],
      env: [{ name: 'TROKKY_URL', value: 'https://t.example', secret: false }, { name: 'TROKKY_TOKEN', value: SECRET, secret: true }],
    });
    expect(out.lines).toContain('  npx -y @trokky/mcp@3');
    expect(out.lines).toContain('  TROKKY_TOKEN=(secret, kept in the vault)');
    expect(out.lines.join('\n')).not.toContain(SECRET);
    expect(out.lines).toContain('Gave mcp.trokky.* to Buddi.');
  });

  it('reads --secret values from stdin without a terminal, and prints the program\'s last lines when it does not start', async () => {
    const program = view({ name: 'Broken', host: 'this computer', authKind: 'none', signedIn: true, transport: 'stdio' });
    const gateway = fakeGateway({
      'POST /api/connections': () => ({ connection: program, signIn: 'none' }),
      [`GET /api/connections/${ID}/review`]: () => { throw new GatewayError(502, 'Broken did not start: Connection closed', { code: 'program-failed' }); },
      [`GET /api/connections/${ID}`]: () => ({ ...program, stderr: ['boom: no such file'] }),
    });
    const out = io({ readStdin: async () => 'one\ntwo\n' });
    const command = parseConnectionsArgs(['add', 'Broken', '--secret', 'A_KEY', '--secret', 'B_TOKEN', '--', 'node', 'server.js']);
    expect(await runConnections(command, { gateway, json: false, io: out })).toBe(1);
    expect((gateway.calls[0]!.body as { env: unknown }).env).toEqual([{ name: 'A_KEY', value: 'one', secret: true }, { name: 'B_TOKEN', value: 'two', secret: true }]);
    expect(out.errors).toEqual(['Broken did not start: Connection closed', 'Its last lines:', '  boom: no such file']);

    const missing = io({ readStdin: async () => 'only-one\n' });
    expect(await runConnections(command, { gateway: fakeGateway({}), json: false, io: missing })).toBe(1);
    expect(missing.errors[0]).toMatch(/No value for B_TOKEN on stdin/);
  });

  it('takes the header of a pasted config as the token', async () => {
    const gateway = fakeGateway({
      'GET /api/connections': () => listing(),
      'POST /api/connections': () => ({ connection: view({ name: 'x' }), signIn: 'manual' }),
      [`POST /api/connections/${ID}/token`]: () => { throw new GatewayError(400, 'x did not accept that token.', { code: 'token-refused' }); },
    });
    const out = io();
    const config = JSON.stringify({ mcpServers: { x: { url: 'https://x.test/mcp', headers: { 'X-API-Key': SECRET } } } });
    expect(await runConnections({ action: 'add', config, token: false, tokenStdin: false, keep: false }, { gateway, json: false, io: out })).toBe(1);
    expect(gateway.calls.find((c) => c.path.endsWith('/token'))?.body).toEqual({ token: SECRET, header: 'X-API-Key', prefix: '' });
    expect(out.errors[0]).toBe('x did not accept that token.');
    expect([...out.lines, ...out.errors].join('\n')).not.toContain(SECRET);
  });

  it('gives and removes through the dashboard\'s routes; remove asks unless --yes', async () => {
    const connected = view({ slug: 'github', state: 'connected', signedIn: true, agents: ['buddi'] });
    const gateway = fakeGateway({
      'GET /api/connections': () => listing([connected]),
      [`POST /api/connections/${ID}/grant`]: (body) => ({ granted: (body as { agents: string[] }).agents, failed: [] }),
      [`DELETE /api/connections/${ID}`]: () => ({ id: ID, name: 'GitHub', touched: ['buddi'] }),
    });
    const give = io();
    expect(await runConnections({ action: 'give', name: 'github', to: ['@ledger'] }, { gateway, json: false, io: give })).toBe(0);
    expect(gateway.calls.at(-1)).toEqual({ method: 'POST', path: `/api/connections/${ID}/grant`, body: { agents: ['ledger'] } });
    const unknown = io();
    expect(await runConnections({ action: 'give', name: 'github', to: ['nemo'] }, { gateway, json: false, io: unknown })).toBe(2);

    const refused = io();
    expect(await runConnections({ action: 'remove', name: 'github', yes: false }, { gateway, json: false, io: refused })).toBe(1);
    expect(gateway.calls.some((c) => c.method === 'DELETE')).toBe(false);
    const removed = io();
    expect(await runConnections({ action: 'remove', name: 'GitHub', yes: true }, { gateway, json: false, io: removed })).toBe(0);
    expect(removed.lines[0]).toBe('Disconnected GitHub; its sign-in is deleted. Its tools were taken from Buddi.');
  });

  it('prints a review as JSON and keeps nothing without --keep', async () => {
    const connected = view({ slug: 'github', state: 'needs-review', signedIn: true });
    const gateway = fakeGateway({
      'GET /api/connections': () => listing([connected]),
      [`GET /api/connections/${ID}/review`]: () => ({ ...REVIEW, slugEditable: false, connection: connected }),
    });
    const out = io();
    expect(await runConnections({ action: 'review', name: 'github', keep: false }, { gateway, json: true, io: out })).toBe(0);
    expect(JSON.parse(out.lines.join('\n'))).toMatchObject({ slug: 'github', hash: 'h1', tools: [{ tier: 'auto' }, { destructive: true }] });
    expect(gateway.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

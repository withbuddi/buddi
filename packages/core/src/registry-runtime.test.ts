/**
 * Tools added and removed while buddi runs (`ctx.buddi.tools`, host API 1.6)
 * and tools whose input is a JSON Schema (buddi-planning/specs/mcp-client.md §7).
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const created = vi.hoisted(() => [] as Array<{ tool: string; canonicalArgs: unknown; envelope: unknown }>);
vi.mock('./actions/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./actions/store.js')>()),
  createAction: vi.fn(async (_db: unknown, input: { tool: string; canonicalArgs: unknown; envelope: unknown; preview: string }) => {
    created.push(input);
    return { id: `action-${created.length}`, preview: input.preview };
  }),
}));

import { canonicalJson, hashAction } from './actions/types.js';
import { compileJsonSchema } from './json-schema.js';
import { ToolRegistry } from './registry.js';
import type { CoreToolContext, PluginManifest, ToolDefinition } from './tools.js';
import type { RegisterHost } from './host/types.js';

const ctx: CoreToolContext = {
  db: {} as CoreToolContext['db'],
  ownerId: 'owner-1',
  agentId: 'concierge',
  now: () => new Date('2026-01-01T00:00:00Z'),
  timezone: 'UTC',
};

const issueSchema = {
  type: 'object',
  properties: {
    repo: { type: 'string', pattern: '^[a-z0-9-]+/[a-z0-9-]+$', description: 'owner/name' },
    title: { type: 'string', minLength: 1 },
    labels: { type: 'array', items: { type: 'string' } },
    draft: { type: 'boolean', default: false },
  },
  required: ['repo', 'title'],
  additionalProperties: false,
} as const;

function jsonTool(name: string, tier: 'auto' | 'gated' = 'auto', execute = vi.fn(async (input: unknown) => input)): ToolDefinition<any, any> {
  return { name, description: `The ${name} tool.`, tier, inputSchema: { ...issueSchema }, execute };
}

function plugin(name = 'mcp', tools: ToolDefinition<any, any>[] = []): { manifest: PluginManifest; host: () => RegisterHost } {
  let host: RegisterHost | undefined;
  return {
    manifest: {
      name, version: '0.1.0', schema: name, migrationsDir: '/tmp/none', tools,
      register: (h) => { host = h; },
    },
    host: () => host!,
  };
}

describe('JSON Schema tool inputs', () => {
  it('hands the schema to the model as written and validates with it', async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const r = new ToolRegistry();
    r.register({ ...plugin().manifest, tools: [jsonTool('mcp.github.create_issue', 'auto', execute)] });
    expect(r.list()[0]!.inputSchema).toEqual(issueSchema);
    await expect(r.invoke('mcp.github.create_issue', { repo: 'a/b', title: 'Hi' }, ctx))
      .resolves.toEqual({ ok: true, output: { repo: 'a/b', title: 'Hi', draft: false } });
    const refused = await r.invoke('mcp.github.create_issue', { repo: 'not a repo', title: 'Hi' }, ctx);
    expect(refused).toMatchObject({ ok: false, reason: 'invalid-args', message: expect.stringContaining('repo: must match pattern') });
    expect(await r.invoke('mcp.github.create_issue', { repo: 'a/b', title: 'Hi', extra: 1 }, ctx))
      .toMatchObject({ ok: false, reason: 'invalid-args', message: expect.stringContaining('additional properties') });
    expect(await r.invoke('mcp.github.create_issue', { title: 'Hi' }, ctx)).toMatchObject({ ok: false, reason: 'invalid-args' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never mutates the caller\'s arguments when filling defaults', async () => {
    const r = new ToolRegistry();
    r.register({ ...plugin().manifest, tools: [jsonTool('mcp.t')] });
    const args = { repo: 'a/b', title: 'Hi' };
    await r.invoke('mcp.t', args, ctx);
    expect(args).toEqual({ repo: 'a/b', title: 'Hi' });
  });

  it('canonicalises a gated call the same way as the zod equivalent', async () => {
    created.length = 0;
    const zodTool: ToolDefinition<any, any> = {
      name: 'mcp.zod_issue', description: 'zod', tier: 'gated', execute: vi.fn(),
      input: z.object({
        repo: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/), title: z.string().min(1),
        labels: z.array(z.string()).optional(), draft: z.boolean().default(false),
      }).strict(),
    };
    const r = new ToolRegistry();
    r.register({ ...plugin().manifest, tools: [zodTool, jsonTool('mcp.json_issue', 'gated')] });
    const args = { title: 'Hi', labels: ['b', 'a'], repo: 'a/b' };
    expect(await r.invoke('mcp.zod_issue', args, ctx)).toMatchObject({ reason: 'approval-required' });
    expect(await r.invoke('mcp.json_issue', { repo: 'a/b', labels: ['b', 'a'], title: 'Hi' }, ctx)).toMatchObject({ reason: 'approval-required' });
    const [a, b] = created;
    expect(canonicalJson(b!.canonicalArgs)).toBe(canonicalJson(a!.canonicalArgs));
    expect(canonicalJson(b!.envelope)).toBe(canonicalJson(a!.envelope));
    expect(hashAction('t', '1', b!.canonicalArgs, b!.envelope)).toBe(hashAction('t', '1', a!.canonicalArgs, a!.envelope));
    // The executor re-parses the stored arguments with the same validator.
    expect(r.lookup('mcp.json_issue')!.input.safeParse(JSON.parse(canonicalJson(b!.canonicalArgs)))).toMatchObject({ success: true });
  });

  it('refuses a schema no provider can take, or that does not compile', () => {
    const bad = (inputSchema: Record<string, unknown>) => () => new ToolRegistry().register({
      ...plugin().manifest, tools: [{ name: 'mcp.x', description: 'x', tier: 'auto', inputSchema, execute: vi.fn() }] });
    expect(bad({ type: 'string' })).toThrow(/not a plain object schema/);
    expect(bad({ type: 'object', anyOf: [{ required: ['a'] }, { required: ['b'] }] })).toThrow(/not a plain object schema/);
    expect(bad({ type: 'object', properties: { a: { type: 'nonsense' } } })).toThrow(/does not compile/);
    expect(bad({ type: 'object', properties: { a: { $ref: 'https://evil.example/schema.json' } } })).toThrow(/does not compile/);
    expect(bad({ type: 'object', properties: { a: { type: 'string', pattern: 'a'.repeat(600) } } })).toThrow(/does not compile/);
    expect(() => new ToolRegistry().register({ ...plugin().manifest, tools: [{ name: 'mcp.x', description: 'x', tier: 'auto', input: z.object({}), inputSchema: { type: 'object' }, execute: vi.fn() } as never] }))
      .toThrow(/both/);
  });

  it('reads drafts 07 and 2020-12', () => {
    const d7 = compileJsonSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { t: { type: 'array', items: [{ type: 'string' }] } } });
    expect(d7.safeParse({ t: ['x'] }).success).toBe(true);
    expect(d7.safeParse({ t: [1] }).success).toBe(false);
    const d2020 = compileJsonSchema({ type: 'object', properties: { t: { type: 'array', prefixItems: [{ type: 'string' }] } } });
    expect(d2020.safeParse({ t: [1] }).success).toBe(false);
    const noSchema = compileJsonSchema({ type: 'object', properties: { t: { type: 'array', items: [{ type: 'string' }] } } });
    expect(noSchema.safeParse({ t: [1] }).success).toBe(false);
  });

  it('works beside zod tools in one registry', async () => {
    const r = new ToolRegistry();
    r.register({ ...plugin().manifest, tools: [jsonTool('mcp.json')] });
    r.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '/tmp/none', tools: [
      { name: 'demo.double', description: 'd', tier: 'auto', input: z.object({ n: z.number() }), execute: async (i: { n: number }) => i.n * 2 },
    ] });
    expect(r.list().map((t) => t.name)).toEqual(['mcp.json', 'demo.double']);
    await expect(r.invoke('demo.double', { n: 2 }, ctx)).resolves.toEqual({ ok: true, output: 4 });
    await expect(r.invoke('mcp.json', { repo: 'a/b', title: 't' }, ctx)).resolves.toMatchObject({ ok: true });
  });
});

describe('runtime tool registration', () => {
  it('adds and removes a plugin\'s own tools, and tells listeners once per burst', async () => {
    const p = plugin();
    const r = new ToolRegistry();
    r.register(p.manifest);
    const heard = vi.fn();
    r.onChange(heard);
    const before = r.revision;
    p.host().tools.register([jsonTool('mcp.github.search'), jsonTool('mcp.github.create_issue', 'gated')]);
    expect(r.list().map((t) => t.name)).toEqual(['mcp.github.search', 'mcp.github.create_issue']);
    expect(p.host().tools.registered()).toEqual(['mcp.github.search', 'mcp.github.create_issue']);
    p.host().tools.unregister(['mcp.github.search']);
    expect(r.has('mcp.github.search')).toBe(false);
    expect(r.revision).toBe(before + 2);
    await Promise.resolve();
    expect(heard).toHaveBeenCalledTimes(1);
    await expect(r.invoke('mcp.github.search', {}, ctx)).resolves.toMatchObject({ reason: 'unknown-tool' });
  });

  it('keeps a plugin in its namespace and out of its manifest tools and other plugins\' tools', () => {
    const p = plugin('mcp', [{ name: 'mcp.status', description: 's', tier: 'auto', input: z.object({}), execute: vi.fn() }]);
    const other = plugin('other');
    const r = new ToolRegistry();
    r.register(p.manifest);
    r.register(other.manifest);
    expect(() => p.host().tools.register([jsonTool('web.search')])).toThrow(/own namespace/);
    expect(() => p.host().tools.register([jsonTool('mcp')])).toThrow(/own namespace/);
    expect(() => p.host().tools.register([jsonTool('mcp.has space')])).toThrow(/own namespace/);
    expect(() => p.host().tools.unregister(['mcp.status'])).toThrow(/registered at runtime/);
    other.host().tools.register([jsonTool('other.thing')]);
    expect(() => p.host().tools.unregister(['other.thing'])).toThrow(/registered at runtime/);
  });

  it('applies the registry\'s checks and is all or nothing', () => {
    const p = plugin();
    const r = new ToolRegistry();
    r.register(p.manifest);
    p.host().tools.register([jsonTool('mcp.a')]);
    expect(() => p.host().tools.register([jsonTool('mcp.b'), jsonTool('mcp.a')])).toThrow(/collision/);
    expect(() => p.host().tools.register([jsonTool('mcp.c'), jsonTool('mcp.c')])).toThrow(/collision/);
    expect(() => p.host().tools.register([{ ...jsonTool('mcp.d'), untrusted: 'nope' as never }])).toThrow(/untrusted/);
    expect(() => p.host().tools.register([{ ...jsonTool('mcp.e'), tier: 'draft', tierFor: vi.fn() }])).toThrow(/draft/);
    expect(() => p.host().tools.register([jsonTool('mcp.f'), { ...jsonTool('mcp.g'), inputSchema: { type: 'string' } }])).toThrow(/object/);
    expect(r.list().map((t) => t.name)).toEqual(['mcp.a']);
    expect(() => p.host().tools.unregister(['mcp.a', 'mcp.nope'])).toThrow();
    expect(r.has('mcp.a')).toBe(true);
  });

  it('answers approvals for runtime tools as the plugin\'s own, and a host without a registry refuses', async () => {
    const p = plugin();
    const r = new ToolRegistry();
    let seen: CoreToolContext['buddi'];
    r.register(p.manifest);
    p.host().tools.register([{ ...jsonTool('mcp.probe'), execute: async (_i: unknown, c: CoreToolContext) => { seen = c.buddi; return null; } }]);
    // A fresh context: hosts are cached per context object and plugin name.
    await r.invoke('mcp.probe', { repo: 'a/b', title: 't' }, { ...ctx });
    expect(seen!.tools.registered()).toEqual(['mcp.probe']);
    const { createPluginHost, hostBindingOf } = await import('./host/build.js');
    const loose = createPluginHost(hostBindingOf(plugin('loose').manifest), ctx);
    expect(() => loose.tools.register([])).toThrow(/not bound to a tool registry/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import type { PluginManifest, Tier, ToolContext } from './tools.js';

const ctx: ToolContext = {
  db: {} as ToolContext['db'],
  ownerId: 'owner-1',
  now: () => new Date('2026-01-01T00:00:00Z'),
  timezone: 'UTC',
};

function manifest(tier: Tier, execute = async (i: { n: number }) => i.n * 2): PluginManifest {
  return {
    name: 'demo',
    version: '0.0.1',
    schema: 'demo',
    migrationsDir: '/tmp/demo-migrations',
    tools: [
      {
        name: 'demo.double',
        description: 'Doubles a number.',
        tier,
        input: z.object({ n: z.number().int() }),
        execute: execute as never,
      },
    ],
  };
}

describe('ToolRegistry', () => {
  it('lists tool specs with a JSON schema for the model', () => {
    const r = new ToolRegistry();
    r.register(manifest('auto'));
    const [spec] = r.list();
    expect(spec?.name).toBe('demo.double');
    expect(spec?.tier).toBe('auto');
    expect(spec?.inputSchema).toMatchObject({
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    });
  });

  it('rejects duplicate plugins and colliding tool names', () => {
    const r = new ToolRegistry();
    r.register(manifest('auto'));
    expect(() => r.register(manifest('auto'))).toThrow(/already registered/);
    expect(() => r.register({ ...manifest('auto'), name: 'other' })).toThrow(/collision/);
  });

  it('executes an auto-tier tool', async () => {
    const r = new ToolRegistry();
    r.register(manifest('auto'));
    await expect(r.invoke('demo.double', { n: 21 }, ctx)).resolves.toEqual({
      ok: true,
      output: 42,
    });
  });

  it('refuses an unknown tool', async () => {
    const r = new ToolRegistry();
    r.register(manifest('auto'));
    const res = await r.invoke('demo.nope', {}, ctx);
    expect(res).toMatchObject({ ok: false, reason: 'unknown-tool' });
  });

  it('refuses invalid arguments before executing', async () => {
    const execute = vi.fn();
    const r = new ToolRegistry();
    r.register(manifest('auto', execute as never));
    const res = await r.invoke('demo.double', { n: 'twenty' }, ctx);
    expect(res).toMatchObject({ ok: false, reason: 'invalid-args' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['draft', 'session'] as Tier[])(
    'refuses tier %s without its required authority',
    async (tier) => {
      const execute = vi.fn();
      const r = new ToolRegistry();
      r.register(manifest(tier, execute as never));
      const res = await r.invoke('demo.double', { n: 1 }, ctx);
      expect(res).toMatchObject({ ok: false, reason: tier === 'session' ? 'session-not-authorized' : 'tier-not-executable' });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('turns a gated call into a pending approval instead of executing it', async () => {
    const execute = vi.fn();
    const r = new ToolRegistry();
    r.register(manifest('gated', execute as never));
    // The action is recorded before anyone is asked, so the gated path needs a
    // database; here it is a stub that answers the one insert with one row.
    const rows: any[][] = [];
    const db = {
      query: async (sql: string, params?: any[]) => {
        rows.push([sql, params]);
        if (!sql.includes('insert into core.actions')) return { rows: [] };
        return {
          rows: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              tool: 'demo.double',
              tool_version: '0.0.1',
              agent_id: 'agent-1',
              conversation_id: null,
              job_id: null,
              canonical_args: { n: 1 },
              envelope: { n: 1 },
              args_hash: 'hash',
              preview: 'demo.double {"n":1}',
              expires_at: new Date('2026-01-02T00:00:00Z'),
              policy_version: 1,
              created_at: new Date('2026-01-01T00:00:00Z'),
              tier: params?.[13] ?? null,
              state: 'pending',
              updated_at: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        };
      },
    };
    const res = await r.invoke('demo.double', { n: 1 }, {
      ...ctx,
      db: db as ToolContext['db'],
      agentId: 'agent-1',
    });
    expect(res).toMatchObject({
      ok: false,
      reason: 'approval-required',
      actionId: '11111111-1111-1111-1111-111111111111',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a gated call when the action cannot be recorded', async () => {
    const execute = vi.fn();
    const r = new ToolRegistry();
    r.register(manifest('gated', execute as never));
    const db = {
      query: async () => {
        throw new Error('database is down');
      },
    };
    const res = await r.invoke('demo.double', { n: 1 }, { ...ctx, db: db as unknown as ToolContext['db'] });
    expect(res).toMatchObject({ ok: false, reason: 'tool-error' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('hands the Executor a tool with its plugin version', () => {
    const r = new ToolRegistry();
    r.register(manifest('gated'));
    expect(r.lookup('demo.double')).toMatchObject({ name: 'demo.double', version: '0.0.1' });
    expect(r.lookup('demo.missing')).toBeUndefined();
  });

  it('reports a throwing tool as tool-error', async () => {
    const r = new ToolRegistry();
    r.register(
      manifest('auto', async () => {
        throw new Error('upstream exploded');
      }),
    );
    const res = await r.invoke('demo.double', { n: 1 }, ctx);
    expect(res).toMatchObject({ ok: false, reason: 'tool-error', message: 'upstream exploded' });
  });
});

/**
 * A tier decided per call (`ToolDefinition.tierFor`).
 *
 * The same tool, gated or not depending on what it was asked to do — which is
 * the developer plugin's whole problem: `rm -rf .` and `ls` are both "run a
 * command". What is under test is the decision being *acted on* (the auto one
 * runs, the gated one records an action, the reason reaches the card) and, at
 * least as much, the envelope around it: `tierFor` reads arguments a **model**
 * chose, so it may only choose inside what the declared tier already bought.
 * A declared-`session` tool keeps every session precondition on every call —
 * a delegate must never get a shell out of one — and a declared-`gated` tool
 * is gated on every call whatever its own rule says.
 */
describe('tierFor: a tier decided per call', () => {
  /** Every insert this fake sees, so a test can read the preview it recorded. */
  function recordingDb(watch?: (sql: string) => void): {
    db: ToolContext['db'];
    previews: string[];
    tiers: Array<string | null>;
  } {
    const previews: string[] = [];
    const tiers: Array<string | null> = [];
    const db = {
      query: async (sql: string, params?: any[]) => {
        watch?.(sql);
        if (!sql.includes('insert into core.actions')) return { rows: [] };
        previews.push(String(params?.[8]));
        tiers.push((params?.[13] ?? null) as string | null);
        return {
          rows: [
            {
              id: '22222222-2222-2222-2222-222222222222',
              tool: 'demo.double',
              tool_version: '0.0.1',
              agent_id: 'agent-1',
              conversation_id: null,
              job_id: null,
              canonical_args: { n: 1 },
              envelope: { n: 1 },
              args_hash: 'hash',
              preview: String(params?.[8]),
              expires_at: new Date('2026-01-02T00:00:00Z'),
              policy_version: 1,
              created_at: new Date('2026-01-01T00:00:00Z'),
              state: 'pending',
              updated_at: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        };
      },
    };
    return { db: db as unknown as ToolContext['db'], previews, tiers };
  }

  /** A tool that is `session` by declaration and decides each call. */
  function deciding(
    tierFor: (input: { n: number }) => Promise<{ tier: Tier; reason?: string }>,
    execute = vi.fn(async (i: { n: number }) => i.n * 2),
  ): { manifest: PluginManifest; execute: ReturnType<typeof vi.fn> } {
    const base = manifest('session', execute as never);
    const tool = base.tools[0]!;
    return {
      manifest: {
        ...base,
        tools: [
          {
            ...tool,
            describe: () => ({ envelope: { n: 1 }, preview: 'Double one number.' }),
            tierFor: (input: unknown) => tierFor(input as { n: number }),
          },
        ],
      },
      execute,
    };
  }

  /** The context a declared-`session` tool needs before anything runs. */
  const granted = (over: Partial<ToolContext> = {}): ToolContext => ({
    ...ctx,
    ownerRequest: { id: 'r1', text: 'run the tests', expiresAt: Date.now() + 60_000 },
    sessionTools: ['demo.double'],
    agentId: 'agent-1',
    conversationId: 'c1',
    ...over,
  });

  it('runs a call the tool decided is auto — under the grant its declaration bought', async () => {
    const r = new ToolRegistry();
    const { manifest: m, execute } = deciding(async () => ({ tier: 'auto' }));
    r.register(m);
    // Declared `session`, so that is still what the model is told and what a
    // grant is checked against.
    expect(r.list()[0]?.tier).toBe('session');
    await expect(r.invoke('demo.double', { n: 21 }, granted())).resolves.toEqual({
      ok: true,
      output: 42,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps every session precondition when the call was decided auto', async () => {
    const r = new ToolRegistry();
    const { manifest: m, execute } = deciding(async () => ({ tier: 'auto' }));
    r.register(m);
    const refusals: Array<[string, ToolContext]> = [
      // A delegate. `sessionTools` is empty for one, and the depth is the
      // second lock: the developer spec promises a delegate gets none of this.
      ['a delegate', granted({ delegationDepth: 1 })],
      ['a delegate with no grant', granted({ delegationDepth: 1, sessionTools: [] })],
      // Nobody asked: a scheduled job must not inherit the owner's shell.
      ['no owner request', granted({ ownerRequest: undefined })],
      ['an expired request', granted({ ownerRequest: { id: 'r1', text: 'x', expiresAt: Date.now() - 1 } })],
      ['no grant', granted({ sessionTools: [] })],
      ['no conversation', granted({ conversationId: undefined })],
    ];
    for (const [what, context] of refusals) {
      expect(await r.invoke('demo.double', { n: 1 }, context), what).toMatchObject({
        ok: false,
        reason: 'session-not-authorized',
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps them when the call was decided gated, before any action is recorded', async () => {
    const r = new ToolRegistry();
    const { manifest: m } = deciding(async () => ({ tier: 'gated', reason: 'rm -rf is a destroyer.' }));
    r.register(m);
    const { db, previews } = recordingDb();
    // A delegate does not even get to put the question to the owner: the
    // declaration says there is no standing here at all.
    expect(
      await r.invoke('demo.double', { n: 1 }, granted({ db, delegationDepth: 1 })),
    ).toMatchObject({ ok: false, reason: 'session-not-authorized' });
    expect(previews).toEqual([]);
  });

  it('will not let a gated tool decide it is not gated', async () => {
    for (const decided of ['auto', 'session'] as Tier[]) {
      const r = new ToolRegistry();
      const execute = vi.fn(async (i: { n: number }) => i.n * 2);
      const base = manifest('gated', execute as never);
      r.register({
        ...base,
        tools: [{ ...base.tools[0]!, tierFor: async () => ({ tier: decided }) }],
      });
      const res = await r.invoke('demo.double', { n: 1 }, granted());
      expect(res, decided).toMatchObject({ ok: false, reason: 'tool-error' });
      expect((res as { message: string }).message).toMatch(
        decided === 'session' ? /a session grant is resolved from the declared tier/ : /gated on every call/,
      );
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('will not let a tool ask for a session grant it never declared', async () => {
    const r = new ToolRegistry();
    const execute = vi.fn();
    const base = manifest('auto', execute as never);
    r.register({
      ...base,
      tools: [{ ...base.tools[0]!, tierFor: async () => ({ tier: 'session' as Tier }) }],
    });
    const res = await r.invoke('demo.double', { n: 1 }, granted());
    expect(res).toMatchObject({ ok: false, reason: 'tool-error' });
    expect((res as { message: string }).message).toMatch(/declare 'session' and narrow from there/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a draft tool that also decides per call, at registration', () => {
    const r = new ToolRegistry();
    const base = manifest('draft');
    expect(() =>
      r.register({ ...base, tools: [{ ...base.tools[0]!, tierFor: async () => ({ tier: 'auto' }) }] }),
    ).toThrow(/nothing to decide per call/);
    expect(r.has('demo.double')).toBe(false);
  });

  it('records an approval whose preview carries the rule that matched', async () => {
    const r = new ToolRegistry();
    const { manifest: m, execute } = deciding(async () => ({
      tier: 'gated',
      reason: 'npm install reaches the network.',
    }));
    r.register(m);
    const { db, previews } = recordingDb();
    const res = await r.invoke('demo.double', { n: 1 }, granted({ db }));
    expect(res).toMatchObject({ ok: false, reason: 'approval-required' });
    expect((res as { preview: string }).preview).toBe(
      'Double one number. — npm install reaches the network.',
    );
    expect(previews).toEqual(['Double one number. — npm install reaches the network.']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not repeat a reason the tool already put in its own preview', async () => {
    const r = new ToolRegistry();
    const { manifest: m } = deciding(async () => ({ tier: 'gated', reason: 'unzip is not on the run list' }));
    const tool = m.tools[0]!;
    r.register({
      ...m,
      tools: [{ ...tool, describe: () => ({ envelope: { n: 1 }, preview: 'It needs your approval: unzip is not on the run list.' }) }],
    });
    const { db, previews } = recordingDb();
    await r.invoke('demo.double', { n: 1 }, granted({ db }));
    expect(previews).toEqual(['It needs your approval: unzip is not on the run list.']);
  });

  it('leaves the preview alone when no reason was given', async () => {
    const r = new ToolRegistry();
    const { manifest: m } = deciding(async () => ({ tier: 'gated' }));
    r.register(m);
    const { db, previews } = recordingDb();
    await r.invoke('demo.double', { n: 1 }, granted({ db }));
    expect(previews).toEqual(['Double one number.']);
  });

  it('refuses the call when tierFor throws', async () => {
    const r = new ToolRegistry();
    const { manifest: m, execute } = deciding(async () => {
      throw new Error('the workspace record is gone');
    });
    r.register(m);
    const res = await r.invoke('demo.double', { n: 1 }, granted());
    expect(res).toMatchObject({ ok: false, reason: 'tool-error' });
    expect((res as { message: string }).message).toMatch(/the workspace record is gone/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a tier that may not be decided per call', async () => {
    const r = new ToolRegistry();
    const { manifest: m, execute } = deciding(async () => ({ tier: 'draft' as Tier }));
    r.register(m);
    const res = await r.invoke('demo.double', { n: 1 }, granted());
    expect(res).toMatchObject({ ok: false, reason: 'tool-error' });
    expect((res as { message: string }).message).toMatch(/only auto, gated, session/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('still asks everything `session` asks when that is what it returns', async () => {
    const r = new ToolRegistry();
    const { manifest: m, execute } = deciding(async () => ({ tier: 'session' }));
    r.register(m);
    // No owner request: the per-call decision buys nothing on its own.
    expect(await r.invoke('demo.double', { n: 1 }, ctx)).toMatchObject({
      ok: false,
      reason: 'session-not-authorized',
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(r.invoke('demo.double', { n: 4 }, granted())).resolves.toEqual({ ok: true, output: 8 });
  });

  it('records the tier the call was created under', async () => {
    const r = new ToolRegistry();
    const { manifest: m } = deciding(async () => ({ tier: 'gated' }));
    r.register(m);
    const { db, tiers } = recordingDb();
    await r.invoke('demo.double', { n: 1 }, granted({ db }));
    expect(tiers).toEqual(['gated']);
  });

  it('never answers a per-call gate from a standing permission', async () => {
    const r = new ToolRegistry();
    const execute = vi.fn(async (i: { n: number }) => i.n * 2);
    const base = manifest('gated', execute as never);
    let permissionsAsked = 0;
    r.register({
      ...base,
      tools: [
        {
          ...base.tools[0]!,
          reusableApproval: true,
          tierFor: async () => ({ tier: 'gated', reason: 'npm install reaches the network.' }),
        },
      ],
    });
    const { db } = recordingDb((sql) => {
      if (sql.includes('tool_permissions')) permissionsAsked += 1;
    });
    const res = await r.invoke('demo.double', { n: 1 }, granted({ db }));
    // "Always allow developer.run" was said about a call that was `ls`. It is
    // not an answer to the call that is `npm install`.
    expect(res).toMatchObject({ ok: false, reason: 'approval-required' });
    expect(permissionsAsked).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('is never asked before the arguments are valid', async () => {
    const tierFor = vi.fn(async () => ({ tier: 'auto' as Tier }));
    const r = new ToolRegistry();
    const { manifest: m } = deciding(tierFor as never);
    r.register(m);
    expect(await r.invoke('demo.double', { n: 'twenty' }, granted())).toMatchObject({
      ok: false,
      reason: 'invalid-args',
    });
    expect(tierFor).not.toHaveBeenCalled();
  });
});

/**
 * The provider contract. Anthropic refuses a whole request whose
 * `input_schema.type` is missing ("tools.N.custom.input_schema.type: Field
 * required") and OpenAI wants the same of `function.parameters`, so an object
 * schema is what the registry owes every provider — whatever a plugin wrote.
 */
describe('the tool input schema guarantee', () => {
  function withInput(input: PluginManifest['tools'][number]['input']): PluginManifest {
    return {
      name: 'demo',
      version: '0.0.1',
      schema: 'demo',
      migrationsDir: '/tmp/demo-migrations',
      tools: [
        {
          name: 'demo.thing',
          description: 'A thing.',
          tier: 'auto',
          input,
          execute: (async () => null) as never,
        },
      ],
    };
  }

  it('flattens a discriminated union into the object schema a provider accepts', async () => {
    const r = new ToolRegistry();
    r.register(
      withInput(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('a'), n: z.number() }),
          z.object({ kind: z.literal('b'), s: z.string() }),
        ]),
      ),
    );
    const schema = r.list()[0]!.inputSchema;
    // No union at the top level: Anthropic refuses one even with the type
    // ("input_schema does not support oneOf, allOf, or anyOf at the top level").
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        // The discriminator reads as one enum rather than a pile of consts.
        kind: { type: 'string', enum: ['a', 'b'] },
        n: { type: 'number' },
        s: { type: 'string' },
      },
      // Only the key every branch requires — never one that would reject a
      // call zod accepts.
      required: ['kind'],
    });

    // The flattening is a description, not a relaxation: zod still decides.
    await expect(r.invoke('demo.thing', { kind: 'a', n: 1 }, ctx)).resolves.toMatchObject({
      ok: true,
    });
    await expect(r.invoke('demo.thing', { kind: 'a', s: 'no' }, ctx)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-args',
    });
  });

  it('keeps a property that genuinely differs across branches as alternatives', () => {
    const r = new ToolRegistry();
    r.register(
      withInput(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('a'), data: z.object({ n: z.number() }) }),
          z.object({ kind: z.literal('b'), data: z.object({ s: z.string() }) }),
        ]),
      ),
    );
    const schema = r.list()[0]!.inputSchema as { properties: { data: { anyOf: unknown[] } } };
    // Legal here — it is the *top level* the API refuses a union at.
    expect(schema.properties.data.anyOf).toHaveLength(2);
  });

  it('also flattens a plain union of objects, and a union of unions', () => {
    const r = new ToolRegistry();
    r.register(withInput(z.union([z.object({ a: z.number() }), z.object({ b: z.string() })])));
    expect(r.list()[0]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'string' } },
    });
    expect(r.list()[0]!.inputSchema.anyOf).toBeUndefined();

    const nested = new ToolRegistry();
    nested.register(
      withInput(
        z.union([
          z.union([z.object({ a: z.number() }), z.object({ b: z.string() })]),
          z.object({ c: z.boolean() }),
        ]),
      ),
    );
    expect(nested.list()[0]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { a: {}, b: {}, c: {} },
    });
    expect(nested.list()[0]!.inputSchema.anyOf).toBeUndefined();
  });

  it('leaves an ordinary object schema exactly as zod rendered it', () => {
    const r = new ToolRegistry();
    r.register(withInput(z.object({ n: z.number().int().describe('a count') })));
    expect(r.list()[0]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { n: { type: 'integer', description: 'a count' } },
      required: ['n'],
    });
  });

  it.each([
    ['a top-level string', z.string(), /type 'string'/],
    ['a top-level array', z.array(z.string()), /type 'array'/],
    ['a top-level number', z.number(), /type 'number'/],
    ['an unconstrained input', z.unknown(), /no type at all/],
    [
      'a union with a non-object branch',
      z.union([z.object({ a: z.number() }), z.string()]),
      /branches are not all objects/,
    ],
  ])('refuses %s at registration, naming the tool', (_label, input, message) => {
    const r = new ToolRegistry();
    expect(() => r.register(withInput(input as never))).toThrow(/demo\.thing/);
    expect(() => r.register(withInput(input as never))).toThrow(/plugin demo/);
    expect(() => r.register(withInput(input as never))).toThrow(message as RegExp);
  });

  it('registers nothing at all when one tool in the manifest is refused', () => {
    const r = new ToolRegistry();
    const bad: PluginManifest = {
      ...withInput(z.object({ ok: z.boolean() })),
      tools: [
        withInput(z.object({ ok: z.boolean() })).tools[0]!,
        {
          name: 'demo.bare',
          description: 'A bare string input.',
          tier: 'auto',
          input: z.string() as never,
          execute: (async () => null) as never,
        },
      ],
    };
    expect(() => r.register(bad)).toThrow(/demo\.bare/);
    expect(r.has('demo.thing')).toBe(false);
    expect(r.list()).toEqual([]);
    expect(r.manifests()).toEqual([]);
  });
});

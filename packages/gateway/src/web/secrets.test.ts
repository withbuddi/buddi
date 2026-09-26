/**
 * The Keys and secrets writes run as the owner: an ownerOnly tool answers
 * "unknown tool" to anybody else, and the dashboard is the owner's own hand.
 */
import { describe, expect, it, vi } from 'vitest';
import { OWNER_AGENT_ID } from '@buddi/core';
import { secretsAct } from './secrets.js';

describe('secretsAct', () => {
  it('invokes the write tool as the owner', async () => {
    const invoke = vi.fn(async () => ({ ok: true, output: { stored: 'Wikipedia_Username' } }));
    const deps = { pool: {} as never, registry: { invoke } as never, ctx: { agentId: 'not-the-owner' } as never };
    const reply = await secretsAct(deps as never, { tool: 'secrets.put', args: { name: 'Wikipedia_Username', value: 'x', bindings: [] } }, { id: 's1' });
    expect(reply.status).toBe(200);
    const [, , ctx] = invoke.mock.calls[0]! as unknown as [string, unknown, { agentId: string }];
    expect(ctx.agentId).toBe(OWNER_AGENT_ID);
  });

  it('refuses a tool that is not a secrets write', async () => {
    const invoke = vi.fn();
    const reply = await secretsAct({ pool: {} as never, registry: { invoke } as never, ctx: {} as never } as never, { tool: 'email.send', args: {} }, { id: 's1' });
    expect(reply.status).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tools.js';
import { executeApproved, type ExecutableTool } from './execute.js';
import { hashAction, POLICY_VERSION } from './types.js';

function fixture() {
  const args = { draftId: 'draft-1' };
  const envelope = { to: 'owner@example.test', body: 'approved body' };
  const row = {
    id: 'action-1', tool: 'mail.send', tool_version: '1', agent_id: 'mailer',
    conversation_id: null, job_id: null, canonical_args: args, envelope,
    args_hash: hashAction('mail.send', '1', args, envelope), preview: 'send',
    policy_version: POLICY_VERSION, created_at: new Date('2026-01-01'),
    expires_at: new Date('2030-01-01'), updated_at: new Date(), state: 'executing',
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("set state = 'executing'")) return { rows: [row] };
    if (sql.includes('insert into core.effect_attempts')) return { rows: [{ id: 'attempt-1', attempt: 1 }] };
    if (sql.includes('returning state')) return { rows: [{ state: params[1] }] };
    return { rows: [] };
  });
  const ctx: ToolContext = { db: { query } as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
  const execute = vi.fn(async (_input: unknown, _ctx: ToolContext): Promise<unknown> => 'sent');
  const tool: ExecutableTool = {
    name: 'mail.send', version: '1', input: { safeParse: (data) => ({ success: true, data }) },
    describe: () => ({ envelope, preview: 'send' }), execute,
  };
  const run = (timeoutMs = 1000) => executeApproved({ query }, {
    actionId: row.id, registry: { lookup: () => tool }, ctx, worker: 'test', timeoutMs,
  });
  return { row, tool, ctx, execute, query, run };
}

describe('effect binding and cancellation', () => {
  it('passes the approved snapshot and action identity to the tool', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.execute.mock.calls[0]?.[1]).toMatchObject({
      actionId: 'action-1', agentId: 'mailer', approvedEffect: { envelope: f.row.envelope },
    });
  });

  it('refuses changed resolved state even when arguments are unchanged', async () => {
    const f = fixture();
    f.tool.describe = () => ({ envelope: { ...f.row.envelope, to: 'different@example.test' }, preview: 'changed' });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'effect-changed' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([sql]) => sql.includes('insert into core.effect_attempts'))).toBe(false);
  });

  it('detects a modified stored envelope', async () => {
    const f = fixture();
    f.row.envelope.body = 'changed after approval';
    expect(await f.run()).toMatchObject({ ok: false, reason: 'args-hash-mismatch' });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('requires a new proposal for legacy approvals', async () => {
    const f = fixture();
    f.row.policy_version = 1;
    expect(await f.run()).toMatchObject({ ok: false, reason: 'policy-version-mismatch' });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('re-describes with the original agent and preview clock', async () => {
    const f = fixture();
    const describeEffect = vi.fn((_args, ctx: ToolContext) => {
      expect(ctx.agentId).toBe('mailer');
      expect(ctx.now()).toEqual(f.row.created_at);
      return { envelope: f.row.envelope, preview: 'send' };
    });
    f.tool.describe = describeEffect;
    expect(await f.run()).toMatchObject({ ok: true });
    expect(describeEffect).toHaveBeenCalledOnce();
  });

  it('aborts the operation on timeout and records unknown completion', async () => {
    const f = fixture();
    let stopped = false;
    f.execute.mockImplementation(async (_args, ctx) => new Promise((_resolve, reject) => {
      ctx.signal!.addEventListener('abort', () => { stopped = true; reject(ctx.signal!.reason); }, { once: true });
    }));
    expect(await f.run(10)).toMatchObject({ state: 'unknown', reason: 'timeout' });
    expect(stopped).toBe(true);
  });

  it('records unknown when the caller cancels an in-flight effect', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.ctx.signal = controller.signal;
    f.execute.mockImplementation(async () => {
      controller.abort(new Error('stop'));
      return new Promise(() => {});
    });
    expect(await f.run()).toMatchObject({ state: 'unknown', reason: 'cancelled' });
  });
});

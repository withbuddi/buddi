/**
 * The Keys and secrets writes run as the owner: an ownerOnly tool answers
 * "unknown tool" to anybody else, and the dashboard is the owner's own hand.
 */
import { describe, expect, it, vi } from 'vitest';
import { OWNER_AGENT_ID } from '@buddi/core';
import { isUnused, secretUsers, secretsAct } from './secrets.js';

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

describe('what holds a secret, and what nothing holds any more', () => {
  const registered = new Set(['browser.field', 'http.header', 'http.url', 'email.account', 'accounts.provider', 'mcp.env']);
  const mailbox = { kind: 'mailbox' as const, id: 'm1', address: 'sam@example.com', provider: 'Gmail', auth: 'app-password' as const, loginFailedAt: null };

  it('a secret something holds is in use, whatever its bindings say', () => {
    expect(isUnused({ name: 'EMAIL_SAM_EXAMPLE_COM_1a2b3c4d', bindings: [{ kind: 'email.account', target: 'm1' }] }, [mailbox], registered)).toBe(false);
  });

  it('an old mailbox password no mailbox names is unused, bound or not', () => {
    // Still bound to the mailbox, but the mailbox's row names its own password now.
    expect(isUnused({ name: 'GMAIL_APP_PASSWORD', bindings: [{ kind: 'email.account', target: 'm1' }] }, [], registered)).toBe(true);
    expect(isUnused({ name: 'GMAIL_APP_PASSWORD', bindings: [] }, [], registered)).toBe(true);
    expect(isUnused({ name: 'PROVIDER_ACCOUNT_5d0c7a4e_1b2c', bindings: [] }, [], registered)).toBe(true);
  });

  it('the owner’s own secret is never called unused for having no binding yet, nor for a place it may go', () => {
    expect(isUnused({ name: 'PNC password', bindings: [] }, [], registered)).toBe(false);
    expect(isUnused({ name: 'PNC password', bindings: [{ kind: 'browser.field', target: 'https://pnc.com' }] }, [], registered)).toBe(false);
    expect(isUnused({ name: 'Calendar link: Work', bindings: [{ kind: 'http.url', target: { plugin: 'calendar', host: 'calendar.google.com' } }] }, [], registered)).toBe(false);
  });

  it('a binding to a kind no installed plugin registers binds nothing', () => {
    expect(isUnused({ name: 'Old token', bindings: [{ kind: 'gone.field', target: 'x' }] }, [], registered)).toBe(true);
  });

  it('reads the mailboxes, model accounts and connections that name a secret, and skips a table that is not there', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('email.accounts')) {
        return { rows: [
          { id: 'm1', address: 'sam@example.com', imap_host: 'imap.gmail.com', auth_mode: 'app-password', secret_name: 'EMAIL_SAM', added_via: 'page', login_failed_at: '2026-10-01T10:00:00Z' },
          { id: 'm2', address: 'old@example.com', imap_host: 'imap.gmail.com', auth_mode: 'app-password', secret_name: 'EMAIL_OLD', added_via: 'env', login_failed_at: null },
        ] };
      }
      if (sql.includes('core.provider_accounts')) return { rows: [{ id: 'a1', label: 'Claude', auth: 'api-key', secret_ref: 'PROVIDER_ACCOUNT_1' }] };
      throw Object.assign(new Error('relation "mcp.connections" does not exist'), { code: '42P01' });
    });
    const users = await secretUsers({ query } as never);
    expect(users.get('EMAIL_SAM')).toEqual([expect.objectContaining({ kind: 'mailbox', address: 'sam@example.com', provider: 'Gmail', loginFailedAt: '2026-10-01T10:00:00Z' })]);
    // A mailbox the old `.env` named still falls back to the legacy password.
    expect(users.get('GMAIL_APP_PASSWORD')).toEqual([expect.objectContaining({ kind: 'mailbox', address: 'old@example.com' })]);
    expect(users.get('PROVIDER_ACCOUNT_1')).toEqual([{ kind: 'model-account', id: 'a1', label: 'Claude', auth: 'api-key' }]);
  });
});

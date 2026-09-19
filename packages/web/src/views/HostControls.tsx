import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../ui';

/** Owner controls, never model-authored permission switches. */
export function HostControls({ agentId, conversationId }: { agentId?: string; conversationId?: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.host(agentId, conversationId), [agentId, conversationId], 2000);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setFailure(null);
    try { await action(); reload(); }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const permissions = data?.permissions ?? [];
  const running = data?.runs ?? [];
  const label = permissions.some(p => !p.conversationId) ? 'Always allowed' : permissions.length ? 'Conversation auto-mode' : 'Ask each time';
  return <details className="host-controls">
    <summary>Host execution · {error ? 'Status unavailable' : label}{running.length ? ` · ${running.length} running` : ''}</summary>
    <p className="muted">Commands run as your user, not in a sandbox. Auto-mode covers all commands within its scope. Stop interrupts a command; revoke also ends the permission. Neither undoes completed changes.</p>
    {error || failure ? <p className="err-banner">{failure ?? error}</p> : null}
    {permissions.map(permission => <div className="bar" key={permission.id}>
      <span>{permission.agentId}: {permission.conversationId ? 'conversation auto-mode' : 'always allowed'}</span>
      <button disabled={busy} onClick={() => void run(() => api.revokeHost(permission.id))}>Revoke permission</button>
    </div>)}
    {!permissions.length ? <p className="muted">The next command will ask for approval. Choose its permission scope there.</p> : null}
    {running.map(command => <div key={command.actionId}>
      <p>{command.agentId} · {command.cwd}</p>
      <pre>{command.command}</pre>
      <pre aria-label="Command output">{command.stdout || command.stderr ? `${command.stdout}\n${command.stderr}` : 'Waiting for output…'}</pre>
      <button disabled={busy} onClick={() => void run(() => api.stopHost(command.agentId, command.conversationId))}>Stop command</button>
    </div>)}
  </details>;
}

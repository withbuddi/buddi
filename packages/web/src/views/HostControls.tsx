import { useState } from 'react';
import { api } from '../api';
import { Button, Code, Details, ErrorBanner, Stack, Toolbar, useAsync } from '../ui';

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
  return (
    <Details
      className="host-controls"
      summary={`Host execution · ${error ? 'Status unavailable' : label}${running.length ? ` · ${running.length} running` : ''}`}
    >
      <Stack gap="sm">
        <p className="muted">Commands run as your user, not in a sandbox. Auto-mode covers all commands within its scope. Stop interrupts a command; revoke also ends the permission. Neither undoes completed changes.</p>
        <ErrorBanner message={failure ?? error} />
        {permissions.map(permission => (
          <Toolbar key={permission.id}>
            <span>{permission.agentId}: {permission.conversationId ? 'conversation auto-mode' : 'always allowed'}</span>
            <Button size="sm" disabled={busy} onClick={() => void run(() => api.revokeHost(permission.id))}>Revoke permission</Button>
          </Toolbar>
        ))}
        {!permissions.length ? <p className="muted">The next command will ask for approval. Choose its permission scope there.</p> : null}
        {running.map(command => (
          <Stack gap="sm" key={command.actionId}>
            <p>{command.agentId} · <span className="mono">{command.cwd}</span></p>
            <Code>{command.command}</Code>
            <Code label="Command output">{command.stdout || command.stderr ? `${command.stdout}\n${command.stderr}` : 'Waiting for output…'}</Code>
            <Toolbar><Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => api.stopHost(command.agentId, command.conversationId))}>Stop command</Button></Toolbar>
          </Stack>
        ))}
      </Stack>
    </Details>
  );
}

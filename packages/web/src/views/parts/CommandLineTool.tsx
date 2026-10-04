/**
 * Settings → System, in buddi.app: "Install Command Line Tool", the same as
 * the app menu's item. The supervisor writes `/usr/local/bin/buddi` (macOS
 * asks for an administrator once) or `~/.local/bin/buddi`, a few lines that
 * run the app's own copy with its own data folder, and survive updates.
 * Outside the app the row is absent: npm's buddi is already on PATH.
 */
import { useState } from 'react';
import { ApiError, api } from '../../api';
import { Button, ErrorBanner, Notice, Section, Stack, Toolbar, useAsync } from '../../ui';

export function CommandLineTool(): JSX.Element | null {
  const view = useAsync(() => api.cliTool(), []);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [said, setSaid] = useState<string[] | null>(null);
  const data = view.data;
  if (!data?.available) return null;
  const install = (): void => {
    setBusy(true);
    setFailed(null);
    setSaid(null);
    api
      .installCliTool()
      .then((answer) => { setSaid(answer.lines); view.reload(); })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const installed = data.installed[0];
  return (
    <Section title="Command line" panel>
      <Stack gap="sm">
        <ErrorBanner message={failed} />
        <p className="ui-card-meta">
          {installed
            ? <>Terminal's <span className="mono">buddi</span> is <span className="mono">{installed}</span>, and runs this app's buddi.</>
            : <>Use <span className="mono">buddi</span> in Terminal: it runs this app's buddi and keeps working after updates. macOS asks for your password once.</>}
        </p>
        {said ? <Notice tone="good" role="status">{said.join(' ')}</Notice> : null}
        <Toolbar align="end">
          <Button disabled={busy} onClick={install}>
            {installed ? 'Install Again' : 'Install Command Line Tool'}
          </Button>
        </Toolbar>
      </Stack>
    </Section>
  );
}

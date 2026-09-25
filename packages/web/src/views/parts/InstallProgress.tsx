/**
 * A browser install as the owner sees it: one line in buddi's words and a
 * bar. The installer's own output (`|■■■■   | 45% of 150 MiB`) is read into
 * numbers by the gateway and never shown.
 */
import type { BrowserInstallProgress } from '../../api';
import { Progress, Stack } from '../../ui';

/** "Fetching Chromium… 45%", "Setting up Chromium…". */
export function installLine(progress: BrowserInstallProgress | undefined): string {
  if (!progress || progress.download === 0) return 'Fetching the browser…';
  if (progress.phase === 'downloading') return `Fetching ${progress.what}… ${progress.percent}%`;
  if (progress.phase === 'installing') return `Setting up ${progress.what}…`;
  if (progress.phase === 'done') return 'Installed.';
  return 'The install stopped.';
}

export function InstallProgress({ progress }: { progress: BrowserInstallProgress | undefined }): JSX.Element {
  return (
    <Stack gap="sm">
      <span role="status">{installLine(progress)}</span>
      <Progress value={progress?.percent ?? 0} label="Fetching the browser" />
    </Stack>
  );
}

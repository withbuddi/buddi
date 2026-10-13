/**
 * "v3 · Versions": a file's place in its history, on its canvas panel. The
 * panel draws the newest version only; the link opens the file's page in
 * Files, where every version is listed with View and Restore. Nothing when
 * the file has one version, or when Files cannot say.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { fileRoute } from '../../routes';

export function FileVersionsLink({ artifactId, revision }: { artifactId: string; revision?: string }): JSX.Element | null {
  const [found, setFound] = useState<{ count: number; latest: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.libraryEntry(artifactId)
      .then((entry) => {
        const versions = entry.versions ?? [];
        if (!cancelled) setFound(versions.length > 1 ? { count: versions.length, latest: versions[0]!.id } : null);
      })
      .catch(() => { if (!cancelled) setFound(null); });
    return () => { cancelled = true; };
  }, [artifactId, revision]);
  if (!found) return null;
  return <a className="ui-btn" data-variant="ghost" data-size="sm" href={fileRoute(found.latest)}>v{found.count} · Versions</a>;
}

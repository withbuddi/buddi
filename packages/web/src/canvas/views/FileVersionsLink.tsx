/**
 * "v3 · Versions": a file's place in its history, on its canvas panel. The
 * panel draws the current version only; the link opens the file's page in
 * Files, where every version is listed with View and Restore. Read from the
 * same `GET /api/files/:id` the editor's file is. Nothing when the file has
 * one version, or when Files cannot say.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { fileRoute } from '../../routes';

export function FileVersionsLink({ fileId, revision }: { fileId: string; revision?: number }): JSX.Element | null {
  const [found, setFound] = useState<{ count: number; current: number; artifactId: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.file(fileId)
      .then((view) => {
        if (!cancelled) setFound(view.versions.length > 1 ? { count: view.versions.length, current: view.current.version, artifactId: view.current.artifactId } : null);
      })
      .catch(() => { if (!cancelled) setFound(null); });
    return () => { cancelled = true; };
  }, [fileId, revision]);
  if (!found) return null;
  return <a className="ui-btn" data-variant="ghost" data-size="sm" href={fileRoute(found.artifactId)} title={`${found.count} versions`}>v{found.current} · Versions</a>;
}

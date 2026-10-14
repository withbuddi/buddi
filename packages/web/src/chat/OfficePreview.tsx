/**
 * A Word, Excel or PowerPoint file, previewed where it is opened — the
 * Canvas or Files — by the one switch in `ArtifactPreview`.
 *
 * The file's bytes come from the preview route (the same auth, at most
 * 20 MB) and are parsed here, by a renderer loaded only now, one chunk per
 * kind (`office/docx`, `office/xlsx`, `office/pptx`): the dashboard's own
 * bundle carries none of them. Nothing in the file runs on this page: a
 * document is drawn into a sandboxed frame with no scripts, a workbook's
 * cells are text in buddi's own table, a deck is painted on a canvas.
 */
import { useEffect, useState, type ComponentType } from 'react';
import type { OfficeKind } from '@buddi/core/office-files';
import { Empty, Notice } from '../ui';
import { previewUrl } from './attachments';

export interface OfficeViewerProps {
  bytes: ArrayBuffer;
  name: string;
}

/** Each kind's renderer, loaded on first use. */
const VIEWERS: Record<OfficeKind, () => Promise<{ default: ComponentType<OfficeViewerProps> }>> = {
  docx: () => import('./office/docx'),
  xlsx: () => import('./office/xlsx'),
  pptx: () => import('./office/pptx'),
};

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; bytes: ArrayBuffer; Viewer: ComponentType<OfficeViewerProps> }
  | { phase: 'too-large' }
  | { phase: 'failed' };

export function OfficePreview({ artifactId, filename, kind }: { artifactId: string; filename: string | null; kind: OfficeKind }): JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    const bytes = fetch(previewUrl(artifactId), { credentials: 'same-origin' }).then(async (res) => {
      if (res.status === 413) return 'too-large' as const;
      if (!res.ok) throw new Error(String(res.status));
      return res.arrayBuffer();
    });
    Promise.all([bytes, VIEWERS[kind]()])
      .then(([data, module]) => {
        if (cancelled) return;
        setState(data === 'too-large' ? { phase: 'too-large' } : { phase: 'ready', bytes: data, Viewer: module.default });
      })
      .catch(() => { if (!cancelled) setState({ phase: 'failed' }); });
    return () => { cancelled = true; };
  }, [artifactId, kind]);

  if (state.phase === 'loading') return <div className="file-preview"><Empty>Loading preview…</Empty></div>;
  if (state.phase === 'too-large') return <Notice>This file is over 20 MB, too large to preview here. Download it to open it.</Notice>;
  if (state.phase === 'failed') return <Notice>The preview could not be loaded. Download the file to open it.</Notice>;
  const { Viewer, bytes } = state;
  return <div className="file-preview file-preview-office" data-kind={kind}><Viewer bytes={bytes} name={filename ?? 'File'} /></div>;
}

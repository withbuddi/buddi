/**
 * A Word, Excel or PowerPoint file, previewed where it is opened — the
 * Canvas or Files — by the one switch in `ArtifactPreview`.
 *
 * The file's bytes come from the preview route (the same auth, at most
 * `OFFICE_PREVIEW_BYTES`), are checked against core's package limits from
 * the zip's directory (`officePackageProblem`), and only then parsed here, by a renderer loaded only now, one chunk per
 * kind (`office/docx`, `office/xlsx`, `office/pptx`): the dashboard's own
 * bundle carries none of them. Nothing in the file runs on this page: a
 * document is drawn into a sandboxed frame with no scripts, a workbook's
 * cells are text in buddi's own table, a deck is painted on a canvas.
 */
import { useEffect, useState, type ComponentType } from 'react';
import { OFFICE_PREVIEW_BYTES, officePackageProblem, type OfficeKind } from '@buddi/core/office-files';
import { Empty, Notice } from '../ui';
import { isChunkLoadError, loadChunk } from '../shell/stale-chunk';
import { previewUrl } from './attachments';

export interface OfficeViewerProps {
  bytes: ArrayBuffer;
  name: string;
}

/** Each kind's renderer, loaded on first use. */
const VIEWERS: Record<OfficeKind, () => Promise<{ default: ComponentType<OfficeViewerProps> }>> = {
  docx: () => loadChunk(() => import('./office/docx')),
  xlsx: () => loadChunk(() => import('./office/xlsx')),
  pptx: () => loadChunk(() => import('./office/pptx')),
};

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; bytes: ArrayBuffer; Viewer: ComponentType<OfficeViewerProps> }
  | { phase: 'too-large' }
  /** Past the package limits, or not a whole package: never handed to a parser. */
  | { phase: 'refused'; why: string }
  | { phase: 'failed' }
  /** The renderer's chunk is gone: the page is from before an update, the file is fine. */
  | { phase: 'stale' };

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
        if (data === 'too-large') { setState({ phase: 'too-large' }); return; }
        // The same limits the server reads with, from the zip's directory, before anything is inflated.
        const problem = officePackageProblem(new Uint8Array(data), kind);
        setState(problem ? { phase: 'refused', why: problem } : { phase: 'ready', bytes: data, Viewer: module.default });
      })
      .catch((error: unknown) => { if (!cancelled) setState({ phase: isChunkLoadError(error) ? 'stale' : 'failed' }); });
    return () => { cancelled = true; };
  }, [artifactId, kind]);

  if (state.phase === 'loading') return <div className="file-preview"><Empty>Loading preview…</Empty></div>;
  if (state.phase === 'too-large') return <Notice>This file is over {Math.round(OFFICE_PREVIEW_BYTES / 1024 / 1024)} MB, too large to preview here. Download it to open it.</Notice>;
  if (state.phase === 'refused') return <Notice>This file can’t be previewed: {state.why}. Download it to open it.</Notice>;
  if (state.phase === 'stale') return <Notice>This part of buddi was updated. Reload the page to see the preview.</Notice>;
  if (state.phase === 'failed') return <Notice>The preview could not be loaded. Download the file to open it.</Notice>;
  const { Viewer, bytes } = state;
  return <div className="file-preview file-preview-office" data-kind={kind}><Viewer bytes={bytes} name={filename ?? 'File'} /></div>;
}

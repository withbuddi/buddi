/**
 * A Word document's pages, drawn by docx-preview (Apache-2.0) into a frame
 * sandboxed with no scripts: its markup and styles stay in the frame, and
 * nothing in the file runs. Images are inlined; comments, tracked changes
 * and embedded HTML are left out. Loaded only when a .docx is opened.
 */
import { renderAsync } from 'docx-preview';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '../../ui';
import type { OfficeViewerProps } from '../OfficePreview';

/** The frame's own page: the document on the sunken ground, its pages centred. */
const FRAME_CSS = `
  html, body { margin: 0; background: transparent; }
  .docx-wrapper { background: transparent !important; padding: 16px !important; }
  .docx-wrapper > section.docx { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18); margin-bottom: 16px !important; }
`;

export default function DocxPreview({ bytes, name }: OfficeViewerProps): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    let cancelled = false;
    setFailed(false);
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    renderAsync(bytes, doc.body, doc.head, {
      inWrapper: true, ignoreLastRenderedPageBreak: true, useBase64URL: true, experimental: false,
      renderComments: false, renderChanges: false, renderAltChunks: false,
    })
      .then(() => {
        // After docx-preview's own styles, which it writes into the head as it renders.
        const style = doc.createElement('style');
        style.textContent = FRAME_CSS;
        doc.head.appendChild(style);
        // As tall as its pages: the panel scrolls, not the frame.
        if (!cancelled && frame.current) frame.current.style.height = `${Math.max(doc.documentElement.scrollHeight, 200)}px`;
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [bytes]);
  return (
    <>
      {failed ? <Notice>This document could not be read. Download it to open it.</Notice> : null}
      <iframe ref={frame} className="office-docx" sandbox="allow-same-origin" title={name} data-testid="office-docx" hidden={failed} />
    </>
  );
}

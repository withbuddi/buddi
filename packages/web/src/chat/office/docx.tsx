/**
 * A Word document's pages, drawn by docx-preview (Apache-2.0) into a frame
 * sandboxed with no scripts: its markup and styles stay in the frame, and
 * nothing in the file runs. Images are inlined; comments, tracked changes
 * and embedded HTML are left out. Office font names fall back to what this
 * computer has (`OFFICE_FONT_FALLBACKS`). Loaded only when a .docx is opened.
 */
import { renderAsync } from 'docx-preview';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '../../ui';
import type { OfficeViewerProps } from '../OfficePreview';

/**
 * The fonts Office documents name, each with what stands in for it where it
 * is not installed: its metric-compatible twin (Carlito, Caladea, Liberation),
 * then what a Mac, Windows or Linux has. The original comes first, so a
 * computer with Office draws the real font. Without this the browser draws
 * a Calibri it lacks in its default serif.
 */
export const OFFICE_FONT_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  Calibri: ['Calibri', 'Carlito', 'Helvetica Neue', 'Arial', 'Liberation Sans', 'DejaVu Sans'],
  'Calibri Light': ['Calibri Light', 'Carlito', 'Helvetica Neue', 'Arial', 'Liberation Sans', 'DejaVu Sans'],
  Aptos: ['Aptos', 'Carlito', 'Helvetica Neue', 'Arial', 'Liberation Sans', 'DejaVu Sans'],
  Cambria: ['Cambria', 'Caladea', 'Georgia', 'Times New Roman', 'Liberation Serif', 'DejaVu Serif'],
  'Times New Roman': ['Times New Roman', 'Liberation Serif', 'Times', 'DejaVu Serif'],
  'Segoe UI': ['Segoe UI', 'SF Pro Text', 'Helvetica Neue', 'Arial', 'Liberation Sans', 'DejaVu Sans'],
  Consolas: ['Consolas', 'Menlo', 'SF Mono', 'Liberation Mono', 'DejaVu Sans Mono', 'Courier New'],
};

const FACES = [
  { weight: 400, style: 'normal', suffix: '' },
  { weight: 700, style: 'normal', suffix: ' Bold' },
  { weight: 400, style: 'italic', suffix: ' Italic' },
  { weight: 700, style: 'italic', suffix: ' Bold Italic' },
] as const;

/**
 * `@font-face` rules that make each Office font name resolve to the first of
 * its stand-ins this computer has, by `local()` only: nothing is fetched.
 * One rule per weight and style, so bold and italic use the real faces.
 */
export function officeFontFaces(): string {
  return Object.entries(OFFICE_FONT_FALLBACKS).flatMap(([family, chain]) => FACES.map(({ weight, style, suffix }) => {
    const src = chain.map((font) => `local('${font}${suffix}')`).join(', ');
    return `@font-face { font-family: '${family}'; font-weight: ${weight}; font-style: ${style}; src: ${src}; }`;
  })).join('\n');
}

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
        // After docx-preview's own styles, which it writes into the head as it
        // renders (clearing it first): the frame's page, and the Office fonts
        // resolved to what this computer has.
        const style = doc.createElement('style');
        style.textContent = `${officeFontFaces()}\n${FRAME_CSS}`;
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

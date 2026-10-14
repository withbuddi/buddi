/**
 * A deck, slide by slide, painted on a canvas by @silurus/ooxml (MIT; a
 * Rust/WASM parser and a Canvas 2D renderer), with Previous and Next. Read
 * only: nothing in the file runs, and no font is fetched (its Google Fonts
 * option stays off). Loaded only when a .pptx is opened.
 */
import { PptxViewer } from '@silurus/ooxml/pptx';
import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Notice } from '../../ui';
import type { OfficeViewerProps } from '../OfficePreview';

export default function PptxPreview({ bytes, name }: OfficeViewerProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<PptxViewer | null>(null);
  const [slide, setSlide] = useState<{ at: number; of: number } | 'loading' | 'failed'>('loading');
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    let cancelled = false;
    setSlide('loading');
    // As wide as the panel lets it be, at most a laptop screen's slide.
    const width = Math.min(Math.max(target.parentElement?.clientWidth ?? 640, 320), 1280);
    const deck = new PptxViewer(target, {
      width, useGoogleFonts: false, enableHyperlinks: false, enableMediaPlayback: false,
      onSlideChange: (index, total) => { if (!cancelled) setSlide({ at: index, of: total }); },
      onError: () => { if (!cancelled) setSlide('failed'); },
    });
    viewer.current = deck;
    deck.load(bytes.slice(0))
      .then(() => { if (!cancelled) setSlide({ at: deck.slideIndex, of: deck.slideCount }); })
      .catch(() => { if (!cancelled) setSlide('failed'); });
    return () => {
      cancelled = true;
      viewer.current = null;
      deck.destroy();
    };
  }, [bytes]);

  const go = (step: -1 | 1): void => { void (step < 0 ? viewer.current?.prevSlide() : viewer.current?.nextSlide()); };
  return (
    <div className="office-pptx" data-testid="office-pptx">
      {slide === 'failed' ? <Notice>This presentation could not be read. Download it to open it.</Notice> : null}
      {slide === 'loading' ? <Empty>Reading the presentation…</Empty> : null}
      <div className="office-pptx-stage" hidden={slide === 'failed'}><canvas ref={canvas} aria-label={name} /></div>
      {typeof slide === 'object' ? (
        <div className="ui-toolbar" data-align="end">
          <span className="muted">Slide {slide.at + 1} of {slide.of}</span>
          <Button size="sm" disabled={slide.at <= 0} onClick={() => go(-1)}>Previous</Button>
          <Button size="sm" disabled={slide.at >= slide.of - 1} onClick={() => go(1)}>Next</Button>
        </div>
      ) : null}
    </div>
  );
}

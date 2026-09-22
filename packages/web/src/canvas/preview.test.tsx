/**
 * The `preview` panel: a process of the owner's, framed beside its output.
 *
 * The property worth a test is the refusal. This panel puts a URL a *plugin*
 * chose into an iframe on the dashboard's own origin, with the owner's session
 * on it — so the only address it may point at is one this gateway proxies,
 * under `/preview/`. Everything else about the panel is layout; this is the
 * rule, and it is asserted from both sides: the resolver drops the address,
 * and the panel draws no frame at all.
 */
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDescriptor, isPreviewPath, resolvePreview } from './resolve';
import { PreviewView } from './views/PreviewView';
import { rendererFor, RENDERERS } from './registry';
import { hasSubstance } from './renderables';
import type { PreviewMap } from './types';

afterEach(cleanup);

const map: PreviewMap = { src: 'url', title: { path: 'name' }, output: 'recent' };

describe('resolving a preview', () => {
  it('takes the frame, the heading and the output out of the result', () => {
    expect(
      resolvePreview({ url: '/preview/developer/web/', name: 'web', recent: 'ready in 412 ms' }, map),
    ).toEqual({ src: '/preview/developer/web/', title: 'web', output: 'ready in 412 ms' });
  });

  it('drops any address that is not one this gateway proxies', () => {
    for (const src of [
      // An absolute URL is an absolute URL whatever host it names; this one
      // keeps the bundle test's rule that no source file names a remote host.
      'https://127.0.0.1/elsewhere',
      '//elsewhere.example/',
      '/api/artifacts/1/download',
      '/',
      'preview/developer/web/',
      'javascript:alert(1)',
    ]) {
      expect(isPreviewPath(src), src).toBe(false);
      expect(resolvePreview({ url: src }, map).src, src).toBeNull();
    }
    expect(isPreviewPath('/preview/developer/web/')).toBe(true);
  });

  it('is reached by the renderer name a descriptor asks for', () => {
    expect(applyDescriptor(
      { tool: 'developer.preview', renderer: 'preview', map },
      { url: '/preview/developer/web/' },
    )).toEqual({
      renderer: 'preview',
      props: { src: '/preview/developer/web/', title: null, output: null },
    });
    expect(rendererFor('preview')).toBe(RENDERERS.preview);
  });

  it('earns its tab from the address, not from the output', () => {
    expect(hasSubstance('preview', { src: '/preview/developer/web/', output: null })).toBe(true);
    expect(hasSubstance('preview', { src: null, output: 'a page of logs' })).toBe(false);
  });
});

describe('the panel', () => {
  it('frames the process, sandboxed, with a way out of the frame', () => {
    render(
      <PreviewView
        props={{ src: '/preview/developer/web/', title: 'web', output: 'ready in 412 ms' }}
      />,
    );
    const frame = screen.getByTitle('web');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', '/preview/developer/web/');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
    // An app that refuses framing shows an empty box; the link is the answer,
    // so it is always there.
    expect(screen.getByRole('link', { name: 'Open in a tab' })).toHaveAttribute(
      'href',
      '/preview/developer/web/',
    );
    expect(screen.getByText('ready in 412 ms')).toBeInTheDocument();
  });

  it('draws nothing framed when the address was refused', () => {
    render(<PreviewView props={{ src: null, title: 'web', output: null }} />);
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/no address on this dashboard/)).toBeInTheDocument();
  });
});

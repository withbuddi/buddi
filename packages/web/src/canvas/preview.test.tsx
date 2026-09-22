/**
 * The `preview` panel: a process of the owner's, framed beside its output.
 *
 * The property worth a test is what the panel is *allowed* to frame. A
 * preview lives on a second origin with a credential of its own, so this
 * panel cannot construct a URL at all: a descriptor names a process, the
 * panel asks the dashboard's link route, and frames the answer. Anything the
 * descriptor says that is not a preview — the dashboard's own paths, another
 * site, a path that resolves out of the prefix — names no process and is
 * drawn as nothing.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyDescriptor, previewTarget, resolvePreview } from './resolve';
import { PreviewView } from './views/PreviewView';
import { rendererFor, RENDERERS } from './registry';
import { hasSubstance } from './renderables';
import { api } from '../api';
import type { PreviewMap } from './types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const map: PreviewMap = { src: 'url', title: { path: 'name' }, output: 'recent' };
const TICKETED = 'http://127.0.0.1:4318/preview/developer/web/?ticket=abc';

describe('resolving a preview', () => {
  it('takes the process, the heading and the output out of the result', () => {
    expect(
      resolvePreview({ url: '/preview/developer/web/', name: 'web', recent: 'ready in 412 ms' }, map),
    ).toEqual({
      target: { plugin: 'developer', name: 'web' },
      title: 'web',
      output: 'ready in 412 ms',
    });
  });

  it('names no process for anything that is not a preview', () => {
    for (const src of [
      // An absolute URL is an absolute URL whatever host it names; this one
      // keeps the bundle test's rule that no source file names a remote host.
      'https://127.0.0.1/elsewhere',
      '//elsewhere.example/',
      '/api/artifacts/1/download',
      '/',
      'preview/developer/web/',
      'javascript:alert(1)',
      // The two that a `startsWith('/preview/')` would have waved through:
      // the browser resolves both to the dashboard's own root.
      '/preview/../../',
      '/preview/developer/../../api/approvals',
      // A preview is a plugin and a process, and nothing deeper.
      '/preview/developer',
      '/preview/developer/web/assets/app.js',
    ]) {
      expect(previewTarget(src), src).toBeNull();
      expect(resolvePreview({ url: src }, map).target, src).toBeNull();
    }
    expect(previewTarget('/preview/developer/web/')).toEqual({ plugin: 'developer', name: 'web' });
    expect(previewTarget('/preview/developer/web')).toEqual({ plugin: 'developer', name: 'web' });
  });

  it('is reached by the renderer name a descriptor asks for', () => {
    expect(applyDescriptor(
      { tool: 'developer.preview', renderer: 'preview', map },
      { url: '/preview/developer/web/' },
    )).toEqual({
      renderer: 'preview',
      props: { target: { plugin: 'developer', name: 'web' }, title: null, output: null },
    });
    expect(rendererFor('preview')).toBe(RENDERERS.preview);
  });

  it('earns its tab from the process, not from the output', () => {
    expect(hasSubstance('preview', { target: { plugin: 'developer', name: 'web' } })).toBe(true);
    expect(hasSubstance('preview', { target: null, output: 'a page of logs' })).toBe(false);
  });
});

describe('the panel', () => {
  it('asks the dashboard for a link, then frames it', async () => {
    const link = vi.spyOn(api, 'previewLink').mockResolvedValue({ url: TICKETED });
    render(
      <PreviewView
        props={{ target: { plugin: 'developer', name: 'web' }, title: 'web', output: 'ready in 412 ms' }}
      />,
    );
    await waitFor(() => expect(screen.getByTitle('web')).toBeInTheDocument());
    expect(link).toHaveBeenCalledWith('developer', 'web');
    const frame = screen.getByTitle('web');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', TICKETED);
    // No `sandbox`: the frame is cross-origin already, and `allow-same-origin`
    // on a same-origin frame was the hole this whole arrangement closes.
    expect(frame).not.toHaveAttribute('sandbox');
    // An app that refuses framing shows an empty box; the link is the answer.
    expect(screen.getByRole('link', { name: 'Open in a tab' })).toHaveAttribute('href', TICKETED);
    expect(screen.getByText('ready in 412 ms')).toBeInTheDocument();
  });

  it('says so when the link cannot be had, and frames nothing', async () => {
    vi.spyOn(api, 'previewLink').mockRejectedValue(new Error('no such preview'));
    render(<PreviewView props={{ target: { plugin: 'developer', name: 'web' }, title: 'web', output: null }} />);
    await waitFor(() => expect(screen.getByText('no such preview')).toBeInTheDocument());
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('draws nothing framed, and asks for nothing, when no process was named', () => {
    const link = vi.spyOn(api, 'previewLink');
    render(<PreviewView props={{ target: null, title: 'web', output: null }} />);
    expect(document.querySelector('iframe')).toBeNull();
    expect(link).not.toHaveBeenCalled();
    expect(screen.getByText(/names no preview/)).toBeInTheDocument();
  });
});

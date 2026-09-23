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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyDescriptor, previewTarget, resolvePreview } from './resolve';
import { PreviewView } from './views/PreviewView';
import { rendererFor, RENDERERS } from './registry';
import { hasSubstance } from './renderables';
import { api } from '../api';
import type { PreviewMap } from './types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const map: PreviewMap = { src: 'url', title: { path: 'name' }, output: 'recent', port: 'port' };
const TICKETED = 'http://127.0.0.1:4318/preview/developer/web/?ticket=abc';

describe('resolving a preview', () => {
  it('takes the process, the heading and the output out of the result', () => {
    expect(
      resolvePreview({ url: '/preview/developer/web/', name: 'web', recent: 'ready in 412 ms', port: 5173 }, map),
    ).toEqual({
      target: { plugin: 'developer', name: 'web' },
      title: 'web',
      output: 'ready in 412 ms',
      port: 5173,
    });
    // A port that is not one is no link.
    expect(resolvePreview({ url: '/preview/developer/web/', port: '5173' }, map).port).toBeNull();
    expect(resolvePreview({ url: '/preview/developer/web/', port: 70000 }, map).port).toBeNull();
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
      props: { target: { plugin: 'developer', name: 'web' }, title: null, output: null, port: null },
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
        props={{ target: { plugin: 'developer', name: 'web' }, title: 'web', output: 'ready in 412 ms', port: 5173 }}
      />,
    );
    await waitFor(() => expect(screen.getByTitle('web')).toBeInTheDocument());
    expect(link).toHaveBeenCalledWith('developer', 'web');
    const frame = screen.getByTitle('web');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', TICKETED);
    // Cross-origin *and* sandboxed: the origin keeps the app away from the
    // dashboard's cookies and API, the sandbox keeps it from navigating the
    // top window or opening tabs nobody asked for.
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-same-origin allow-modals allow-downloads',
    );
    // An app that refuses framing shows an empty box; the link is the answer.
    // Its href is the clean URL: the frame's load spent the ticket and bought
    // the cookie, and the cookie answers for the clean path.
    expect(screen.getByRole('link', { name: 'Open in a tab' })).toHaveAttribute(
      'href',
      'http://127.0.0.1:4318/preview/developer/web/',
    );
    // And the process itself, for when the owner is at the machine.
    expect(screen.getByRole('link', { name: 'localhost:5173' })).toHaveAttribute('href', 'http://localhost:5173/');
    // The process output is there on request, not beside the app by default.
    expect(screen.queryByText('ready in 412 ms')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Output' }));
    expect(screen.getByText('ready in 412 ms')).toBeInTheDocument();
  });

  it('readies a fresh ticket for the tab on hover, and never opens a window itself', async () => {
    const link = vi
      .spyOn(api, 'previewLink')
      .mockResolvedValueOnce({ url: TICKETED })
      .mockResolvedValueOnce({ url: `${TICKETED}2` });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<PreviewView props={{ target: { plugin: 'developer', name: 'web' }, title: 'web', output: null, port: null }} />);
    await waitFor(() => expect(screen.getByTitle('web')).toBeInTheDocument());

    const anchor = screen.getByRole('link', { name: 'Open in a tab' });
    // A real link the browser opens: `window.open` with `noopener` hands
    // back nothing to navigate, which is how the tab came up about:blank.
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor.getAttribute('rel')).toContain('noopener');
    fireEvent.pointerEnter(anchor);
    await waitFor(() => expect(anchor).toHaveAttribute('href', `${TICKETED}2`));
    expect(link).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('says so when the link cannot be had, and frames nothing', async () => {
    vi.spyOn(api, 'previewLink').mockRejectedValue(new Error('no such preview'));
    render(<PreviewView props={{ target: { plugin: 'developer', name: 'web' }, title: 'web', output: null, port: null }} />);
    await waitFor(() => expect(screen.getByText('no such preview')).toBeInTheDocument());
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('draws nothing framed, and asks for nothing, when no process was named', () => {
    const link = vi.spyOn(api, 'previewLink');
    render(<PreviewView props={{ target: null, title: 'web', output: null, port: null }} />);
    expect(document.querySelector('iframe')).toBeNull();
    expect(link).not.toHaveBeenCalled();
    expect(screen.getByText(/names no preview/)).toBeInTheDocument();
  });
});

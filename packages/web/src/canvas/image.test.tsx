/**
 * The `image` panel: a picture from the Files library, named by a result.
 *
 * The property worth a test is what it will load: a library file's id, and
 * only through the library's own routes. Anything else the descriptor finds
 * — a URL, a path, a name — is no picture. The fixture tool is made up.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { applyDescriptor, libraryFileId, resolveImage } from './resolve';
import { RENDERERS, rendererFor } from './registry';
import { hasSubstance } from './renderables';
import { ImageView } from './views/ImageView';
import type { ImageMap } from './types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ID = '0b6f6a3c-8a41-4d7e-9a8e-3b1f2c4d5e6f';
const map: ImageMap = { src: 'shot', title: { path: 'name' }, caption: { path: 'about' } };

describe('resolving an image', () => {
  it('takes a library id, bare or inside the file object, and nothing else', () => {
    expect(resolveImage({ shot: ID, name: 'garden.png', about: 'The bed, from above' }, map)).toEqual({
      artifactId: ID,
      title: 'garden.png',
      caption: 'The bed, from above',
    });
    expect(libraryFileId({ artifactId: ID.toUpperCase() })).toBe(ID);
    expect(libraryFileId({ id: ID, filename: 'garden.png' })).toBe(ID);
    for (const value of [
      '//elsewhere.example/garden.png',
      '/api/artifacts/../session',
      `/api/artifacts/${ID}/preview`,
      'garden.png',
      `${ID}/../x`,
      42,
      null,
    ]) {
      expect(libraryFileId(value), String(value)).toBeNull();
    }
  });

  it('is reached by the renderer name a descriptor asks for, and earns its tab from the file', () => {
    expect(applyDescriptor({ tool: 'demo.snap', renderer: 'image', map }, { shot: ID })).toEqual({
      renderer: 'image',
      props: { artifactId: ID, title: null, caption: null },
    });
    expect(rendererFor('image')).toBe(RENDERERS.image);
    expect(hasSubstance('image', { artifactId: ID })).toBe(true);
    expect(hasSubstance('image', { artifactId: null })).toBe(false);
  });
});

describe('the panel', () => {
  it('draws the picture through the library, with its name, size, dimensions and a download', async () => {
    vi.spyOn(api, 'libraryEntry').mockResolvedValue({
      entry: { filename: 'garden.png', sizeBytes: 250 * 1024 },
    } as never);
    render(<ImageView props={{ artifactId: ID, title: null, caption: 'The bed, from above' }} />);
    const picture = screen.getByRole('img');
    expect(picture).toHaveAttribute('src', `/api/artifacts/${ID}/preview`);
    expect(picture).toHaveAttribute('alt', 'The bed, from above');
    // A click opens it at full size, in the same tab.
    const open = picture.closest('a');
    expect(open).toHaveAttribute('href', `/api/artifacts/${ID}/preview`);
    expect(open).not.toHaveAttribute('target');

    await waitFor(() => expect(screen.getByText('garden.png')).toBeInTheDocument());
    Object.defineProperty(picture, 'naturalWidth', { configurable: true, value: 1200 });
    Object.defineProperty(picture, 'naturalHeight', { configurable: true, value: 800 });
    fireEvent.load(picture);
    expect(screen.getByText('1200 × 800 · 250 KB')).toBeInTheDocument();

    const download = screen.getByRole('link', { name: 'Download' });
    expect(download).toHaveAttribute('href', `/api/artifacts/${ID}/download`);
    expect(download).toHaveAttribute('download', 'garden.png');
    expect(screen.getByText('The bed, from above')).toBeInTheDocument();
  });

  it('still draws without its library entry, and says so when the file cannot be shown', async () => {
    vi.spyOn(api, 'libraryEntry').mockRejectedValue(new Error('no such file'));
    render(<ImageView props={{ artifactId: ID, title: 'plan.png', caption: null }} />);
    expect(screen.getByText('plan.png')).toBeInTheDocument();
    fireEvent.error(screen.getByRole('img'));
    expect(await screen.findByText(/cannot be shown here/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/api/artifacts/${ID}/download`);
  });

  it('loads nothing for props that name no library file', () => {
    const entry = vi.spyOn(api, 'libraryEntry');
    render(<ImageView props={{ artifactId: '//elsewhere.example/x.png', title: null, caption: null }} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(entry).not.toHaveBeenCalled();
    expect(screen.getByText(/names no file/)).toBeInTheDocument();
  });
});

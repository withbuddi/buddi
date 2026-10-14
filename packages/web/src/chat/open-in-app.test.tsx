/**
 * Open in app on a file's Canvas card (chat/OpenInApp): from this computer
 * the button opens the file in the owner's app, a save there comes back as
 * a new version the card draws, and a save refused because buddi wrote a
 * newer one meanwhile gets the bar every refused save gets. From another
 * device the button is off, and says why.
 *
 * Each test loads the modules afresh: which computer the dashboard is on is
 * read once per page load.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFICE_MIME } from '@buddi/core/office-files';
import type { AttachmentBlock } from './attachments';

const FILE = '11111111-1111-4111-8111-111111111111';
const V1 = '22222222-2222-4222-8222-222222222222';
const attachment: AttachmentBlock = { type: 'attachment', artifactId: V1, fileId: FILE, filename: 'Plan.docx', mime: OFFICE_MIME.docx, kind: 'document', sizeBytes: 9_000 };

const view = (version: number, createdBy: string) => ({
  file: { id: FILE, name: 'Plan.docx', mime: OFFICE_MIME.docx, conversationId: null, origin: 'upload', createdBy: 'owner' },
  current: { fileId: FILE, version, artifactId: `33333333-3333-4333-8333-33333333333${version}`, sha256: 'x', createdBy },
  versions: [], entry: null, contexts: [], contextsTotal: 0, contextsOffset: 0, available: true,
});

beforeEach(() => {
  vi.resetModules();
  // The previews fetch their bytes; here they get none and say so.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function card(signedInThrough: 'local' | 'ticket') {
  const { api } = await import('../api');
  const { ArtifactView } = await import('../canvas/views/ArtifactView');
  vi.spyOn(api, 'session').mockResolvedValue({ timezone: 'UTC', platform: 'darwin', signedInThrough } as never);
  const file = vi.spyOn(api, 'file').mockResolvedValue(view(1, 'writer') as never);
  const state = vi.spyOn(api, 'openInAppState').mockResolvedValue({ open: false });
  const open = vi.spyOn(api, 'openInApp').mockResolvedValue({ open: true, fileId: FILE, name: 'Plan.docx', base: 1 });
  const resolve = vi.spyOn(api, 'resolveOpenInApp').mockResolvedValue({ open: true, fileId: FILE, base: 3, savedVersion: 3 });
  render(<ArtifactView attachment={attachment} />);
  return { api, file, state, open, resolve };
}

describe('Open in app', () => {
  it('opens the file from this computer and draws the version a save there brought back', async () => {
    const { file, state, open } = await card('local');
    const button = await screen.findByRole('button', { name: 'Open in app' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(await screen.findByText('v1, by writer')).toBeInTheDocument();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(button);
    await waitFor(() => expect(open).toHaveBeenCalledWith(FILE));
    expect(await screen.findByText(/Each save there comes back here as a new version/)).toBeInTheDocument();
    // He saves in Word: the next look says v2 came back, and the card reads the file again.
    state.mockResolvedValue({ open: true, fileId: FILE, base: 2, savedVersion: 2 });
    file.mockResolvedValue(view(2, 'owner') as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(await screen.findByText('v2, by you')).toBeInTheDocument();
    expect(screen.getByText(/your last save there is v2/)).toBeInTheDocument();
  });

  it('offers theirs or mine when a save in the app was refused', async () => {
    const { state, resolve } = await card('local');
    state.mockResolvedValue({ open: true, fileId: FILE, base: 1, conflict: 'newer', current: { fileId: FILE, version: 2, artifactId: V1, sha256: 'y', createdBy: 'writer' } });
    expect(await screen.findByText(/This file changed since you opened it \(v2 is newer\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(FILE, 'mine'));
    expect(await screen.findByText(/your last save there is v3/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep mine' })).not.toBeInTheDocument();
  });

  it('is off from another device, saying where it works', async () => {
    const { open, state } = await card('ticket');
    expect(await screen.findByText('Open in app works on the Mac buddi runs on.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in app' })).toBeDisabled();
    expect(open).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  });
});

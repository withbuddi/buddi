/**
 * One frame of another tab, as a file the composer can attach.
 *
 * The browser owns the picking: `getDisplayMedia` opens its own chooser (a
 * tab, a window or the screen, depending on the browser), hands back a video
 * stream, and buddi takes exactly one frame of it, stops the stream, and
 * returns a PNG. Nothing is recorded, nothing leaves the page but the file
 * the owner then sends. A dismissed chooser is `null`, not an error.
 */

export const SNAP_UNSUPPORTED = 'This browser cannot capture a tab. Chrome, Safari and Firefox can, on a secure address.';
export const SNAP_FAILED = 'The tab could not be captured. Try again, and pick the tab itself rather than the whole screen.';

export interface SnapDeps {
  media?: MediaDevices | undefined;
  now?: () => Date;
  document?: Document;
}

const dismissed = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError');

/** Ask the browser for another tab and return one frame of it, or `null` when the owner picked nothing. */
export async function snapTab(deps: SnapDeps = {}): Promise<File | null> {
  const media = deps.media ?? (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices);
  if (!media || typeof media.getDisplayMedia !== 'function') throw new Error(SNAP_UNSUPPORTED);
  let stream: MediaStream;
  try {
    // Chrome reads these hints and starts its chooser on the tab list,
    // without this page in it; the others ignore what they do not know.
    stream = await media.getDisplayMedia({
      video: { displaySurface: 'browser' } as MediaTrackConstraints,
      audio: false,
      ...({ selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', preferCurrentTab: false } as object),
    });
  } catch (error) {
    if (dismissed(error)) return null;
    throw new Error(SNAP_FAILED);
  }
  try {
    const doc = deps.document ?? document;
    const video = doc.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error(SNAP_FAILED));
    });
    await video.play();
    // One more frame after play so the first drawn one is not black.
    await new Promise<void>((resolve) => {
      const rvf = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => void }).requestVideoFrameCallback;
      if (typeof rvf === 'function') rvf.call(video, () => resolve());
      else setTimeout(resolve, 120);
    });
    const canvas = doc.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0) throw new Error(SNAP_FAILED);
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error(SNAP_FAILED);
    const stamp = (deps.now?.() ?? new Date()).toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    return new File([blob], `Tab ${stamp}.png`, { type: 'image/png' });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

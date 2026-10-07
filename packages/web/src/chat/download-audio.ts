import { downloadUrl } from './attachments';

/** Convert locally: no second model call, and the source file stays unchanged. */
export async function downloadMp3(audio: { fileId: string; mime: string; filename: string | null }): Promise<void> {
  const response = await fetch(downloadUrl(audio.fileId), { credentials: 'same-origin' });
  if (!response.ok) throw Error('Audio download failed');
  const bytes = await response.arrayBuffer();
  let blob: Blob;
  if (audio.mime === 'audio/mpeg') blob = new Blob([bytes], { type: 'audio/mpeg' });
  else {
    const context = new AudioContext({ sampleRate: 44100 });
    try {
      const decoded = await context.decodeAudioData(bytes);
      const { Mp3Encoder } = await import('@breezystack/lamejs');
      const channels = Math.min(2, decoded.numberOfChannels);
      const encoder = new Mp3Encoder(channels, decoded.sampleRate, 128);
      const pcm = Array.from({ length: channels }, (_, i) => Int16Array.from(decoded.getChannelData(i), value => Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767))));
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (let offset = 0; offset < decoded.length; offset += 1152) {
        const encoded = encoder.encodeBuffer(pcm[0]!.subarray(offset, offset + 1152), pcm[1]?.subarray(offset, offset + 1152));
        if (encoded.length) parts.push(Uint8Array.from(encoded));
        if (offset % (1152 * 64) === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      parts.push(Uint8Array.from(encoder.flush()));
      blob = new Blob(parts, { type: 'audio/mpeg' });
    } finally { await context.close(); }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${(audio.filename ?? 'recording').replace(/\.[^.]+$/, '')}.mp3`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

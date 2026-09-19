/**
 * Server-sent events, read off a transport tap.
 *
 * Both providers stream their answer as `text/event-stream`: a sequence of
 * frames separated by a blank line, each with an optional `event:` name and
 * one or more `data:` lines. This parser holds the leftover between chunks
 * so a frame split across two reads is one frame, and hands each complete
 * frame's data — parsed as JSON — to the caller. Nothing here knows what the
 * frames mean; that is the adapter's business.
 */
export interface SseFrame {
  event: string | null;
  data: string;
}

export class SseParser {
  #rest = '';

  /** Feed one chunk; get back every frame it completed. */
  push(chunk: string): SseFrame[] {
    this.#rest += chunk.replace(/\r\n/g, '\n');
    const frames: SseFrame[] = [];
    for (;;) {
      const gap = this.#rest.indexOf('\n\n');
      if (gap === -1) break;
      const raw = this.#rest.slice(0, gap);
      this.#rest = this.#rest.slice(gap + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Whatever a stream that ended without a trailing blank line left behind. */
  end(): SseFrame[] {
    const raw = this.#rest;
    this.#rest = '';
    const frame = raw.trim() === '' ? null : parseFrame(raw);
    return frame ? [frame] : [];
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** `data:` as JSON, or null for `[DONE]` and anything that is not JSON. */
export function frameJson(frame: SseFrame): Record<string, unknown> | null {
  if (frame.data === '[DONE]') return null;
  try {
    const parsed: unknown = JSON.parse(frame.data);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

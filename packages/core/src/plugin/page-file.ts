/**
 * The two things a page query may answer besides data: a refusal meant for the
 * owner, and a file. Pure, so they sit in `@buddi/core/plugin`; `pages.ts`
 * re-exports them.
 */
/**
 * A query saying no, in words meant for the owner.
 *
 * Everything else a `produce` throws is a defect, and a defect is a 502 with
 * a generic sentence and the detail in the log. This is the other case: "No
 * conversation here has that id" is an *answer*, the owner is the one who
 * asked, and it reaches them as a 400 carrying this message verbatim. Throw
 * it only for what the owner can act on; never for a bug.
 */
export class QueryRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryRefusal';
  }
}

/* ------------------------------------------------------------------ *
 * Files: the one answer that is not JSON
 * ------------------------------------------------------------------ */

const PAGE_FILE = Symbol.for('buddi.page-file');

/**
 * A query answering with bytes rather than data: a file of a workspace to
 * show, or an archive of a folder to download.
 *
 * The query route carries JSON, and a picture or a PDF drawn from JSON would
 * be base64 inside a 1 MB cap, which is neither honest nor small. So a query
 * may return one of these instead, and the gateway streams it on the same
 * route, behind the same session check, with the content type and the
 * disposition said here — **except** that the gateway, not the plugin, decides
 * what may be shown inline on the dashboard's origin (plain text, passive
 * images, PDF) and serves everything else as a download of
 * `application/octet-stream`. Branded with a registered symbol rather than a
 * class, so a plugin built against another copy of core is still recognised.
 */
export interface PageFile {
  readonly [PAGE_FILE]: true;
  /** The bytes, whole or as a stream the gateway pipes out and closes. */
  body: Buffer | NodeJS.ReadableStream;
  /** What the plugin says it is. The gateway narrows it (see above). */
  contentType: string;
  /** The name a download is saved under. */
  filename: string;
  /** `inline` to show it, `attachment` to save it. */
  disposition: 'inline' | 'attachment';
  /** The length, when it is known before the first byte. */
  size?: number;
  /** True when the bytes are addressed by a version the URL carries: cacheable. */
  immutable?: boolean;
}

export function pageFile(file: Omit<PageFile, typeof PAGE_FILE>): PageFile {
  return { ...file, [PAGE_FILE]: true } as PageFile;
}

export function isPageFile(value: unknown): value is PageFile {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[PAGE_FILE] === true;
}

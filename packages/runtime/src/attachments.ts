/**
 * Attachments: the bridge between the artifact store and a provider request.
 *
 * A surface hands in a photo or a PDF; it is saved as an artifact, and the run
 * carries an `artifact_ref` — id, mime, kind, nothing else. Two rules follow:
 *
 * - **What is persisted is the reference.** `core.messages` never stores base64.
 *   A transcript with a 4 MB statement in it would be re-read on every replay
 *   and would make deletion meaningless; the ref keeps the bytes in one place
 *   that can actually be deleted.
 * - **What is sent is hydrated, per request.** Replay loads the bytes back
 *   through an injected `loadArtifact`, so the runtime holds no store schema. A
 *   reference whose artifact is gone becomes a text placeholder — the model is
 *   told the attachment is unavailable, never silently shown a shorter history.
 *
 * Caps are enforced here and fail closed: v1 does not resize, transcode, or
 * silently drop. Too big is an error the owner can see and act on.
 */
import { ATTACHMENT_UNAVAILABLE, type ContentBlock } from './anthropic.js';

/** Bytes for one artifact, as the loop's injected loader returns them. */
export interface LoadedArtifact {
  mime: string;
  /** base64. */
  data: string;
}

/** Injected by whoever wires the run; the runtime owns no store. */
export type LoadArtifact = (artifactId: string) => Promise<LoadedArtifact | null>;

/** What a caller attaches to a user message. Metadata only — no bytes. */
export interface AttachmentRef {
  artifactId: string;
  mime: string;
  kind: string;
  filename?: string | null;
  sizeBytes?: number;
}

/** Per-message caps. No resizing in v1: over the line is a refusal. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Decoded size of a base64 payload, without decoding it. */
export function base64Bytes(data: string): number {
  const len = data.length;
  if (len === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/** The persisted form of an attachment list. */
export function toArtifactRefBlocks(attachments: readonly AttachmentRef[]): ContentBlock[] {
  return attachments.map((a) => ({
    type: 'artifact_ref' as const,
    artifactId: a.artifactId,
    mime: a.mime,
    kind: a.kind,
    ...(a.filename ? { filename: a.filename } : {}),
    ...(typeof a.sizeBytes === 'number' && a.sizeBytes > 0 ? { sizeBytes: a.sizeBytes } : {}),
  }));
}

/** Only what a model can actually look at travels as bytes: images and PDFs. */
export function isSendableInline(ref: { kind: string; mime: string }): boolean {
  return ref.kind === 'image' || ref.mime.toLowerCase() === 'application/pdf';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What the model is told about a file, in the user turn.
 *
 * Generated at send time from the stored reference and never persisted: the
 * transcript holds the owner's words and the reference, and a page rendering
 * it shows a file, not this sentence. The id is always given, even for an
 * image the model can see — it is how the agent reaches the bytes again
 * through the artifacts tools, and a model that can see a PDF still cannot
 * cite it without one.
 */
export function attachmentNote(ref: {
  artifactId: string;
  mime: string;
  kind: string;
  filename?: string | null;
  sizeBytes?: number;
}): string {
  const name = ref.filename ?? 'a file';
  const size = ref.sizeBytes ? `, ${formatBytes(ref.sizeBytes)}` : '';
  const seen = isSendableInline(ref)
    ? 'It is attached to this message.'
    : 'Its contents are not in this message — read them with the artifacts tools.';
  return `[Attached file: ${name} (${ref.mime}${size}), artifact id ${ref.artifactId}. ${seen}]`;
}

/** Count cap — checked before anything is loaded or persisted. */
export function assertAttachmentCount(attachments: readonly AttachmentRef[]): void {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentError(
      `too many attachments: ${attachments.length} (max ${MAX_ATTACHMENTS_PER_MESSAGE} per message)`,
    );
  }
}

function placeholder(ref: { mime?: string; kind?: string }, why: string): ContentBlock {
  const what = ref.mime ? ` ${ref.mime}` : '';
  return { type: 'text', text: `${ATTACHMENT_UNAVAILABLE}${what} — ${why}` };
}

/**
 * Turn one `artifact_ref` into what a provider can carry.
 *
 * Always a note first — name, type, size, id — because that is how the model
 * refers to the file afterwards. Then, for an image or a PDF, the bytes as
 * base64. Everything else (a CSV, audio, an archive) is the note alone: the
 * model can still reach for a tool that reads it, and pretending it was
 * attached would be a lie it cannot detect.
 */
async function hydrateRef(
  ref: Extract<ContentBlock, { type: 'artifact_ref' }>,
  load: LoadArtifact | undefined,
  enforceCaps: boolean,
  budget: { total: number },
): Promise<ContentBlock[]> {
  const note: ContentBlock = { type: 'text', text: attachmentNote(ref) };
  if (!isSendableInline(ref)) return [note];
  const media = await hydrateBytes(ref, load, enforceCaps, budget);
  return [note, media];
}

async function hydrateBytes(
  ref: Extract<ContentBlock, { type: 'artifact_ref' }>,
  load: LoadArtifact | undefined,
  enforceCaps: boolean,
  budget: { total: number },
): Promise<ContentBlock> {
  if (!load) return placeholder(ref, 'no artifact loader is configured for this run');

  let loaded: LoadedArtifact | null;
  try {
    loaded = await load(ref.artifactId);
  } catch {
    loaded = null;
  }
  if (!loaded) return placeholder(ref, 'it is no longer in the artifact store');

  const bytes = base64Bytes(loaded.data);
  if (ref.kind === 'image' && bytes > MAX_IMAGE_BYTES) {
    // Fail closed on the new message; on replay, degrade rather than break the
    // conversation over a file that was already accepted once.
    const message =
      `image attachment is ${mib(bytes)} MiB, over the ${mib(MAX_IMAGE_BYTES)} MiB limit; ` +
      'resize it before sending (buddi does not resize in v1)';
    if (enforceCaps) throw new AttachmentError(message);
    return placeholder(ref, 'it is too large to send');
  }
  budget.total += bytes;
  if (budget.total > MAX_ATTACHMENT_TOTAL_BYTES) {
    const message =
      `attachments total ${mib(budget.total)} MiB, over the ${mib(MAX_ATTACHMENT_TOTAL_BYTES)} MiB limit per message`;
    if (enforceCaps) throw new AttachmentError(message);
    return placeholder(ref, 'the message exceeds the attachment size limit');
  }

  if (ref.kind === 'image') {
    return { type: 'image', mime: loaded.mime || ref.mime, data: loaded.data };
  }
  return { type: 'document', mime: 'application/pdf', data: loaded.data };
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Replace every `artifact_ref` in one message's content with sendable blocks.
 *
 * `enforceCaps` is true only for the message being sent now: history was
 * accepted under the rules of its day, and a cap change must not make an old
 * conversation unreplayable.
 */
export async function hydrateContent(
  content: readonly ContentBlock[],
  load: LoadArtifact | undefined,
  opts: { enforceCaps?: boolean } = {},
): Promise<ContentBlock[]> {
  if (!content.some((b) => b.type === 'artifact_ref')) return [...content];
  const budget = { total: 0 };
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type !== 'artifact_ref') {
      out.push(block);
      continue;
    }
    out.push(...(await hydrateRef(block, load, opts.enforceCaps === true, budget)));
  }
  return out;
}

/** `hydrateContent` over a whole history. Never enforces caps. */
export async function hydrateMessages<M extends { role: any; content: ContentBlock[] }>(
  messages: readonly M[],
  load: LoadArtifact | undefined,
): Promise<M[]> {
  const out: M[] = [];
  for (const message of messages) {
    out.push({ ...message, content: await hydrateContent(message.content, load) });
  }
  return out;
}

/**
 * Attachments, as a surface sees them.
 *
 * A surface moves bytes and presentation; it stores nothing itself. Everything
 * here is either pure (what kind of thing is this, how do I say its size, does
 * this sentence point at a file) or a narrow port onto two owners:
 *
 *  - the **artifact store** in core, reached through `ArtifactStore` so the
 *    surface never learns where bytes live, and
 *  - two **surface-shaped tables** (migration 006) that answer "which files
 *    arrived in this chat" and "which one does 'this file' mean" — questions
 *    about a conversation, not about an artifact.
 *
 * Both are ports rather than direct calls, so the surface's tests need neither
 * a disk nor a database, and so the day artifacts move (object storage, a
 * different retention rule) nothing in the surface changes.
 */
import {
  getArtifact,
  localDateString,
  readArtifactBytes,
  saveArtifact,
  type ArtifactKind,
  type ArtifactRow,
  type Queryable,
  type SaveArtifactInput,
} from '@buddi/core';
import type { Pool } from 'pg';
import { MAX_FILE_BYTES, type TelegramMessage } from './api.js';

export type { ArtifactKind, ArtifactRow, SaveArtifactInput };

/** Telegram will not hand a bot a file bigger than this. Their limit, not ours. */
export const MAX_ATTACHMENT_BYTES = MAX_FILE_BYTES;

/** How long "import this statement" may keep pointing at the last file. */
export const ATTACHMENT_RECENCY_MS = 30 * 60_000;

/* ------------------------------------------------------------------ *
 * The core artifact store, as a port
 * ------------------------------------------------------------------ */

/**
 * The surface's whole view of artifact storage: put bytes in, get bytes back
 * for a run. No listing, no deletion, no storage paths — a surface has no
 * business with any of those, and a test can satisfy this in four lines.
 */
export interface ArtifactStore {
  save(input: SaveArtifactInput): Promise<ArtifactRow>;
  load(id: string): Promise<LoadedArtifact | null>;
}

/** What the runtime wants back for a multimodal content block. */
export interface LoadedArtifact {
  mime: string;
  /** base64, as the provider block expects. */
  data: string;
}

export interface CoreArtifactStoreDeps {
  pool: Queryable;
  /** Core reads the data dir from here; `process.env` satisfies it. */
  env: NodeJS.ProcessEnv;
}

/**
 * The store, bound to core. Two calls wide on purpose: everything else core's
 * artifact module offers — listing, deletion, paths — belongs to the artifacts
 * *tool*, where the model can be refused, not to the surface.
 */
export function createCoreArtifactStore(deps: CoreArtifactStoreDeps): ArtifactStore {
  // Core's artifact functions take a `pg.Pool`; the surface is written against
  // the narrow `Queryable` its tests can stub. The cast is the seam, in one
  // place, rather than widening the surface's own dependency.
  const pool = deps.pool as unknown as Pool;
  return {
    save: (input) => saveArtifact(pool, input, deps.env),
    async load(id) {
      const row = await getArtifact(pool, id);
      if (!row) return null;
      const bytes = await readArtifactBytes(deps.env, row);
      return { mime: row.mime, data: bytes.toString('base64') };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reading one Telegram message
 * ------------------------------------------------------------------ */

/** One file Telegram is offering, before anything has been downloaded. */
export interface IncomingAttachment {
  fileId: string;
  /** Which Telegram field carried it — the surface's own vocabulary. */
  slot: 'document' | 'photo' | 'voice' | 'audio';
  kind: ArtifactKind;
  mime: string;
  filename: string;
  /** Telegram's own claim, when it makes one. Verified again after `getFile`. */
  sizeBytes?: number;
  caption?: string;
}

/**
 * Telegram sends every rendition it made, smallest first; the original is the
 * one to keep. Pixels decide when Telegram reports them — a heavily compressed
 * original can weigh less than a thumbnail of a busier crop — and file size is
 * the fallback. Ties go to the later entry, which is Telegram's own ordering.
 */
export function largestPhoto<
  T extends { file_id: string; file_size?: number; width?: number; height?: number },
>(sizes: readonly T[] | undefined): T | undefined {
  if (!sizes || sizes.length === 0) return undefined;
  const score = (s: T): number =>
    s.width ? s.width * (s.height ?? s.width) : (s.file_size ?? 0);
  return sizes.reduce((best, size) => (score(size) >= score(best) ? size : best), sizes[0] as T);
}

/**
 * Map core's mime rules onto a kind. The store decides the stored kind; this
 * is the surface's local read of the same fact, used for wording and for
 * whether the model can see the file at all.
 */
export function classifyMime(mime: string): ArtifactKind {
  const value = mime.toLowerCase();
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('audio/')) return 'audio';
  if (value === 'application/pdf') return 'document';
  return 'other';
}

/**
 * Only what a model can actually look at travels as an attachment: images and
 * PDFs. A CSV is saved just the same, but the agent reaches it through
 * `artifacts.text` rather than pretending to see it.
 */
export function isViewable(kind: ArtifactKind, mime: string): boolean {
  return kind === 'image' || mime.toLowerCase() === 'application/pdf';
}

/** The file this message carries, if any. Text-only messages return undefined. */
export function extractAttachment(message: TelegramMessage): IncomingAttachment | undefined {
  const caption = (message.caption ?? '').trim() || undefined;

  const document = message.document;
  if (document) {
    const mime = document.mime_type ?? 'application/octet-stream';
    return {
      fileId: document.file_id,
      slot: 'document',
      kind: classifyMime(mime),
      mime,
      filename: document.file_name ?? `document-${document.file_unique_id ?? document.file_id}`,
      ...(document.file_size !== undefined ? { sizeBytes: document.file_size } : {}),
      ...(caption ? { caption } : {}),
    };
  }

  const photo = largestPhoto(message.photo);
  if (photo) {
    return {
      fileId: photo.file_id,
      slot: 'photo',
      kind: 'image',
      mime: 'image/jpeg',
      filename: `photo-${photo.file_unique_id ?? photo.file_id}.jpg`,
      ...(photo.file_size !== undefined ? { sizeBytes: photo.file_size } : {}),
      ...(caption ? { caption } : {}),
    };
  }

  const voice = message.voice;
  if (voice) {
    const mime = voice.mime_type ?? 'audio/ogg';
    return {
      fileId: voice.file_id,
      slot: 'voice',
      kind: 'audio',
      mime,
      filename: `voice-${voice.file_unique_id ?? voice.file_id}.ogg`,
      ...(voice.file_size !== undefined ? { sizeBytes: voice.file_size } : {}),
      ...(caption ? { caption } : {}),
    };
  }

  const audio = message.audio;
  if (audio) {
    const mime = audio.mime_type ?? 'audio/mpeg';
    return {
      fileId: audio.file_id,
      slot: 'audio',
      kind: 'audio',
      mime,
      filename: audio.file_name ?? `audio-${audio.file_unique_id ?? audio.file_id}`,
      ...(audio.file_size !== undefined ? { sizeBytes: audio.file_size } : {}),
      ...(caption ? { caption } : {}),
    };
  }

  return undefined;
}

/* ------------------------------------------------------------------ *
 * Wording
 * ------------------------------------------------------------------ */

/** One row of a chat's file history — presentation only, no bytes. */
export interface ChatAttachment {
  artifactId: string;
  filename: string | null;
  kind: string;
  mime: string;
  sizeBytes: number;
  createdAt: Date;
}

/** `812 KB`, `3.4 MB` — a human size, never bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** The reply to a file that arrived with no caption: an invitation, not a receipt. */
export function gotFileText(filename: string, kind: string, sizeBytes: number): string {
  return (
    `Got ${filename} (${kind}, ${formatBytes(sizeBytes)}). ` +
    `Tell me what to do with it, e.g. 'import this statement into PNC Spend' or 'this is a receipt'.`
  );
}

/**
 * Voice notes and audio files are kept, not heard. Saying so plainly beats a
 * silent drop *and* beats a transcription the owner never asked for.
 */
export function gotAudioText(filename: string, sizeBytes: number): string {
  return (
    `Got ${filename} (audio, ${formatBytes(sizeBytes)}). I've saved it, but I can't listen to ` +
    `audio yet — tell me in a line what it was about and I'll work from that.`
  );
}

/** Over Telegram's own ceiling: their limit, said as a size and a way forward. */
export function oversizeText(filename: string, sizeBytes: number): string {
  return (
    `${filename} is ${formatBytes(sizeBytes)}, and Telegram only lets a bot download files up ` +
    `to ${formatBytes(MAX_ATTACHMENT_BYTES)}. Can you split it, or export a shorter date range?`
  );
}

/** `/files` with nothing to list. */
export const NO_FILES_TEXT =
  'No files in this chat yet. Send me a statement, a receipt photo or a CSV and it will land here.';

/**
 * `/files` — name, kind, date, id, newest first. The date is the owner's
 * calendar day in `timezone`: a file sent at 9 PM in New York was sent today,
 * whatever UTC calls it.
 */
export function filesText(rows: readonly ChatAttachment[], timezone: string): string {
  if (rows.length === 0) return NO_FILES_TEXT;
  const lines = rows.map((r) => {
    const day = localDateString(r.createdAt, timezone);
    return `• ${r.filename ?? '(unnamed)'} — ${r.kind}, ${formatBytes(r.sizeBytes)}, ${day}\n  ${r.artifactId}`;
  });
  return ['Files in this chat:', ...lines].join('\n');
}

/**
 * Does this sentence point at the file that just arrived?
 *
 * Deliberately loose and deliberately short-lived: paired with a thirty-minute
 * window, a false positive costs one extra attachment on a run the owner was
 * having anyway, while a false negative costs them re-uploading a statement.
 */
export const ATTACHMENT_REFERENCE_RE =
  /\b(this|that|the) (file|statement|receipt|pdf|photo|image|document)\b|\bit\b/i;

export function referencesAttachment(text: string): boolean {
  return ATTACHMENT_REFERENCE_RE.test(text);
}

/* ------------------------------------------------------------------ *
 * The chat's file history (core.surface_attachments, migration 006)
 * ------------------------------------------------------------------ */

/** Remember the file, and make it the one "this file" means. */
export async function recordChatAttachment(
  pool: Queryable,
  surface: string,
  chatId: string,
  row: {
    artifactId: string;
    messageId?: string;
    filename: string | null;
    kind: string;
    mime: string;
    sizeBytes: number;
  },
): Promise<void> {
  await pool.query(
    `insert into core.surface_attachments
       (surface, external_chat_id, artifact_id, external_message_id, filename, kind, mime, size_bytes)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (surface, external_chat_id, artifact_id) do nothing`,
    [
      surface,
      chatId,
      row.artifactId,
      row.messageId ?? null,
      row.filename,
      row.kind,
      row.mime,
      row.sizeBytes,
    ],
  );
  await pool.query(
    `insert into core.surface_last_attachment (surface, external_chat_id, artifact_id)
     values ($1, $2, $3)
     on conflict (surface, external_chat_id) do update
       set artifact_id = excluded.artifact_id, created_at = now()`,
    [surface, chatId, row.artifactId],
  );
}

/**
 * The file "this statement" would mean, with the instant it arrived and enough
 * of its shape to decide whether the model can look at it. The caller applies
 * the recency window — this function only reports what the chat last received.
 */
export interface LastAttachment {
  artifactId: string;
  createdAt: Date;
  filename?: string | null;
  kind?: string;
  mime?: string;
  sizeBytes?: number;
}

export async function getLastAttachment(
  pool: Queryable,
  surface: string,
  chatId: string,
): Promise<LastAttachment | undefined> {
  const { rows } = await pool.query(
    `select l.artifact_id, l.created_at, a.kind, a.mime, a.filename, a.size_bytes
       from core.surface_last_attachment l
       left join core.surface_attachments a
         on a.surface = l.surface
        and a.external_chat_id = l.external_chat_id
        and a.artifact_id = l.artifact_id
      where l.surface = $1 and l.external_chat_id = $2`,
    [surface, chatId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    artifactId: String(row.artifact_id),
    createdAt: new Date(row.created_at),
    ...(row.mime
      ? {
          mime: String(row.mime),
          kind: String(row.kind),
          filename: row.filename === null || row.filename === undefined ? null : String(row.filename),
          sizeBytes: Number(row.size_bytes ?? 0),
        }
      : {}),
  };
}

/** This chat's most recent files, newest first. */
export async function listChatAttachments(
  pool: Queryable,
  surface: string,
  chatId: string,
  limit = 10,
): Promise<ChatAttachment[]> {
  const { rows } = await pool.query(
    `select artifact_id, filename, kind, mime, size_bytes, created_at
       from core.surface_attachments
      where surface = $1 and external_chat_id = $2
      order by created_at desc
      limit $3`,
    [surface, chatId, limit],
  );
  return rows.map((r) => ({
    artifactId: String(r.artifact_id),
    filename: r.filename === null || r.filename === undefined ? null : String(r.filename),
    kind: String(r.kind),
    mime: String(r.mime),
    sizeBytes: Number(r.size_bytes ?? 0),
    createdAt: new Date(r.created_at),
  }));
}

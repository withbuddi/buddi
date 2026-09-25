/**
 * An agent's face, picked: the bundled Buddi Blob mascots first, then the
 * emoji, then — where the caller adds one — an upload of the owner's own.
 *
 * One component for the two places a face is chosen, the first-run wizard and
 * an agent's Setup tab, so a mascot means the same picture in both: it is
 * uploaded through the avatar route like any owner picture, and an emoji is a
 * line in the agent's file.
 */
import type { ReactNode } from 'react';
import { FACES, MASCOTS, SCRIPT, mascotUrl, type MascotRole } from '../meet/script';

/** A face: one of the mascots, an emoji, or the picture the agent already wears. */
export type FaceChoice =
  | { kind: 'mascot'; role: MascotRole }
  | { kind: 'emoji'; value: string }
  | { kind: 'kept'; url: string };

export const sameFace = (a: FaceChoice | null, b: FaceChoice | null): boolean =>
  !!a && !!b && a.kind === b.kind &&
  (a.kind === 'mascot' ? a.role === (b as typeof a).role : a.kind === 'emoji' ? a.value === (b as typeof a).value : true);

/**
 * The bundled mascot, as a file the avatar upload takes.
 *
 * Through the same route an owner's own picture goes, so the gateway keeps
 * one way a picture is checked, re-encoded and stored — and the roster, the
 * chat header and the canvas draw it like any other.
 */
export async function mascotFile(role: MascotRole): Promise<File> {
  const response = await fetch(mascotUrl(role));
  if (!response.ok) throw new Error(`The picture could not be read (${response.status}).`);
  const blob = await response.blob();
  return new File([blob], `buddi-blob-${role}.png`, { type: 'image/png' });
}

export function FacePicker({
  face,
  onPick,
  label = SCRIPT.assistant.face,
  kept,
  disabled,
  disableEmoji,
  children,
}: {
  face: FaceChoice | null;
  onPick: (face: FaceChoice) => void;
  label?: string;
  /** The picture the agent wears now, drawn first so it can be shown chosen. */
  kept?: string;
  disabled?: boolean;
  /** Emoji live in the agent's file; a read-only file cannot take one. */
  disableEmoji?: boolean;
  /** A third row, such as an upload. */
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="meet-faces" role="group" aria-label={label}>
      {/* The mascots first, then the emoji: two rows, one choice. */}
      <div className="meet-face-row">
        {kept ? (
          <button
            type="button"
            className="meet-face"
            data-kind="image"
            data-chosen={face?.kind === 'kept' ? 'true' : undefined}
            aria-pressed={face?.kind === 'kept'}
            aria-label="The current picture"
            disabled={disabled}
            onClick={() => onPick({ kind: 'kept', url: kept })}
          >
            <img src={kept} alt="" />
          </button>
        ) : null}
        {MASCOTS.map((role) => {
          const option: FaceChoice = { kind: 'mascot', role };
          const chosen = sameFace(face, option);
          return (
            <button
              key={role}
              type="button"
              className="meet-face"
              data-kind="image"
              data-chosen={chosen ? 'true' : undefined}
              aria-pressed={chosen}
              aria-label={SCRIPT.assistant.mascot(role)}
              disabled={disabled}
              onClick={() => onPick(option)}
            >
              <img src={mascotUrl(role)} alt="" />
            </button>
          );
        })}
      </div>
      <div className="meet-face-row">
        {FACES.map((emoji) => {
          const chosen = face?.kind === 'emoji' && face.value === emoji;
          return (
            <button
              key={emoji}
              type="button"
              className="meet-face"
              data-chosen={chosen ? 'true' : undefined}
              aria-pressed={chosen}
              disabled={disabled || disableEmoji}
              onClick={() => onPick({ kind: 'emoji', value: emoji })}
            >
              {emoji}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}

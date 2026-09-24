/**
 * An agent's face, wherever it appears: the same source everywhere, so the day
 * an agent gets a picture or a colour it changes in every place at once.
 *
 * Order of truth: the picture the owner uploaded (served from the database),
 * else the icon its file names — an image its folder ships or an emoji — else
 * its initials in its own accent, else its initials in a tint hashed from its
 * id. A picture that fails to load falls back to the icon rather than a broken
 * image. The accent travels as one custom property; nothing else is styled
 * inline.
 */
import { useState, type CSSProperties } from 'react';
import type { ChatAgent } from '../../chat/types';
import { tintOf } from '../../shell/AgentRail';
import { monogram } from '../../shell/roster';

export type Face = Pick<ChatAgent, 'avatar' | 'accent' | 'picture'>;

/**
 * The one component that draws a face's mark. `className` is the frame it
 * sits in — `ui-avatar` on a page, `wb-face-mark` in the rail — and every
 * frame styles `data-kind` the same way.
 */
export function FaceMark({
  className,
  name,
  face,
  tint,
  size,
  unavailable,
  initials = 2,
}: {
  className: string;
  name: string;
  face?: Face | undefined;
  tint?: number | string | undefined;
  size?: 'sm' | 'lg' | 'xl' | undefined;
  unavailable?: boolean | undefined;
  /** How many letters of the monogram to draw when it comes to that. */
  initials?: 1 | 2;
}): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null);
  const picture = face?.picture && face.picture !== broken ? face.picture : undefined;
  const icon = face?.avatar;
  const kind = picture ? 'image' : icon?.kind;
  const style = face?.accent ? ({ '--face-accent': face.accent } as CSSProperties) : undefined;
  return (
    <span
      className={className}
      data-tint={tint}
      data-size={size}
      data-kind={kind}
      data-accent={face?.accent ? 'true' : undefined}
      data-unavailable={unavailable ? 'true' : undefined}
      style={style}
      aria-hidden="true"
    >
      {picture ? (
        <img src={picture} alt="" onError={() => setBroken(picture)} />
      ) : icon?.kind === 'image' ? (
        <img src={icon.url} alt="" />
      ) : icon?.kind === 'emoji' ? (
        icon.value
      ) : (
        monogram(name).slice(0, initials)
      )}
    </span>
  );
}

export function Avatar({
  id,
  name,
  size,
  unavailable,
  face,
}: {
  id: string;
  name: string;
  size?: 'sm' | 'lg' | 'xl';
  unavailable?: boolean;
  face?: Face;
}): JSX.Element {
  return <FaceMark className="ui-avatar" tint={tintOf(id)} name={name} size={size} unavailable={unavailable} face={face} />;
}

/** The face of an agent in a roster, by id: falls back to initials for an id the roster does not know. */
export function AgentAvatar({
  agents,
  id,
  size,
}: {
  agents: readonly ChatAgent[];
  id: string;
  size?: 'sm' | 'lg' | 'xl';
}): JSX.Element {
  const agent = agents.find((a) => a.id === id);
  return <Avatar id={id} name={agent?.name ?? id} size={size} unavailable={agent ? !agent.available : false} face={agent} />;
}

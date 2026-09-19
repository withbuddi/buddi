/**
 * An agent's face, wherever it appears: the same source everywhere, so the day
 * an agent gets a picture or a colour it changes in every place at once.
 *
 * Order of truth: an image the agent's folder ships, else an emoji from its
 * file, else its initials in its own accent, else its initials in a tint
 * hashed from its id. The accent travels as one custom property; nothing else
 * is styled inline.
 */
import type { CSSProperties } from 'react';
import type { ChatAgent } from '../../chat/types';
import { tintOf } from '../../shell/AgentRail';
import { monogram } from '../../shell/roster';

export type Face = Pick<ChatAgent, 'avatar' | 'accent'>;

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
  const style = face?.accent ? ({ '--face-accent': face.accent } as CSSProperties) : undefined;
  return (
    <span
      className="ui-avatar"
      data-tint={tintOf(id)}
      data-size={size}
      data-kind={face?.avatar?.kind}
      data-accent={face?.accent ? 'true' : undefined}
      data-unavailable={unavailable ? 'true' : undefined}
      style={style}
      aria-hidden="true"
    >
      {face?.avatar?.kind === 'image' ? (
        <img src={face.avatar.url} alt="" />
      ) : face?.avatar?.kind === 'emoji' ? (
        face.avatar.value
      ) : (
        monogram(name)
      )}
    </span>
  );
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

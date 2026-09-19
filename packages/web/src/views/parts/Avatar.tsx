/**
 * An agent's face, wherever it appears outside the rail: the same tint the rail
 * uses, so one agent is one colour across the whole hub.
 */
import { tintOf } from '../../shell/AgentRail';
import { monogram } from '../../shell/roster';

export function Avatar({
  id,
  name,
  size,
  unavailable,
}: {
  id: string;
  name: string;
  size?: 'sm' | 'lg' | 'xl';
  unavailable?: boolean;
}): JSX.Element {
  return (
    <span
      className="ui-avatar"
      data-tint={tintOf(id)}
      data-size={size}
      data-unavailable={unavailable ? 'true' : undefined}
      aria-hidden="true"
    >
      {monogram(name)}
    </span>
  );
}

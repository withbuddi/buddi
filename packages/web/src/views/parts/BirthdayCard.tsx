/**
 * Home on the owner's birthday (docs/dashboard.md, Home): one card under the
 * glance — FROM YOUR TEAM, the front desk's note in display type, the faces
 * that signed it, and the Illustrator's picture beside it when there is one.
 * × puts it away for the day. Nothing at all on any other day, or before the
 * greeting went out (the greeting line says it then).
 */
import type { BirthdayGlanceView } from '../../api';
import type { ChatAgent } from '../../chat/types';
import { previewUrl } from '../../chat/attachments';
import { AgentAvatar } from './Avatar';
import { Icon } from '../../ui';

/** "Buddi", "Buddi and Postie", "Buddi, Postie, Ledger and 2 more". */
export function signedBy(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= 4) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

export function BirthdayCard({ glance, team, onClose }: {
  glance: BirthdayGlanceView;
  /** The team in roster order, front desk first. */
  team: readonly ChatAgent[];
  onClose: () => void;
}): JSX.Element | null {
  if (!glance.today || !glance.note) return null;
  const signers = team.filter((a) => a.available).slice(0, 8);
  return (
    <section className="bd-card" aria-label="Your birthday">
      {glance.image ? (
        <figure className="bd-art">
          <img src={previewUrl(glance.image)} alt="A picture your team made for your birthday" />
          <figcaption>Made for you</figcaption>
        </figure>
      ) : null}
      <div className="bd-body">
        <p className="bd-kicker">From your team</p>
        <p className="bd-note">{glance.note}</p>
        {signers.length > 0 ? (
          <div className="bd-foot">
            <span className="bd-faces">{signers.slice(0, 4).map((a) => <AgentAvatar key={a.id} agents={team} id={a.id} size="sm" />)}</span>
            <span className="bd-sign">{signedBy(signers.map((a) => a.name))}</span>
          </div>
        ) : null}
      </div>
      {/* Home's ×, drawn here so this part needs nothing from the page. */}
      <button type="button" className="ui-icon-btn bd-close" data-size="sm" aria-label="Put it away for today" title="Put it away for today" onClick={onClose}>
        <Icon name="close" />
      </button>
    </section>
  );
}

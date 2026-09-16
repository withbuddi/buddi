/**
 * What an agent is, drawn.
 *
 * The dashboard has always been able to say *who* you are talking to. This is
 * the panel that says what it can do to your life — and, because that is the
 * only part that is really a privilege, it leads with the split the whole trust
 * model rests on: **which tools run on their own, and which stop and wait for
 * you.** A finance read and a mail send must never look like the same row.
 *
 * Everything drawn here arrives as data from `GET /api/agents/:id/profile`.
 * This file knows no plugin, no tool and no family by name: a family is a
 * string the server sent, a tier is the platform's own word, and every
 * description is the tool's own, written by whoever shipped it.
 *
 * It is a read. There is no control on it that changes anything — the one
 * button hands the owner to the maker agent with the subject already named,
 * which is where a grant change becomes an approval instead of a silent edit.
 */
import type { ReactNode } from 'react';
import type { AgentProfile, AgentProfileFamily, AgentProfileTool } from '../../api';
import { humanise } from '../resolve';

export interface ProfileProps {
  profile: AgentProfile;
  /**
   * Hand the owner to the maker, with the opening line the server wrote.
   * Absent when no agent claims the role, which is also when `changeVia` is.
   */
  onChange?: (target: { agentId: string; prompt: string }) => void;
}

export function Profile({ profile, onChange }: ProfileProps): JSX.Element {
  return (
    <div className="wb-prof" data-testid="agent-profile">
      <p className="wb-prof-lead">{profile.description}</p>

      <div className="wb-prof-tags">
        {profile.isDefault ? <Tag>Opens by default</Tag> : null}
        <Tag>{profile.source === 'example' ? 'Shipped with buddi' : 'Yours'}</Tag>
        {profile.roles.map((role) => (
          <Tag key={role} title={`A surface command that asks for "${role}" lands on this agent.`}>
            {humanise(role)}
          </Tag>
        ))}
      </div>

      {profile.available ? null : (
        <p className="wb-prof-blocked" data-testid="agent-profile-unavailable">
          <strong>This agent cannot run here.</strong> {profile.unavailableReason}
        </p>
      )}

      <Section
        title="What it can do"
        note={grantSummary(profile)}
        tone={profile.gatedCount > 0 ? 'warning' : undefined}
      >
        {profile.tools.length === 0 ? (
          <p className="wb-prof-empty">
            No tools at all. It answers from the conversation and from what it remembers, and it
            can change nothing.
          </p>
        ) : (
          /*
           * Families that stop for the owner come first, so the amber row is
           * the first thing under a summary that has just said there is one.
           * A grant of forty tools is a page of scrolling; the boundary must
           * not be somewhere down it.
           */
          [...profile.tools]
            .sort((a, b) => Number(b.gated > 0) - Number(a.gated > 0))
            .map((family) => <Family key={family.family} family={family} />)
        )}
      </Section>

      <Section title="What it runs on">
        <dl className="wb-prof-kv">
          <Row label="Provider">{profile.engine.provider}</Row>
          <Row label="Model">
            <span className="mono">{profile.engine.model}</span>
          </Row>
          <Row label="Credential">
            {/* Named, never shown: the kind, and the variable it is read from.
                No value for it ever leaves the server. */}
            {profile.engine.credentialKind} from{' '}
            <span className="mono">{profile.engine.credentialEnv}</span>
          </Row>
          <Row label="Turn budget">
            {profile.engine.maxTurns} {profile.engine.maxTurns === 1 ? 'turn' : 'turns'} per message
          </Row>
          <Row label="Language">{languageText(profile.engine.language)}</Row>
        </dl>
      </Section>

      {profile.skills.length > 0 ? (
        <Section
          title="What it has read"
          note={`${profile.skills.length} ${profile.skills.length === 1 ? 'skill' : 'skills'}, composed into every run`}
        >
          <ul className="wb-prof-list">
            {profile.skills.map((skill) => (
              <li key={skill.file} className="wb-prof-row">
                <span className="wb-prof-row-main">
                  <span className="wb-prof-row-name mono">{skill.name}</span>
                  {skill.description ? (
                    <span className="wb-prof-row-desc">{skill.description}</span>
                  ) : null}
                </span>
                <span className="wb-prof-row-side" title={skill.file}>
                  {skill.scope === 'private' ? 'its own' : 'shared'} · {skill.provenance}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {profile.delegates.length > 0 ? (
        <Section
          title="Who it can hand work to"
          note="A colleague's tools are reached through the colleague, never held here"
        >
          <ul className="wb-prof-list">
            {profile.delegates.map((delegate) => (
              <li key={delegate.id} className="wb-prof-row">
                <span className="wb-prof-row-main">
                  <span className="wb-prof-row-name mono">@{delegate.handle}</span>
                  <span className="wb-prof-row-desc">{delegate.description}</span>
                </span>
                <span className="wb-prof-row-side">
                  {delegate.available ? delegate.name : `${delegate.name} · cannot run`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <footer className="wb-prof-foot">
        <p className="wb-prof-note">{profile.note}</p>
        <p className="wb-prof-file mono" title={profile.file}>
          {profile.file}
        </p>
        {profile.changeVia && onChange ? (
          <button
            className="wb-btn"
            data-testid="agent-profile-change"
            title={profile.changeVia.prompt}
            onClick={() =>
              onChange({
                agentId: profile.changeVia!.agentId,
                prompt: profile.changeVia!.prompt,
              })
            }
          >
            Ask @{profile.changeVia.handle} to change this
          </button>
        ) : null}
      </footer>
    </div>
  );
}

/**
 * The sentence above the grant.
 *
 * It is the first thing read and it is the one the owner is really asking
 * about, so it counts the gated tools out loud rather than leaving them to be
 * spotted in a list.
 */
export function grantSummary(profile: AgentProfile): string {
  if (profile.toolCount === 0) return 'Nothing. This agent holds no tools.';
  const tools = `${profile.toolCount} ${profile.toolCount === 1 ? 'tool' : 'tools'}`;
  if (profile.gatedCount === 0) {
    return `${tools}, every one of them running without asking you. None of them can send, spend or write to the world.`;
  }
  const gated =
    profile.gatedCount === 1
      ? 'one of them stops and waits for you'
      : `${profile.gatedCount} of them stop and wait for you`;
  return `${tools}, and ${gated}.`;
}

/** One plugin's tools. Gated first: the boundary should not have to be hunted. */
function Family({ family }: { family: AgentProfileFamily }): JSX.Element {
  const tools = [...family.tools].sort((a, b) => Number(b.gated) - Number(a.gated));
  return (
    <section className="wb-prof-family">
      <h4 className="wb-prof-family-head">
        <span className="wb-prof-family-name">{humanise(family.family)}</span>
        <span className="wb-prof-family-note">
          {family.tools.length} {family.tools.length === 1 ? 'tool' : 'tools'}
          {family.gated > 0 ? ` · ${family.gated} needs you` : ''}
        </span>
      </h4>
      <ul className="wb-prof-list">
        {tools.map((tool) => (
          <Tool key={tool.name} tool={tool} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One tool.
 *
 * `data-gated` carries the whole visual difference — an amber rule down the
 * left and an amber pill on the right — because a tier is not a detail about a
 * tool, it is the answer to whether this agent can do that thing to you while
 * you are asleep.
 */
function Tool({ tool }: { tool: AgentProfileTool }): JSX.Element {
  return (
    <li className="wb-prof-row" data-gated={tool.gated ? 'true' : undefined} data-testid="agent-profile-tool">
      <span className="wb-prof-row-main">
        <span className="wb-prof-row-name mono">{leafOf(tool.name)}</span>
        {/* A tool's description is written for a model and can run to a
            paragraph. Two lines is what a person reads while scanning forty of
            them; the rest is on hover, where the whole of it still is. */}
        <span className="wb-prof-row-desc" data-clamp="true" title={tool.description}>
          {tool.description}
        </span>
      </span>
      {tool.gated ? (
        <span className="wb-prof-gate" title="The call is recorded and waits; nothing happens until you approve it.">
          <LockIcon />
          Needs your approval
        </span>
      ) : (
        <span className="wb-prof-auto" title={tierNote(tool.tier)}>
          {tierText(tool.tier)}
        </span>
      )}
    </li>
  );
}

/**
 * What a tier means to the owner, in their words rather than the registry's.
 *
 * Only two tiers execute or gate in this build; anything else is a tool the
 * installation will refuse to run, which is worth saying plainly rather than
 * drawing as though it worked.
 */
export function tierText(tier: string): string {
  if (tier === 'auto') return 'Runs on its own';
  if (tier === 'gated') return 'Needs your approval';
  return 'Not runnable here';
}

function tierNote(tier: string): string {
  return tier === 'auto'
    ? 'Called during a run without asking you. It reads, or records something you can see.'
    : `Tier "${tier}" does not execute in this build; a call to it is refused.`;
}

/** `orchard.pick_fruit` -> `pick fruit`: the family is already the heading. */
export function leafOf(name: string): string {
  const parts = name.split('.');
  return (parts[parts.length - 1] ?? name).replace(/_/g, ' ');
}

function languageText(language: string): string {
  if (language === 'mirror') return 'Mirrors whichever language you write in';
  if (language === 'en') return 'Always English';
  if (language === 'fr') return 'Always French';
  return language;
}

function Section({
  title,
  note,
  tone,
  children,
}: {
  title: string;
  note?: string;
  tone?: 'warning';
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="wb-prof-section">
      <h3 className="wb-prof-title">{title}</h3>
      {note ? (
        <p className="wb-prof-note-lead" data-tone={tone}>
          {note}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="wb-prof-k">{label}</dt>
      <dd className="wb-prof-v">{children}</dd>
    </>
  );
}

function Tag({ children, title }: { children: ReactNode; title?: string }): JSX.Element {
  return (
    <span className="wb-prof-tag" title={title}>
      {children}
    </span>
  );
}

function LockIcon(): JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 14 14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2.8" y="6" width="8.4" height="6.2" rx="1.4" />
      <path d="M4.8 6V4.4a2.2 2.2 0 0 1 4.4 0V6" />
    </svg>
  );
}

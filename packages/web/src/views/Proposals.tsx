/**
 * Settings → Proposals: what the agents learned, waiting for the owner.
 *
 * Nothing an agent learns applies itself (docs/specs/learning.md). A skill, a
 * rule, a change to its own file — each arrives here as a card saying what it
 * is, why the agent thinks so, and where it came from, including the mark
 * that untrusted text (a page, a mail, a file) was in view when it was made.
 * That mark and its sources are the run's, not the agent's: an agent cannot
 * leave them off.
 *
 * Keep and Discard are the two answers. For a skill or a change the owner can
 * correct the text before keeping it. Kept and discarded ones stay under the
 * fold for a week, and a proposal nobody decides is expired after 30 days.
 *
 * A kept skill is a file under the agent. A later proposal on the same skill
 * is its next version and is drawn as a diff against the one that loads now;
 * the sentences that also appeared in untrusted text are highlighted in it.
 * The fold offers to remove a kept skill that is still the live version.
 *
 * A rule (a policy) is drawn from its payload's shape alone — plugin,
 * matcher, action, how many decisions it was learned from — so this page
 * knows no plugin. A plugin page links here filtered to its own rules
 * (`#/settings/proposals?plugin=<name>`); keeping one calls that plugin's
 * apply on the server.
 *
 * A change to an agent's own file is drawn as a diff against the file as it
 * is now, with the untrusted sentences marked, and a tool list that widens the
 * grant says what it adds before the owner keeps it. A keep the server refuses
 * (an unknown tool, a hand-only one) leaves the card open with the sentence
 * beside the button. The weekly digest's day and hour are set at the foot.
 */
import { useState } from 'react';
import { api, type DigestSchedule, type ProposalRow } from '../api';
import { DiffLines } from '../canvas/views/DiffLines';
import { lineDiff } from '../canvas/line-diff';
import { fmtRelative } from '../format';
import { agentRoute, settingsRoute, transcriptRoute } from '../routes';
import {
  Button,
  Card,
  Code,
  Details,
  Empty,
  ErrorBanner,
  Field,
  KV,
  List,
  ListRow,
  Notice,
  PageFrame,
  Panel,
  Pill,
  Stack,
  Toolbar,
  useAsync,
} from '../ui';

const KIND_LABEL: Record<ProposalRow['kind'], string> = {
  skill: 'skill',
  policy: 'rule',
  change: 'change to itself',
};

/** The matcher as the owner reads it: key and value, the plugin's `…Id` handles left out. */
export function matcherLine(matcher: unknown): string {
  if (matcher === null || typeof matcher !== 'object' || Array.isArray(matcher)) return String(matcher ?? '');
  return Object.entries(matcher as Record<string, unknown>)
    .filter(([key, value]) => !/Id$/.test(key) && value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' · ');
}

/** A tool list as the names it declares: comma- or line-separated. */
export function toolNames(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((t) => t.trim().replace(/^[-*]\s+/, '')).filter((t) => t !== ''))];
}

/**
 * What a change's tool list adds to the grant. The server's answer, resolved
 * against the registry, for the text as proposed; for the owner's own edit,
 * the names it declares that the current list does not.
 */
export function addedTools(proposal: ProposalRow, text: string): string[] {
  const change = proposal.change;
  if (!change || change.part !== 'tools') return [];
  if (text === proposal.editable) return change.added;
  const before = new Set(toolNames(change.current ?? ''));
  return toolNames(text).filter((name) => !before.has(name));
}

/** True when the proposal belongs under a plugin filter (none: everything does). */
export function inFilter(proposal: ProposalRow, plugin: string | null | undefined): boolean {
  return !plugin || (proposal.kind === 'policy' && proposal.payload.plugin === plugin);
}

export function Proposals({ embedded, plugin }: { embedded?: boolean; plugin?: string | null }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.proposals(), [], 30_000);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A refused keep, by card: the sentence stays beside that card's button.
  const [refused, setRefused] = useState<Record<string, string>>({});

  const act = async (id: string, run: () => Promise<string>, onCard = false): Promise<void> => {
    setFailure(null);
    setDone(null);
    setBusy(id);
    setRefused(({ [id]: _, ...rest }) => rest);
    try {
      setDone(await run());
      reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (onCard) setRefused((all) => ({ ...all, [id]: message }));
      else setFailure(message);
    } finally {
      setBusy(null);
    }
  };

  const open = (data?.open ?? []).filter((p) => inFilter(p, plugin));
  const closed = (data?.closed ?? []).filter((p) => inFilter(p, plugin));

  return (
    <PageFrame
      embedded={embedded}
      title="Proposals"
      lede="What your agents learned and would like to keep: a procedure, a rule, a change to their own instructions. Nothing here applies itself. Keep what is right, correct what is nearly right, discard the rest."
    >
      <ErrorBanner message={error ?? failure} />
      {plugin ? (
        <Notice role="status">
          Showing the rules {plugin} proposes. <a href={settingsRoute('proposals')}>Show every proposal</a>
        </Notice>
      ) : null}
      {done ? (
        <Notice tone="good" role="status">
          {done}
        </Notice>
      ) : null}
      {!data ? (
        <Empty>Loading…</Empty>
      ) : open.length === 0 ? (
        <Empty>
          {plugin
            ? `No rule from ${plugin} is waiting. It proposes one when you decide the same way several times running.`
            : 'Nothing proposed. When an agent learns something worth keeping, it waits here.'}
        </Empty>
      ) : (
        <Stack>
          {open.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              busy={busy === proposal.id}
              refusal={refused[proposal.id] ?? null}
              onKeep={(text) =>
                void act(
                  proposal.id,
                  async () => {
                    const result = await api.keepProposal(proposal.id, text);
                    return `${proposal.title}: ${result.note}`;
                  },
                  true,
                )
              }
              onDiscard={(reason) =>
                void act(proposal.id, async () => {
                  await api.discardProposal(proposal.id, reason);
                  return `Discarded: ${proposal.title}. ${proposal.agent} will be told once and will not propose it again for 90 days.`;
                })
              }
            />
          ))}
        </Stack>
      )}
      {closed.length > 0 ? (
        <Details summary={`Kept, discarded and expired (${closed.length})`} boxed>
          <Panel flush>
            <List>
              {closed.map((proposal) => (
                <ListRow
                  key={proposal.id}
                  title={proposal.title}
                  sub={`${proposal.agent}: ${closedSentence(proposal)}`}
                  side={
                    proposal.kind === 'skill' && proposal.state === 'kept' && proposal.skill?.live ? (
                      <Toolbar align="end">
                        <span className="muted">{fmtRelative(proposal.decidedAt ?? proposal.createdAt)}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === proposal.id}
                          onClick={() =>
                            void act(proposal.id, async () => {
                              const skill = proposal.skill!;
                              await api.removeSkill(proposal.agent, skill.name);
                              return `Removed ${skill.name} from ${proposal.agent}. Its versions are kept, and ${proposal.agent} will not propose it again for 90 days.`;
                            })
                          }
                        >
                          Remove this skill
                        </Button>
                      </Toolbar>
                    ) : (
                      fmtRelative(proposal.decidedAt ?? proposal.createdAt)
                    )
                  }
                />
              ))}
            </List>
          </Panel>
          <p className="muted">These stop being shown a week after they were decided.</p>
        </Details>
      ) : null}
      {!plugin && data?.digest ? <DigestSettings schedule={data.digest.schedule} onSaved={reload} /> : null}
    </PageFrame>
  );
}

/** What happened to a decided proposal, in a sentence. */
export function closedSentence(proposal: ProposalRow): string {
  switch (proposal.state) {
    case 'kept':
      return proposal.kind === 'skill' && proposal.skill
        ? proposal.skill.live
          ? `Kept as ${proposal.skill.name}, version ${proposal.skill.version}; it loads on the agent's next run.`
          : `Kept; ${proposal.skill.name} has a newer version now (${proposal.skill.version}).`
        : proposal.note ?? 'Kept.';
    case 'discarded':
      return proposal.reason ? `Discarded: ${proposal.reason}` : 'Discarded.';
    case 'expired':
      return `Expired: ${proposal.reason ?? 'not decided in 30 days'}.`;
    default:
      return 'Waiting.';
  }
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The weekly digest: which day and hour it runs, in the installation's zone. */
function DigestSettings({ schedule, onSaved }: { schedule: DigestSchedule; onSaved: () => void }): JSX.Element {
  const [day, setDay] = useState(schedule.day);
  const [hour, setHour] = useState(schedule.hour);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  const changed = day !== schedule.day || hour !== schedule.hour;
  const save = async (): Promise<void> => {
    setSaving(true);
    setMessage(null);
    try {
      await api.setDigestSchedule(day, hour);
      setMessage({ tone: 'good', text: `The digest now runs on ${DAYS[day]} at ${String(hour).padStart(2, '0')}:00.` });
      onSaved();
    } catch (err) {
      setMessage({ tone: 'critical', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title="Weekly digest">
      <Stack gap="sm">
        <p className="muted">
          Once a week, one message on Telegram and a card on Home: what your agents learned, what waits here, and what the
          rules you kept stopped them doing. No message when nothing was learned and nothing waits.
          {schedule.next ? ` Next: ${fmtRelative(schedule.next)}.` : ''}
        </p>
        <Toolbar align="end">
          <Field label="Day">
            <select value={day} disabled={saving} onChange={(e) => setDay(Number(e.target.value))}>
              {DAYS.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Hour (${schedule.timezone})`}>
            <select value={hour} disabled={saving} onChange={(e) => setHour(Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </Field>
          <Button variant="accent" size="sm" disabled={saving || !changed} onClick={() => void save()}>
            Save
          </Button>
        </Toolbar>
        {message ? (
          <Notice tone={message.tone} role="status">
            {message.text}
          </Notice>
        ) : null}
      </Stack>
    </Panel>
  );
}

/** A tool list drawn one name per line, so a diff shows each tool added or removed. */
function asLines(part: 'instructions' | 'tools', text: string): string {
  return part === 'tools' ? toolNames(text).join('\n') : text;
}

function ProposalCard({
  proposal,
  busy,
  refusal,
  onKeep,
  onDiscard,
}: {
  proposal: ProposalRow;
  busy: boolean;
  refusal: string | null;
  onKeep: (text?: string) => void;
  onDiscard: (reason?: string) => void;
}): JSX.Element {
  const [text, setText] = useState(proposal.editable ?? '');
  const [reason, setReason] = useState('');
  const edited = proposal.editable !== null && text !== proposal.editable;
  const payload = proposal.payload;
  const echoes = proposal.echoes ?? [];
  const change = proposal.kind === 'change' ? proposal.change ?? null : null;
  const adds = addedTools(proposal, text);
  return (
    <Card
      tone={proposal.untrusted ? 'warning' : 'accent'}
      title={proposal.title}
      meta={
        <>
          <Pill>{KIND_LABEL[proposal.kind]}</Pill>
          <Pill mono>{proposal.agent}</Pill>
          {proposal.untrusted ? <Pill tone="warning">untrusted text in view</Pill> : null}
          {adds.length > 0 ? <Pill tone="warning">widens its tools</Pill> : null}
        </>
      }
      foot={
        <Toolbar align="end">
          {refusal ? (
            <span className="proposal-refusal" role="alert">
              {refusal}
            </span>
          ) : null}
          <input
            aria-label="Reason for discarding (optional)"
            placeholder="Reason for discarding (optional)"
            value={reason}
            maxLength={300}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDiscard(reason.trim() || undefined)}>
            Discard
          </Button>
          <Button
            variant="accent"
            size="sm"
            disabled={busy || (proposal.editable !== null && text.trim() === '')}
            onClick={() => onKeep(edited ? text : undefined)}
          >
            {edited ? 'Keep my version' : 'Keep'}
          </Button>
        </Toolbar>
      }
    >
      <Stack gap="sm">
        {proposal.why ? <p>{proposal.why}</p> : null}
        <p className="ui-card-meta">
          Proposed by {proposal.agent} {fmtRelative(proposal.createdAt)}
          {proposal.conversationId ? (
            <>
              {' in '}
              <a href={transcriptRoute(proposal.conversationId)}>
                {proposal.turn ? `this conversation, turn ${proposal.turn}` : 'this conversation'}
              </a>
            </>
          ) : null}
          .
        </p>
        {proposal.untrusted ? (
          <Notice tone="warning" title={proposal.kind === 'policy' ? 'Learned from mail you received.' : 'Made with untrusted text in view.'}>
            {/*
              A rule is counted by its plugin from the owner's own decisions;
              no model read the mail to write it, so "look for instructions
              that came from there" would send the owner hunting for nothing.
              Keyed off the kind, never off a plugin's name.
            */}
            {proposal.kind === 'policy'
              ? 'The plugin counted this rule from your own triage decisions; no instruction in that mail can change what it does.'
              : "Something written by someone other than you was in the agent's context when it proposed this. Read it for instructions that came from there rather than from you."}
            <ul className="proposal-sources">
              {proposal.sources.map((source) => (
                <li key={source} className="mono">
                  {source}
                </li>
              ))}
            </ul>
            {echoes.length > 0 ? (
              <>
                <p className="proposal-echo-lede">These sentences of it also appear in that text:</p>
                <ul className="proposal-sources" aria-label="Sentences found in the untrusted text">
                  {echoes.map((echo) => (
                    <li key={echo}>
                      <mark className="wb-diff-mark">{echo}</mark>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Notice>
        ) : null}
        {proposal.kind === 'skill' ? (
          <>
            {typeof payload.when === 'string' ? <p className="ui-card-meta">When: {payload.when}</p> : null}
            {proposal.skill ? (
              <Stack gap="sm">
                <p className="ui-card-meta">
                  {proposal.agent} already has this skill (
                  <a href={agentRoute(proposal.agent, 'skills')}>{proposal.skill.name}, version {proposal.skill.version}</a>
                  ). Keeping this writes version {proposal.skill.version + 1}; the earlier ones stay readable.
                </p>
                <DiffLines
                  text={lineDiff(proposal.skill.steps, text)}
                  marks={echoes}
                  label={`Version ${proposal.skill.version} against this proposal`}
                />
              </Stack>
            ) : null}
            <Field label="The steps, as it would follow them" hint="Correct them here and keep your version.">
              <textarea rows={8} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
            </Field>
          </>
        ) : null}
        {proposal.kind === 'change' ? (
          <>
            {adds.length > 0 ? (
              <Notice tone="warning" title={`Adds: ${adds.join(', ')}`}>
                Keeping this lets {proposal.agent} call tools it cannot call now.
              </Notice>
            ) : null}
            {change?.refusal && !edited ? (
              <Notice tone="warning" title="Keeping this as proposed will be refused.">
                {change.refusal}
              </Notice>
            ) : null}
            {change && change.current !== null ? (
              <DiffLines
                text={lineDiff(asLines(change.part, change.current), asLines(change.part, text))}
                marks={echoes}
                label={`${proposal.agent}'s ${change.part === 'tools' ? 'tool list' : 'instructions'} now, against this proposal`}
              />
            ) : typeof payload.before === 'string' ? (
              <Details summary={`What its ${payload.part === 'tools' ? 'tool list' : 'instructions'} said when proposed`}>
                <Code>{payload.before}</Code>
              </Details>
            ) : null}
            <Field
              label={payload.part === 'tools' ? 'Proposed tool list' : 'Proposed instructions'}
              hint="Correct it here and keep your version."
            >
              <textarea rows={8} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
            </Field>
          </>
        ) : null}
        {proposal.kind === 'policy' ? (
          <KV
            items={[
              { label: 'Plugin', value: <span className="mono">{String(payload.plugin ?? '')}</span> },
              { label: 'Matches', value: <span className="mono">{matcherLine(payload.matcher ?? {})}</span> },
              { label: 'Does', value: String(payload.action ?? '') },
              {
                label: 'Learned from',
                value: (() => {
                  const n = Array.isArray(payload.verdicts) ? payload.verdicts.length : 0;
                  return `${n} ${n === 1 ? 'decision' : 'decisions'}`;
                })(),
              },
            ]}
          />
        ) : null}
      </Stack>
    </Card>
  );
}

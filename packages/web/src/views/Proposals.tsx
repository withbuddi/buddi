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
 */
import { useState } from 'react';
import { api, type ProposalRow } from '../api';
import { DiffLines } from '../canvas/views/DiffLines';
import { lineDiff } from '../canvas/line-diff';
import { fmtRelative } from '../format';
import { agentRoute, transcriptRoute } from '../routes';
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

export function Proposals({ embedded }: { embedded?: boolean }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.proposals(), [], 30_000);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, run: () => Promise<string>): Promise<void> => {
    setFailure(null);
    setDone(null);
    setBusy(id);
    try {
      setDone(await run());
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const open = data?.open ?? [];
  const closed = data?.closed ?? [];

  return (
    <PageFrame
      embedded={embedded}
      title="Proposals"
      lede="What your agents learned and would like to keep: a procedure, a rule, a change to their own instructions. Nothing here applies itself. Keep what is right, correct what is nearly right, discard the rest."
    >
      <ErrorBanner message={error ?? failure} />
      {done ? (
        <Notice tone="good" role="status">
          {done}
        </Notice>
      ) : null}
      {!data ? (
        <Empty>Loading…</Empty>
      ) : open.length === 0 ? (
        <Empty>Nothing proposed. When an agent learns something worth keeping, it waits here.</Empty>
      ) : (
        <Stack>
          {open.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              busy={busy === proposal.id}
              onKeep={(text) =>
                void act(proposal.id, async () => {
                  const result = await api.keepProposal(proposal.id, text);
                  return `${proposal.title}: ${result.note}`;
                })
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

function ProposalCard({
  proposal,
  busy,
  onKeep,
  onDiscard,
}: {
  proposal: ProposalRow;
  busy: boolean;
  onKeep: (text?: string) => void;
  onDiscard: (reason?: string) => void;
}): JSX.Element {
  const [text, setText] = useState(proposal.editable ?? '');
  const [reason, setReason] = useState('');
  const edited = proposal.editable !== null && text !== proposal.editable;
  const payload = proposal.payload;
  const echoes = proposal.echoes ?? [];
  return (
    <Card
      tone={proposal.untrusted ? 'warning' : 'accent'}
      title={proposal.title}
      meta={
        <>
          <Pill>{KIND_LABEL[proposal.kind]}</Pill>
          <Pill mono>{proposal.agent}</Pill>
          {proposal.untrusted ? <Pill tone="warning">untrusted text in view</Pill> : null}
        </>
      }
      foot={
        <Toolbar align="end">
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
          <Notice tone="warning" title="Made with untrusted text in view.">
            Something written by someone other than you was in the agent's context when it proposed this. Read it for
            instructions that came from there rather than from you.
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
            {typeof payload.before === 'string' ? (
              <Details summary={`What its ${payload.part === 'tools' ? 'tool list' : 'instructions'} say now`}>
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
              { label: 'Matches', value: <span className="mono">{JSON.stringify(payload.matcher ?? {})}</span> },
              { label: 'Does', value: String(payload.action ?? '') },
              {
                label: 'Learned from',
                value: `${Array.isArray(payload.verdicts) ? payload.verdicts.length : 0} decision(s)`,
              },
            ]}
          />
        ) : null}
      </Stack>
    </Card>
  );
}

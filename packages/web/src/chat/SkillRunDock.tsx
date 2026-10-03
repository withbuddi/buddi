/**
 * A skill bundle's script, as the approval dock asks about it (the kit's
 * SkRunDock): which script, from which bundle, its arguments, the working
 * folder, and what it may read and write — then Reject · Show the script ·
 * Allow once. No Auto and no Always: a bundle script asks every time, and the
 * gateway offers no standing permission for it (core's `asksEachTime`).
 *
 * It never shows an untrusted bundle's script: host.exec refuses that call
 * before anyone is asked, so every card here is from a bundle the owner
 * marked as theirs.
 */
import type { ApprovalRow } from '../api';
import { Button, ErrorBanner, KV, Spacer, Toolbar } from '../ui';
import { skillsRoute } from '../views/parts/skills-data';

/** What host.exec's envelope carries about a bundle script's run. */
export interface SkillRunEnvelope {
  bundle: string;
  title: string;
  script: string;
  interpreter: string;
  args: string[];
  reads: string;
  writes: string;
  files: number;
}

/** The run's context, when this action is a bundle script's. */
export function skillRunOf(action: ApprovalRow | null): SkillRunEnvelope | null {
  const envelope = action?.envelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const run = (envelope as Record<string, unknown>).skillRun;
  if (!run || typeof run !== 'object') return null;
  const r = run as Partial<SkillRunEnvelope>;
  if (typeof r.bundle !== 'string' || typeof r.script !== 'string') return null;
  return {
    bundle: r.bundle,
    title: typeof r.title === 'string' ? r.title : r.bundle,
    script: r.script,
    interpreter: typeof r.interpreter === 'string' ? r.interpreter : '',
    args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [],
    reads: typeof r.reads === 'string' ? r.reads : '',
    writes: typeof r.writes === 'string' ? r.writes : '',
    files: typeof r.files === 'number' ? r.files : 0,
  };
}

/** An argument as typed: quoted when it has a space or a quote in it. */
function shown(arg: string): string {
  return /[\s"'\\]/.test(arg) || arg === '' ? JSON.stringify(arg) : arg;
}

/** `--title "Night Train"` on one line: a flag and its value together. */
function argLines(args: readonly string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    const next = args[i + 1];
    if (a.startsWith('-') && !a.includes('=') && next !== undefined && !next.startsWith('-')) {
      lines.push(`${shown(a)} ${shown(next)}`);
      i += 1;
    } else lines.push(shown(a));
  }
  return lines;
}

export function SkillRunDock({
  action,
  run,
  agentName,
  count,
  busy,
  error,
  onDecide,
}: {
  action: ApprovalRow;
  run: SkillRunEnvelope;
  agentName: string;
  count: number;
  busy: 'approve' | 'reject' | null;
  error: string | null;
  onDecide: (decision: 'approve' | 'reject') => void;
}): JSX.Element {
  const disabled = busy !== null || action.state !== 'pending';
  const lines = argLines(run.args);
  return (
    <section id="approval-dock" tabIndex={-1} className="wb-question skb-dock" data-kind="approval" aria-label="Approval needed" data-testid="approval-dock">
      <div className="wb-question-head">
        <span className="wb-question-kicker">Needs your OK</span>
        {count > 1 ? <span className="wb-dock-count" data-testid="approval-dock-count">1 of {count}</span> : null}
        <strong>{agentName} wants to run a script from {run.title}</strong>
      </div>
      <div className="wb-dock-section wb-dock-subject">
        <code className="wb-dock-gist">{[run.interpreter, run.script].filter(Boolean).join(' ')}</code>
        <span className="wb-dock-where">From a bundle you marked as yours.</span>
      </div>
      <div className="wb-dock-section">
        <KV
          items={[
            { label: 'Arguments', value: lines.length ? <span className="mono skb-args">{lines.map((l, i) => <span key={`${i}:${l}`}>{l}</span>)}</span> : 'None' },
            { label: 'Working folder', value: <span className="mono skb-path">{run.writes}</span> },
            {
              label: 'What it may touch',
              value: `Reads ${run.title}’s ${run.files} file${run.files === 1 ? '' : 's'} without changing them, and the working folder. Writes only in the working folder.`,
            },
          ]}
        />
      </div>
      <ErrorBanner message={error} />
      <div className="wb-dock-section">
        <Toolbar>
          <span className="skb-dock-note">Scripts ask every time.</span>
          <Spacer />
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onDecide('reject')}>{busy === 'reject' ? 'Rejecting…' : 'Reject'}</Button>
          <Button size="sm" onClick={() => { window.location.hash = skillsRoute(run.bundle, run.script); }}>Show the script</Button>
          <Button variant="good" size="sm" disabled={disabled} onClick={() => onDecide('approve')}>{busy === 'approve' ? 'Allowing…' : 'Allow once'}</Button>
        </Toolbar>
      </div>
    </section>
  );
}

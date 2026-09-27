/**
 * A delegation that came back after the owner decided, unfolded for a person.
 *
 * The colleague's answer arrives as the delegate tool's output — its name, its
 * words, the files it saved, a note for the asking model — and dumping that
 * object on screen is a record, not a reading. This draws the parts the owner
 * wants: who was asked, the question, the answer, the files, how long it took.
 * The object itself stays one click further down, under "Raw JSON".
 *
 * The question is not in the output; it is on the call that asked, found by
 * the colleague's approval id the call's result was left waiting on.
 */
import { DELEGATE_TOOL } from '../canvas/renderables';
import { Details } from '../ui';
import { delegatedFiles, downloadUrl, isPreviewable, previewUrl, type AttachmentBlock } from './attachments';
import { FileTile } from './FileTile';
import { Markdown } from './markdown';
import type { ChatBlock, ChatMessage } from './types';

export interface DelegationSummary {
  /** The colleague's name, or its handle or id when that is all there is. */
  who: string | null;
  question: string | null;
  answer: string | null;
  files: AttachmentBlock[];
  /** From the ask to the answer, in milliseconds, when both ends are dated. */
  durationMs: number | null;
}

/** What a delegate output and the call that asked for it say, for a person. */
export function delegationSummary(output: unknown, asked: { input: unknown; at: string | null } | null, answeredAt: string | null): DelegationSummary {
  const out = record(output);
  const input = record(asked?.input);
  const who = text(out?.['name']) ?? handle(text(out?.['handle'])) ?? text(out?.['agent']) ?? text(input?.['agent']);
  const answer = typeof output === 'string' ? (output.trim() || null) : text(out?.['text']) ?? text(out?.['note']);
  const own = finite(out?.['durationMs']) ?? finite(out?.['elapsedMs']);
  const from = asked?.at ? Date.parse(asked.at) : NaN;
  const to = answeredAt ? Date.parse(answeredAt) : NaN;
  const spanned = Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
  return {
    who,
    question: text(input?.['task']),
    answer,
    files: delegatedFiles(output),
    durationMs: own ?? spanned,
  };
}

/** The delegate call a decided colleague action answers, by the approval it waited on. */
export function askingCall(messages: readonly ChatMessage[], actionId: string): { input: unknown; at: string | null } | null {
  let toolUseId: string | null = null;
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_result' && block.name === DELEGATE_TOOL && block.delegation?.approvalId === actionId) toolUseId = block.toolUseId;
    }
  }
  if (toolUseId === null) return null;
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_use' && block.id === toolUseId) return { input: block.input, at: message.at || null };
    }
  }
  return null;
}

export function DelegationResult({
  block,
  messages,
  answeredAt,
}: {
  block: Extract<ChatBlock, { type: 'approval_result' }>;
  messages: readonly ChatMessage[];
  answeredAt: string | null;
}): JSX.Element {
  const summary = delegationSummary(block.output, askingCall(messages, block.actionId), answeredAt);
  const facts = [summary.who ? `Asked ${summary.who}` : null, summary.durationMs === null ? null : `took ${duration(summary.durationMs)}`]
    .filter((fact): fact is string => fact !== null);
  return (
    <div className="wb-delegation-result" data-testid="delegation-result">
      {facts.length > 0 ? <p className="wb-delegation-facts">{facts.join(' · ')}</p> : null}
      {summary.question ? <blockquote className="wb-delegation-question">{summary.question}</blockquote> : null}
      {summary.answer ? (
        <div className="wb-delegation-answer" data-testid="delegation-answer"><Markdown text={summary.answer} /></div>
      ) : (
        <p className="wb-delegation-facts">No answer came back.</p>
      )}
      {summary.files.length > 0 ? (
        <div className="wb-msg-files" role="list" aria-label={`Files ${summary.who ?? 'the colleague'} made`}>
          {summary.files.map((file) => (
            <a role="listitem" key={file.artifactId} href={downloadUrl(file.artifactId)} download>
              <FileTile
                name={file.filename ?? 'Untitled file'}
                mime={file.mime}
                sizeBytes={file.sizeBytes}
                thumbnail={isPreviewable(file.mime) ? previewUrl(file.artifactId) : null}
                size="sm"
              />
            </a>
          ))}
        </div>
      ) : null}
      <Details summary="Raw JSON">
        <pre className="wb-approval-output mono">{stringify(block.output)}</pre>
      </Details>
    </div>
  );
}

/** A span a person reads: 800ms, 12s, 3m 04s. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

function handle(value: string | null): string | null {
  return value === null ? null : `@${value.replace(/^@/, '')}`;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

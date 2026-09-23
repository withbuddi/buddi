/**
 * `terminal` — what a command printed, the way a terminal shows it.
 *
 * The command is the header line, with the exit code and the elapsed time as
 * the facts beside it and "Copy" on the right. The output is the body: plain
 * text in a dark monospace box, scrollable, which follows the end as output
 * arrives unless the owner has scrolled up to read something. A cap that
 * dropped the head of the output is said above the body, so a tail never
 * passes for the whole.
 *
 * The body is its own component because the Preview panel's output pane is
 * the same thing: what a running process has printed.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { formatBytes } from '../../chat/attachments';
import { Button, Pill, Toolbar } from '../../ui';
import { fmtValue } from '../format';
import type { TerminalProps } from '../types';

/** How close to the end still counts as "at the end", in CSS pixels of scroll. */
const AT_END_SLACK = 8;

/**
 * The dark body. Follows the end while the reader is at it: a scroll up
 * stops the following, and a scroll back down to the end starts it again.
 */
export function TerminalBody({
  text,
  label = 'Output',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLPreElement | null>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const body = ref.current;
    if (body && following.current) body.scrollTop = body.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      className={className ? `wb-terminal-body ${className}` : 'wb-terminal-body'}
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => {
        const body = event.currentTarget;
        following.current = body.scrollHeight - body.scrollTop - body.clientHeight <= AT_END_SLACK;
      }}
    >
      {text}
    </pre>
  );
}

/** `1234` → `1.2 s`; under a second stays in milliseconds. */
export function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

function CopyOutput({ text }: { text: string }): JSX.Element {
  const [status, setStatus] = useState('');
  return (
    <>
      {status ? <span role="status" className="wb-hint">{status}</span> : null}
      <Button
        size="sm"
        onClick={() => {
          setStatus('');
          if (!navigator.clipboard?.writeText) {
            setStatus('Copy unavailable; select the text to copy.');
            return;
          }
          void navigator.clipboard.writeText(text).then(
            () => setStatus('Copied'),
            () => setStatus('Copy failed; select the text to copy.'),
          );
        }}
      >
        Copy
      </Button>
    </>
  );
}

export function TerminalView({ props }: { props: TerminalProps }): JSX.Element {
  const output = props.output ?? '';
  return (
    <div className="wb-terminal">
      <Toolbar className="wb-terminal-head">
        {props.command !== null ? (
          <code className="wb-terminal-command" title={props.command}>
            {props.command}
          </code>
        ) : null}
        {props.exitCode !== null ? (
          <Pill tone={props.exitCode === 0 ? 'good' : 'critical'} mono>
            exit {props.exitCode}
          </Pill>
        ) : null}
        {props.elapsedMs !== null ? <span className="wb-terminal-fact">{fmtElapsed(props.elapsedMs)}</span> : null}
        <span className="ui-toolbar-spacer" />
        {output !== '' ? <CopyOutput text={output} /> : null}
      </Toolbar>

      {props.omittedBytes !== null ? (
        <p className="wb-terminal-note">First {formatBytes(props.omittedBytes)} not shown.</p>
      ) : null}

      {output !== '' ? (
        <TerminalBody text={output} />
      ) : (
        <p className="wb-empty">No output.</p>
      )}

      {props.metadata.length > 0 ? (
        <dl className="ui-kv wb-terminal-facts">
          {props.metadata.map((item) => (
            <div key={item.label} className="contents">
              <dt>{item.label}</dt>
              <dd>{fmtValue(item.value, item.unit, null)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

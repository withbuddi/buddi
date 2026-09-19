import { useState, type ReactNode } from 'react';
import type { CommandResultView } from '../command-result';
import { json } from '../../format';

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [status, setStatus] = useState('');
  return <span className="wb-command-copy">
    <button className="wb-btn" onClick={() => {
      setStatus('');
      if (!navigator.clipboard?.writeText) { setStatus('Copy unavailable; select the text to copy.'); return; }
      void navigator.clipboard.writeText(text).then(() => setStatus('Copied'), () => setStatus('Copy failed; select the text to copy.'));
    }}>{label}</button>
    {status && <span role="status" className="wb-hint">{status}</span>}
  </span>;
}

function Output({ title, text, error = false }: { title: string; text: string; error?: boolean }): JSX.Element {
  return <section className="wb-command-stream" data-error={error || undefined}>
    <div className="wb-command-bar"><h4>{title}</h4><CopyButton text={text} label={`Copy ${title.toLowerCase()}`} /></div>
    <pre className="wb-command-text" aria-label={title} tabIndex={0}>{text}</pre>
  </section>;
}

export function CommandResult({ value, children }: { value: CommandResultView; children?: ReactNode }): JSX.Element {
  const { result, command, input } = value;
  const failed = result.state === 'completed' && result.exitCode !== null && result.exitCode !== 0;
  const signal = typeof result.signal === 'string' && result.signal ? result.signal : null;
  const good = result.state === 'completed' && result.exitCode === 0;
  const details = Object.fromEntries(Object.entries(result).filter(([key, item]) =>
    !['stdout', 'stderr', 'state', 'exitCode', 'artifacts', 'outputErrors', 'command'].includes(key)
    && item !== null && item !== undefined && item !== ''));
  const errors = Array.isArray(result.outputErrors) ? result.outputErrors.filter((e): e is string => typeof e === 'string') : [];
  return <div className="wb-command-result">
    <div className="wb-command-bar">
      <span className="pill" data-tone={good ? 'good' : 'critical'}>{failed ? 'Failed' : result.state === 'completed' && signal ? 'Terminated' : result.state}</span>
      {result.exitCode !== null && <span className="mono">Exit code {result.exitCode}</span>}
      {signal && <span className="mono">Signal {signal}</span>}
      <span className="wb-hint">Recorded command result</span>
    </div>
    {command !== null && <Output title="Command" text={command} />}
    {result.state === 'output-limit' && <p className="wb-fail">Output limit reached. The command was stopped and the captured output may be incomplete.</p>}
    {result.state === 'timed-out' && <p className="wb-fail">The command exceeded its time limit. Output below may be partial.</p>}
    {result.state === 'cancelled' && <p className="wb-note">The command was cancelled. Completed changes were not undone.</p>}
    {result.stdout ? <Output title="Output" text={result.stdout} /> : <p className="wb-note">No standard output.</p>}
    {result.stderr ? <Output title="Standard error" text={result.stderr} error /> : null}
    {errors.length > 0 && <section><h4>File export errors</h4>{errors.map((error, i) => <p className="wb-fail" key={i}>{error}</p>)}</section>}
    {children}
    {(Object.keys(details).length > 0 || input !== null) && <details className="wb-aside">
      <summary>Execution details</summary>
      <pre>{json({ ...details, ...(input ? { input } : {}) })}</pre>
    </details>}
  </div>;
}

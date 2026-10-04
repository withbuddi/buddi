/**
 * Settings → System, the last row: "Remove buddi from this Mac".
 *
 * One dialog, three steps, nothing deleted until the last:
 *
 *  1. What goes (the data folder, the keychain entries, the background
 *     service, buddi.app), and "Keep my data for a reinstall".
 *  2. The last backup, moved to ~/buddi-backups, and the six words that open
 *     it with Copy and "I wrote it down" — they leave the keychain with the
 *     rest, so they have to be with the owner first.
 *  3. Remove: the supervisor runs the uninstall; buddi.app finishes it and
 *     moves itself to the Trash.
 *
 * The gateway answers only on this computer and only with the token the plan
 * minted (packages/gateway/src/web/uninstall.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type UninstallPlan as AnyPlan } from '../../api';
import { Button, ErrorBanner, Modal, Notice, Section, Stack, Toolbar } from '../../ui';

type Step = 'plan' | 'backup' | 'words' | 'removing';
type UninstallPlan = Extract<AnyPlan, { available: true }>;

export function RemoveBuddi(): JSX.Element {
  const [plan, setPlan] = useState<UninstallPlan | null>(null);
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .uninstallPlan()
      .then((answer) => {
        if (!answer.available) { setUnavailable(answer.reason); return; }
        setPlan(answer);
        setOpen(true);
      })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return (
    <Section title="Remove buddi">
      <Stack gap="sm">
        <ErrorBanner message={failed} />
        {unavailable ? <Notice>{unavailable}</Notice> : (
          <p className="ui-card-meta">Takes a last backup and gives you its passphrase first; nothing is deleted before you have both.</p>
        )}
        <Toolbar align="end">
          <Button variant="danger" disabled={busy || unavailable !== null} onClick={start}>
            Remove buddi from this Mac…
          </Button>
        </Toolbar>
      </Stack>
      {open && plan ? <RemoveDialog plan={plan} onClose={() => setOpen(false)} /> : null}
    </Section>
  );
}

/** The lines of what goes, in the owner's words. */
export function removalLines(plan: UninstallPlan, keepData: boolean): string[] {
  const lines: string[] = [];
  if (plan.service) lines.push(`The background service (${plan.service}).`);
  if (!keepData) {
    lines.push(`Your data: agents, chats, memory, files and the database, in ${plan.data}.`);
    if (plan.keychain) lines.push(`The passwords and keys buddi keeps in the keychain (${plan.keychain}).`);
  }
  if (plan.app) lines.push(`buddi.app, moved to the Trash (${plan.app}).`);
  return lines;
}

const BACKUP_POLL_MS = 1_000;

function RemoveDialog({ plan, onClose }: { plan: UninstallPlan; onClose: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>('plan');
  const [keepData, setKeepData] = useState(false);
  const [wrote, setWrote] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [kept, setKept] = useState<{ archive: string; passphraseFile?: string; passphrase?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const follow = (id: string): void => {
    api
      .uninstallJob(id)
      .then((job) => {
        setPhase(job.detail ?? job.phase);
        if (!job.finishedAt) { timer.current = window.setTimeout(() => follow(id), BACKUP_POLL_MS); return; }
        if (job.phase !== 'done' || !job.report) { setFailed(`The last backup did not finish: ${job.error ?? 'no reason given'}. Nothing was removed.`); setStep('plan'); return; }
        setKept(job.report);
        setStep('words');
      })
      .catch((error: unknown) => { setFailed(error instanceof ApiError ? error.message : String(error)); setStep('plan'); });
  };
  const backup = (): void => {
    setFailed(null);
    setStep('backup');
    api
      .uninstallBackup(plan.token)
      .then((answer) => follow(answer.job.id))
      .catch((error: unknown) => { setFailed(error instanceof ApiError ? error.message : String(error)); setStep('plan'); });
  };
  const remove = (): void => {
    setFailed(null);
    setStep('removing');
    api
      .uninstall({ token: plan.token, wroteItDown: true, keepData })
      .catch((error: unknown) => {
        // The gateway going away mid-answer is the removal under way.
        if (error instanceof ApiError && error.status !== 0 && error.status < 500) { setFailed(error.message); setStep('words'); }
      });
  };

  const lines = removalLines(plan, keepData);
  const foot = step === 'plan' ? (
    <>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="accent" onClick={backup}>Take the last backup</Button>
    </>
  ) : step === 'words' ? (
    <>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="danger" disabled={!wrote && kept?.passphrase !== undefined} onClick={remove}>Remove buddi</Button>
    </>
  ) : null;

  return (
    <Modal title="Remove buddi from this Mac" onClose={step === 'removing' ? () => {} : onClose} foot={foot}>
      <Stack gap="sm">
        <ErrorBanner message={failed} />
        {step === 'plan' || step === 'backup' ? (
          <>
            <p>This removes:</p>
            <ul className="remove-list">{lines.map((line) => <li key={line}>{line}</li>)}</ul>
            <p className="ui-card-meta">First, one last backup goes to <span className="mono">{plan.backups}</span>, where it stays.</p>
            <label className="backup-check">
              <input type="checkbox" checked={keepData} disabled={step !== 'plan'} onChange={(event) => setKeepData(event.target.checked)} />
              <span>Keep my data for a reinstall</span>
            </label>
            {step === 'backup' ? <Notice role="status">Taking the last backup{phase ? `: ${phase}` : ''}…</Notice> : null}
          </>
        ) : null}
        {step === 'words' && kept ? (
          <>
            <p>The last backup is <span className="mono">{kept.archive}</span>.</p>
            {kept.passphrase ? (
              <>
                <p>These six words open it. They leave this Mac's keychain with the rest, so write them down now:</p>
                <p className="backup-phrase mono" aria-label="Your backup passphrase">{kept.passphrase}</p>
                {kept.passphraseFile ? <p className="ui-card-meta">They are also in <span className="mono">{kept.passphraseFile}</span>, which only you can read. Delete it once they are written down.</p> : null}
                <Toolbar align="end">
                  <Button onClick={() => { void navigator.clipboard.writeText(kept.passphrase!).then(() => setCopied(true), () => setCopied(false)); }}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </Toolbar>
                <label className="backup-check">
                  <input type="checkbox" checked={wrote} onChange={(event) => setWrote(event.target.checked)} />
                  <span>I wrote it down</span>
                </label>
              </>
            ) : null}
            <ul className="remove-list">{lines.map((line) => <li key={line}>{line}</li>)}</ul>
          </>
        ) : null}
        {step === 'removing' ? (
          <Notice role="status">
            {plan.appFinishes
              ? 'Removing buddi. The app quits when it is done.'
              : `Removing buddi. This page stops answering in a moment; what was removed is written to a log in ${plan.backups}.`}
          </Notice>
        ) : null}
      </Stack>
    </Modal>
  );
}

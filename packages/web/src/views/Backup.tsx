/**
 * Settings → Backup: the copy, the copies, and the way back from one.
 *
 * Everything here is one of four things the owner ever wants: a backup taken
 * on its own every night, a backup taken right now, proof that the ones on
 * disk are still readable, and the passphrase without which none of them opens.
 * Restoring is the fifth and it is deliberately the last thing on the page,
 * behind a word typed back, because it replaces everything.
 *
 * The gateway does the work through the supervisor. A developer checkout has
 * no supervisor and so cannot stop the gateway to restore under it; there the
 * restore block says the one command that does it instead.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type BackupArchive,
  type BackupJob,
  type BackupSchedule,
} from '../api';
import { formatBytes } from '../chat/attachments';
import { fmtRelative } from '../format';
import { Button, Empty, ErrorBanner, Field, FormGrid, Notice, Pill, Section, Stack, Table, Toolbar, useAsync, EmptyState } from '../ui';
import { RecoveryChecklist, useRecovery } from './Recovery';

/** How often a running job is asked where it has got to. */
const JOB_POLL_MS = 2_000;

/** What each phase of a job is, in the words of the thing being waited for. */
const PHASE_WORDS: Record<string, string> = {
  queued: 'Getting started.',
  stopping: 'Stopping the gateway. The database stays up.',
  snapshot: 'Taking a copy of what is here now, first.',
  database: 'Putting the database back.',
  recovery: 'Marking this installation as restored.',
  files: 'Putting the files back.',
  starting: 'Starting back up.',
  encrypt: 'Locking it with your passphrase.',
  done: 'Done.',
  failed: 'That did not work.',
  'rolled-back': 'That did not work, so everything was put back as it was.',
};

function phaseWords(job: BackupJob): string {
  return PHASE_WORDS[job.phase] ?? job.detail ?? job.phase;
}

/** A phase nothing follows. */
const ENDED = new Set(['done', 'failed', 'rolled-back']);

function finished(job: BackupJob | undefined): boolean {
  return job !== undefined && (ENDED.has(job.phase) || Boolean(job.finishedAt));
}

/**
 * One job, watched to its end.
 *
 * A restore takes the gateway down with it, so losing contact is part of the
 * job rather than an error: the poll keeps asking, and the first answer after
 * the silence means the gateway is back — at which point this page is reading
 * a database it no longer matches, and the honest thing is to reload it.
 */
function useJob(id: string | null): { job: BackupJob | undefined; away: boolean; error: string | null } {
  const [job, setJob] = useState<BackupJob | undefined>(undefined);
  const [away, setAway] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lost = useRef(false);
  useEffect(() => {
    if (!id) {
      setJob(undefined);
      setAway(false);
      lost.current = false;
      return undefined;
    }
    let stopped = false;
    const ask = (): void => {
      api
        .backupJob(id)
        .then((next) => {
          if (stopped) return;
          if (lost.current) {
            // The gateway answered again after going away: whatever this page
            // is holding was read before the restore.
            window.location.reload();
            return;
          }
          setJob(next);
          setError(null);
          if (finished(next)) stopped = true;
        })
        .catch((err: unknown) => {
          if (stopped) return;
          // A gateway that is restarting refuses or never answers. Both are
          // the middle of a restore, not a failure to report.
          if (err instanceof ApiError && err.status !== 0 && err.status < 500) {
            setError(err.message);
            return;
          }
          lost.current = true;
          setAway(true);
        });
    };
    ask();
    const timer = window.setInterval(ask, JOB_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [id]);
  return { job, away, error };
}

/** A job's line: where it is, or what went wrong. */
function JobProgress({ job, away, error }: ReturnType<typeof useJob>): JSX.Element | null {
  if (error) return <ErrorBanner message={error} />;
  if (away) {
    return (
      <Notice tone="warning" role="status">
        buddi is restarting. This page comes back on its own when it answers again.
      </Notice>
    );
  }
  if (!job) return null;
  if (job.phase === 'rolled-back' || job.phase === 'failed') {
    return (
      <Notice tone="critical" role="alert">
        {phaseWords(job)} {job.error ?? ''}
      </Notice>
    );
  }
  return (
    <Notice tone={job.phase === 'done' ? 'good' : undefined} role="status">
      {phaseWords(job)}
      {job.copyLate ? ' The backup was made, but the copy to your folder did not go through.' : ''}
      {job.error ? ` ${job.error}` : ''}
    </Notice>
  );
}

export function Backup(): JSX.Element {
  const view = useAsync(() => api.backups(), [], 30_000);
  const recovery = useRecovery();
  const service = useAsync(() => api.service(), []);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set when the server says this installation cannot restore under itself. */
  const [noSupervisor, setNoSupervisor] = useState<string | null>(null);

  /*
   * A checkout is known two ways, and either is enough: the supervisor section
   * already knows whether one supervises this gateway, and a restore that is
   * refused says so with a 409 and the command to run instead.
   */
  const supervised = view.data?.supervised ?? service.data?.supervised;
  const checkout = noSupervisor !== null || supervised === false;

  const archives = view.data?.archives ?? [];

  const run = (work: Promise<{ job: BackupJob }>): void => {
    setBusy(true);
    setFailed(null);
    work
      .then((answer) => setJobId(answer.job?.id ?? null))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 409) setNoSupervisor(error.message);
        else setFailed(error instanceof ApiError ? error.message : String(error));
      })
      .finally(() => {
        setBusy(false);
        view.reload();
      });
  };

  // A finished job changes the list it came from.
  useEffect(() => {
    if (finished(job.job)) view.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.job?.phase]);

  return (
    <Stack gap="lg">
      {recovery.data?.active ? <RecoveryChecklist view={recovery.data} onLeft={recovery.reload} /> : null}
      <ErrorBanner message={view.error ?? failed} />
      <JobProgress {...job} />

      <Schedule onSaved={() => view.reload()} />

      <Section
        title="Backups"
        panel
        actions={
          <Button variant="accent" size="sm" disabled={busy} onClick={() => run(api.startBackup(true))}>
            Back up now
          </Button>
        }
      >
        <Stack divided>
          <Section>
            <p className="ui-card-meta">
              Kept in <span className="mono">{view.data?.dir ?? '…'}</span>. A backup holds your
              agents, conversations, memory and files. It never holds a key.
            </p>
          </Section>
          <Section>
            {view.data && archives.length === 0 ? (
              <EmptyState icon="archive" title="No backups yet">Make one now, or turn on the nightly backup.</EmptyState>
            ) : !view.data ? (
              <Empty>Loading…</Empty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Taken</th>
                    <th>Size</th>
                    <th>State</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {archives.map((archive) => (
                    <ArchiveRow
                      key={archive.name}
                      archive={archive}
                      busy={busy}
                      database={view.data?.database}
                      checkout={checkout}
                      onVerify={() => run(api.verifyArchive(archive.name))}
                      onRestore={(passphrase, confirm) =>
                        run(api.restoreArchive({ name: archive.name, ...(passphrase ? { passphrase } : {}), ...(confirm ? { confirm } : {}) }))
                      }
                    />
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
        </Stack>
      </Section>

      <Passphrase />

      <FromAFile
        busy={busy}
        checkout={checkout}
        checkoutSaid={noSupervisor}
        database={view.data?.database}
        onRestore={(file, passphrase, confirm) => run(api.restoreUpload(file, { passphrase, confirm }))}
      />
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * Every night, by itself
 * ------------------------------------------------------------------ */

const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  time: '03:00',
  keep: 7,
  encryptLocal: true,
  copyTo: null,
};

function Schedule({ onSaved }: { onSaved: () => void }): JSX.Element {
  const loaded = useAsync(() => api.backupSchedule(), []);
  const [draft, setDraft] = useState<BackupSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (loaded.data) setDraft(loaded.data);
  }, [loaded.data]);
  const current = { ...DEFAULT_SCHEDULE, ...(draft ?? loaded.data ?? {}) };
  /*
   * A checkout's nightly backup is a launchd or systemd unit rather than
   * anything the supervisor keeps, so the server says so and this says it
   * back. A switch that changed nothing would be worse than no switch.
   */
  if (loaded.data?.supervised === false) {
    return (
      <Section title="Every night" panel>
        <Section>
          <Notice tone="warning">{loaded.data.error ?? 'This installation schedules its own backups.'}</Notice>
        </Section>
      </Section>
    );
  }
  const set = (patch: Partial<BackupSchedule>): void => {
    setSaved(false);
    setDraft({ ...current, ...patch });
  };
  const save = (): void => {
    setSaving(true);
    setFailed(null);
    api
      .setBackupSchedule(current)
      .then((next) => {
        setDraft(next);
        setSaved(true);
        onSaved();
      })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setSaving(false));
  };
  return (
    <Section
      title="Every night"
      panel
      foot={
        <Button variant="accent" disabled={saving} onClick={save}>
          Save
        </Button>
      }
    >
      <Stack divided>
        <Section>
          <Stack gap="sm">
            <ErrorBanner message={failed} />
            <label className="backup-check">
              <input type="checkbox" checked={current.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
              <span>Back this buddi up on its own</span>
            </label>
            <FormGrid>
              <Field label="At">
                <input type="time" value={current.time} onChange={(event) => set({ time: event.target.value })} />
              </Field>
              <Field label="Keep" hint="How many to keep before the oldest is thrown away.">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={current.keep}
                  onChange={(event) => set({ keep: Number(event.target.value) || 1 })}
                />
              </Field>
            </FormGrid>
            <label className="backup-check">
              <input
                type="checkbox"
                checked={current.encryptLocal}
                onChange={(event) => set({ encryptLocal: event.target.checked })}
              />
              <span>Lock each one with the passphrase</span>
            </label>
          </Stack>
        </Section>
        <Section>
          <Stack gap="sm">
            <Field label="Also copy to a folder" hint="A second disk, or a folder that syncs somewhere. Left empty, backups stay on this machine.">
              <input
                type="text"
                value={current.copyTo ?? ''}
                placeholder="/Volumes/backup/buddi"
                onChange={(event) => set({ copyTo: event.target.value === '' ? null : event.target.value })}
              />
            </Field>
            {saved ? <Notice tone="good" role="status">Saved.{current.lastRunAt ? ` Last run ${fmtRelative(current.lastRunAt)}.` : ''}</Notice> : null}
          </Stack>
        </Section>
      </Stack>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * One archive
 * ------------------------------------------------------------------ */

function ArchiveRow({
  archive,
  busy,
  database,
  checkout,
  onVerify,
  onRestore,
}: {
  archive: BackupArchive;
  busy: boolean;
  database: string | undefined;
  checkout: boolean;
  onVerify: () => void;
  onRestore: (passphrase: string, confirm: string) => void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  return (
    <>
      <tr>
        <td className="mono">{archive.name}</td>
        <td>{fmtRelative(archive.createdAt)}</td>
        <td>{formatBytes(archive.bytes)}</td>
        <td>
          {archive.encrypted ? <Pill tone="good">locked</Pill> : <Pill tone="muted">plain</Pill>}{' '}
          {archive.envelopeOk === false ? <Pill tone="critical">damaged</Pill> : null}
        </td>
        <td>
          <Toolbar align="end">
            <Button size="sm" disabled={busy} onClick={onVerify}>
              Verify
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(!asking)}>
              Restore…
            </Button>
          </Toolbar>
        </td>
      </tr>
      {asking ? (
        <tr>
          <td colSpan={5}>
            {checkout ? (
              <Notice tone="warning">{CHECKOUT_LINE}</Notice>
            ) : (
              <Confirm
                what={`${archive.name}, taken ${fmtRelative(archive.createdAt)}, ${formatBytes(archive.bytes)}`}
                database={database}
                needsPassphrase={archive.encrypted}
                passphrase={passphrase}
                onPassphrase={setPassphrase}
                confirm={confirm}
                onConfirm={setConfirm}
                busy={busy}
                onCancel={() => setAsking(false)}
                onGo={() => onRestore(passphrase, confirm)}
              />
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The one line a checkout gets instead of a restore.
 *
 * A checkout has no supervisor, so nothing can stop the gateway from under
 * itself and start it again afterwards. The command does both.
 */
const CHECKOUT_LINE = 'Restoring needs the packaged installation. In a checkout, run: buddi backup restore <file>';

/** What is about to be replaced, and the word that says you meant it. */
function Confirm({
  what,
  database,
  needsPassphrase,
  passphrase,
  onPassphrase,
  confirm,
  onConfirm,
  busy,
  onCancel,
  onGo,
}: {
  what: string;
  database: string | undefined;
  needsPassphrase: boolean;
  passphrase: string;
  onPassphrase: (next: string) => void;
  confirm: string;
  onConfirm: (next: string) => void;
  busy: boolean;
  onCancel: () => void;
  onGo: () => void;
}): JSX.Element {
  const asked = database ?? '';
  const ready = asked === '' ? confirm.trim() !== '' : confirm.trim() === asked;
  return (
    <Stack gap="sm">
      <Notice tone="warning">
        This replaces everything in this buddi with {what}. What is here now is copied first, so a
        restore that fails puts it back.
      </Notice>
      {needsPassphrase ? (
        <Field label="The passphrase this one was locked with">
          <input type="password" autoComplete="off" value={passphrase} onChange={(event) => onPassphrase(event.target.value)} />
        </Field>
      ) : null}
      <Field
        label={asked ? `Type ${asked} to confirm` : 'Type the name of this database to confirm'}
        hint={asked ? undefined : 'The same name buddi shows on the System tab.'}
      >
        <input value={confirm} onChange={(event) => onConfirm(event.target.value)} />
      </Field>
      <Toolbar align="end">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" disabled={busy || !ready || (needsPassphrase && passphrase === '')} onClick={onGo}>
          Restore
        </Button>
      </Toolbar>
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * The passphrase
 * ------------------------------------------------------------------ */

function Passphrase(): JSX.Element {
  const [shown, setShown] = useState<string | null>(null);
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const reveal = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .backupPassphrase()
      .then((answer) => setShown(answer.passphrase))
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const replace = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .setBackupPassphrase(own.trim())
      .then((answer) => {
        setShown(answer.passphrase);
        setOwn('');
        setSaved(true);
      })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return (
    <Section title="The passphrase" panel>
      <Stack divided>
        <Section>
          <Stack gap="sm">
            <ErrorBanner message={failed} />
            <p className="ui-card-meta">This is the only thing that opens an encrypted backup. Write it down.</p>
            {shown ? (
              <p className="backup-phrase mono">{shown}</p>
            ) : (
              <Toolbar align="end">
                <Button disabled={busy} onClick={reveal}>
                  Show it
                </Button>
              </Toolbar>
            )}
            {saved ? <Notice tone="good" role="status">Saved. Backups made from now on use it; older ones keep the one they were made with.</Notice> : null}
          </Stack>
        </Section>
        <Section>
          <Stack gap="sm">
            <Field label="Use my own" hint="Six words you can read out loud beat a short one nobody can.">
              <input type="text" autoComplete="off" value={own} onChange={(event) => { setSaved(false); setOwn(event.target.value); }} />
            </Field>
            <Toolbar align="end">
              <Button variant="accent" disabled={busy || own.trim() === ''} onClick={replace}>
                Use this one
              </Button>
            </Toolbar>
          </Stack>
        </Section>
      </Stack>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * From a file the owner brought
 * ------------------------------------------------------------------ */

function FromAFile({
  busy,
  checkout,
  checkoutSaid,
  database,
  onRestore,
}: {
  busy: boolean;
  checkout: boolean;
  checkoutSaid: string | null;
  database: string | undefined;
  onRestore: (file: File, passphrase: string, confirm: string) => void;
}): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [asking, setAsking] = useState(false);
  if (checkout) {
    return (
      <Section title="Restore from a file" panel>
        <Section>
          <Notice tone="warning">{checkoutSaid ?? CHECKOUT_LINE}</Notice>
        </Section>
      </Section>
    );
  }
  return (
    <Section title="Restore from a file" panel>
      <Stack divided>
        <Section>
          <Stack gap="sm">
            <p className="ui-card-meta">A backup from another buddi, or one you keep somewhere else.</p>
            <FormGrid>
              <Field label="The backup file">
                <input
                  type="file"
                  onChange={(event) => {
                    setAsking(false);
                    setFile(event.target.files?.[0] ?? null);
                  }}
                />
              </Field>
              <Field label="Its passphrase" hint="Only if it was locked with one.">
                <input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
              </Field>
            </FormGrid>
            {asking ? null : (
              <Toolbar align="end">
                <Button variant="accent" disabled={busy || !file} onClick={() => setAsking(true)}>
                  Restore
                </Button>
              </Toolbar>
            )}
          </Stack>
        </Section>
        {asking && file ? (
          <Section>
            <Confirm
              what={`${file.name}, ${formatBytes(file.size)}`}
              database={database}
              needsPassphrase={false}
              passphrase={passphrase}
              onPassphrase={setPassphrase}
              confirm={confirm}
              onConfirm={setConfirm}
              busy={busy}
              onCancel={() => setAsking(false)}
              onGo={() => onRestore(file, passphrase, confirm)}
            />
          </Section>
        ) : null}
      </Stack>
    </Section>
  );
}

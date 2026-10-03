/**
 * Settings → Memory → People: the owner's people, as a contact list every
 * agent reads (docs/memory.md, "People").
 *
 * A row per person: the initial on a warm tile, the name, who they are to the
 * owner and their birthday, the next date as a pill (accent within a week), a
 * bell when their reminders are on. The sheet edits everything, and "Remind me
 * of their dates" is the switch of the person's reminder missions (a week
 * before and on the day, from the front desk), greyed until a date is set.
 * Forget asks once, then offers Undo.
 *
 * People an agent proposed, and the ones the one-time look through the notes
 * found, wait above the list as cards — the same proposals as Settings →
 * Proposals — with Keep, Not a person, and Keep all.
 */
import { useState } from 'react';
import { ApiError, api, type PersonRow, type ProposalRow } from '../api';
import { UndoToast } from '../shell/UndoToast';
import { Button, Empty, Field, FormGrid, Icon, List, ListRow, Notice, Panel, Pill, Section, Sheet, Spacer, Stack, Switch, Toolbar, useAsync } from '../ui';
import { DayMonthField, dateOf, dateWords, draftOf } from './parts/DayMonthField';

const UNDO_MS = 8000;

/** An open card proposing a person (the memory plugin's `person` rule kind). */
export function isPersonCard(p: ProposalRow): boolean {
  return p.kind === 'policy' && p.state === 'open' && String(p.payload.plugin ?? '') === 'memory' && p.ruleKind === 'person';
}

/** "Birthday in 6 days · turns 35", "Anniversary today · 12 years", "Birthday 30 January". */
export function nextWords(p: PersonRow): string | null {
  if (!p.next) return null;
  const what = p.next.what === 'birthday' ? 'Birthday' : 'Anniversary';
  const years = p.next.turning === null ? '' : p.next.what === 'birthday' ? ` · turns ${p.next.turning}` : ` · ${p.next.turning} years`;
  if (p.next.inDays === 0) return `${what} today${years}`;
  if (p.next.inDays === 1) return `${what} tomorrow${years}`;
  if (p.next.inDays <= 14) return `${what} in ${p.next.inDays} days${years}`;
  if (p.next.inDays <= 31) return `${what} in ${Math.round(p.next.inDays / 7)} weeks`;
  const date = p[p.next.what];
  return date ? `${what} ${dateWords(date, false)}` : null;
}

function PersonFace({ name, small }: { name: string; small?: boolean }): JSX.Element {
  return <span className="person-face" data-size={small ? 'sm' : undefined} aria-hidden="true">{name.trim().charAt(0).toUpperCase()}</span>;
}

export function People(): JSX.Element {
  const people = useAsync(() => api.people(), [], 60_000);
  const proposals = useAsync(() => api.proposals(), [], 60_000);
  const [editing, setEditing] = useState<PersonRow | 'new' | null>(null);
  const [forgetting, setForgetting] = useState<PersonRow | null>(null);
  const [toast, setToast] = useState<{ id: number; person: PersonRow } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setProblem(null);
    try { await work(); people.reload(); proposals.reload(); return true; }
    catch (err) { setProblem(err instanceof ApiError ? err.message : String(err)); return false; }
    finally { setBusy(null); }
  };

  const cards = (proposals.data?.open ?? []).filter(isPersonCard);
  const rows = people.data?.people ?? [];
  const sub = (p: PersonRow): string =>
    [p.relationship, p.birthday ? `born ${dateWords(p.birthday)}` : null].filter(Boolean).join(' · ') || 'No details yet';

  return (
    <Stack gap="lg">
      {problem ? <Notice tone="critical">{problem}</Notice> : null}
      {cards.length > 0 ? (
        <Notice tone="accent" title={cards.length === 1 ? 'One person to keep?' : `${cards.length} people to keep?`}>
          <p>Your agents and your notes name them. Keep them as people and every agent knows who they are; nothing is added until you say so.</p>
          <Panel flush>
            <List>
              {cards.map((card) => (
                <ListRow
                  key={card.id}
                  lead={<PersonFace name={String((card.payload.matcher as { person?: string } | undefined)?.person ?? '?')} small />}
                  title={String(card.payload.action ?? '')}
                  sub={<span className="person-from">{card.why}</span>}
                  side={
                    <span className="person-side">
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run(`discard:${card.id}`, () => api.discardProposal(card.id, 'Not a person'))}>Not a person</Button>
                      <Button size="sm" disabled={busy !== null} onClick={() => void run(`keep:${card.id}`, () => api.keepProposal(card.id))}>Keep</Button>
                    </span>
                  }
                />
              ))}
            </List>
          </Panel>
          {cards.length > 1 ? (
            <Toolbar align="end">
              <Button variant="accent" size="sm" disabled={busy !== null} onClick={() => void run('keep-all', () => api.keepAllProposals(cards.map((c) => c.id)))}>Keep all ({cards.length})</Button>
            </Toolbar>
          ) : null}
        </Notice>
      ) : null}

      <Section
        title="People"
        aside="every agent knows who they are"
        panel
        flush
        actions={<Button variant="accent" size="sm" onClick={() => setEditing('new')}>Add a person</Button>}
      >
        {!people.data ? (
          <Empty>{people.error ?? 'Loading…'}</Empty>
        ) : rows.length === 0 ? (
          <Empty>Nobody yet. Tell any agent “Marion is my wife, her birthday is 14 March”, or add someone here. Agents ask before they add anyone you did not tell them about.</Empty>
        ) : (
          <List>
            {rows.map((p) => {
              const next = nextWords(p);
              return (
                <ListRow
                  key={p.id}
                  label={`${p.name}: edit`}
                  onClick={() => setEditing(p)}
                  lead={<PersonFace name={p.name} />}
                  title={p.name}
                  sub={sub(p)}
                  side={
                    <span className="person-side">
                      {next ? <Pill tone={p.next && p.next.inDays <= 7 ? 'accent' : undefined}>{next}</Pill> : null}
                      {p.reminders ? <span className="person-bell" title="Reminders on" aria-label="Reminders on"><Icon name="bell" size={14} /></span> : null}
                    </span>
                  }
                />
              );
            })}
          </List>
        )}
        <p className="person-note">Agents read each person in one line: name, who they are to you, how to address them, their dates. Notes are read only when an agent looks the person up.</p>
      </Section>

      {editing ? (
        <PersonSheet
          person={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); people.reload(); }}
          onForget={(p) => { setEditing(null); setForgetting(p); }}
        />
      ) : null}
      {forgetting ? (
        <Sheet
          title={`Forget ${forgetting.name}?`}
          onClose={() => setForgetting(null)}
          foot={
            <Toolbar>
              <Spacer />
              <Button variant="ghost" onClick={() => setForgetting(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={busy !== null}
                onClick={() => {
                  const gone = forgetting;
                  void run(`forget:${gone.id}`, () => api.forgetPerson(gone.id)).then((ok) => {
                    setForgetting(null);
                    if (ok) setToast({ id: Date.now(), person: gone });
                  });
                }}
              >
                Forget
              </Button>
            </Toolbar>
          }
        >
          <p>
            Every agent stops knowing who {forgetting.name} is{forgetting.reminders !== null ? ', and the reminders for their dates are removed' : ''}. Notes that mention them stay in Notes.
          </p>
        </Sheet>
      ) : null}
      {toast ? (
        <UndoToast
          key={toast.id}
          title={`Forgot ${toast.person.name}.`}
          duration={UNDO_MS}
          onUndo={() => { const back = toast.person; void run(`restore:${back.id}`, () => api.restorePerson(back.id)); }}
          onGone={() => setToast(null)}
        />
      ) : null}
    </Stack>
  );
}

function PersonSheet({ person, onClose, onSaved, onForget }: {
  person: PersonRow | null;
  onClose: () => void;
  onSaved: () => void;
  onForget: (person: PersonRow) => void;
}): JSX.Element {
  const [name, setName] = useState(person?.name ?? '');
  const [relationship, setRelationship] = useState(person?.relationship ?? '');
  const [addressAs, setAddressAs] = useState(person?.addressAs ?? '');
  const [birthday, setBirthday] = useState(draftOf(person?.birthday));
  const [anniversary, setAnniversary] = useState(draftOf(person?.anniversary));
  const [notes, setNotes] = useState(person?.notes ?? '');
  const [reminders, setReminders] = useState(person?.reminders === true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const birthdayDate = dateOf(birthday);
  const anniversaryDate = dateOf(anniversary);
  const incomplete = birthdayDate === 'incomplete' || anniversaryDate === 'incomplete';
  const hasDate = (birthdayDate !== null && birthdayDate !== 'incomplete') || (anniversaryDate !== null && anniversaryDate !== 'incomplete');

  const save = async (): Promise<void> => {
    if (incomplete) return;
    setSaving(true);
    setProblem(null);
    try {
      const clean = (value: string): string | null => (value.trim() === '' ? null : value.trim());
      await api.savePerson({
        ...(person ? { id: person.id } : {}),
        name: name.trim(),
        relationship: clean(relationship),
        addressAs: clean(addressAs),
        birthday: birthdayDate as Exclude<typeof birthdayDate, 'incomplete'>,
        anniversary: anniversaryDate as Exclude<typeof anniversaryDate, 'incomplete'>,
        notes: clean(notes),
        reminders: hasDate && reminders,
      });
      onSaved();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title={person ? person.name : 'Add a person'}
      onClose={onClose}
      foot={
        <Toolbar>
          {person ? <Button variant="danger-ghost" disabled={saving} onClick={() => onForget(person)}>Forget…</Button> : null}
          <Spacer />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={saving || name.trim() === '' || incomplete} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
        </Toolbar>
      }
    >
      <Stack gap="lg">
        <FormGrid>
          <Field label="Name">
            <input value={name} maxLength={80} placeholder="Marion" autoFocus={!person} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Who they are to you">
            <input value={relationship} maxLength={60} placeholder="wife, brother, accountant…" onChange={(e) => setRelationship(e.target.value)} />
          </Field>
        </FormGrid>
        <Field label="How to address them" hint="What agents call them when they write to you about them, or to them for you.">
          <input value={addressAs} maxLength={80} placeholder={name.trim() || 'Mum, Dr Lee…'} onChange={(e) => setAddressAs(e.target.value)} />
        </Field>
        <DayMonthField label="Birthday" hint="The year is optional." value={birthday} onChange={setBirthday} />
        <DayMonthField label="Anniversary" hint="A wedding, the day you met: the year is optional." value={anniversary} onChange={setAnniversary} />
        <Field label="Notes" hint="Gift ideas, allergies, what they are into. Read when an agent looks them up.">
          <textarea rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="person-remind" data-off={hasDate ? undefined : 'true'}>
          <div className="person-remind-text">
            <div className="person-remind-title">Remind me of their dates</div>
            <div className="ui-field-hint">{hasDate ? 'A week before and on the day, from the front desk, with an offer to find something.' : 'Add a birthday or an anniversary first.'}</div>
          </div>
          <Switch checked={hasDate && reminders} disabled={!hasDate} onChange={setReminders} label="Remind me of their dates" />
        </div>
        {problem ? <Notice tone="critical">{problem}</Notice> : null}
      </Stack>
    </Sheet>
  );
}

/**
 * You: who the agents are talking to.
 *
 * Four fields, one row in the database, read into every agent's prompt. This
 * is the same profile the first-run interview fills and an agent updates when
 * you tell it "call me Sam"; the page is just the direct way to see it and
 * change it. Nothing here is a permission — it is how to address a person.
 */
import { useEffect, useState } from 'react';
import { ApiError, api, type OwnerView } from '../api';
import { Button, ErrorBanner, Field, Notice, PageFrame, Section, Stack, Toolbar, useAsync } from '../ui';

export function You({ embedded }: { embedded?: boolean }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.owner(), []);
  return (
    <PageFrame embedded={embedded} title="You" lede="What every agent knows about the person it is talking to.">
      <ErrorBanner message={error} />
      {data ? <Form initial={data} onSaved={reload} /> : null}
    </PageFrame>
  );
}

function Form({ initial, onSaved }: { initial: OwnerView; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(initial.preferredName ?? '');
  const [zone, setZone] = useState(initial.timezone ?? '');
  const [language, setLanguage] = useState(initial.language ?? '');
  const [about, setAbout] = useState(initial.about ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setName(initial.preferredName ?? '');
    setZone(initial.timezone ?? '');
    setLanguage(initial.language ?? '');
    setAbout(initial.about ?? '');
  }, [initial]);

  const dirty =
    name.trim() !== (initial.preferredName ?? '') ||
    zone !== (initial.timezone ?? '') ||
    language.trim() !== (initial.language ?? '') ||
    about.trim() !== (initial.about ?? '');

  const save = async (): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      await api.setOwner({
        preferredName: name.trim() === '' ? null : name.trim(),
        timezone: zone === '' ? null : zone,
        language: language.trim() === '' ? null : language.trim(),
        about: about.trim() === '' ? null : about.trim(),
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const zones = initial.zones.length > 0 ? initial.zones : [initial.detectedTimezone];
  return (
    <Section
      title="Your profile"
      aside="read by every agent, as context"
      panel
      foot={
        <>
          {saved && !dirty ? <span className="muted">Saved</span> : null}
          <Button variant="accent" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <Stack divided gap="lg">
        <Section title="Name and place">
          <Toolbar valign="end">
            <Field label="What the agents call you" grow>
              <input value={name} maxLength={80} placeholder={initial.displayName ?? 'Your name'} onChange={(e) => { setSaved(false); setName(e.target.value); }} />
            </Field>
            <Field label="Timezone" hint={`This host is in ${initial.detectedTimezone}. Existing schedules keep the zone they were made in.`}>
              <select value={zone} onChange={(e) => { setSaved(false); setZone(e.target.value); }}>
                <option value="">Not set (use the host's)</option>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </Field>
            <Field label="Answer me in" hint="A language, as you would say it. Blank mirrors whatever you write in.">
              <input value={language} maxLength={40} placeholder="English, français…" onChange={(e) => { setSaved(false); setLanguage(e.target.value); }} />
            </Field>
          </Toolbar>
        </Section>
        <Section title="About you">
          <Field label="In your own words" hint="Who you are, how you like answers, anything every agent should keep in mind. A few lines is plenty.">
            <textarea
              rows={4}
              maxLength={1000}
              value={about}
              placeholder="I run a small studio and prefer short answers with the numbers first. Call me by my first name."
              onChange={(e) => { setSaved(false); setAbout(e.target.value); }}
            />
          </Field>
          {problem ? <Notice tone="critical">{problem}</Notice> : null}
        </Section>
      </Stack>
    </Section>
  );
}

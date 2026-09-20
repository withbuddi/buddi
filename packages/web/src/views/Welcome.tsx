/**
 * First run: seven screens between a fresh install and a first conversation.
 *
 * The wizard owns no settings of its own. Two of its screens are the settings
 * pages themselves, embedded (`You`, `Providers`), one is the chat, and the
 * rest are a sentence and a button. What it adds is order, a record of where
 * the owner got to, and the promise that none of it needs a terminal.
 *
 * Progress lives on the server (`/api/onboarding`), not in this component: a
 * reload, a restart, or the same install opened in another tab resumes at the
 * same screen. `needs` is what the server still has no answer for — a name, a
 * model account, an agent — and it is what gates Next rather than anything the
 * page believes about what it just saved.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, chatApi, ApiError, type CreatedAgent, type OnboardingView } from '../api';
import { ChatPage } from '../chat/ChatPage';
import { groupAgents } from '../shell/roster';
import { HOME_ROUTE, welcomeRoute } from '../routes';
import { Providers } from './Providers';
import { You } from './You';
import {
  Button,
  Card,
  Code,
  ErrorBanner,
  Field,
  Notice,
  Section,
  Stack,
  Toolbar,
  useAsync,
} from '../ui';

/** The screens, in order. `done` is the only one that is not a recorded step. */
export const WIZARD_STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'you', label: 'You' },
  { id: 'model', label: 'A model' },
  { id: 'agent', label: 'Your first agent' },
  { id: 'hello', label: 'Say hello' },
  { id: 'extras', label: 'Extras' },
  { id: 'done', label: 'Done' },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

const IDS = WIZARD_STEPS.map((step) => step.id) as readonly WizardStepId[];

export function isWizardStep(value: string | null | undefined): value is WizardStepId {
  return typeof value === 'string' && (IDS as readonly string[]).includes(value);
}

/** Which screen a still-outstanding need belongs to. */
function needOf(view: OnboardingView, step: WizardStepId): boolean {
  if (step === 'you') return view.needs.owner;
  if (step === 'model') return view.needs.model;
  if (step === 'agent') return view.needs.agent;
  return false;
}

/**
 * Where a reload lands.
 *
 * The first screen whose question is still unanswered, because that is the one
 * the owner has to deal with either way; failing that, the screen after the
 * last one they finished. An install that has recorded nothing starts at the
 * beginning, even though it needs everything — the first screen is the one
 * that explains what the rest are for.
 */
export function resumeStep(view: OnboardingView): WizardStepId {
  const done = view.stepsDone.filter(isWizardStep);
  if (done.length === 0) return 'welcome';
  const outstanding = IDS.find((id) => needOf(view, id));
  if (outstanding) return outstanding;
  const last = done.reduce((furthest, id) => (IDS.indexOf(id) > IDS.indexOf(furthest) ? id : furthest), done[0]!);
  return IDS[Math.min(IDS.indexOf(last) + 1, IDS.length - 1)]!;
}

/** `Ada Bright` → `ada-bright`. Editable afterwards; this is only the offer. */
export function suggestHandle(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 20)
    .replace(/-+$/, '');
}

export interface WelcomeProps {
  /** The step named by `#/welcome?step=…`, when the hash names one. */
  step: string | null;
  navigate: (next: string, replace?: boolean) => void;
  timezone: string;
}

export function Welcome({ step, navigate, timezone }: WelcomeProps): JSX.Element {
  const { data: view, error, reload } = useAsync(() => api.onboarding(), [], 4_000);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** A refused Skip or Finish. Shown here; the owner stays where they are. */
  const [problem, setProblem] = useState<string | null>(null);
  const current: WizardStepId | null = isWizardStep(step) ? step : null;

  // No step in the hash: resume where the record says, replacing rather than
  // pushing so Back does not bounce between the two.
  useEffect(() => {
    if (current || !view) return;
    navigate(welcomeRoute(resumeStep(view)), true);
  }, [current, view, navigate]);

  const index = current ? IDS.indexOf(current) : 0;
  const go = (next: WizardStepId): void => {
    if (current && current !== 'done') void api.onboardingStep(current).then(reload).catch(() => {});
    navigate(welcomeRoute(next));
  };
  /*
   * Leaving happens only when the server agrees it happened.
   *
   * Navigating home in a `finally` would send the owner to a dashboard that
   * still thinks first run is pending, and the next reload would drop them back
   * into the wizard with no idea why. A failure stays here and says so.
   */
  const leave = (record: () => Promise<unknown>): void => {
    setLeaving(true);
    setProblem(null);
    record()
      .then(() => navigate(HOME_ROUTE))
      .catch((err: unknown) => setProblem(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLeaving(false));
  };
  const later = (): void => leave(() => api.skipOnboarding());
  const finish = (): void => leave(() => api.completeOnboarding());

  /** Nothing is outstanding, so "done" would be true if the owner said it. */
  const settled = view ? !view.needs.model && !view.needs.agent : false;

  const ready = view
    ? current === 'you'
      ? !view.needs.owner
      : current === 'model'
        ? !view.needs.model
        : current === 'agent'
          ? !view.needs.agent
          : true
    : current === 'welcome';

  return (
    <div className="welcome">
      <div className="welcome-frame" data-wide={current === 'hello' ? 'true' : undefined}>
        <ol className="welcome-progress" aria-label="Setup progress">
          {WIZARD_STEPS.map((s, at) => (
            <li
              key={s.id}
              className="welcome-progress-step"
              data-state={at < index ? 'done' : at === index ? 'here' : 'ahead'}
              aria-current={at === index ? 'step' : undefined}
            >
              <span className="welcome-progress-mark" aria-hidden="true" />
              <span className="welcome-progress-label">{s.label}</span>
            </li>
          ))}
        </ol>

        <ErrorBanner message={error ?? problem} />

        <div className="welcome-body">
          {current === 'welcome' ? <WelcomeStep /> : null}
          {current === 'you' ? <YouStep /> : null}
          {current === 'model' ? <ModelStep /> : null}
          {current === 'agent' ? (
            <AgentStep view={view} created={created} onCreated={(agent) => { setCreated(agent); reload(); }} />
          ) : null}
          {current === 'hello' ? <HelloStep timezone={timezone} created={created} /> : null}
          {current === 'extras' ? <ExtrasStep /> : null}
          {current === 'done' ? <DoneStep view={view} navigate={navigate} /> : null}
        </div>

        <footer className="welcome-foot">
          <div className="welcome-foot-left">
            {index > 0 && current !== null ? (
              <Button variant="ghost" onClick={() => navigate(welcomeRoute(IDS[index - 1]!))}>
                Back
              </Button>
            ) : null}
          </div>
          <div className="welcome-foot-right">
            <button className="welcome-later" type="button" disabled={leaving} onClick={later}>
              Set up later
            </button>
            {current === 'done' ? (
              <Button variant="accent" disabled={leaving || !settled} onClick={finish}>
                Finish
              </Button>
            ) : (
              <Button variant="accent" disabled={!ready} onClick={() => go(IDS[index + 1]!)}>
                {current === 'welcome' ? 'Get started' : 'Next'}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 1. Welcome and security
 * ------------------------------------------------------------------ */

function WelcomeStep(): JSX.Element {
  const [restore, setRestore] = useState(false);
  return (
    <Stack gap="lg">
      <Header
        title="Welcome to buddi"
        lede="Your own agents, running on this machine, against your own data. Six short screens and you will be talking to the first one."
      />
      <Section title="Where everything lives">
        <ul className="welcome-list">
          <li>
            <strong>On this machine only.</strong> The dashboard listens on loopback — nothing on your
            network can reach it, and nothing is sent anywhere except the model provider you choose next.
          </li>
          <li>
            <strong>One data directory</strong> holds the database, the files your agents make, the logs
            and the backups. It is the one thing to copy if you ever move machines.
          </li>
          <li>
            <strong>Keys go in the vault</strong> — your keychain where there is one, an encrypted file
            otherwise. They never touch a terminal, a log or a settings file.
          </li>
        </ul>
      </Section>
      <Section>
        <button className="welcome-quiet" type="button" onClick={() => setRestore(!restore)} aria-expanded={restore}>
          I have a backup from another machine
        </button>
        {restore ? (
          <Notice>
            Restore it from a terminal first, then come back here:
            <Code>buddi backup restore &lt;archive&gt;</Code>
            Restoring from the dashboard is not built yet.
          </Notice>
        ) : null}
      </Section>
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * 2 and 3. The settings pages, embedded
 * ------------------------------------------------------------------ */

function YouStep(): JSX.Element {
  return (
    <Stack gap="lg">
      <Header title="You" lede="How the agents address you, and what they should keep in mind. Save it and the Next button opens." />
      <You embedded />
    </Stack>
  );
}

function ModelStep(): JSX.Element {
  return (
    <Stack gap="lg">
      <Header
        title="A model"
        lede="Add one account with a key or a subscription. The agents run on it; buddi never falls back to another credential on its own."
      />
      <Providers embedded />
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * 4. The first agent
 * ------------------------------------------------------------------ */

const FACES = ['🙂', '📚', '🧭', '🦊', '🛟', '🌿', '🛠️', '🎧'];

function AgentStep({
  view,
  created,
  onCreated,
}: {
  view: OnboardingView | undefined;
  created: CreatedAgent | null;
  onCreated: (agent: CreatedAgent) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [touched, setTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [face, setFace] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const suggested = useMemo(() => suggestHandle(name), [name]);
  const chosen = touched ? handle : suggested;

  if (view && !view.needs.agent) {
    return (
      <Stack gap="lg">
        <Header title="Your first agent" lede="You already have one. Say hello to it on the next screen." />
        <Notice tone="good" role="status">
          {created?.agent
            ? `${created.agent.name} is ready — @${created.agent.handle}.`
            : 'An agent of your own is installed and ready.'}
        </Notice>
        {created && !created.live ? (
          <Notice tone="warning">
            The file is written, but this gateway could not reload it. Run <span className="mono">buddi</span> again and it
            will be there.
          </Notice>
        ) : null}
      </Stack>
    );
  }

  const submit = async (): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      onCreated(await api.createFirstAgent({ name: name.trim(), handle: chosen, description: description.trim(), ...(face ? { avatar: face } : {}) }));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="lg">
      <Header
        title="Your first agent"
        lede="One agent, with your memory tools and nothing else. You can give it more whenever you want."
      />
      <Section title="Who it is">
        <Toolbar valign="end">
          <Field label="Name" grow>
            <input value={name} maxLength={60} placeholder="Ada" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Handle" hint="What you type to address it. Lower-case letters, digits and hyphens.">
            <input
              value={chosen}
              maxLength={20}
              placeholder="ada"
              onChange={(e) => {
                setTouched(true);
                setHandle(e.target.value);
              }}
            />
          </Field>
        </Toolbar>
      </Section>
      <Section title="What it is for">
        <Field label="In a sentence or two" hint="This becomes its persona. Say what you want it to do and how you want to be answered.">
          <textarea
            rows={4}
            maxLength={1000}
            value={description}
            placeholder="Keeps track of what I am reading and reminds me about things I said I would do."
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </Section>
      <Section title="A face" aside={<span className="muted">optional</span>}>
        <div className="welcome-faces" role="group" aria-label="A face">
          {FACES.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="welcome-face"
              data-chosen={face === emoji ? 'true' : undefined}
              aria-pressed={face === emoji}
              onClick={() => setFace(face === emoji ? '' : emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      </Section>
      {problem ? <Notice tone="critical">{problem}</Notice> : null}
      <Toolbar align="end">
        <Button
          variant="accent"
          disabled={saving || name.trim() === '' || chosen.length < 2 || description.trim() === ''}
          onClick={() => void submit()}
        >
          {saving ? 'Creating…' : 'Create the agent'}
        </Button>
      </Toolbar>
    </Stack>
  );
}

/**
 * Nobody is waiting on the owner inside the wizard: there is one agent, one
 * conversation, and no rail to draw a badge on.
 */
const EMPTY_ATTENTION = new Map<string, never>();

/* ------------------------------------------------------------------ *
 * 5. Say hello — the chat itself, inside the frame
 * ------------------------------------------------------------------ */

function HelloStep({ timezone, created }: { timezone: string; created: CreatedAgent | null }): JSX.Element {
  const { data } = useAsync(() => chatApi.agents(), []);
  const list = data?.agents ?? [];
  const agentId = created?.id && list.some((a) => a.id === created.id)
    ? created.id
    : (data?.defaultAgentId ?? list[0]?.id ?? null);
  return (
    <Stack gap="lg">
      <Header title="Say hello" lede="The first answer arriving is the moment the install is real. Ask it anything — or just carry on." />
      <div className="welcome-chat">
        <ChatPage
          timezone={timezone}
          agents={groupAgents(list, data?.defaultAgentId ?? null)}
          agentId={agentId}
          onSelectAgent={() => {}}
          attention={EMPTY_ATTENTION}
          agentsInHeader={false}
          narrow
          canvasOpen={false}
        />
      </div>
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * 6 and 7. Extras, and the end
 * ------------------------------------------------------------------ */

function ExtrasStep(): JSX.Element {
  const [skipped, setSkipped] = useState(false);
  return (
    <Stack gap="lg">
      <Header title="One more thing, if you want it" lede="Everything here is optional and can be done later from Settings." />
      <Card
        title="Telegram"
        meta="Talk to your agents from your phone, in the same conversations."
      >
        {skipped ? (
          <p className="ui-card-meta">Skipped. Settings has it whenever you want it.</p>
        ) : (
          <Stack gap="sm">
            <p className="ui-card-meta">Run this in a terminal and follow what it prints:</p>
            <Code>buddi telegram pair</Code>
            <Toolbar align="end">
              <Button variant="ghost" onClick={() => setSkipped(true)}>
                Skip
              </Button>
            </Toolbar>
          </Stack>
        )}
      </Card>
    </Stack>
  );
}

function DoneStep({
  view,
  navigate,
}: {
  view: OnboardingView | undefined;
  navigate: (next: string, replace?: boolean) => void;
}): JSX.Element {
  const { data } = useAsync(() => api.session(), []);
  const missing: Array<{ step: WizardStepId; what: string }> = [
    ...(view?.needs.model ? [{ step: 'model' as const, what: 'a model account' }] : []),
    ...(view?.needs.agent ? [{ step: 'agent' as const, what: 'an agent of your own' }] : []),
  ];
  return (
    <Stack gap="lg">
      <Header title="That is all of it" lede="Your installation is set up. Here is where things are." />
      {missing.length > 0 ? (
        <Notice tone="warning" role="status">
          Not quite: this installation still needs{' '}
          {missing.map((item, at) => (
            <span key={item.step}>
              {at > 0 ? ' and ' : ''}
              <a
                href={welcomeRoute(item.step)}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(welcomeRoute(item.step));
                }}
              >
                {item.what}
              </a>
            </span>
          ))}
          . Add it and Finish opens — or set up later, which leaves it for another day.
        </Notice>
      ) : null}
      <Section title="Opening buddi again">
        <p className="ui-card-meta">
          The dashboard is bound to{' '}
          <span className="mono">{data ? `${data.host}:${data.port}` : 'this host'}</span> — bookmark this page,
          nothing here expires. From a terminal, this opens it again:
        </p>
        <Code>buddi</Code>
      </Section>
      <Section title="Keeping it current">
        <p className="ui-card-meta">A new version is two commands, and your data is untouched:</p>
        <Code>npm install -g buddi@latest</Code>
        <Code>buddi</Code>
      </Section>
      <Section title="Where the rest lives">
        <ul className="welcome-list">
          <li>
            <strong>Agents</strong> — add one, change what it may reach, give it a model account.
          </li>
          <li>
            <strong>Settings → You</strong> — anything you told us here, changed.
          </li>
          <li>
            <strong>Settings → System</strong> — this host, the queue, and setup again if you want it.
          </li>
        </ul>
      </Section>
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * bits
 * ------------------------------------------------------------------ */

function Header({ title, lede }: { title: string; lede: string }): JSX.Element {
  return (
    <header className="welcome-head">
      <h1 className="welcome-title">{title}</h1>
      <p className="welcome-lede">{lede}</p>
    </header>
  );
}

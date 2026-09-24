/**
 * First run: you meet buddi (docs/onboarding.md).
 *
 * One screen, one thread. buddi asks four things — your name, your clock, a
 * brain for your assistant, and the assistant itself — in message bubbles,
 * scripted, with no model behind them. Each answer is given inline where a
 * reply would go and becomes a bubble on the owner's side with a small
 * "change" link, so the thread reads back as a conversation.
 *
 * Then the speaker changes and the screen does not: the assistant's first
 * message lands in the same thread, under the same composer, and the record is
 * marked done when it arrives. Nothing here is a settings page; the settings
 * pages are unchanged for later.
 *
 * What is answered lives on the server, never in this component: a reload
 * replays the answers from the record, the profile and the accounts, and asks
 * the first question nobody has answered (`meet/machine.ts`).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ApiError,
  api,
  chatApi,
  type BackupJob,
  type OllamaProbe,
  type PairingOffer,
  type ProviderAccountsView,
} from '../api';
import { Composer } from '../chat/Composer';
import { MessageList } from '../chat/MessageList';
import type { ChatAgent, ChatMessage } from '../chat/types';
import { HOME_ROUTE, chatRoute } from '../routes';
import { Button, ButtonLink, Field, Mark } from '../ui';
import {
  FACES,
  OPENING_INSTRUCTION,
  SCRIPT,
  SUGGESTED_NAMES,
} from './meet/script';
import {
  STEP_OF,
  afterRestore,
  answersFrom,
  firstOpen,
  idFor,
  keyKind,
  rememberRestore,
  rememberedRestore,
  reopen,
  suggestedName,
  thread,
  type BrainAnswer,
  type MeetAnswers,
  type QuestionId,
} from './meet/machine';
import { qrSvgDataUrl } from './meet/qr';

/** How long a scripted bubble "types" before it lands. */
const TYPING_MS = 550;

/**
 * How long a silent, *living* run goes before buddi says something about it.
 *
 * A brain on this computer loads for a minute before it says a word, and the
 * first message may take several turns. So this is not a deadline: it is when
 * one more line appears saying what the wait is.
 */
export const PATIENCE_MS = 60_000;

/**
 * The longest first run waits at all.
 *
 * Past this, with nothing said, the thread stops claiming anything is coming —
 * whatever the run says about itself.
 */
export const FIRST_MESSAGE_TIMEOUT_MS = 5 * 60_000;

/** How often the thread asks whether the answer has arrived. */
const POLL_MS = 1_500;

/** How long the finished board waits before leaving for the dashboard itself. */
export const LEAVE_MS = 3_000;

/** The longest the thread watches for a phone before offering a fresh code. */
export const PAIRING_WATCH_MS = 10 * 60_000;

/**
 * A field that opens is a field the owner is being asked to fill in.
 *
 * Every question puts its input in the dock, one at a time, so the thing that
 * just appeared is the only thing to type into — and asking someone to click
 * it first is asking them to do the obvious by hand.
 *
 * Focusing once on mount is not enough, and the reason is not React: measured
 * in Chrome, the field *was* `document.activeElement` while `document.
 * hasFocus()` was false, because the dashboard opens in a tab the owner is
 * not looking at yet. The first thing they do is click the window to bring it
 * forward, and that click lands where they clicked — usually the board — and
 * takes the caret with it. So this asks three times: after the frame is
 * painted, once more on the next turn of the loop if nothing has claimed the
 * focus, and again whenever the window itself comes back, as long as nobody
 * else holds it. It never takes focus away from something the owner chose.
 */
function useOpened<T extends HTMLElement>(): RefObject<T> {
  const field = useRef<T>(null);
  useEffect(() => {
    let frame = 0;
    let later = 0;
    /** Nobody is typing anywhere: the open question may have the caret. */
    const free = (node: T): boolean => {
      const active = node.ownerDocument.activeElement;
      return active === null || active === node.ownerDocument.body || active === node.ownerDocument.documentElement;
    };
    const take = (): void => {
      const node = field.current;
      if (node && free(node)) node.focus();
    };
    // After the paint, not during the commit: a field that is not laid out yet
    // is a field whose focus the browser may have nothing to put a caret in.
    // Somewhere with no frames to wait for, the field is simply focused.
    const painted = (): void => {
      take();
      later = window.setTimeout(take, 0);
    };
    if (typeof window.requestAnimationFrame === 'function') frame = window.requestAnimationFrame(painted);
    else painted();
    window.addEventListener('focus', take);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(later);
      window.removeEventListener('focus', take);
    };
  }, []);
  return field;
}

/** Reduced motion means no theatre: the bubbles are simply there. */
function useStill(): boolean {
  const [still, setStill] = useState(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let list: MediaQueryList;
    try {
      list = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return undefined;
    }
    const onChange = (event: MediaQueryListEvent): void => setStill(event.matches);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, []);
  return still;
}

/**
 * A scripted bubble, after a pause with a typing indicator under buddi's name.
 *
 * The pause is what makes a script read as speech rather than as a page that
 * rendered. It is skipped entirely when the owner has asked for less motion.
 */
function Said({ children, at = 0 }: { children: ReactNode; at?: number }): JSX.Element {
  const still = useStill();
  const [shown, setShown] = useState(still || at === 0);
  useEffect(() => {
    if (still) {
      setShown(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setShown(true), TYPING_MS * at);
    return () => window.clearTimeout(timer);
  }, [still, at]);
  if (!shown) {
    return (
      <div className="wb-msg" data-role="assistant">
        <span className="wb-working" role="status" aria-live="polite">
          <span className="wb-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </span>
      </div>
    );
  }
  return (
    <div className="wb-msg" data-role="assistant">
      <div className="wb-bubble">{children}</div>
    </div>
  );
}

/**
 * buddi's name and face, over a run of its bubbles.
 *
 * The face is the mark from the rail — the same accent tile with the same
 * letter — because this is the same buddi the owner will see in the corner of
 * every page afterwards. Initials would be a stand-in for a face we have.
 */
function Buddi({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="meet-turn">
      <div className="wb-msg-who">
        <Mark size="sm" />
        <span>buddi</span>
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The dock: one place at the bottom of the board
 * ------------------------------------------------------------------ */

/**
 * Where the thing being answered goes.
 *
 * The board is one card with the thread scrolling inside it, so whatever the
 * owner is answering *right now* — a field, a set of cards, the real composer
 * — is pinned at its bottom rather than sitting at the end of a column that
 * grows past the window. Each question still owns its own input; it renders
 * through here, so nothing had to be split in two to be placed in two.
 */
const DockSlot = createContext<HTMLElement | null>(null);

function Dock({ children }: { children: ReactNode }): JSX.Element {
  const slot = useContext(DockSlot);
  return slot ? createPortal(children, slot) : <>{children}</>;
}

/** What the owner said, with the way back to it. */
function Answered({ text, onChange }: { text: string; onChange: () => void }): JSX.Element {
  return (
    <div className="wb-msg" data-role="user">
      <div className="wb-bubble">{text}</div>
      <button type="button" className="meet-change" onClick={onChange}>
        {SCRIPT.change}
      </button>
    </div>
  );
}

/** Where an answer is given: the composer's place, primary action on the right. */
function Ask({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Dock>
      <div className="meet-ask">{children}</div>
    </Dock>
  );
}

/** The assistant on disk: what a change edits rather than replaces. */
export interface ExistingAssistant {
  id: string;
  name: string;
  avatar: string;
  description: string;
}

export interface MeetProps {
  navigate: (next: string, replace?: boolean) => void;
  /** The installation's zone. The clock question offers the browser's own. */
  timezone: string;
}

export function Meet({ navigate, timezone }: MeetProps): JSX.Element {
  const [answers, setAnswers] = useState<MeetAnswers>({});
  const [open, setOpen] = useState<QuestionId | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccountsView | undefined>(undefined);
  const [zones, setZones] = useState<string[]>([]);
  const [assistantAgent, setAssistantAgent] = useState<ChatAgent | null>(null);
  /** Anything that failed, said in the thread rather than in a banner. */
  const [trouble, setTrouble] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** The handover conversation the record already knows about, if any. */
  const [met, setMet] = useState<string | null>(null);
  /**
   * The assistant that already exists, whatever the answers currently say.
   *
   * "Change" empties the answer, and the answer is what the thread draws; this
   * is what the *installation* holds, and it is what decides whether saving
   * the assistant question writes a first agent or changes the one there is.
   */
  const [existing, setExisting] = useState<ExistingAssistant | null>(null);
  /** The dock's element, once it is on the page, for the open question to fill. */
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  /**
   * Where this thread carries on once the assistant has spoken.
   *
   * From that moment first run is over — the record says so — and the quiet
   * link under the dock stops offering to set up later, which is no longer a
   * thing that can happen, and offers the way out instead.
   */
  const [carriesOn, setCarriesOn] = useState<string | null>(null);
  /**
   * The other way this screen can go.
   *
   * `running` is seeded from what this tab remembered, because the restore
   * takes the gateway down with it and a reload in the middle of one must not
   * land back on "what should we call you?".
   */
  const [restore, setRestore] = useState<RestoreState>(() => (rememberedRestore() ? 'running' : 'idle'));

  /** The zone this browser is in, which is what the question offers. */
  const browserZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
    } catch {
      return timezone;
    }
  }, [timezone]);

  /** The caller's navigate, always current, never a reason to reload. */
  const go = useRef(navigate);
  go.current = navigate;

  /* ---- resume: replay what the server already knows ---- */
  /**
   * Read the server and, on the first pass, replay what it already knows.
   *
   * A refresh after a write does not replay: the thread has just decided
   * something, and re-deriving the answers from a read that may not yet show
   * it would overwrite the newer truth with the older one — the account the
   * assistant was moved onto a moment ago being the case that bites.
   */
  const load = useCallback(async (replay = true, restoredNow = false): Promise<void> => {
    const [onboarding, owner, accountView, roster] = await Promise.all([
      api.onboarding().catch(() => undefined),
      api.owner().catch(() => undefined),
      api.providerAccounts().catch(() => undefined),
      chatApi.agents().catch(() => undefined),
    ]);
    setAccounts(accountView);
    setZones(owner?.zones ?? []);
    // The conversation the handover opened, if it already did. Held on the
    // record rather than in this component, because a reload is exactly when
    // it matters: the assistant introduces itself once.
    setMet(onboarding?.details?.conversationId ?? null);
    const own = roster?.agents.find((agent) => agent.id === roster.defaultAgentId) ?? roster?.agents[0];
    if (own) setAssistantAgent(own);
    setExisting(
      onboarding && !onboarding.needs.agent && own
        ? { id: own.id, name: own.name, avatar: own.avatar?.kind === 'emoji' ? own.avatar.value : '', description: own.description }
        : null,
    );
    const facts = {
      onboarding,
      owner,
      accounts: accountView,
      ...(own ? { assistant: { id: own.id, name: own.name, avatar: own.avatar?.kind === 'emoji' ? own.avatar.value : '' } } : {}),
    };
    const replayed = answersFrom(facts);
    /*
     * A restore that just landed brings a finished record with it, which is
     * the one case where "done" does not mean the owner should be sent away:
     * the keys did not come back, so there is a question left to ask.
     */
    if (restoredNow) {
      const resume = afterRestore(facts);
      setAnswers(resume.answers);
      setOpen(resume.open);
      if (!resume.stay) {
        const carry = onboarding?.details?.conversationId;
        go.current(carry && own ? chatRoute(own.id, carry) : HOME_ROUTE, true);
      }
      return;
    }
    /*
     * A finished first run has no thread to show.
     *
     * The record is done, so this route is a page the owner has already left;
     * a reload lands where the conversation is — the same one they met their
     * assistant in, with the rail around it — or Home when the record does not
     * name one. Replaced rather than pushed, so Back does not return here.
     */
    if (replay && onboarding?.state === 'done') {
      const carry = onboarding.details?.conversationId;
      go.current(carry && own ? chatRoute(own.id, carry) : HOME_ROUTE, true);
      return;
    }
    if (!replay) return;
    setAnswers(replayed);
    setOpen((current) => current ?? firstOpen(replayed));
    // Deliberately no dependencies: this reads the server once on mount and
    // again only when something asks it to. `navigate` is held in a ref rather
    // than depended on, because a caller that passes a fresh function every
    // render would otherwise make "read the server" mean "read it for ever".
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const record = (id: QuestionId, learned: { conversationId?: string; accountId?: string } = {}): void => {
    void api.onboardingStep(STEP_OF[id], learned).catch(() => {});
  };

  /** One answer saved: keep it, record the step, move on. */
  const settle = (id: QuestionId, next: MeetAnswers): void => {
    setTrouble(null);
    setAnswers(next);
    // The account chosen here is recorded with the step, so a reload knows
    // which of several accounts is this assistant's brain.
    record(id, id === 'brain' && next.brain ? { accountId: next.brain.accountId } : {});
    setOpen(firstOpen(next));
  };

  const change = (id: QuestionId): void => {
    setTrouble(null);
    setAnswers((current) => reopen(current, id));
    setOpen(id);
  };

  /*
   * Leaving happens only when the server agrees it happened: a dashboard that
   * still thinks first run is pending would drop the owner back here on the
   * next reload with no idea why.
   */
  const later = (): void => {
    setLeaving(true);
    api
      .skipOnboarding()
      .then(() => navigate(HOME_ROUTE))
      .catch((err: unknown) => setTrouble(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLeaving(false));
  };

  // While a restore is being asked for or run, it is the only thing on the
  // screen: there is nothing to answer that it would not overwrite.
  const shown = restore === 'form' || restore === 'running' ? [] : open ? thread(answers, open) : [];

  /*
   * The newest line is the one at the bottom, and it is where the owner is
   * looking. Anything that lengthens the thread scrolls it down; `auto` is
   * deliberate, because a jump is what a chat does and reduced motion is
   * honoured by the browser rather than by us.
   */
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return undefined;
    const pin = (): void => {
      node.scrollTop = node.scrollHeight;
    };
    pin();
    // Everything that lengthens the thread is watched, not just the things
    // this component happens to re-render for: a scripted bubble landing after
    // its pause, and the assistant's answer arriving inside the handover, are
    // both simply the content getting taller.
    let observer: ResizeObserver | undefined;
    try {
      observer = new ResizeObserver(pin);
      if (node.firstElementChild) observer.observe(node.firstElementChild);
    } catch {
      /* No ResizeObserver: the effect above still pins on every render. */
    }
    return () => observer?.disconnect();
  }, [shown.length, open, answers, trouble]);

  return (
    <DockSlot.Provider value={slot}>
    <div className="meet">
      <div className="meet-stack">
      {/*
        One board, centred, never taller than the window: the thread scrolls
        inside it with the newest line at the bottom, and what is being
        answered is docked under a single hairline. A short thread is a short
        card, and the page itself never scrolls.
      */}
        <header className="meet-head">
          <Mark size="lg" />
          <span className="meet-head-who">
            <span className="meet-head-name">buddi</span>
            <span className="meet-head-line">{SCRIPT.tagline}</span>
          </span>
        </header>

        <div className="meet-board">
        <div className="meet-scroll" ref={scroller}>
          <div className="meet-thread" data-testid="meet-thread">
              <Buddi>
                {SCRIPT.opening.map((line, at) => (
                  <Said key={line} at={at}>
                    {line}
                  </Said>
                ))}
              </Buddi>

              <FromABackup
                state={restore}
                offered={open === 'name' && answers.name === undefined}
                name={answers.name}
                onState={setRestore}
                onDone={() => {
                  setRestore('idle');
                  void load(true, true);
                }}
                onTrouble={setTrouble}
              />

              {shown.map((id) => (
                <Question
                  key={id}
                  id={id}
                  openNow={open === id}
                  answers={answers}
                  accounts={accounts}
                  zones={zones}
                  browserZone={browserZone}
                  assistantAgent={assistantAgent}
                  met={met}
                  onMet={setMet}
                  existing={existing}
                  navigate={navigate}
                  onCarriesOn={setCarriesOn}
                  onSettled={(next) => settle(id, next)}
                  onChange={() => change(id)}
                  onTrouble={setTrouble}
                  onReload={() => void load(false)}
                  onPickAnotherBrain={() => change('brain')}
                />
              ))}

            {trouble ? (
              <Buddi>
                <Said>{trouble}</Said>
              </Buddi>
            ) : null}
          </div>
        </div>

        <footer className="meet-dock">
          <div className="meet-dock-ask" ref={setSlot} />
          {carriesOn ? (
            <a
              className="meet-later"
              href={carriesOn}
              onClick={(event) => {
                event.preventDefault();
                navigate(carriesOn, true);
              }}
            >
              {SCRIPT.done.open}
            </a>
          ) : (
            <button className="meet-later" type="button" disabled={leaving} onClick={later}>
              {SCRIPT.later}
            </button>
          )}
        </footer>
        </div>
      </div>
    </div>
    </DockSlot.Provider>
  );
}

/* ------------------------------------------------------------------ *
 * 0. There is already a buddi, and this one is meant to become it
 * ------------------------------------------------------------------ */

/** Idle, being asked for, or under way. */
export type RestoreState = 'idle' | 'form' | 'running';

/**
 * Restoring, offered before the first question and never after it.
 *
 * It is a quiet link under the opening bubbles because almost nobody has a
 * backup on the day they install this, and the one person who does is looking
 * for exactly those words. What follows is the job's own phases, said in
 * buddi's voice, and then the thread picks up at the brain — the one answer a
 * backup can never bring back, because it never carries a key.
 */
function FromABackup({
  state,
  offered,
  name,
  onState,
  onDone,
  onTrouble,
}: {
  state: RestoreState;
  /** Nothing has been answered yet, so there is nothing a restore would undo. */
  offered: boolean;
  name: string | undefined;
  onState: (next: RestoreState) => void;
  onDone: () => void;
  onTrouble: (message: string | null) => void;
}): JSX.Element | null {
  const [jobId, setJobId] = useState<string | null>(() => rememberedRestore());
  const [phases, setPhases] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [sending, setSending] = useState(false);

  /*
   * The job outlives this page: halfway through, the gateway is stopped and
   * every request fails. A failed poll is therefore not news — only an answer
   * is — and the id that makes the answer findable is what the tab remembers.
   */
  useEffect(() => {
    if (!jobId) return undefined;
    let stopped = false;
    const ask = (): void => {
      api
        .backupJob(jobId)
        .then((job: BackupJob) => {
          if (stopped) return;
          setPhases((seen) => (seen.includes(job.phase) ? seen : [...seen, job.phase]));
          if (job.phase === 'done') {
            stopped = true;
            rememberRestore(null);
            setDone(true);
            onDone();
          } else if (job.phase === 'rolled-back' || job.phase === 'failed') {
            // Both are the end of this job. They differ in what is on disk
            // now, which is what the job's own error says, so it is preferred
            // over either standing sentence.
            stopped = true;
            rememberRestore(null);
            setJobId(null);
            onTrouble(job.error ?? SCRIPT.restore.phases[job.phase]);
            onState('idle');
          }
        })
        .catch(() => {
          /* Restarting, or not answering yet. Ask again in a moment. */
        });
    };
    ask();
    const timer = window.setInterval(ask, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const send = (): void => {
    if (!file || sending) return;
    setSending(true);
    onTrouble(null);
    api
      .firstRunRestore(file, passphrase.trim())
      .then((answer) => {
        rememberRestore(answer.job.id);
        setJobId(answer.job.id);
        onState('running');
      })
      .catch((error: unknown) => onTrouble(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setSending(false));
  };

  const said = phases.filter((phase): phase is keyof typeof SCRIPT.restore.phases => phase in SCRIPT.restore.phases);

  return (
    <>
      {offered && state === 'idle' && !done ? (
        <button type="button" className="meet-later" onClick={() => onState('form')}>
          {SCRIPT.restore.offer}
        </button>
      ) : null}

      {state === 'form' ? (
        <Ask>
          <button type="button" className="meet-quiet" onClick={() => onState('idle')}>
            {SCRIPT.restore.cancel}
          </button>
          <Field label={SCRIPT.restore.file} grow>
            <input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </Field>
          <Field label={SCRIPT.restore.passphrase} hint={SCRIPT.restore.passphraseHint}>
            <input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          </Field>
          <Button variant="accent" disabled={sending || !file} onClick={send}>
            {SCRIPT.restore.submit}
          </Button>
        </Ask>
      ) : null}

      {state === 'running' || done ? (
        <Buddi>
          <Said>{SCRIPT.restore.started}</Said>
          {said.map((phase) => (
            <Said key={phase}>{SCRIPT.restore.phases[phase]}</Said>
          ))}
        </Buddi>
      ) : null}

      {done ? (
        <Buddi>
          {/* The name comes back with the backup; a backup that carried none
              simply gets the sentence that matters instead. */}
          {name ? <Said>{SCRIPT.restore.welcome(name)}</Said> : null}
          <Said>{SCRIPT.restore.keys}</Said>
        </Buddi>
      ) : null}
    </>
  );
}

interface QuestionProps {
  id: QuestionId;
  openNow: boolean;
  answers: MeetAnswers;
  accounts: ProviderAccountsView | undefined;
  zones: string[];
  browserZone: string;
  assistantAgent: ChatAgent | null;
  /** The handover conversation the record already holds, if any. */
  met: string | null;
  onMet: (conversationId: string) => void;
  /** The assistant this installation already has, if it has one. */
  existing: ExistingAssistant | null;
  /** The thread is over: where it carries on, as a route. */
  onCarriesOn: (route: string) => void;
  navigate: (next: string, replace?: boolean) => void;
  onSettled: (next: MeetAnswers) => void;
  onChange: () => void;
  onTrouble: (message: string | null) => void;
  onReload: () => void;
  onPickAnotherBrain: () => void;
}

function Question(props: QuestionProps): JSX.Element | null {
  const { id, openNow, answers, onChange } = props;
  if (id === 'name') {
    return (
      <>
        <Buddi>
          <Said at={1}>{SCRIPT.name.ask}</Said>
        </Buddi>
        {openNow ? <NameAsk {...props} /> : <Answered text={answers.name ?? ''} onChange={onChange} />}
      </>
    );
  }
  if (id === 'clock') {
    return (
      <>
        <Buddi>
          <Said at={1}>{SCRIPT.clock.ask(answers.name ?? '', answers.clock ?? props.browserZone)}</Said>
        </Buddi>
        {openNow ? <ClockAsk {...props} /> : <Answered text={SCRIPT.clock.answer(answers.clock ?? '')} onChange={onChange} />}
      </>
    );
  }
  if (id === 'brain') {
    return (
      <>
        <Buddi>
          <Said at={1}>{SCRIPT.brain.ask}</Said>
        </Buddi>
        {openNow ? (
          <BrainAsk {...props} />
        ) : (
          <>
            <Answered text={SCRIPT.brain.answer(answers.brain?.label ?? '')} onChange={onChange} />
            <Buddi>
              <Said>{SCRIPT.brain.works(answers.brain?.model ?? '')}</Said>
            </Buddi>
          </>
        )}
      </>
    );
  }
  if (id === 'assistant') {
    return (
      <>
        <Buddi>
          <Said at={1}>{SCRIPT.assistant.ask}</Said>
        </Buddi>
        {openNow ? (
          <AssistantAsk {...props} />
        ) : (
          <Answered text={`${answers.assistant?.avatar ?? ''} ${answers.assistant?.name ?? ''}`.trim()} onChange={onChange} />
        )}
      </>
    );
  }
  return <Handover {...props} />;
}

/* ------------------------------------------------------------------ *
 * 1. Your name
 * ------------------------------------------------------------------ */

function NameAsk({ answers, onSettled, onTrouble }: QuestionProps): JSX.Element {
  const field = useOpened<HTMLInputElement>();
  const [value, setValue] = useState(answers.name ?? '');
  const [saving, setSaving] = useState(false);
  const submit = (): void => {
    const name = value.trim();
    if (name === '' || saving) return;
    setSaving(true);
    api
      .setOwner({ preferredName: name })
      .then(() => onSettled({ ...answers, name }))
      .catch((err: unknown) => onTrouble(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setSaving(false));
  };
  return (
    <Ask>
      <input
        ref={field}
        className="meet-input"
        aria-label={SCRIPT.name.placeholder}
        placeholder={SCRIPT.name.placeholder}
        maxLength={80}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
      />
      <Button variant="accent" disabled={saving || value.trim() === ''} onClick={submit}>
        {SCRIPT.name.submit}
      </Button>
    </Ask>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Your clock
 * ------------------------------------------------------------------ */

function ClockAsk({ answers, zones, browserZone, onSettled, onTrouble }: QuestionProps): JSX.Element {
  const [picking, setPicking] = useState(false);
  const [zone, setZone] = useState(browserZone);
  const [saving, setSaving] = useState(false);
  const save = (chosen: string): void => {
    setSaving(true);
    api
      .setOwner({ timezone: chosen })
      .then(() => onSettled({ ...answers, clock: chosen }))
      .catch((err: unknown) => onTrouble(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setSaving(false));
  };
  if (!picking) {
    return (
      <Ask>
        <button type="button" className="meet-quiet" onClick={() => setPicking(true)}>
          {SCRIPT.clock.another}
        </button>
        <Button variant="accent" disabled={saving} onClick={() => save(browserZone)}>
          {SCRIPT.clock.yes}
        </Button>
      </Ask>
    );
  }
  return (
    <Ask>
      <select className="meet-input" aria-label={SCRIPT.clock.label} value={zone} onChange={(event) => setZone(event.target.value)}>
        {(zones.includes(zone) ? zones : [zone, ...zones]).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <Button variant="accent" disabled={saving} onClick={() => save(zone)}>
        {SCRIPT.clock.yes}
      </Button>
    </Ask>
  );
}

/* ------------------------------------------------------------------ *
 * 3. The brain
 * ------------------------------------------------------------------ */

type Card = 'claude' | 'key' | 'ollama' | 'service';

function BrainAsk(props: QuestionProps): JSX.Element {
  const { accounts, answers, onSettled, onReload } = props;
  const [card, setCard] = useState<Card | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ollama, setOllama] = useState<OllamaProbe | null>(null);
  /** The models the owner is choosing between, and what to do with the answer. */
  const [choice, setChoice] = useState<{
    models: string[];
    make: (model: string) => Parameters<typeof api.saveProviderAccount>[0];
    label: string;
  } | null>(null);
  const claudeOffered = accounts?.anthropicOAuthEnabled === true;

  // The Ollama card has to know before it is opened whether Ollama is there:
  // that is the difference between "Found it" and "Install it". The gateway
  // asks the machine; this only reads the answer, and keeps asking while the
  // card is open and the answer is no.
  useEffect(() => {
    let cancelled = false;
    const ask = (): void => {
      api
        .ollama()
        .then((probe) => {
          if (!cancelled) setOllama(probe);
        })
        .catch(() => {});
    };
    ask();
    const timer = window.setInterval(ask, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * Save the account, test it, bind it, and let buddi name the model the
   * assistant will think with.
   *
   * The binding is the part that is easy to forget: changing the brain after
   * the assistant exists has to move *that agent* onto the new account, or the
   * thread would confirm one thing and the assistant would keep answering on
   * another. A new assistant is bound at creation instead, with this account's
   * id, so nothing is assigned twice.
   */
  const bind = async (brain: BrainAnswer): Promise<string | null> => {
    const assistant = answers.assistant;
    if (assistant) {
      try {
        // One call: the assistant moves, and so does anything shipped that
        // was following its choice of AI.
        await api.bindBrain({ accountId: brain.accountId, model: brain.model });
      } catch (err) {
        return err instanceof ApiError ? err.message : String(err);
      }
    }
    onReload();
    onSettled({ ...answers, brain });
    return null;
  };

  const adopt = async (
    body: Parameters<typeof api.saveProviderAccount>[0],
    label: string,
  ): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const saved = await api.saveProviderAccount(body);
      const verdict = await api.testProviderAccount(saved.id);
      if (verdict.state !== 'connected') {
        setProblem(verdict.message);
        return;
      }
      const refused = await bind({ accountId: saved.id, label, model: body.defaultModel });
      if (refused) setProblem(refused);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /*
   * One more question, and only when it is a real one.
   *
   * A service with thirty models has no "the" model, and picking `models[0]`
   * for the owner meant buddi confidently naming something arbitrary. So when
   * there are several and none of them is the service's own default, the
   * thread asks — once, with the list — and the answer becomes the account's
   * default and the model the confirmation names. One model, or a flagged
   * default, is not a question and is not asked.
   */
  const offer = (models: string[], make: (model: string) => Parameters<typeof api.saveProviderAccount>[0], label: string): void => {
    if (models.length <= 1) {
      void adopt(make(models[0] ?? ''), label);
      return;
    }
    setChoice({ models, make, label });
  };

  if (choice) {
    return (
      <>
        <Buddi>
          <Said>{SCRIPT.brain.model.ask}</Said>
        </Buddi>
        <ModelChoice
          busy={busy}
          models={choice.models}
          onUse={(model) => void adopt(choice.make(model), choice.label)}
        />
      </>
    );
  }

  if (card === 'key') return <KeyCard busy={busy} problem={problem} onBack={() => setCard(null)} onUse={adopt} />;
  if (card === 'service') {
    return (
      <ServiceCard
        busy={busy}
        problem={problem}
        address={ollama?.cloudBaseUrl ?? ''}
        onBack={() => setCard(null)}
        onOffer={offer}
      />
    );
  }
  if (card === 'ollama') {
    return <OllamaCard busy={busy} problem={problem} probe={ollama} onBack={() => setCard(null)} onOffer={offer} />;
  }
  if (card === 'claude') {
    return <ClaudeCard busy={busy} problem={problem} onBack={() => setCard(null)} onConnected={bind} {...props} />;
  }

  return (
    <Dock>
    <div className="meet-cards" role="group" aria-label={SCRIPT.brain.ask}>
      {claudeOffered ? <BrainCard mark={<ClaudeMark />} card={SCRIPT.brain.cards.claude} onPick={() => setCard('claude')} /> : null}
      <BrainCard mark={<KeyMark />} card={SCRIPT.brain.cards.key} onPick={() => setCard('key')} />
      <BrainCard
        mark={<OllamaMark />}
        card={SCRIPT.brain.cards.ollama}
        note={ollama === null ? SCRIPT.brain.ollama.looking : ollama.running ? SCRIPT.brain.ollama.found : SCRIPT.brain.ollama.missing}
        onPick={() => setCard('ollama')}
      />
      <BrainCard mark={<CloudMark />} card={SCRIPT.brain.cards.service} onPick={() => setCard('service')} />
    </div>
    </Dock>
  );
}

function BrainCard({
  mark,
  card,
  note,
  onPick,
}: {
  mark: ReactNode;
  card: { title: string; line: string };
  note?: string;
  onPick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="meet-card" onClick={onPick}>
      <span className="meet-card-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="meet-card-words">
        <span className="meet-card-title">{card.title}</span>
        <span className="meet-card-line">{note ?? card.line}</span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * The marks on the cards
 *
 * Drawn here, in one colour, from paths — never fetched, never an image file.
 * Each is the shape that AI is known by, at the weight of the page's own
 * icons, so the owner recognises what they already pay for rather than reading
 * four lines of text to find it.
 * ------------------------------------------------------------------ */

/** Claude: the burst. */
function ClaudeMark(): JSX.Element {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      {rays.map((angle) => (
        <rect
          key={angle}
          x="11.1"
          y="2.6"
          width="1.8"
          height="8.6"
          rx="0.9"
          fill="currentColor"
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </svg>
  );
}

/** A key: what a key from Anthropic or OpenAI is, in the hand. */
function KeyMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="3.6" />
      <path d="M10.6 10.6 19.4 19.4" />
      <path d="M13.8 13.8 11.9 15.7" />
      <path d="M16.6 16.6 14.7 18.5" />
    </svg>
  );
}

/**
 * Ollama: this computer.
 *
 * Two attempts at the llama were made and both were illegible at the size a
 * card mark is drawn — a 22px squiggle nobody reads as an animal is worse than
 * no mark at all. So the card carries what it actually means, and what its own
 * line says: the AI on this machine. If a proper Ollama mark is ever shipped
 * as an asset, this is the one place to change.
 */
function OllamaMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.2" y="4.6" width="17.6" height="11.2" rx="2" />
      <path d="M9.4 19.4h5.2" />
      <path d="M12 15.8v3.6" />
    </svg>
  );
}

/** Anything else that answers over the wire: a cloud. */
function CloudMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.2 18.3h9.6a3.8 3.8 0 0 0 .5-7.6 5.4 5.4 0 0 0-10.3-1.2 3.9 3.9 0 0 0 .2 8.8Z" />
    </svg>
  );
}

type Adopt = (body: Parameters<typeof api.saveProviderAccount>[0], label: string) => Promise<void>;

/** Hand the models over, with what to do once one of them is chosen. */
type Offer = (
  models: string[],
  make: (model: string) => Parameters<typeof api.saveProviderAccount>[0],
  label: string,
) => void;

/** The one question a service with many models is worth: which of them. */
function ModelChoice({
  busy,
  models,
  onUse,
}: {
  busy: boolean;
  models: string[];
  onUse: (model: string) => void;
}): JSX.Element {
  const [chosen, setChosen] = useState(models[0] ?? '');
  return (
    <Ask>
      <Field label={SCRIPT.brain.model.label} grow>
        <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Field>
      <Button variant="accent" disabled={busy || chosen === ''} onClick={() => onUse(chosen)}>
        {SCRIPT.brain.model.submit}
      </Button>
    </Ask>
  );
}

/** A pasted key, and which AI it belongs to. */
function KeyCard({
  busy,
  problem,
  onBack,
  onUse,
}: {
  busy: boolean;
  problem: string | null;
  onBack: () => void;
  onUse: Adopt;
}): JSX.Element {
  const field = useOpened<HTMLInputElement>();
  const [secret, setSecret] = useState('');
  const [override, setOverride] = useState<'anthropic' | 'openai' | null>(null);
  const kind = override ?? keyKind(secret);
  const submit = (): void => {
    const value = secret.trim();
    if (value === '' || busy) return;
    void (async () => {
      // The model list first, so the default buddi names is one this key can
      // actually reach rather than one this page believes in.
      let defaultModel = kind === 'anthropic' ? 'claude-sonnet-5' : 'gpt-5';
      try {
        const probed = await api.probeModels({ kind, auth: 'api-key', secret: value });
        // Only a model the provider itself flags as the default displaces the
        // sensible one. The first of a long list is not an answer, and these
        // two providers have a well-known model worth starting on.
        defaultModel = probed.models.find((model) => model.isDefault)?.id ?? defaultModel;
      } catch {
        // A key that cannot list models may still answer; the test below is
        // the verdict that counts.
      }
      await onUse(
        { label: kind === 'anthropic' ? SCRIPT.brain.key.anthropic : SCRIPT.brain.key.openai, kind, auth: 'api-key', baseUrl: '', defaultModel, enabled: true, secret: value },
        kind === 'anthropic' ? SCRIPT.brain.key.anthropic : SCRIPT.brain.key.openai,
      );
    })();
  };
  return (
    <>
      {problem ? (
        <Buddi>
          <Said>{SCRIPT.brain.key.refused}</Said>
        </Buddi>
      ) : null}
      <Ask>
        <Field label={SCRIPT.brain.key.field} grow>
          <input
            ref={field}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={SCRIPT.brain.key.placeholder}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </Field>
        <button
          type="button"
          className="meet-quiet"
          onClick={() => setOverride(kind === 'anthropic' ? 'openai' : 'anthropic')}
        >
          {kind === 'anthropic' ? SCRIPT.brain.key.anthropic : SCRIPT.brain.key.openai} · {SCRIPT.brain.key.which}
        </button>
        <button type="button" className="meet-quiet" onClick={onBack}>
          ←
        </button>
        <Button variant="accent" disabled={busy || secret.trim() === ''} onClick={submit}>
          {SCRIPT.brain.key.submit}
        </Button>
      </Ask>
    </>
  );
}

/** Ollama, on this computer. */
function OllamaCard({
  busy,
  problem,
  probe,
  onBack,
  onOffer,
}: {
  busy: boolean;
  problem: string | null;
  probe: OllamaProbe | null;
  onBack: () => void;
  onOffer: Offer;
}): JSX.Element {
  const models = probe?.models ?? [];
  const use = (): void => {
    if (!probe) return;
    // Several models pulled and no "the" one: the owner is asked which. One,
    // and there is nothing worth asking.
    onOffer(
      models,
      (model) => ({
        label: SCRIPT.brain.cards.ollama.title,
        kind: 'openai-compatible',
        auth: 'none',
        // The address comes from the probe, not from here: this page names no
        // host, and the machine Ollama answers on is the gateway's.
        baseUrl: probe.baseUrl,
        defaultModel: model,
        enabled: true,
      }),
      SCRIPT.brain.cards.ollama.title,
    );
  };
  return (
    <>
      {problem ? (
        <Buddi>
          <Said>{problem}</Said>
        </Buddi>
      ) : null}
      <Ask>
        <span className="meet-line">
          {probe === null
            ? SCRIPT.brain.ollama.looking
            : probe.running
              ? SCRIPT.brain.ollama.found
              : SCRIPT.brain.ollama.missing}
        </span>
        <button type="button" className="meet-quiet" onClick={onBack}>
          ←
        </button>
        {probe?.running ? (
          <Button variant="accent" disabled={busy || models.length === 0} onClick={use}>
            {SCRIPT.brain.ollama.connect}
          </Button>
        ) : probe ? (
          <a className="ui-btn" href={probe.downloadUrl} target="_blank" rel="noreferrer">
            {SCRIPT.brain.ollama.download}
          </a>
        ) : null}
      </Ask>
    </>
  );
}

/** Ollama Cloud, or anything else that speaks the same way. */
function ServiceCard({
  busy,
  problem,
  address: offered,
  onBack,
  onOffer,
}: {
  busy: boolean;
  problem: string | null;
  /**
   * The address to start from, from the server — Ollama's own hosted service,
   * which is what most owners opening this card mean. Editable, because the
   * same field takes any service that answers the same way, and empty when the
   * server offered none, where the placeholder speaks instead.
   */
  address: string;
  onBack: () => void;
  onOffer: Offer;
}): JSX.Element {
  const field = useOpened<HTMLInputElement>();
  const [address, setAddress] = useState(offered);
  const [secret, setSecret] = useState('');
  const submit = (): void => {
    if (address.trim() === '' || busy) return;
    void (async () => {
      const auth = secret.trim() ? ('api-key' as const) : ('none' as const);
      const make = (defaultModel: string): Parameters<typeof api.saveProviderAccount>[0] => ({
        label: SCRIPT.brain.cards.service.title,
        kind: 'openai-compatible',
        auth,
        baseUrl: address.trim(),
        defaultModel,
        enabled: true,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      });
      let models: string[] = [];
      let flagged: string | undefined;
      try {
        const probed = await api.probeModels({
          kind: 'openai-compatible',
          auth,
          baseUrl: address.trim(),
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        });
        models = probed.models.map((model) => model.id);
        flagged = probed.models.find((model) => model.isDefault)?.id;
      } catch {
        /* Said below by the save or the test, in its own words. */
      }
      // A service that names its own default has answered the question; one
      // that offers thirty has not, and buddi asks rather than guessing.
      onOffer(flagged ? [flagged] : models, make, SCRIPT.brain.cards.service.title);
    })();
  };
  return (
    <>
      {problem ? (
        <Buddi>
          <Said>{problem}</Said>
        </Buddi>
      ) : null}
      <Ask>
        <Field label={SCRIPT.brain.service.address} grow>
          <input
            ref={field}
            value={address}
            placeholder={SCRIPT.brain.service.addressPlaceholder}
            onChange={(event) => setAddress(event.target.value)}
          />
        </Field>
        <Field label={SCRIPT.brain.service.key}>
          <input type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(event) => setSecret(event.target.value)} />
        </Field>
        <button type="button" className="meet-quiet" onClick={onBack}>
          ←
        </button>
        <Button variant="accent" disabled={busy || address.trim() === ''} onClick={submit}>
          {SCRIPT.brain.service.submit}
        </Button>
      </Ask>
    </>
  );
}

/**
 * Claude, through the sign-in this installation already has.
 *
 * The account is written first — signing in is something that happens *to* an
 * account — and then the existing browser consent flow runs, with the code
 * pasted back here.
 */
function ClaudeCard({
  busy,
  problem,
  onBack,
  onConnected,
  accounts,
}: {
  busy: boolean;
  problem: string | null;
  onBack: () => void;
  /** Saves the answer and moves the assistant onto it. Returns what refused it. */
  onConnected: (brain: BrainAnswer) => Promise<string | null>;
} & QuestionProps): JSX.Element {
  const [working, setWorking] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ id: string; revision: number; url: string; attemptId: string } | null>(null);
  const [code, setCode] = useState('');
  const model = 'claude-sonnet-5';

  const start = (): void => {
    setWorking(true);
    setTrouble(null);
    void (async () => {
      try {
        const existing = (accounts?.accounts ?? []).find((account) => account.auth === 'anthropic-oauth');
        const saved = existing
          ? { id: existing.id }
          : await api.saveProviderAccount({
              label: SCRIPT.brain.cards.claude.title,
              kind: 'anthropic',
              auth: 'anthropic-oauth',
              baseUrl: '',
              defaultModel: model,
              enabled: true,
            });
        const view = await api.providerAccounts();
        const row = view.accounts.find((account) => account.id === saved.id)!;
        const login = (await api.anthropicAccountAction(row.id, 'login', row.revision)) as {
          verificationUrl?: string;
          attemptId?: string;
        };
        setAttempt({
          id: row.id,
          revision: row.revision + 1,
          url: login.verificationUrl ?? '',
          attemptId: login.attemptId ?? '',
        });
      } catch (err) {
        setTrouble(err instanceof ApiError ? err.message : String(err));
      } finally {
        setWorking(false);
      }
    })();
  };

  const finish = (): void => {
    if (!attempt || code.trim() === '') return;
    setWorking(true);
    void (async () => {
      try {
        await api.anthropicAccountAction(attempt.id, 'complete-login', attempt.revision, {
          attemptId: attempt.attemptId,
          code: code.trim(),
        });
        const verdict = await api.testProviderAccount(attempt.id);
        if (verdict.state !== 'connected') {
          setTrouble(verdict.message);
          return;
        }
        setTrouble(await onConnected({ accountId: attempt.id, label: SCRIPT.brain.cards.claude.title, model }));
      } catch (err) {
        setTrouble(err instanceof ApiError ? err.message : String(err));
      } finally {
        setWorking(false);
      }
    })();
  };

  return (
    <>
      {problem ?? trouble ? (
        <Buddi>
          <Said>{problem ?? trouble}</Said>
        </Buddi>
      ) : null}
      {attempt ? (
        <>
          <Buddi>
            <Said>{SCRIPT.brain.claude.waiting}</Said>
          </Buddi>
          <Ask>
            <a className="ui-btn" href={attempt.url} target="_blank" rel="noreferrer">
              {SCRIPT.brain.claude.open}
            </a>
            <Field label={SCRIPT.brain.claude.paste} grow>
              <ClaudeCode value={code} onChange={setCode} />
            </Field>
            <Button variant="accent" disabled={working || code.trim() === ''} onClick={finish}>
              {SCRIPT.brain.claude.finish}
            </Button>
          </Ask>
        </>
      ) : (
        <Ask>
          <button type="button" className="meet-quiet" onClick={onBack}>
            ←
          </button>
          <Button variant="accent" disabled={busy || working} onClick={start}>
            {SCRIPT.brain.claude.start}
          </Button>
        </Ask>
      )}
    </>
  );
}

/** The code from the consent page. Its own component so it takes focus when
    the step that asks for it appears, rather than when the card does. */
function ClaudeCode({ value, onChange }: { value: string; onChange: (next: string) => void }): JSX.Element {
  const field = useOpened<HTMLInputElement>();
  return (
    <input
      ref={field}
      type="password"
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/* ------------------------------------------------------------------ *
 * 4. The assistant
 * ------------------------------------------------------------------ */

function AssistantAsk({ answers, existing, onSettled, onTrouble, onReload }: QuestionProps): JSX.Element {
  const [at] = useState(() => Math.floor(Math.random() * SUGGESTED_NAMES.length));
  const [name, setName] = useState(() => existing?.name ?? suggestedName(SUGGESTED_NAMES, at));
  const [face, setFace] = useState<string>(existing?.avatar || FACES[0]);
  const [purpose, setPurpose] = useState<string>(existing?.description || SCRIPT.assistant.purposeValue);
  const [saving, setSaving] = useState(false);

  /*
   * Two ways to save one answer.
   *
   * The first time there is no agent and this writes one, bound to the account
   * the thread just tested. Afterwards — the owner took up "change either" —
   * writing a *first* agent is refused, and rightly: there is one, and the
   * change belongs in its file. Same name, same face, same purpose, one
   * assistant either way.
   */
  const submit = (): void => {
    if (name.trim() === '' || saving) return;
    setSaving(true);
    const written = existing
      ? api.updateFirstAgent({ name: name.trim(), description: purpose.trim(), avatar: face })
      : api.createFirstAgent({
          name: name.trim(),
          handle: idFor(name),
          description: purpose.trim(),
          avatar: face,
          ...(answers.brain ? { accountId: answers.brain.accountId } : {}),
        });
    written
      .then((saved) => {
        onReload();
        onSettled({ ...answers, assistant: { id: saved.id, name: name.trim(), avatar: face } });
      })
      .catch((err: unknown) => onTrouble(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <Ask>
      {/* The face is the assistant, so it is shown at the size of a face and
          not at the size of a control: big, beside its name, changing as the
          owner picks. */}
      <span className="meet-chosen-face" aria-hidden="true">
        {face}
      </span>
      <Field label={SCRIPT.assistant.name}>
        <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
      </Field>
      <div className="meet-faces" role="group" aria-label={SCRIPT.assistant.face}>
        {FACES.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="meet-face"
            data-chosen={face === emoji ? 'true' : undefined}
            aria-pressed={face === emoji}
            onClick={() => setFace(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <Field label={SCRIPT.assistant.purpose} grow>
        <input value={purpose} maxLength={1000} onChange={(event) => setPurpose(event.target.value)} />
      </Field>
      <Button variant="accent" disabled={saving || name.trim() === ''} onClick={submit}>
        {SCRIPT.assistant.submit}
      </Button>
    </Ask>
  );
}

/* ------------------------------------------------------------------ *
 * 5. The switch
 * ------------------------------------------------------------------ */

/**
 * The assistant speaks first.
 *
 * The runtime has no way to start a turn without one: a run is something a
 * message causes. So the thread sends one message the owner never sees — the
 * instruction from the script — and does not render it. Everything after it is
 * an ordinary conversation, in the owner's history like any other.
 */
function Handover({ answers, assistantAgent, met, onMet, onCarriesOn, navigate, onPickAnotherBrain }: QuestionProps): JSX.Element {
  const assistant = answers.assistant;
  const [conversationId, setConversationId] = useState<string | null>(met);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [silent, setSilent] = useState(false);
  /** The run is alive and slow, and the owner has been watching for a minute. */
  const [patient, setPatient] = useState(false);
  const [running, setRunning] = useState(true);
  const [offers, setOffers] = useState<'open' | 'phone' | 'gone'>('open');
  /** The owner is finished here, and the thread says where it carries on. */
  const [closing, setClosing] = useState(false);
  const still = useStill();
  const started = useRef(false);
  const agents = useMemo<ChatAgent[]>(() => (assistantAgent ? [assistantAgent] : []), [assistantAgent]);

  /*
   * The introduction happens once per installation, not once per page.
   *
   * A conversation the record already names is rejoined and polled — the run
   * outlived the reload — and only an installation that has none opens one.
   * The server holds the same rule from the other side: the opening turn is
   * claimed against the record, and a second claim is refused, so two tabs
   * racing this cannot make the assistant introduce itself twice.
   */
  useEffect(() => {
    if (!assistant || started.current) return undefined;
    started.current = true;
    if (met) {
      setConversationId(met);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const opened = await chatApi.startConversation(assistant.id);
        if (cancelled) return;
        setConversationId(opened.conversationId);
        onMet(opened.conversationId);
        // Recorded before the turn is sent: a reload a second later has to
        // find the conversation even if the send never came back.
        await api.onboardingStep(STEP_OF.handover, { conversationId: opened.conversationId }).catch(() => {});
        await chatApi.send(assistant.id, {
          conversationId: opened.conversationId,
          text: OPENING_INSTRUCTION,
          opening: true,
        });
      } catch {
        if (!cancelled) {
          setRunning(false);
          setSilent(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assistant?.id, met]);

  /*
   * The answer, when it comes. Polled: a run outlives any one page.
   *
   * Waiting is not the failure. A model on this computer takes a minute to
   * load, and a first message that looks up the owner's profile before it
   * writes takes several turns — a fixed deadline told the owner their
   * assistant was not answering while it was demonstrably working. So the
   * transcript's own runs decide: while one is open the thread stays patient
   * and says so after a minute, and only a run that ended without a word, or
   * five minutes of nothing at all, brings out the script's fallback.
   */
  useEffect(() => {
    if (!conversationId) return undefined;
    let cancelled = false;
    const since = Date.now();
    const read = (): void => {
      chatApi
        .conversation(conversationId)
        .then((transcript) => {
          if (cancelled) return;
          setMessages(transcript.messages);
          const waited = Date.now() - since;
          if (transcript.messages.some(isSpoken)) {
            setRunning(false);
            setSilent(false);
            setPatient(false);
            // Nothing is recorded here. First run was finished when the
            // assistant was made and this conversation opened; what this
            // moment decides is only what the screen offers next.
            return;
          }
          const runs = transcript.runs ?? [];
          const alive = runs.some((run) => run.finishedAt === null);
          const ended = runs.length > 0 && !alive;
          setPatient(alive && waited >= PATIENCE_MS);
          if (ended || waited >= FIRST_MESSAGE_TIMEOUT_MS) {
            setRunning(false);
            setSilent(true);
          }
        })
        .catch(() => {});
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversationId]);

  /**
   * The same conversation, in the shell.
   *
   * Not a new thread and not Home: the owner has just met their assistant in
   * this conversation, and "open buddi" should land them in it with the rail
   * around it. Replaced rather than pushed, because first run is not a place
   * to go back to.
   */
  const carriesOn = assistant && conversationId ? chatRoute(assistant.id, conversationId) : null;
  const spoken = messages.some(isSpoken);
  useEffect(() => {
    if (spoken && carriesOn) onCarriesOn(carriesOn);
  }, [spoken, carriesOn, onCarriesOn]);

  /*
   * Three seconds and the board leaves by itself.
   *
   * The owner said they were done — "not now", or a phone that said hello —
   * and a screen that then just sits there is the dead end this fixes. The
   * button is always there to do it sooner, and an owner who has asked for
   * less motion is never moved without pressing it.
   */
  useEffect(() => {
    if (!closing || !carriesOn || still) return undefined;
    const timer = window.setTimeout(() => navigate(carriesOn, true), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [closing, carriesOn, still, navigate]);

  const send = (text: string): void => {
    if (!assistant || !conversationId) return;
    setRunning(true);
    void chatApi
      .send(assistant.id, { conversationId, text })
      .catch(() => setRunning(false));
  };

  return (
    <>
      {/*
        What was said, and nothing about how. The chat draws the folded
        thoughts and the tool rows because that is its job; here they are the
        first thing an owner ever sees of an assistant, and "looking around" is
        the true and sufficient version of it.
      */}
      <MessageList
        messages={messages}
        live={[]}
        now={Date.now()}
        onOpen={() => {}}
        working={running}
        agents={agents}
        agentName={assistant?.name ?? ''}
        emptyHint={SCRIPT.handover.waiting}
        plain
        workingLine={SCRIPT.handover.looking(assistant?.name ?? '')}
      />

      {patient && !silent ? (
        <Buddi>
          <Said>{SCRIPT.handover.slow}</Said>
        </Buddi>
      ) : null}

      {silent ? (
        <>
          <Buddi>
            <Said>{SCRIPT.handover.silent}</Said>
          </Buddi>
          <Ask>
            <Button variant="accent" onClick={onPickAnotherBrain}>
              {SCRIPT.handover.again}
            </Button>
          </Ask>
        </>
      ) : null}

      {closing ? (
        <Buddi>
          <Said>{SCRIPT.done.said}</Said>
        </Buddi>
      ) : null}

      {/*
        An offer is a question, and a question is answered in the dock.
        The chips, and then the phone's own step, take the composer's place
        while they are open — the way the name, the clock, the brain and the
        assistant each did — so there is never a second thing to fill in
        underneath the thing the owner is filling in.
      */}
      {spoken && offers === 'open' ? (
        <Ask>
          <button type="button" className="ui-btn" onClick={() => setOffers('phone')}>
            {SCRIPT.offers.phone}
          </button>
          <Button
            variant="accent"
            onClick={() => {
              setOffers('gone');
              setClosing(true);
            }}
          >
            {SCRIPT.offers.notNow}
          </Button>
        </Ask>
      ) : null}

      {spoken && offers === 'phone' ? (
        <TelegramCard
          onPaired={() => setClosing(true)}
          onDismiss={() => {
            setOffers('gone');
            setClosing(true);
          }}
        />
      ) : null}

      {assistant && offers !== 'open' && offers !== 'phone' ? (
        <Dock>
        {closing && carriesOn ? (
          <div className="meet-ask">
            <ButtonLink
              variant="accent"
              href={carriesOn}
              onClick={(event) => {
                event.preventDefault();
                navigate(carriesOn, true);
              }}
            >
              {SCRIPT.done.open}
            </ButtonLink>
          </div>
        ) : null}
        <Composer
          disabled={!conversationId}
          running={running}
          onSend={(text) => send(text)}
          onStop={() => {
            if (conversationId) void chatApi.cancel(conversationId).catch(() => {});
          }}
          agentName={assistant.name}
        />
        </Dock>
      ) : null}
    </>
  );
}

/** A message with words in it from the assistant. */
function isSpoken(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    (message.blocks ?? []).some((block) => block.type === 'text' && block.text.trim() !== '')
  );
}

/* ------------------------------------------------------------------ *
 * The phone
 * ------------------------------------------------------------------ */

/**
 * Telegram: the token from BotFather in the thread, then a square to scan.
 *
 * What buddi says is a bubble and what the owner answers is in the dock —
 * the same shape as every other question on this screen, and the reason the
 * composer steps aside while this is open. "Not now" is always there: an
 * offer the owner took by mistake has to have a way back out of it.
 *
 * The pairing state is polled rather than assumed — the thread says the phone
 * arrived when the phone says hello, and not before.
 */
function TelegramCard({ onPaired, onDismiss }: { onPaired: () => void; onDismiss: () => void }): JSX.Element {
  const field = useOpened<HTMLInputElement>();
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [square, setSquare] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  /** The code stopped being valid, so watching for it stopped too. */
  const [stale, setStale] = useState(false);

  const ask = async (): Promise<void> => {
    const pairing = await api.telegramPairing();
    setOffer(pairing);
    setStale(false);
    setSquare(await qrSvgDataUrl(pairing.link).catch(() => ''));
  };

  const save = (): void => {
    if (token.trim() === '' || saving) return;
    setSaving(true);
    setNote(null);
    void (async () => {
      try {
        const saved = await api.saveTelegramToken(token.trim());
        setToken('');
        if (saved.restartNeeded) {
          // buddi's own reason when it had one — a restored installation says
          // why it is staying quiet rather than asking for a restart.
          setNote(saved.note ?? SCRIPT.telegram.restart);
          return;
        }
        await ask();
      } catch (err) {
        setNote(err instanceof ApiError ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    })();
  };

  const again = (): void => {
    setNote(null);
    void ask().catch((err: unknown) => setNote(err instanceof ApiError ? err.message : String(err)));
  };

  /*
   * Watch for the phone — until the code stops being worth watching.
   *
   * A code expires, and a page left open overnight asking every two seconds
   * whether a dead code was used is a page doing nothing, loudly. The code's
   * own expiry decides, capped at ten minutes, and then buddi offers a new one.
   */
  useEffect(() => {
    if (!offer || paired || stale) return undefined;
    let cancelled = false;
    const until = Math.min(Date.parse(offer.expiresAt) || Date.now() + PAIRING_WATCH_MS, Date.now() + PAIRING_WATCH_MS);
    const timer = window.setInterval(() => {
      if (Date.now() >= until) {
        setStale(true);
        return;
      }
      api
        .telegram()
        .then((status) => {
          if (cancelled || !status.paired) return;
          setPaired(true);
          onPaired();
        })
        .catch(() => {});
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [offer, paired, stale]);

  if (paired) {
    return (
      <Buddi>
        <Said>{SCRIPT.telegram.paired}</Said>
      </Buddi>
    );
  }

  if (offer) {
    return (
      <>
        <Buddi>
          <Said>{stale ? SCRIPT.telegram.expired : SCRIPT.telegram.scan}</Said>
        </Buddi>
        <Ask>
          {stale ? null : (
            <div className="meet-pair">
              {square ? <img className="meet-qr" src={square} alt={offer.link} /> : null}
              <a className="meet-link" href={offer.link} target="_blank" rel="noreferrer">
                {offer.link}
              </a>
            </div>
          )}
          <button type="button" className="meet-quiet" onClick={onDismiss}>
            {SCRIPT.offers.notNow}
          </button>
          {stale ? (
            <Button variant="accent" onClick={again}>
              {SCRIPT.telegram.newCode}
            </Button>
          ) : null}
        </Ask>
      </>
    );
  }

  return (
    <>
      <Buddi>
        <Said>{SCRIPT.telegram.how}</Said>
        {note ? <Said>{note}</Said> : null}
      </Buddi>
      <Ask>
        <Field label={SCRIPT.telegram.field} grow>
          <input
            ref={field}
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
            }}
          />
        </Field>
        <button type="button" className="meet-quiet" onClick={onDismiss}>
          {SCRIPT.offers.notNow}
        </button>
        <Button variant="accent" disabled={saving || token.trim() === ''} onClick={save}>
          {SCRIPT.telegram.submit}
        </Button>
      </Ask>
    </>
  );
}

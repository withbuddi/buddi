/**
 * First run: you meet buddi (docs/onboarding.md).
 *
 * One screen, five chapters and a handover. A map on the left says where the
 * owner is, what they answered (with "change") and the way out; one card on
 * the field holds buddi's bubbles, the chapter's inputs and a dock: "Chapter n
 * of 5" on the left, Back, the chapter's secondary action and its primary on
 * the right. At phone width the map folds into a strip of dots.
 *
 *   1. Hello: a name and a clock.
 *   2. A brain: the accounts, each tested with one small call.
 *   3. What I take on: outcomes whose plugins install in the background.
 *   4. Reach me: the phone, a mailbox, the app and the browser, all optional.
 *   5. Your assistant: a name, a colour and a persona.
 *
 * Then the speaker changes: the assistant's first message lands in the same
 * card, with four first questions under it and the things still waiting.
 *
 * What is answered lives on the server, never in this component: a reload
 * replays the answers from the record, the profile and the accounts, and
 * opens the first chapter nobody has answered (`meet/machine.ts`). Every word
 * is in `meet/script.ts`.
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
  OLLAMA_CLOUD_MODEL,
  api,
  chatApi,
  type BackupJob,
  type BrowserInstallProgress,
  type BrowserLaunchCheck,
  type ConnectionVerdict,
  keyRefused,
  type MlxhProbe,
  type OllamaProbe,
  type OllamaPull,
  type OnboardingReach,
  type ProviderAccountsView,
  type TakeOnView,
  type VersionView,
} from '../api';
import { useAsync } from '../ui/async';
import { MessageList } from '../chat/MessageList';
import type { ChatAgent, ChatMessage } from '../chat/types';
import { AGENTS_ROUTE, HOME_ROUTE, chatRoute } from '../routes';
import { Blob, Button, ButtonLink, Code, Field, FloatCard, GradientField, Icon, Mark, Notice, Pill, Progress, Segment, Sheet, Spacer, Stack, Toolbar, type IconName } from '../ui';
import { useMediaQuery } from '../useMediaQuery';
import { GEMINI_FALLBACK_MODEL, geminiBrains, isGeminiAccount, isGeminiPro, limited, pickGeminiFlash, pickGeminiModel } from '../gemini';
import { firstMlxhModel, isMlxhAccount, isMlxhImageModel, mlxhNotAnswering } from '../mlxh';
import { BankSheet, CalendarSheet, MailboxSheet, SIGN_IN_POLL_MS } from './parts/FirstRunSheets';
import { InstallProgress } from './parts/InstallProgress';
import { SignInCode } from './parts/SignInCode';
import { inBuddiApp, installHint, useInstallPrompt } from './parts/KeepClose';
import { STORE_URL } from './Browser';
import {
  COLOURS,
  DEFAULT_ASSISTANT_NAME,
  OPENING_INSTRUCTION,
  SCRIPT,
  TAKE_ON,
  TAKE_ON_DEFAULT,
  mascotUrl,
  type ColourId,
  type TakeOnTile,
} from './meet/script';
import { mascotFile } from './parts/FacePicker';
import {
  CHAPTERS,
  STEP_OF,
  afterRestore,
  answered,
  answersFrom,
  firstOpen,
  idFor,
  keyKind,
  mapState,
  previous,
  rememberRestore,
  rememberedRestore,
  reopen,
  usableAccounts,
  type BrainAnswer,
  type BrowserAnswer,
  type ChapterId,
  type MeetAnswers,
} from './meet/machine';
import { PairingTile, useTelegramPairing } from './parts/TelegramPairing';
import { HandoverTeam } from './parts/CatalogueSuggest';
import { WakesAfterRestart } from './parts/WakesAfterRestart';
import { announcePagesChanged } from '../pages/usePages';
import { fmtClock } from '../format';

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
 * Past this, with nothing said, the handover stops claiming anything is
 * coming — whatever the run says about itself.
 */
export const FIRST_MESSAGE_TIMEOUT_MS = 5 * 60_000;

/** How often the handover asks whether the answer has arrived. */
const POLL_MS = 1_500;

/** How often chapter 3's progress is read while an install runs. */
export const TAKE_ON_POLL_MS = 2_000;

/** Below this width the map folds into a strip of dots. */
const PHONE = '(max-width: 720px)';

/**
 * A field that opens is a field the owner is being asked to fill in.
 *
 * Every chapter puts its input on the card, and the thing that just appeared
 * is the thing to type into — asking someone to click it first is asking them
 * to do the obvious by hand.
 *
 * Focusing once on mount is not enough, and the reason is not React: measured
 * in Chrome, the field *was* `document.activeElement` while `document.
 * hasFocus()` was false, because the dashboard opens in a tab the owner is
 * not looking at yet. The first thing they do is click the window to bring it
 * forward, and that click lands where they clicked — usually the card — and
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
    /**
     * Nobody is typing anywhere: the open field may have the caret. A sheet
     * that just opened puts the focus on its own first button (Close); that
     * is the sheet arriving, not the owner choosing, so a field in the same
     * sheet may still take it.
     */
    const free = (node: T): boolean => {
      const active = node.ownerDocument.activeElement;
      if (active === null || active === node.ownerDocument.body || active === node.ownerDocument.documentElement) return true;
      const sheet = node.closest('[role="dialog"]');
      return sheet !== null && active.tagName === 'BUTTON' && active.closest('[role="dialog"]') === sheet;
    };
    const take = (): void => {
      const node = field.current;
      if (node && free(node)) node.focus();
    };
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

/** Reduced motion means no theatre. */
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

/* ------------------------------------------------------------------ *
 * buddi speaking, and buddi at work
 * ------------------------------------------------------------------ */

/** How many of buddi's working lines are up, so the Blob beside them can move. */
const MeetBusy = createContext<{ busy: number; report: (on: boolean) => void }>({ busy: 0, report: () => {} });

function MeetBusyProvider({ children }: { children: ReactNode }): JSX.Element {
  const [busy, setBusy] = useState(0);
  const report = useCallback((on: boolean) => setBusy((n) => Math.max(0, n + (on ? 1 : -1))), []);
  const value = useMemo(() => ({ busy, report }), [busy, report]);
  return <MeetBusy.Provider value={value}>{children}</MeetBusy.Provider>;
}

/**
 * One of buddi's bubbles: the Blob, then the words.
 *
 * The face is the real Buddi Blob, the same one the owner meets again in the
 * corner of every page; it moves while buddi is working on something.
 */
function Said({ children }: { children: ReactNode }): JSX.Element {
  const { busy } = useContext(MeetBusy);
  return (
    <div className="wiz-say">
      <Blob state={busy > 0 ? 'working' : 'idle'} size="sm" className="wiz-say-face" />
      <div className="wiz-bubble">{children}</div>
    </div>
  );
}

/** A run of buddi's bubbles. Kept as a name so a chapter reads as a script. */
function Buddi({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

/**
 * buddi at work: three dots and a line saying what it is doing, until the
 * verdict arrives as a bubble. Never blocks anything.
 */
function Thinking({ line }: { line?: string }): JSX.Element {
  const { report } = useContext(MeetBusy);
  useEffect(() => {
    report(true);
    return () => report(false);
  }, [report]);
  return (
    <div className="wiz-busy" role="status" aria-live="polite">
      <span className="wiz-pulse" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {line}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The dock: the card's last row
 * ------------------------------------------------------------------ */

/** The dock's actions element, once it is on the page, for the open chapter to fill. */
const DockSlot = createContext<HTMLElement | null>(null);

/**
 * Where an answer is given.
 *
 * What is being filled in sits on the card (`children`), and the actions sit
 * on the dock's one row (`actions`): Back first, the secondary, then the
 * primary last and rightmost. Each chapter renders exactly one row at a time.
 */
function Ask({ children, actions }: { children?: ReactNode; actions?: ReactNode }): JSX.Element {
  const slot = useContext(DockSlot);
  const row = actions === undefined || actions === null ? null : slot ? createPortal(actions, slot) : <div className="wiz-dock-inline">{actions}</div>;
  return (
    <>
      {children ? <div className="wiz-ask">{children}</div> : null}
      {row}
    </>
  );
}

/** Back, as a real, labelled action: to the chapter before, or to the brain cards. */
function Back({ onClick, disabled }: { onClick: () => void; disabled?: boolean }): JSX.Element {
  return (
    <Button variant="ghost" size="lg" onClick={onClick} disabled={disabled}>
      <Icon name="chevron-left" />
      {SCRIPT.back}
    </Button>
  );
}

/** The chapter's primary: accent, large, with the arrow. */
function Primary({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }): JSX.Element {
  return (
    <Button variant="accent" size="lg" onClick={onClick} disabled={disabled}>
      {children}
      <Icon name="arrow" />
    </Button>
  );
}

/** The assistant on disk: what a change edits rather than replaces. */
export interface ExistingAssistant {
  id: string;
  name: string;
  avatar: string;
  description: string;
  /** The picture it wears, when it has one (a Blob chosen here, or an upload). */
  picture?: string;
}

export interface MeetProps {
  navigate: (next: string, replace?: boolean) => void;
  /** The installation's zone. Chapter 1 offers the browser's own. */
  timezone: string;
}


/** What a chapter is handed: the answers, what the server holds, and the ways to answer. */
interface QuestionProps {
  answers: MeetAnswers;
  accounts: ProviderAccountsView | undefined;
  /** The catalogue's default model for a new Claude account, when the server named one. */
  claudeModel?: string | undefined;
  zones: string[];
  browserZone: string;
  assistantAgent: ChatAgent | null;
  /** The handover conversation the record already holds, if any. */
  met: string | null;
  onMet: (conversationId: string) => void;
  /** The assistant this installation already has, if it has one. */
  existing: ExistingAssistant | null;
  /** Chapter 3's progress, as the server last said it. */
  progress: TakeOnView | null;
  /** The tiles chapter 3 may draw, as `GET /api/onboarding` said; null before it answered. */
  offers: readonly string[] | null;
  /** Read chapter 3's progress again now. */
  onProgress: () => void;
  navigate: (next: string, replace?: boolean) => void;
  /** Save this chapter's answer and open the next unanswered one. */
  onSettled: (next: MeetAnswers) => void;
  /** Keep an answer without moving on (a brain tested, a model changed). */
  onKept: (next: MeetAnswers) => void;
  onBack: () => void;
  onTrouble: (message: string | null) => void;
  onReload: () => void;
  onPickAnotherBrain: () => void;
  /** The handover: the assistant has spoken, and first run is over. */
  onSpoken: (route: string) => void;
}

export function Meet({ navigate, timezone }: MeetProps): JSX.Element {
  const phone = useMediaQuery(PHONE);
  // The machine buddi runs on, from the gateway: the browser may be elsewhere.
  const [platform, setPlatform] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.session().then((s) => setPlatform(s.platform)).catch(() => {});
  }, []);
  const [answers, setAnswers] = useState<MeetAnswers>({});
  const [open, setOpen] = useState<ChapterId | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccountsView | undefined>(undefined);
  // The model catalogue's default for a Claude account, when the server names one.
  const [claudeModel, setClaudeModel] = useState<string | undefined>(undefined);
  const [zones, setZones] = useState<string[]>([]);
  const [assistantAgent, setAssistantAgent] = useState<ChatAgent | null>(null);
  /** Anything that failed, said on the card rather than in a banner. */
  const [trouble, setTrouble] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** The handover conversation the record already knows about, if any. */
  const [met, setMet] = useState<string | null>(null);
  /**
   * The assistant that already exists, whatever the answers currently say.
   *
   * Start over empties the answers, and the answers are what the map draws;
   * this is what the *installation* holds, and it is what decides whether
   * saving chapter 5 writes a first agent or changes the one there is.
   */
  const [existing, setExisting] = useState<ExistingAssistant | null>(null);
  /** The dock's actions element, once it is on the page. */
  const [dock, setDock] = useState<HTMLElement | null>(null);
  /** Where the conversation carries on once the assistant has spoken: first run is over. */
  const [carriesOn, setCarriesOn] = useState<string | null>(null);
  /**
   * The other way this screen can go.
   *
   * `running` is seeded from what this tab remembered, because the restore
   * takes the gateway down with it and a reload in the middle of one must not
   * land back on "what should we call you?".
   */
  const [restore, setRestore] = useState<RestoreState>(() => (rememberedRestore() ? 'running' : 'idle'));
  /** Start over: what the server already holds and the new run meets again as answered. */
  const [kept, setKept] = useState<{ brain?: BrainAnswer }>({});
  /**
   * What buddi says once at the foot of the open chapter: what stays after
   * Start over, or the welcome back after a restore. Gone with the next answer.
   */
  const [said, setSaid] = useState<string[]>([]);
  /** Bumped by Start over, so every chapter mounts afresh. */
  const [round, setRound] = useState(0);
  /** The brain the wizard last knew, so starting over can meet it again. */
  const lastBrain = useRef<BrainAnswer | undefined>(undefined);
  /** Chapter 3's progress, read from the server and read again while it runs. */
  const [progress, setProgress] = useState<TakeOnView | null>(null);
  /** Chapter 3's tiles, as the gateway decided them (only plugins withbuddi.com lists). */
  const [offers, setOffers] = useState<readonly string[] | null>(null);
  const readProgress = useCallback((): void => {
    void Promise.resolve()
      .then(() => api.takeOnProgress())
      .then((view) => {
        if (view && Array.isArray(view.plugins)) setProgress(view);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!progress?.running) return undefined;
    const timer = window.setInterval(readProgress, TAKE_ON_POLL_MS);
    return () => window.clearInterval(timer);
  }, [progress?.running, readProgress]);

  /** The zone this browser is in, which is what chapter 1 offers. */
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
   * A refresh after a write does not replay: the wizard has just decided
   * something, and re-deriving the answers from a read that may not yet show
   * it would overwrite the newer truth with the older one — the account the
   * assistant was moved onto a moment ago being the case that bites.
   */
  const load = useCallback(async (replay = true, restoredNow = false): Promise<void> => {
    const [onboarding, owner, accountView, roster, browserView, providers] = await Promise.all([
      api.onboarding().catch(() => undefined),
      api.owner().catch(() => undefined),
      api.providerAccounts().catch(() => undefined),
      chatApi.agents().catch(() => undefined),
      api.browser().catch(() => undefined),
      api.providers().catch(() => undefined),
    ]);
    setAccounts(accountView);
    if (Array.isArray(onboarding?.offers)) setOffers(onboarding.offers);
    const anthropicDefault = providers?.providers.find((provider) => provider.kind === 'anthropic')?.defaultModel?.trim();
    setClaudeModel(anthropicDefault ? anthropicDefault : undefined);
    setZones(owner?.zones ?? []);
    // The conversation the handover opened, if it already did. Held on the
    // record rather than in this component, because a reload is exactly when
    // it matters: the assistant introduces itself once.
    setMet(onboarding?.details?.conversationId ?? null);
    const own = roster?.agents.find((agent) => agent.id === roster.defaultAgentId) ?? roster?.agents[0];
    if (own) setAssistantAgent(own);
    setExisting(
      onboarding && !onboarding.needs.agent && own
        ? {
            id: own.id,
            name: own.name,
            avatar: own.avatar?.kind === 'emoji' ? own.avatar.value : '',
            description: own.description,
            ...(own.picture ? { picture: own.picture } : {}),
          }
        : null,
    );
    if (Array.isArray(onboarding?.details?.takeOn)) readProgress();
    const facts = {
      onboarding,
      owner,
      accounts: accountView,
      browser: browserView?.browser?.engine,
      ...(own ? { assistant: { id: own.id, name: own.name, avatar: own.avatar?.kind === 'emoji' ? own.avatar.value : '' } } : {}),
    };
    /*
     * A restore that just landed brings a finished record with it, which is
     * the one case where "done" does not mean the owner should be sent away:
     * the keys did not come back, so there is a chapter left to answer.
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
     * A finished first run has nothing to show.
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
    const replayed = answersFrom(facts);
    setAnswers(replayed);
    setOpen((current) => current ?? firstOpen(replayed));
    // Deliberately no dependencies: this reads the server once on mount and
    // again only when something asks it to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const record = (id: ChapterId, learned: { conversationId?: string; accountId?: string; reach?: OnboardingReach } = {}): void => {
    void Promise.resolve()
      .then(() => api.onboardingStep(STEP_OF[id], learned))
      .catch(() => {});
  };

  /** After Start over, a brain the server already holds is met as answered, with its "change". */
  const withKept = (next: MeetAnswers): MeetAnswers =>
    firstOpen(next) === 'brain' && kept.brain ? { ...next, brain: kept.brain } : next;

  /** One chapter saved: keep it, record the step, open the next chapter nobody answered. */
  const settle = (id: ChapterId, given: MeetAnswers): void => {
    const next = withKept(given);
    if (next.brain) lastBrain.current = next.brain;
    setTrouble(null);
    setSaid([]);
    setAnswers(next);
    // Chapter 3 is recorded by its own route; chapter 4 carries its rows.
    if (id === 'brain' && next.brain) record(id, { accountId: next.brain.accountId });
    else if (id === 'reach') record(id, next.reach ? { reach: next.reach } : {});
    else if (id !== 'takeOn') record(id);
    setOpen(firstOpen(next));
  };

  /** An answer kept without moving on: the brain tested, a model changed. */
  const keep = (id: ChapterId, given: MeetAnswers): void => {
    setTrouble(null);
    setAnswers(given);
    if (given.brain) lastBrain.current = given.brain;
    if (id === 'brain' && given.brain) record(id, { accountId: given.brain.accountId });
  };

  const change = (id: ChapterId): void => {
    setTrouble(null);
    setAnswers((current) => reopen(current, id));
    setOpen(id);
  };

  const back = (): void => {
    if (!open) return;
    const before = previous(open === 'handover' ? 'handover' : open);
    if (before) change(before);
  };

  /*
   * Start over: back to chapter 1 with nothing answered.
   *
   * Unmounting the open chapter is what cancels anything in flight — a
   * sign-in waiting for its code cancels itself when its card goes. Nothing
   * saved is undone, so there is nothing to confirm: buddi says what stays,
   * once, and meets the brain again as answered when the owner gets there.
   */
  const startOver = (): void => {
    const brainNow = answers.brain ?? lastBrain.current;
    const installedNow = (progress?.plugins ?? []).filter((p) => p.state === 'ready').map((p) => p.title);
    setTrouble(null);
    setKept({});
    setSaid([]);
    setAnswers({});
    setOpen('hello');
    setRound((at) => at + 1);
    void (async () => {
      const [accountView, telegram, browserView] = await Promise.all([
        Promise.resolve().then(() => api.providerAccounts()).catch(() => undefined),
        Promise.resolve().then(() => api.telegram()).catch(() => undefined),
        Promise.resolve().then(() => api.browser()).catch(() => undefined),
      ]);
      const usable = usableAccounts(accountView);
      const brain = brainNow && usable.some((account) => account.id === brainNow.accountId) ? brainNow : undefined;
      if (accountView) setAccounts(accountView);
      setKept(brain ? { brain } : {});
      const stays = [
        ...new Set(usable.map((account) => account.label)),
        ...(telegram?.paired ? [SCRIPT.startOver.telegram] : []),
        ...(browserView?.browser?.engine === 'chromium' ? [SCRIPT.startOver.browser] : []),
        ...installedNow,
      ];
      setSaid(stays.length > 0 ? [SCRIPT.startOver.said(stays.join(', '))] : []);
    })();
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

  // The running version, quietly under the tagline: the one place an owner
  // reads it before the dashboard exists.
  const version = useAsync<VersionView>(() => api.version().catch(() => ({ current: '' } as VersionView)), []);
  const wizard = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (wizard.current) wizard.current.scrollTop = 0;
  }, [open]);

  const restoring = restore === 'running';
  const nothingAnswered = Object.keys(answers).length === 0;
  const props: QuestionProps = {
    answers,
    accounts,
    claudeModel,
    zones,
    browserZone,
    assistantAgent,
    met,
    onMet: setMet,
    existing,
    progress,
    offers,
    onProgress: readProgress,
    navigate,
    onSettled: (next) => open && settle(open, next),
    onKept: (next) => open && keep(open, next),
    onBack: back,
    onTrouble: setTrouble,
    onReload: () => void load(false),
    onPickAnotherBrain: () => change('brain'),
    onSpoken: setCarriesOn,
  };

  /* ---- the map ---- */
  const takeOnTitles = (answers.takeOn ?? []).map((tile) => TAKE_ON.find((t) => t.id === tile)?.title ?? tile);
  const installs = progress?.plugins ?? [];
  const ready = installs.filter((p) => p.state === 'ready').length;
  const installSub =
    installs.length === 0 ? null : progress?.running ? SCRIPT.takeOn.installing(ready, installs.length) : ready === installs.length ? SCRIPT.takeOn.installed : null;
  const reachDone = [
    answers.reach?.phone ? (SCRIPT.reach.done.phone as string) : null,
    answers.reach?.mailbox ? SCRIPT.reach.done.mailbox : null,
    answers.reach?.app || answers.reach?.browser ? SCRIPT.reach.done.app : null,
  ].filter((line): line is string => line !== null);
  const mapAnswers: Record<Exclude<ChapterId, 'handover'>, { answer: string; sub?: string | null }> = {
    hello: { answer: SCRIPT.hello.answer(answers.name ?? ''), sub: answers.clock ?? null },
    brain: { answer: SCRIPT.brain.answer(answers.brain?.label ?? '') },
    takeOn: { answer: SCRIPT.takeOn.answer(takeOnTitles), sub: installSub },
    reach: { answer: SCRIPT.reach.answer(reachDone) },
    assistant: { answer: answers.assistant?.name ?? '' },
  };
  const chapterIds = CHAPTERS.filter((id): id is Exclude<ChapterId, 'handover'> => id !== 'handover');
  const at = open === null || open === 'handover' ? chapterIds.length : chapterIds.indexOf(open);
  const noteAt = Math.min(at, chapterIds.length - 1);

  const outLinks = carriesOn ? null : (
    <div className="wiz-map-out">
      <button type="button" className="wiz-link" disabled={leaving} onClick={later}>
        {SCRIPT.later}
      </button>
      {open === 'hello' && nothingAnswered && restore === 'idle' ? (
        <button type="button" className="wiz-link" onClick={() => setRestore('form')}>
          {SCRIPT.restore.offer}
        </button>
      ) : !restoring && open !== null && !(open === 'hello' && nothingAnswered) ? (
        <button type="button" className="wiz-link" disabled={leaving} onClick={startOver}>
          {SCRIPT.startOver.link}
        </button>
      ) : null}
    </div>
  );

  const tagline = platform === undefined || platform === 'darwin' ? SCRIPT.tagline : SCRIPT.taglineElsewhere;
  const count = open && open !== 'handover' ? <span className="wiz-count">{SCRIPT.count(at + 1)}</span> : <span className="wiz-count" />;

  return (
    <DockSlot.Provider value={dock}>
      <MeetBusyProvider>
        <GradientField className="wiz-ground">
          <div className="wiz" ref={wizard} data-phone={phone ? 'true' : undefined} data-testid="meet">
            <div className="wiz-frame">
              {phone ? (
                <div className="wiz-strip">
                  <Mark size="sm" />
                  <span className="wiz-dots" aria-label={open && open !== 'handover' ? SCRIPT.count(at + 1) : undefined}>
                    {chapterIds.map((id) => (
                      <i key={id} data-state={mapState(answers, open, id)} />
                    ))}
                  </span>
                  <span className="wiz-strip-name">
                    {open && open !== 'handover' ? SCRIPT.strip(at + 1, SCRIPT.chapters[at] ?? '') : SCRIPT.handover.starterLabel}
                  </span>
                </div>
              ) : (
                <nav className="wiz-map" aria-label="Chapters">
                  <div className="wiz-head">
                    <Mark size="lg" />
                    <div>
                      <div className="wiz-head-name">buddi</div>
                      <div className="wiz-head-line">{tagline}</div>
                      {version.data?.current ? <div className="wiz-head-version mono">buddi {version.data.current}</div> : null}
                    </div>
                  </div>
                  {chapterIds.map((id, index) => {
                    const state = restoring ? (id === 'hello' ? 'now' : 'todo') : mapState(answers, open, id);
                    const shown = mapAnswers[id];
                    return (
                      <div key={id} className="wiz-ch" data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                        <span className="wiz-num" data-state={state}>
                          {state === 'done' ? <Icon name="check" size={12} /> : index + 1}
                        </span>
                        <span className="wiz-ch-label">
                          {state === 'done' ? shown.answer : SCRIPT.chapters[index]}
                          {state === 'done' && shown.sub ? <span className="wiz-ch-sub">{shown.sub}</span> : null}
                        </span>
                        {state === 'done' && !restoring ? (
                          <button type="button" className="wiz-link" onClick={() => change(id)}>
                            {SCRIPT.change}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                  <div className="wiz-map-spacer" />
                  <div className="wiz-map-note">{SCRIPT.mapNotes[noteAt]}</div>
                  {outLinks}
                </nav>
              )}
              <div className="wiz-stage" role="main">
                <div className="wiz-column" data-width={open === 'hello' ? 'narrow' : open === 'brain' ? 'mid' : 'wide'}>
                  <FloatCard
                    key={`${round}-${open ?? ''}-${restoring ? 'r' : ''}`}
                    dock={
                      <>
                        {count}
                        <div className="wiz-dock-actions" ref={setDock} />
                      </>
                    }
                  >
                    {restoring ? (
                      <RestoreRunning
                        onDone={(name) => {
                          setRestore('idle');
                          // The name comes back with the backup; a backup that
                          // carried none simply gets the sentence that matters.
                          setSaid([...(name ? [SCRIPT.restore.welcome(name)] : []), SCRIPT.restore.keys]);
                          void load(true, true);
                        }}
                        onFailed={(message) => {
                          setRestore('idle');
                          setTrouble(message);
                        }}
                      />
                    ) : open === 'hello' ? (
                      <HelloChapter {...props} />
                    ) : open === 'brain' ? (
                      <BrainChapter {...props} />
                    ) : open === 'takeOn' ? (
                      <TakeOnChapter {...props} />
                    ) : open === 'reach' ? (
                      <ReachChapter {...props} />
                    ) : open === 'assistant' ? (
                      <AssistantChapter {...props} />
                    ) : open === 'handover' ? (
                      <Handover {...props} />
                    ) : (
                      <Thinking />
                    )}
                    {said.length > 0 || trouble ? (
                      <Buddi>
                        {said.map((line) => (
                          <Said key={line}>{line}</Said>
                        ))}
                        {trouble ? <Said>{trouble}</Said> : null}
                      </Buddi>
                    ) : null}
                  </FloatCard>
                  {phone ? <div className="wiz-phone-out">{outLinks}</div> : null}
                </div>
              </div>
            </div>
          </div>
          {restore === 'form' ? (
            <RestoreForm
              onCancel={() => setRestore('idle')}
              onStarted={() => setRestore('running')}
              onTrouble={setTrouble}
            />
          ) : null}
        </GradientField>
      </MeetBusyProvider>
    </DockSlot.Provider>
  );
}

/** A chapter's title: the one heading on the card. */
function Title({ children }: { children: ReactNode }): JSX.Element {
  return <h1 className="wiz-title">{children}</h1>;
}

/* ------------------------------------------------------------------ *
 * 1. Hello: a name and a clock
 * ------------------------------------------------------------------ */

/** Now, on the clock in `zone`, as "18:22"; empty for a zone the browser does not know. */
function timeIn(zone: string): string {
  try {
    return fmtClock(new Date(), zone);
  } catch {
    return '';
  }
}

function HelloChapter({ answers, zones, browserZone, onSettled, onTrouble }: QuestionProps): JSX.Element {
  const field = useOpened<HTMLInputElement>();
  const [name, setName] = useState(answers.name ?? '');
  const [zone, setZone] = useState(answers.clock ?? browserZone);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || saving) return;
    setSaving(true);
    api
      .setOwner({ preferredName: trimmed, timezone: zone })
      .then(() => onSettled({ ...answers, name: trimmed, clock: zone }))
      .catch((err: unknown) => onTrouble(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setSaving(false));
  };
  return (
    <>
      <Title>{SCRIPT.hello.title}</Title>
      <Buddi>
        {SCRIPT.hello.opening.map((line) => (
          <Said key={line}>{line}</Said>
        ))}
      </Buddi>
      <Ask
        actions={
          <Primary onClick={submit} disabled={saving || name.trim() === ''}>
            {SCRIPT.hello.submit}
          </Primary>
        }
      >
        <div className="wiz-pair">
          <Field label={SCRIPT.name.label}>
            <input
              ref={field}
              placeholder={SCRIPT.name.placeholder}
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </Field>
          {picking ? (
            <Field label={SCRIPT.clock.label} hint={SCRIPT.clock.hint(timeIn(zone))}>
              <select value={zone} onChange={(event) => setZone(event.target.value)}>
                {(zones.includes(zone) ? zones : [zone, ...zones]).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field
              label={SCRIPT.clock.label}
              hint={SCRIPT.clock.hint(timeIn(zone))}
              action={
                <Button size="lg" onClick={() => setPicking(true)}>
                  {SCRIPT.clock.change}
                </Button>
              }
            >
              <input value={zone} readOnly />
            </Field>
          )}
        </div>
        <div className="wiz-foot">{SCRIPT.hello.foot}</div>
      </Ask>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 2. A brain
 * ------------------------------------------------------------------ */

type Card = 'free' | 'claude' | 'chatgpt' | 'key' | 'local';
type KeyKind = 'key' | 'gemini' | 'service';

const CARD_LOOK: Record<Card, { icon: IconName; tone?: string; wide?: boolean }> = {
  free: { icon: 'cloud', tone: 'good' },
  claude: { icon: 'bulb', tone: 'mail' },
  chatgpt: { icon: 'chat', tone: 'coding' },
  key: { icon: 'key', tone: 'accent' },
  local: { icon: 'monitor', tone: 'plain', wide: true },
};

function BrainChapter(props: QuestionProps): JSX.Element {
  const { accounts, answers, onSettled, onKept, onReload, onBack } = props;
  const [card, setCard] = useState<Card | null>(null);
  const [keyKindShown, setKeyKindShown] = useState<KeyKind>('key');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ollama, setOllama] = useState<OllamaProbe | null>(null);
  const [mlxh, setMlxh] = useState<MlxhProbe | null>(null);
  /** The models the owner is choosing between, and what to do with the answer. */
  const [choice, setChoice] = useState<{
    models: string[];
    make: (model: string) => Parameters<typeof api.saveProviderAccount>[0];
    label: string;
  } | null>(null);
  const claudeOffered = accounts?.anthropicOAuthEnabled === true;
  const chatgptOffered = accounts?.codexEnabled === true;
  /** Where Gemini answers and where a key is made: the gateway's to say, as ever. */
  const gemini = accounts?.gemini;
  /** The ollama.com or openai.com window, opened inside the tap so no popup blocker stops it. */
  const [consent, setConsent] = useState<Window | null>(null);

  // The "On this computer" card has to know before it is opened what is
  // there, Ollama or mlxh: its line says what was found. The gateway asks the
  // machine; this only reads the answers, and keeps asking.
  useEffect(() => {
    let cancelled = false;
    const ask = (): void => {
      Promise.resolve()
        .then(() => api.ollama())
        .then((probe) => {
          if (!cancelled && probe) setOllama(probe);
        })
        .catch(() => {});
      Promise.resolve()
        .then(() => api.mlxh())
        .then((probe) => {
          if (!cancelled && probe) setMlxh(probe);
        })
        .catch(() => {
          // A gateway without the probe: nothing local of that kind.
          if (!cancelled) setMlxh({ running: false, baseUrl: '', manager: false, models: [] });
        });
    };
    ask();
    const timer = window.setInterval(ask, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * Keep the brain: move the assistant onto it when there is one, and light
   * "Use this brain".
   *
   * The binding is the part that is easy to forget: changing the brain after
   * the assistant exists has to move *that agent* onto the new account, or the
   * card would confirm one thing and the assistant would keep answering on
   * another. A new assistant is bound at creation instead, with this account's
   * id, so nothing is assigned twice.
   */
  const bind = async (brain: BrainAnswer): Promise<string | null> => {
    // The installation's assistant, even when a Start over emptied the answer.
    if (answers.assistant ?? props.existing) {
      try {
        // One call: the assistant moves, and so does anything shipped that
        // was following its choice of AI.
        await api.bindBrain({ accountId: brain.accountId, model: brain.model });
      } catch (err) {
        return err instanceof ApiError ? err.message : String(err);
      }
    }
    onReload();
    onKept({ ...answers, brain });
    // The card closes: what shows now is the verdict and "Use this brain".
    consent?.close();
    setConsent(null);
    setCard(null);
    setChoice(null);
    return null;
  };

  const adopt = async (
    body: Parameters<typeof api.saveProviderAccount>[0],
    label: string,
    flash?: string,
  ): Promise<ConnectionVerdict | null> => {
    setBusy(true);
    setProblem(null);
    try {
      const saved = await api.saveProviderAccount(body);
      let verdict = await api.testProviderAccount(saved.id);
      let model = body.defaultModel;
      let freeTier = false;
      // A free Google AI key has no Pro allowance at all: Google answers 429.
      // Try once more on the newest Flash before saying anything.
      if (verdict.state !== 'connected' && flash && flash !== model && limited(verdict)) {
        const listed = (await api.providerAccounts()).accounts.find((account) => account.id === saved.id);
        if (listed) {
          await api.saveProviderAccount({
            id: listed.id, revision: listed.revision, label: listed.label, kind: listed.kind, auth: listed.auth,
            baseUrl: listed.baseUrl, defaultModel: flash, enabled: listed.enabled,
          });
          verdict = await api.testProviderAccount(saved.id);
          if (verdict.state === 'connected') {
            model = flash;
            freeTier = true;
          }
        }
      }
      if (verdict.state !== 'connected') {
        // The account was saved so it could be tested; a test that failed
        // leaves nothing behind, or every retry would add one more copy of
        // an account that does not work.
        try {
          const listed = (await api.providerAccounts()).accounts.find((account) => account.id === saved.id);
          if (listed) await api.removeProviderAccount(saved.id, listed.revision);
        } catch {
          /* the message below is the thing that matters; Settings can still remove it */
        }
        setProblem(verdict.message);
        return verdict;
      }
      const refused = await bind({ accountId: saved.id, label, model, ...(freeTier ? { freeTier } : {}) });
      if (refused) setProblem(refused);
      return verdict;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  /**
   * One small call before the model list is offered. A service can list its
   * models without a key (Ollama Cloud does), so a list is no proof the key
   * works: the account is saved, tested on `body`'s model, and removed again
   * whatever the verdict, so a retry or a Back leaves nothing behind. The
   * picked model is then saved and tested for real by `adopt`.
   */
  const trial = async (body: Parameters<typeof api.saveProviderAccount>[0]): Promise<ConnectionVerdict | null> => {
    setBusy(true);
    setProblem(null);
    try {
      const saved = await api.saveProviderAccount(body);
      let verdict: ConnectionVerdict;
      try {
        verdict = await api.testProviderAccount(saved.id);
      } finally {
        try {
          const listed = (await api.providerAccounts()).accounts.find((account) => account.id === saved.id);
          if (listed) await api.removeProviderAccount(saved.id, listed.revision);
        } catch {
          /* Settings can still remove it */
        }
      }
      if (verdict.state !== 'connected') setProblem(verdict.message);
      return verdict;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  /*
   * One more question, and only when it is a real one.
   *
   * A service with thirty models has no "the" model, and picking `models[0]`
   * for the owner meant buddi confidently naming something arbitrary. So when
   * there are several and none of them is the service's own default, the card
   * asks — once, with the list — and the answer becomes the account's default
   * and the model the confirmation names. One model, or a flagged default, is
   * not a question and is not asked.
   */
  const offer = (models: string[], make: (model: string) => Parameters<typeof api.saveProviderAccount>[0], label: string): void => {
    if (models.length <= 1) {
      void adopt(make(models[0] ?? ''), label);
      return;
    }
    setChoice({ models, make, label });
  };

  const pick = (next: Card): void => {
    if (next === card) return;
    consent?.close();
    // Opened inside the tap, so no popup blocker stops it.
    // Not ChatGPT: its code is shown first, and its Open button opens the page in the order the bubble says.
    const opens = next === 'free';
    setConsent(opens && typeof window.open === 'function' ? window.open('', '_blank') : null);
    setProblem(null);
    setChoice(null);
    setKeyKindShown('key');
    setCard(next);
  };
  const leave = (): void => {
    consent?.close();
    setConsent(null);
    setChoice(null);
    setProblem(null);
    setCard(null);
  };

  const localLine = localFound(ollama, mlxh);
  const shownCards: Card[] = ['free', ...(claudeOffered ? (['claude'] as Card[]) : []), ...(chatgptOffered ? (['chatgpt'] as Card[]) : []), 'key', 'local'];

  let flow: ReactNode = null;
  if (choice) {
    flow = (
      <>
        <Buddi>
          <Said>{SCRIPT.brain.model.ask}</Said>
        </Buddi>
        {busy ? (
          <Thinking line={SCRIPT.brain.checking.service} />
        ) : problem ? (
          <Buddi>
            <Said>{problem}</Said>
          </Buddi>
        ) : null}
        <ModelChoice busy={busy} models={choice.models} onBack={leave} onUse={(model) => void adopt(choice.make(model), choice.label)} />
      </>
    );
  } else if (card === 'key') {
    flow = (
      <>
        {(
          <Segment
            label={SCRIPT.brain.keyKinds.label}
            value={keyKindShown}
            onChange={(next) => {
              setProblem(null);
              setKeyKindShown(next);
            }}
            options={[
              { value: 'key' as KeyKind, label: SCRIPT.brain.keyKinds.key },
              ...(gemini ? [{ value: 'gemini' as KeyKind, label: SCRIPT.brain.keyKinds.gemini }] : []),
              { value: 'service' as KeyKind, label: SCRIPT.brain.keyKinds.service },
            ]}
          />
        )}
        {keyKindShown === 'gemini' && gemini ? (
          <GeminiCard key="gemini" busy={busy} problem={problem} preset={gemini} onBack={leave} onUse={adopt} />
        ) : keyKindShown === 'service' ? (
          <ServiceCard key="service" busy={busy} problem={problem} address={ollama?.cloudBaseUrl ?? ''} onBack={leave} onOffer={offer} onTrial={trial} onUse={adopt} />
        ) : (
          <KeyCard key="key" busy={busy} problem={problem} onBack={leave} onUse={adopt} />
        )}
      </>
    );
  } else if (card === 'local') {
    flow = <LocalCard busy={busy} problem={problem} probe={ollama} mlxh={mlxh} onBack={leave} onOffer={offer} onUse={adopt} onCloud={() => pick('free')} />;
  } else if (card === 'free') {
    flow = <OllamaCloudCard {...props} busy={busy} consent={consent} onBack={leave} onConnected={bind} />;
  } else if (card === 'chatgpt') {
    flow = <ChatGPTCard {...props} busy={busy} consent={consent} onBack={leave} onConnected={bind} />;
  } else if (card === 'claude') {
    flow = <ClaudeCard {...props} busy={busy} problem={problem} onBack={leave} onConnected={bind} />;
  }

  return (
    <>
      <Title>{SCRIPT.brain.title}</Title>
      <Buddi>
        <Said>{SCRIPT.brain.ask}</Said>
      </Buddi>
      <div className="wiz-grid" role="group" aria-label={SCRIPT.brain.ask}>
        {shownCards.map((id) => {
          const look = CARD_LOOK[id];
          const words = SCRIPT.brain.cards[id];
          return (
            <button
              key={id}
              type="button"
              className="wiz-opt"
              aria-pressed={card === id}
              data-wide={look.wide ? 'true' : undefined}
              onClick={() => pick(id)}
            >
              <span className="wiz-glyph" data-tone={look.tone} aria-hidden="true">
                <Icon name={look.icon} />
              </span>
              <span>
                <span className="wiz-opt-title">{words.title}</span>
                <span className="wiz-opt-line">{id === 'local' ? localLine : words.line}</span>
                {'pill' in words ? <Pill tone="good">{words.pill}</Pill> : null}
              </span>
            </button>
          );
        })}
      </div>
      {flow}
      {flow === null && answers.brain ? (
        <Buddi>
          <Said>
            {answers.brain.freeTier ? SCRIPT.brain.worksOnFlash(answers.brain.model) : SCRIPT.brain.works(answers.brain.model)}
          </Said>
          <CloudModels {...props} />
          {answers.brain.label === SCRIPT.brain.ollama.label || answers.brain.label === SCRIPT.brain.mlxh.label ? (
            <Notice tone="warm" title={SCRIPT.brain.ollama.honestTitle}>
              {SCRIPT.brain.ollama.honest}
            </Notice>
          ) : null}
        </Buddi>
      ) : null}
      {flow === null ? (
        <Ask
          actions={
            <>
              <Back onClick={onBack} />
              {/* Lit only once a brain has answered its one small call. */}
              <Primary onClick={() => answers.brain && onSettled(answers)} disabled={!answers.brain}>
                {SCRIPT.brain.submit}
              </Primary>
            </>
          }
        />
      ) : null}
    </>
  );
}


/* ------------------------------------------------------------------ *
 * The brain's sign-ins and keys
 * ------------------------------------------------------------------ */

/**
 * Save, test and bind; `flash` is tried once when the first model is refused for a limit.
 * Answers the test's verdict, or null when the save itself failed (the problem says why).
 */
type Adopt = (body: Parameters<typeof api.saveProviderAccount>[0], label: string, flash?: string) => Promise<ConnectionVerdict | null>;

/** Save, test and remove again: whether the key answers before a model list is offered. */
type Trial = (body: Parameters<typeof api.saveProviderAccount>[0]) => Promise<ConnectionVerdict | null>;

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
  onBack,
  onUse,
}: {
  busy: boolean;
  models: string[];
  onBack: () => void;
  onUse: (model: string) => void;
}): JSX.Element {
  const [chosen, setChosen] = useState(models[0] ?? '');
  return (
    <Ask
      actions={
        <>
        <Back onClick={onBack} disabled={busy} />
        <Button variant="accent" size="lg" disabled={busy || chosen === ''} onClick={() => onUse(chosen)}>
          {SCRIPT.brain.model.submit}
        </Button>
        </>
      }
    >
      <Field label={SCRIPT.brain.model.label} grow>
        <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Field>
    </Ask>
  );
}

/** The list, kept open in a card after a test failed for something other than the key. */
function ModelSelect({
  models,
  picked,
  disabled,
  onPick,
}: {
  models: string[];
  picked: string;
  disabled: boolean;
  onPick: (model: string) => void;
}): JSX.Element {
  return (
    <Field label={SCRIPT.brain.model.label} grow>
      <select value={picked} disabled={disabled} onChange={(event) => onPick(event.target.value)}>
        {models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </Field>
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
  /** Listing the key's models, before the save and the test even start. */
  const [probing, setProbing] = useState(false);
  /** The key's own list, offered when the test failed for something other than the key. */
  const [models, setModels] = useState<string[]>([]);
  const [picked, setPicked] = useState('');
  /** The test said 401/403: the key itself, not the model. */
  const [refused, setRefused] = useState(false);
  const working = busy || probing;
  const picking = !refused && problem !== null && models.length > 0;
  const kind = override ?? keyKind(secret);
  const submit = (): void => {
    const value = secret.trim();
    if (value === '' || working) return;
    setProbing(true);
    setRefused(false);
    void (async () => {
      // The model list first, so the default buddi names is one this key can
      // actually reach rather than one this page believes in.
      let defaultModel = kind === 'anthropic' ? 'claude-sonnet-5' : 'gpt-5';
      let listed = models;
      if (picking && picked !== '') {
        // The owner chose from the list after a limit or a missing model.
        defaultModel = picked;
      } else {
        try {
          const probed = await api.probeModels({ kind, auth: 'api-key', secret: value });
          // Only a model the provider itself flags as the default displaces the
          // sensible one. The first of a long list is not an answer, and these
          // two providers have a well-known model worth starting on.
          defaultModel = probed.models.find((model) => model.isDefault)?.id ?? defaultModel;
          listed = probed.models.map((model) => model.id);
        } catch {
          // A key that cannot list models may still answer; the test below is
          // the verdict that counts.
          listed = [];
        }
      }
      setProbing(false);
      const verdict = await onUse(
        { label: kind === 'anthropic' ? SCRIPT.brain.key.anthropic : SCRIPT.brain.key.openai, kind, auth: 'api-key', baseUrl: '', defaultModel, enabled: true, secret: value },
        kind === 'anthropic' ? SCRIPT.brain.key.anthropic : SCRIPT.brain.key.openai,
      );
      if (!verdict || verdict.state === 'connected') return;
      if (keyRefused(verdict)) {
        setRefused(true);
        setModels([]);
        return;
      }
      // A limit or a model this key cannot use: the key may be fine, so the
      // list stays open with the model that was tried.
      setModels(listed.includes(defaultModel) || listed.length === 0 ? listed : [defaultModel, ...listed]);
      setPicked(defaultModel);
    })();
  };
  return (
    <>
      {working ? (
        <Buddi>
          <Thinking line={SCRIPT.brain.checking.key} />
        </Buddi>
      ) : refused ? (
        <Buddi>
          <Said>{SCRIPT.brain.key.refused}</Said>
        </Buddi>
      ) : problem ? (
        <Buddi>
          <Said>{problem}</Said>
        </Buddi>
      ) : null}
      <Ask
        actions={
          <>
            <Back onClick={onBack} disabled={working} />
            <Button variant="accent" size="lg" disabled={working || secret.trim() === ''} onClick={submit}>
              {picking ? SCRIPT.brain.model.retry : SCRIPT.brain.key.submit}
            </Button>
          </>
        }
      >
        <Field label={SCRIPT.brain.key.field} grow>
          <input
            ref={field}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={SCRIPT.brain.key.placeholder}
            value={secret}
            onChange={(event) => {
              setSecret(event.target.value);
              // Another key is another list.
              setModels([]);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </Field>
        {picking ? <ModelSelect models={models} picked={picked} disabled={working} onPick={setPicked} /> : null}
        <button
          type="button"
          className="wiz-link"
          onClick={() => setOverride(kind === 'anthropic' ? 'openai' : 'anthropic')}
        >
          {kind === 'anthropic' ? SCRIPT.brain.key.anthropic : SCRIPT.brain.key.openai} · {SCRIPT.brain.key.which}
        </button>
      </Ask>
    </>
  );
}
/**
 * Gemini, with a Google AI key: one field. The address is fixed and comes
 * from the gateway; the model is the newest Pro the key can reach, read from
 * Google's own list before anything is saved. A free key has no Pro
 * allowance, so a refused Pro is tried once more on the newest Flash; when
 * that fails too, the key stays and the list is offered to pick from.
 */
function GeminiCard({
  busy,
  problem,
  preset,
  onBack,
  onUse,
}: {
  busy: boolean;
  problem: string | null;
  preset: { baseUrl: string; keyUrl: string };
  onBack: () => void;
  onUse: Adopt;
}): JSX.Element {
  const field = useOpened<HTMLInputElement>();
  const [secret, setSecret] = useState('');
  const [probing, setProbing] = useState(false);
  /** Google's list for this key, once read; the picker after a refusal offers it. */
  const [models, setModels] = useState<string[]>([]);
  const [picked, setPicked] = useState('');
  const working = busy || probing;
  const picking = problem !== null && models.length > 0;
  const submit = (): void => {
    const value = secret.trim();
    if (value === '' || working) return;
    setProbing(true);
    void (async () => {
      let defaultModel = GEMINI_FALLBACK_MODEL;
      let flash: string | undefined;
      if (picking && picked !== '') {
        // The owner chose from the list: that model, and no second guess.
        defaultModel = picked;
      } else {
        try {
          const probed = await api.probeModels({ kind: 'openai-compatible', auth: 'api-key', baseUrl: preset.baseUrl, secret: value });
          const ids = probed.models.map((model) => model.id);
          defaultModel = pickGeminiModel(ids) ?? defaultModel;
          flash = isGeminiPro(defaultModel) ? pickGeminiFlash(ids) : undefined;
          setModels(geminiBrains(ids));
          setPicked(flash ?? defaultModel);
        } catch {
          // A key that cannot list may still answer; the test after the save decides.
        }
      }
      setProbing(false);
      await onUse(
        {
          label: SCRIPT.brain.gemini.label,
          kind: 'openai-compatible',
          auth: 'api-key',
          baseUrl: preset.baseUrl,
          defaultModel,
          enabled: true,
          secret: value,
        },
        SCRIPT.brain.gemini.label,
        flash,
      );
    })();
  };
  return (
    <>
      {working ? (
        <Buddi>
          <Thinking line={SCRIPT.brain.checking.gemini} />
        </Buddi>
      ) : problem ? (
        <Buddi>
          <Said>{problem}</Said>
        </Buddi>
      ) : null}
      <Ask
        actions={
          <>
            <Back onClick={onBack} disabled={working} />
            <Button variant="accent" size="lg" disabled={working || secret.trim() === ''} onClick={submit}>
              {SCRIPT.brain.gemini.submit}
            </Button>
          </>
        }
      >
        <Field label={SCRIPT.brain.gemini.field} grow>
          <input
            ref={field}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={SCRIPT.brain.gemini.placeholder}
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
        {picking ? (
          <Field label={SCRIPT.brain.model.label} grow>
            <select value={picked} disabled={working} onChange={(event) => setPicked(event.target.value)}>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <a className="wiz-link" href={preset.keyUrl} target="_blank" rel="noreferrer">
          {SCRIPT.brain.gemini.get}
        </a>
      </Ask>
    </>
  );
}
/**
 * What the "On this computer" card says: what answered here, Ollama, mlxh,
 * both or neither. Still looking until both probes have answered once.
 */
function localFound(ollama: OllamaProbe | null, mlxh: MlxhProbe | null): string {
  if (ollama === null || mlxh === null) return SCRIPT.brain.local.looking;
  if (!ollama.running && !mlxh.running) return SCRIPT.brain.local.missing;
  return SCRIPT.brain.local.found({
    ...(ollama.running ? { ollama: ollama.models.length } : {}),
    ...(mlxh.running ? { mlxh: mlxh.models.length } : {}),
  });
}

/** How often a model fetch is asked about while it runs. */
export const OLLAMA_PULL_POLL_MS = 1_000;

/** "Copy" beside a command the owner runs himself: buddi never runs it. */
function Command({ command }: { command: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="rs-cmd">
      <code className="rs-cmd-text">{command}</code>
      <Button size="sm" onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => {})}>
        {copied ? SCRIPT.brain.ollama.copied : SCRIPT.brain.ollama.copy}
      </Button>
    </div>
  );
}

const gb = (bytes: number): string => (bytes / 1e9).toFixed(1);

/**
 * On this computer: Ollama, mlxh, or both. Ollama asks which model when it
 * has several; mlxh starts on its first language model (a loaded one when
 * there is one), and "Think with another" offers the rest after.
 *
 * When Ollama is not ready, the card walks the owner there with no key at
 * all: the install command shown (never run), then the model this machine's
 * memory suits fetched with progress, then the account made and tried. Ollama
 * Cloud stays one tap away for a machine that would be slow.
 */
function LocalCard({
  busy,
  problem,
  probe,
  mlxh,
  onBack,
  onOffer,
  onUse,
  onCloud,
}: {
  busy: boolean;
  problem: string | null;
  probe: OllamaProbe | null;
  mlxh: MlxhProbe | null;
  onBack: () => void;
  onOffer: Offer;
  onUse: Adopt;
  onCloud: () => void;
}): JSX.Element {
  const models = probe?.models ?? [];
  const mlxhModel = firstMlxhModel(mlxh);
  const machine = probe?.machine;
  const [pull, setPull] = useState<OllamaPull | null>(null);
  const [pullProblem, setPullProblem] = useState<string | null>(null);
  /** The model fetched here, adopted once: a poll that sees "done" twice must not save two accounts. */
  const adopted = useRef<string | null>(null);
  const shownPull = pull ?? probe?.pull ?? null;
  const pulling = shownPull?.state === 'pulling';

  const make = (model: string): Parameters<typeof api.saveProviderAccount>[0] => ({
    label: SCRIPT.brain.ollama.label,
    kind: 'openai-compatible',
    auth: 'none',
    // The address comes from the probe, not from here: this page names no
    // host, and the machine Ollama answers on is the gateway's.
    baseUrl: probe?.baseUrl ?? '',
    defaultModel: model,
    enabled: true,
  });

  // While a fetch runs, ask how it stands; once it is done, make the account.
  useEffect(() => {
    if (!pulling) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.ollamaPullState().then(
        (answer) => {
          if (!cancelled && answer.pull) setPull(answer.pull);
        },
        () => {},
      );
    }, OLLAMA_PULL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pulling]);
  useEffect(() => {
    if (pull?.state !== 'done' || !probe || adopted.current === pull.model) return;
    adopted.current = pull.model;
    void onUse(make(pull.model), SCRIPT.brain.ollama.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pull?.state, pull?.model, probe]);

  const fetchModel = (model: string): void => {
    setPullProblem(null);
    adopted.current = null;
    void api.ollamaPull(model).then(
      (answer) => setPull(answer.pull),
      (err: unknown) => setPullProblem(err instanceof ApiError ? err.message : String(err)),
    );
  };

  const useMlxh = (): void => {
    if (!mlxh?.running || !mlxhModel) return;
    void onUse(
      {
        label: SCRIPT.brain.mlxh.label,
        kind: 'openai-compatible',
        // mlxh takes any key, so the account holds none.
        auth: 'none',
        // From the probe: this page names no address, not even a local one.
        baseUrl: mlxh.baseUrl,
        defaultModel: mlxhModel,
        enabled: true,
      },
      SCRIPT.brain.mlxh.label,
    );
  };
  const nothing = probe !== null && mlxh !== null && !probe.running && !mlxh.running;
  const use = (): void => {
    if (!probe) return;
    // Several models pulled and no "the" one: the owner is asked which. One,
    // and there is nothing worth asking.
    onOffer(models, make, SCRIPT.brain.ollama.label);
  };

  const where = machine?.platform === 'darwin' ? 'this Mac' : 'this computer';
  /** Ollama answered with no model, or is not here: the walk to a first model. */
  const empty = probe?.running === true && models.length === 0;
  const walk = machine !== undefined && !mlxh?.running && (empty || nothing || pulling);
  const why: 'memory' | 'gpu' | null = machine?.cloudSuggested ? (machine.memoryGb < 7 ? 'memory' : 'gpu') : null;
  const cloud = machine ? (
    <div className="wiz-foot">
      {SCRIPT.brain.ollama.cloud(why, machine.memoryGb)}{' '}
      <button type="button" className="wiz-link" onClick={onCloud}>
        {SCRIPT.brain.ollama.useCloud}
      </button>
    </div>
  ) : null;

  let steps: ReactNode = null;
  if (walk && machine) {
    const failed = shownPull?.state === 'failed' ? shownPull : null;
    if (pulling && shownPull) {
      const share = shownPull.total > 0 ? shownPull.completed / shownPull.total : 0;
      steps = (
        <div className="wiz-stack">
          <div className="wiz-busy" data-boxed="true">
            <span className="wiz-pulse" aria-hidden="true"><i /><i /><i /></span>
            <span>{SCRIPT.brain.ollama.fetching(shownPull.model, gb(shownPull.completed), shownPull.total > 0 ? gb(shownPull.total) : '')}</span>
            <span className="wiz-busy-side">{Math.round(share * 100)}%</span>
          </div>
          <Progress value={share * 100} label={SCRIPT.brain.ollama.fetch(shownPull.model)} />
          <div className="wiz-foot">{SCRIPT.brain.ollama.fetchingFoot}</div>
        </div>
      );
    } else if (empty) {
      const model = failed?.model ?? machine.recommended.model;
      steps = (
        <div className="wiz-stack">
          <Buddi>
            <Said>
              {failed
                ? SCRIPT.brain.ollama.failed(failed.error ?? '')
                : SCRIPT.brain.ollama.empty(where, machine.memoryGb, machine.recommended.model, machine.recommended.sizeGb)}
            </Said>
          </Buddi>
          {pullProblem ? <Notice tone="critical">{pullProblem}</Notice> : null}
          <Toolbar>
            <span className="wiz-foot">{SCRIPT.brain.ollama.emptyFoot(where)}</span>
            <Spacer />
            <Button variant="accent" size="lg" disabled={busy} onClick={() => fetchModel(model)}>
              {failed ? SCRIPT.brain.ollama.again : SCRIPT.brain.ollama.fetch(model)}
            </Button>
          </Toolbar>
          {cloud}
        </div>
      );
    } else if (machine.installed) {
      steps = (
        <div className="wiz-stack">
          <Buddi>
            <Said>{SCRIPT.brain.ollama.stopped(machine.platform)}</Said>
          </Buddi>
          {machine.platform === 'linux' ? <Command command="ollama serve" /> : null}
          {cloud}
        </div>
      );
    } else {
      steps = (
        <div className="wiz-stack">
          <Buddi>
            <Said>{SCRIPT.brain.ollama.missing(where)}</Said>
          </Buddi>
          {machine.install.command ? <Command command={machine.install.command} /> : null}
          <Toolbar>
            <span className="wiz-foot">{SCRIPT.brain.ollama.missingHow(machine.platform, where)}</span>
            <Spacer />
            {machine.platform === 'linux' ? null : (
              <ButtonLink size="lg" href={machine.install.url} target="_blank" rel="noreferrer">
                {SCRIPT.brain.ollama.download}
              </ButtonLink>
            )}
          </Toolbar>
          {cloud}
        </div>
      );
    }
  }

  return (
    <>
      {busy ? (
        <Buddi>
          <Thinking line={SCRIPT.brain.checking.ollama} />
        </Buddi>
      ) : problem ? (
        <Buddi>
          <Said>{problem}</Said>
        </Buddi>
      ) : null}
      {steps}
      <Ask
        actions={
          <>
            <Back onClick={onBack} disabled={busy} />
            {probe?.running && models.length > 0 ? (
              <Button variant={mlxh?.running ? undefined : 'accent'} size="lg" disabled={busy} onClick={use}>
                {SCRIPT.brain.ollama.connect}
              </Button>
            ) : null}
            {mlxh?.running ? (
              <Button variant="accent" size="lg" disabled={busy || !mlxhModel} onClick={useMlxh}>
                {SCRIPT.brain.mlxh.connect}
              </Button>
            ) : null}
            {nothing && probe && !machine ? (
              <ButtonLink variant="accent" size="lg" href={probe.downloadUrl} target="_blank" rel="noreferrer">
                {SCRIPT.brain.ollama.download}
              </ButtonLink>
            ) : null}
          </>
        }
      >
        {walk ? null : (
          <span className="wiz-foot">
            {localFound(probe, mlxh)}
            {mlxh?.running && !mlxhModel ? ` ${SCRIPT.brain.mlxh.noBrain}` : ''}
            {nothing && mlxh?.baseUrl ? ` ${mlxhNotAnswering(mlxh.baseUrl)}` : ''}
          </span>
        )}
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
  onTrial,
  onUse,
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
  onTrial: Trial;
  onUse: Adopt;
}): JSX.Element {
  const field = useOpened<HTMLInputElement>();
  const [address, setAddress] = useState(offered);
  const [secret, setSecret] = useState('');
  /** Asking the service for its models, before the save and the test start. */
  const [probing, setProbing] = useState(false);
  /** The service's list, offered in the card when the test failed for something other than the key. */
  const [models, setModels] = useState<string[]>([]);
  const [picked, setPicked] = useState('');
  /** The test said 401/403: the key itself, not the model. */
  const [refused, setRefused] = useState(false);
  const working = busy || probing;
  const picking = !refused && problem !== null && models.length > 0;
  const submit = (): void => {
    if (address.trim() === '' || working) return;
    setProbing(true);
    setRefused(false);
    void (async () => {
      const auth = secret.trim() ? ('api-key' as const) : ('none' as const);
      const make = (defaultModel: string): Parameters<typeof api.saveProviderAccount>[0] => ({
        label: SCRIPT.brain.service.label,
        kind: 'openai-compatible',
        auth,
        baseUrl: address.trim(),
        defaultModel,
        enabled: true,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      });
      /** A failed test: the key refused closes the list, anything else keeps it open on `tried`. */
      const settle = (verdict: ConnectionVerdict | null, listed: string[], tried: string): void => {
        if (!verdict || verdict.state === 'connected') return;
        if (keyRefused(verdict)) {
          setRefused(true);
          setModels([]);
          return;
        }
        setModels(listed);
        setPicked(tried);
      };
      if (auth === 'api-key' && picking && picked !== '') {
        // The owner chose from the list after a limit or a missing model.
        setProbing(false);
        settle(await onUse(make(picked), SCRIPT.brain.service.label), models, picked);
        return;
      }
      let listed: string[] = [];
      let flagged: string | undefined;
      try {
        const probed = await api.probeModels({
          kind: 'openai-compatible',
          auth,
          baseUrl: address.trim(),
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        });
        listed = probed.models.map((model) => model.id);
        flagged = probed.models.find((model) => model.isDefault)?.id;
      } catch {
        /* Said below by the save or the test, in its own words. */
      }
      setProbing(false);
      // A service that names its own default has answered the question; one
      // that offers thirty has not, and buddi asks rather than guessing.
      const candidates = flagged ? [flagged] : listed;
      if (auth === 'none') {
        onOffer(candidates, make, SCRIPT.brain.service.label);
        return;
      }
      // A key: some services list their models without one (Ollama Cloud
      // does), so the list proves nothing. One small call on the first model
      // decides before the picker is offered.
      const first = candidates[0] ?? '';
      if (candidates.length <= 1) {
        settle(await onUse(make(first), SCRIPT.brain.service.label), listed, first);
        return;
      }
      const verdict = await onTrial(make(first));
      if (verdict?.state === 'connected') onOffer(candidates, make, SCRIPT.brain.service.label);
      else settle(verdict, listed, first);
    })();
  };
  return (
    <>
      {working ? (
        <Buddi>
          <Thinking line={SCRIPT.brain.checking.service} />
        </Buddi>
      ) : refused ? (
        <Buddi>
          <Said>{SCRIPT.brain.key.refused}</Said>
        </Buddi>
      ) : problem ? (
        <Buddi>
          <Said>{problem}</Said>
        </Buddi>
      ) : null}
      <Ask
        actions={
          <>
            <Back onClick={onBack} disabled={working} />
            <Button variant="accent" size="lg" disabled={working || address.trim() === ''} onClick={submit}>
              {picking ? SCRIPT.brain.model.retry : SCRIPT.brain.service.submit}
            </Button>
          </>
        }
      >
        <Field label={SCRIPT.brain.service.address} grow>
          <input
            ref={field}
            value={address}
            placeholder={SCRIPT.brain.service.addressPlaceholder}
            onChange={(event) => {
              setAddress(event.target.value);
              setModels([]);
            }}
          />
        </Field>
        <Field label={SCRIPT.brain.service.key}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(event) => {
              setSecret(event.target.value);
              setModels([]);
            }}
          />
        </Field>
        {picking ? <ModelSelect models={models} picked={picked} disabled={working} onPick={setPicked} /> : null}
      </Ask>
    </>
  );
}
/** How often the one-tap card asks whether Connect was pressed. */
export const OLLAMA_POLL_MS = 2_000;

/**
 * Ollama Cloud, one tap: buddi makes a key, the owner presses Connect on
 * ollama.com, and the card notices. No key is typed or shown.
 *
 * The window was opened by the tap on the card; it is pointed at the connect
 * page as soon as the server names it. The link stays for a browser that
 * refused the window anyway.
 */
function OllamaCloudCard({
  busy,
  consent,
  onBack,
  onConnected,
  accounts,
}: {
  busy: boolean;
  consent: Window | null;
  onBack: () => void;
  onConnected: (brain: BrainAnswer) => Promise<string | null>;
} & QuestionProps): JSX.Element {
  const [working, setWorking] = useState(true);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ id: string; attemptId: string; url: string } | null>(null);
  const [round, setRound] = useState(0);
  const started = useRef(-1);
  /** The window a "Try again" tap opened, for the same reason the card's tap opens one. */
  const retried = useRef<Window | null>(null);
  const label = SCRIPT.brain.cloud.label;

  // Start once per round: the account (reused when there is one), then the key.
  useEffect(() => {
    if (started.current === round) return;
    started.current = round;
    setWorking(true);
    setTrouble(null);
    const opened = round === 0 ? consent : retried.current;
    void (async () => {
      try {
        const existing = (accounts?.accounts ?? []).find((account) => account.auth === 'device-key');
        const saved = existing
          ? { id: existing.id }
          : await api.saveProviderAccount({
              label,
              kind: 'openai-compatible',
              auth: 'device-key',
              // The server pins the address; this page names no outside host.
              baseUrl: '',
              defaultModel: OLLAMA_CLOUD_MODEL,
              enabled: true,
            });
        const row = (await api.providerAccounts()).accounts.find((account) => account.id === saved.id)!;
        const connect = await api.ollamaConnect(row.id, row.revision);
        setAttempt({ id: row.id, attemptId: connect.attemptId, url: connect.verificationUrl });
        if (opened) opened.location.href = connect.verificationUrl;
      } catch (err) {
        opened?.close();
        setTrouble(err instanceof ApiError ? err.message : String(err));
      } finally {
        setWorking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);

  // Ask every two seconds until ollama.com says who the key belongs to.
  useEffect(() => {
    if (!attempt) return undefined;
    let stopped = false;
    let asking = false;
    const ask = async (): Promise<void> => {
      if (stopped || asking) return;
      asking = true;
      try {
        const answer = await api.ollamaPoll(attempt.id, attempt.attemptId);
        if (stopped) return;
        if (answer.state === 'waiting') return;
        stopped = true;
        setAttempt(null);
        if (answer.state === 'failed') {
          setTrouble(answer.message);
          return;
        }
        setWorking(true);
        setTrouble(await adopt(attempt.id));
        setWorking(false);
      } catch {
        /* Not answering for a moment; ask again on the next tick. */
      } finally {
        asking = false;
      }
    };
    const timer = window.setInterval(() => void ask(), OLLAMA_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  /** Connected: settle on a model ollama.com offers, try it once, and move the assistant onto it. */
  const adopt = async (id: string): Promise<string | null> => {
    try {
      const offered = (await api.accountModels(id).catch(() => ({ models: [] as Array<{ id: string }> }))).models.map((model) => model.id);
      const model = offered.length === 0 || offered.includes(OLLAMA_CLOUD_MODEL) ? OLLAMA_CLOUD_MODEL : offered[0]!;
      const row = (await api.providerAccounts()).accounts.find((account) => account.id === id);
      if (row && row.defaultModel !== model) {
        await api.saveProviderAccount({
          id: row.id, revision: row.revision, label: row.label, kind: row.kind, auth: row.auth,
          baseUrl: row.baseUrl, defaultModel: model, enabled: row.enabled,
        });
      }
      const verdict = await api.testProviderAccount(id);
      if (verdict.state !== 'connected') return verdict.message;
      return await onConnected({ accountId: id, label, model });
    } catch (err) {
      return err instanceof ApiError ? err.message : String(err);
    }
  };

  return (
    <>
      {working || busy ? (
        <Buddi>
          <Thinking line={SCRIPT.brain.checking.cloud} />
        </Buddi>
      ) : trouble ? (
        <Buddi>
          <Said>{trouble}</Said>
        </Buddi>
      ) : attempt ? (
        <Buddi>
          <Said>{SCRIPT.brain.cloud.waiting}</Said>
        </Buddi>
      ) : null}
      <Ask
        actions={
          <>
            <Back onClick={onBack} disabled={working || busy} />
            {attempt ? (
              <ButtonLink variant="accent" size="lg" href={attempt.url} target="_blank" rel="noreferrer">
                {SCRIPT.brain.cloud.open}
              </ButtonLink>
            ) : trouble ? (
              <Button variant="accent" size="lg" disabled={working || busy} onClick={() => {
                retried.current = typeof window.open === 'function' ? window.open('', '_blank') : null;
                setRound((n) => n + 1);
              }}>
                {SCRIPT.brain.cloud.again}
              </Button>
            ) : null}
          </>
        }
      />
    </>
  );
}

/**
 * The model list under "That works", for the one-tap Ollama Cloud brain: its
 * free tier serves several, and the first one chosen for the owner is only a
 * start.
 */
function CloudModels({ answers, accounts, onKept, onTrouble }: QuestionProps): JSX.Element | null {
  const brain = answers.brain;
  const account = brain ? (accounts?.accounts ?? []).find((row) => row.id === brain.accountId) : undefined;
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // Ollama Cloud, ChatGPT and Gemini all serve several models, and the first
  // one chosen for the owner is only a start.
  const mlxhAccount = isMlxhAccount(account);
  const cloud = account?.auth === 'device-key' || account?.kind === 'codex' || mlxhAccount || (!!account && isGeminiAccount(account, accounts?.gemini?.baseUrl));
  useEffect(() => {
    if (!cloud || !account) return;
    let cancelled = false;
    api
      .accountModels(account.id)
      .then((listed) => {
        // mlxh lists its image models too; they are not brains.
        const brains = mlxhAccount
          ? listed.models.filter((model) => !isMlxhImageModel({ id: model.id, loaded: false, ...(model.image ? { kind: 'image' as const } : {}) }))
          : listed.models;
        if (!cancelled) setModels(brains.map((model) => model.id));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cloud, account?.id]);
  if (!cloud || !account || !brain || models.length < 2) return null;
  const choose = (model: string): void => {
    if (model === brain.model || saving) return;
    setSaving(true);
    onTrouble(null);
    void (async () => {
      try {
        // The account's default is what a new assistant is made with; the
        // binding is what an existing one answers on. Both move together.
        await api.saveProviderAccount({
          id: account.id, revision: account.revision, label: account.label, kind: account.kind, auth: account.auth,
          baseUrl: account.baseUrl, defaultModel: model, enabled: account.enabled,
        });
        if (answers.assistant) await api.bindBrain({ accountId: account.id, model });
        // The owner's own pick: the free-tier line no longer applies.
        onKept({ ...answers, brain: { accountId: brain.accountId, label: brain.label, model } });
      } catch (err) {
        onTrouble(err instanceof ApiError ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    })();
  };
  // In the thread, under the sentence it changes: the dock belongs to the
  // question being answered now.
  return (
    <Said>
      <Field label={SCRIPT.brain.model.change}>
        <select value={brain.model} disabled={saving} onChange={(event) => choose(event.target.value)}>
          {(models.includes(brain.model) ? models : [brain.model, ...models]).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Field>
    </Said>
  );
}
/** The model a new ChatGPT account starts on until the plan's list names its own default. */
export const CHATGPT_FALLBACK_MODEL = 'gpt-5.5';

/** How often the ChatGPT card asks whether the code was entered. */
export const CHATGPT_POLL_MS = 2_000;

type ChatGPTLogin = NonNullable<NonNullable<ProviderAccountsView['accounts'][number]['login']>>;

/**
 * ChatGPT, through buddi's own device sign-in: buddi shows a code, the owner
 * enters it on openai.com and approves, and the card notices.
 *
 * The window was opened by the tap on the card and follows the sign-in page as
 * soon as the server names it; the link stays for a browser that refused the
 * window. Leaving the card while the code is still out cancels the sign-in.
 */
function ChatGPTCard({
  busy,
  consent,
  onBack,
  onConnected,
  accounts,
}: {
  busy: boolean;
  consent: Window | null;
  onBack: () => void;
  onConnected: (brain: BrainAnswer) => Promise<string | null>;
} & QuestionProps): JSX.Element {
  const [working, setWorking] = useState(true);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ id: string; revision: number; url: string; code: string } | null>(null);
  /** The openai.com page is open (the button, or Try again's tab): the bubble waits rather than instructs. */
  const [opened, setOpened] = useState(false);
  /** Approved: who signed in, while the plan's model is being settled. */
  const [signedIn, setSignedIn] = useState<string | null | undefined>(undefined);
  const [round, setRound] = useState(0);
  const started = useRef(-1);
  /** The window a "Try again" tap opened, for the same reason the card's tap opens one. */
  const retried = useRef<Window | null>(null);
  /** The sign-in still waiting for its code, to cancel if the owner leaves. */
  const pending = useRef<{ id: string; revision: number } | null>(null);
  const label = SCRIPT.brain.chatgpt.label;

  useEffect(
    () => () => {
      const open = pending.current;
      pending.current = null;
      if (open) void api.codexAccountAction(open.id, 'cancel-login', open.revision).catch(() => {});
    },
    [],
  );

  // Start once per round: the account (reused when there is one), then the sign-in.
  useEffect(() => {
    if (started.current === round) return;
    started.current = round;
    setWorking(true);
    setTrouble(null);
    const opened = round === 0 ? consent : retried.current;
    void (async () => {
      try {
        const existing = (accounts?.accounts ?? []).find((account) => account.kind === 'codex');
        const saved = existing
          ? { id: existing.id }
          : await api.saveProviderAccount({
              label,
              kind: 'codex',
              auth: 'chatgpt',
              // The server pins the address; this page names no outside host.
              baseUrl: '',
              defaultModel: CHATGPT_FALLBACK_MODEL,
              enabled: true,
            });
        const row = (await api.providerAccounts()).accounts.find((account) => account.id === saved.id)!;
        const login = (await api.codexAccountAction(row.id, 'login', row.revision)) as ChatGPTLogin | undefined;
        if (!login?.verificationUrl || !login.userCode) throw new Error(login?.message ?? SCRIPT.brain.chatgpt.failed);
        pending.current = { id: row.id, revision: row.revision };
        setAttempt({ id: row.id, revision: row.revision, url: login.verificationUrl, code: login.userCode });
        setOpened(Boolean(opened));
        if (opened) opened.location.href = login.verificationUrl;
      } catch (err) {
        opened?.close();
        setTrouble(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
      } finally {
        setWorking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);

  // Ask every two seconds until the server says the code was approved.
  useEffect(() => {
    if (!attempt) return undefined;
    let stopped = false;
    let asking = false;
    const ask = async (): Promise<void> => {
      if (stopped || asking) return;
      asking = true;
      try {
        const row = (await api.providerAccounts()).accounts.find((account) => account.id === attempt.id);
        if (stopped) return;
        const login = row?.login;
        if (!login || login.state === 'pending') return;
        stopped = true;
        pending.current = null;
        setAttempt(null);
        if (login.state !== 'connected') {
          setTrouble(login.message ?? SCRIPT.brain.chatgpt.failed);
          return;
        }
        setSignedIn(login.account ?? null);
        setWorking(true);
        setTrouble(await adopt(attempt.id));
        setWorking(false);
        setSignedIn(undefined);
      } catch {
        /* Not answering for a moment; ask again on the next tick. */
      } finally {
        asking = false;
      }
    };
    const timer = window.setInterval(() => void ask(), CHATGPT_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  /**
   * Connected: settle on the plan's own default model, and move the assistant
   * onto it. There is no connection test for a ChatGPT plan (it has no
   * per-turn cap to keep a test small); the assistant's first answer is the test.
   */
  const adopt = async (id: string): Promise<string | null> => {
    try {
      const offered = (await api.accountModels(id).catch(() => ({ models: [] as Array<{ id: string; isDefault: boolean }> }))).models;
      const model = offered.find((entry) => entry.isDefault)?.id ?? offered[0]?.id ?? CHATGPT_FALLBACK_MODEL;
      const row = (await api.providerAccounts()).accounts.find((account) => account.id === id);
      if (row && row.defaultModel !== model) {
        await api.saveProviderAccount({
          id: row.id, revision: row.revision, label: row.label, kind: row.kind, auth: row.auth,
          baseUrl: row.baseUrl, defaultModel: model, enabled: row.enabled,
        });
      }
      return await onConnected({ accountId: id, label, model });
    } catch (err) {
      return err instanceof ApiError ? err.message : String(err);
    }
  };

  const leave = (): void => {
    const open = pending.current;
    pending.current = null;
    if (open) void api.codexAccountAction(open.id, 'cancel-login', open.revision).catch(() => {});
    onBack();
  };

  return (
    <>
      {signedIn !== undefined ? (
        <Buddi>
          <Said>{SCRIPT.brain.chatgpt.signedIn(signedIn)}</Said>
          <Thinking line={SCRIPT.brain.checking.chatgpt} />
        </Buddi>
      ) : working || busy ? (
        <Buddi>
          <Thinking line={SCRIPT.brain.checking.chatgpt} />
        </Buddi>
      ) : trouble ? (
        <Buddi>
          <Said>{trouble}</Said>
        </Buddi>
      ) : attempt ? (
        <Buddi>
          {opened ? <Thinking line={SCRIPT.brain.chatgpt.waiting} /> : <Said>{SCRIPT.brain.chatgpt.instruct}</Said>}
        </Buddi>
      ) : null}
      <Ask
        actions={
          <>
            <Back onClick={leave} disabled={working || busy} />
            {attempt ? (
              <ButtonLink variant="accent" size="lg" href={attempt.url} target="_blank" rel="noreferrer" onClick={() => setOpened(true)}>
                {SCRIPT.brain.chatgpt.open}
              </ButtonLink>
            ) : trouble ? (
              <Button variant="accent" size="lg" disabled={working || busy} onClick={() => {
                retried.current = typeof window.open === 'function' ? window.open('', '_blank') : null;
                setRound((n) => n + 1);
              }}>
                {SCRIPT.brain.chatgpt.again}
              </Button>
            ) : null}
          </>
        }
      >
        {attempt ? <SignInCode code={attempt.code} label={SCRIPT.brain.chatgpt.code} large /> : null}
      </Ask>
    </>
  );
}
/** The Claude model a new account starts on when the catalogue names no default. */
export const CLAUDE_FALLBACK_MODEL = 'claude-sonnet-5';

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
  claudeModel,
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
  /** The sign-in still waiting for its code, to cancel if the owner leaves. */
  const pending = useRef<{ id: string; revision: number } | null>(null);
  useEffect(
    () => () => {
      const open = pending.current;
      pending.current = null;
      if (open) void api.anthropicAccountAction(open.id, 'cancel-login', open.revision).catch(() => {});
    },
    [],
  );
  const leave = (): void => {
    const open = pending.current;
    pending.current = null;
    if (open) void api.anthropicAccountAction(open.id, 'cancel-login', open.revision).catch(() => {});
    onBack();
  };
  // The catalogue's default for a new Claude account, as the server's model
  // list names it; the constant only when it named none. The model list after
  // the sign-in is where it changes.
  const model = claudeModel ?? CLAUDE_FALLBACK_MODEL;

  const start = (): void => {
    setWorking(true);
    setTrouble(null);
    // Opened here, inside the click, so no popup blocker stops it; it is
    // pointed at the consent page the moment the server names it. The button
    // below stays for a browser that refused the window anyway.
    const consent = typeof window.open === 'function' ? window.open('', '_blank') : null;
    void (async () => {
      try {
        const existing = (accounts?.accounts ?? []).find((account) => account.auth === 'anthropic-oauth');
        const saved = existing
          ? { id: existing.id }
          : await api.saveProviderAccount({
              label: SCRIPT.brain.claude.label,
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
        pending.current = { id: row.id, revision: row.revision + 1 };
        setAttempt({
          id: row.id,
          revision: row.revision + 1,
          url: login.verificationUrl ?? '',
          attemptId: login.attemptId ?? '',
        });
        if (consent && login.verificationUrl) consent.location.href = login.verificationUrl;
        else consent?.close();
      } catch (err) {
        consent?.close();
        setTrouble(err instanceof ApiError ? err.message : String(err));
      } finally {
        setWorking(false);
      }
    })();
  };

  const finish = (): void => {
    if (!attempt || code.trim() === '') return;
    // Finishing is not leaving: the attempt is spent either way.
    pending.current = null;
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
        setTrouble(await onConnected({ accountId: attempt.id, label: SCRIPT.brain.claude.label, model }));
      } catch (err) {
        setTrouble(err instanceof ApiError ? err.message : String(err));
      } finally {
        setWorking(false);
      }
    })();
  };

  return (
    <>
      {working || busy ? (
        <Buddi>
          <Thinking line={SCRIPT.brain.checking.claude} />
        </Buddi>
      ) : problem ?? trouble ? (
        <Buddi>
          <Said>{problem ?? trouble}</Said>
        </Buddi>
      ) : null}
      {attempt ? (
        <>
          <Buddi>
            <Said>{SCRIPT.brain.claude.waiting}</Said>
          </Buddi>
          <Ask
            actions={
              <>
                <Back onClick={leave} disabled={working} />
                <ButtonLink size="lg" href={attempt.url} target="_blank" rel="noreferrer">
                  {SCRIPT.brain.claude.open}
                </ButtonLink>
                <Button variant="accent" size="lg" disabled={working || code.trim() === ''} onClick={finish}>
                  {SCRIPT.brain.claude.finish}
                </Button>
              </>
            }
          >
            <Field label={SCRIPT.brain.claude.paste} grow>
              <ClaudeCode value={code} onChange={setCode} />
            </Field>
          </Ask>
        </>
      ) : (
        <Ask
          actions={
            <>
              <Back onClick={leave} disabled={busy || working} />
              <Button variant="accent" size="lg" disabled={busy || working} onClick={start}>
                {SCRIPT.brain.claude.start}
              </Button>
            </>
          }
        />
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
 * 3. What I take on
 * ------------------------------------------------------------------ */

const TILE_ICON: Record<TakeOnTile, IconName> = {
  days: 'calendar',
  mail: 'mail',
  money: 'money',
  voice: 'bulb',
  code: 'monitor',
  pictures: 'files',
};

/**
 * The progress line: what is being fetched and how far along, what is in, or
 * what did not come — one line, never a gate.
 */
function progressLine(progress: TakeOnView | null): { line: string; done: boolean } | null {
  const plugins = progress?.plugins ?? [];
  if (plugins.length === 0) return null;
  const titles = plugins.map((p) => p.title);
  const failed = plugins.filter((p) => p.state === 'failed');
  if (progress?.running) {
    const ready = plugins.filter((p) => p.state === 'ready' || p.state === 'failed').length;
    return { line: SCRIPT.takeOn.fetching(titles, Math.min(ready + 1, plugins.length), plugins.length), done: false };
  }
  if (failed.length > 0) {
    return { line: failed.map((p) => SCRIPT.takeOn.failed(p.title, p.reason ?? '')).join(' '), done: true };
  }
  return { line: SCRIPT.takeOn.ready(titles), done: true };
}

function TakeOnChapter({ answers, progress, offers, onProgress, onSettled, onBack, onTrouble }: QuestionProps): JSX.Element {
  // Only the tiles the gateway offers: one whose plugin withbuddi.com does not list would only fail to install.
  const shown = offers ? TAKE_ON.filter((tile) => offers.includes(tile.id)) : TAKE_ON;
  const [tiles, setTiles] = useState<string[]>(() => answers.takeOn ?? [...TAKE_ON_DEFAULT]);
  const [sending, setSending] = useState(false);
  const picked = shown.filter((tile) => tiles.includes(tile.id));
  const toggle = (id: string): void => setTiles((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));
  /*
   * Recorded, and the installs started behind the answer: the route answers
   * at once, and chapter 4 opens while withbuddi.com is still being asked.
   */
  const send = (list: string[]): void => {
    if (sending) return;
    setSending(true);
    Promise.resolve()
      .then(() => api.takeOn(list))
      .then(() => {
        onProgress();
        onSettled({ ...answers, takeOn: list });
      })
      .catch((err: unknown) => onTrouble(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setSending(false));
  };
  const line = progressLine(progress);
  return (
    <>
      <Title>{SCRIPT.takeOn.title}</Title>
      <Buddi>
        <Said>{SCRIPT.takeOn.ask}</Said>
      </Buddi>
      <Ask
        actions={
          <>
            <Back onClick={onBack} disabled={sending} />
            <Button variant="ghost" size="lg" disabled={sending} onClick={() => send([])}>
              {SCRIPT.takeOn.none}
            </Button>
            <Primary onClick={() => send(picked.map((t) => t.id))} disabled={sending || picked.length === 0}>
              {SCRIPT.takeOn.submit}
            </Primary>
          </>
        }
      >
        <div className="wiz-grid" data-cols="3" role="group" aria-label={SCRIPT.takeOn.title}>
          {shown.map((tile) => {
            const on = tiles.includes(tile.id);
            return (
              <button key={tile.id} type="button" className="wiz-opt" data-tile="true" aria-pressed={on} onClick={() => toggle(tile.id)}>
                <span className="wiz-tile-top">
                  <span className="wiz-glyph" aria-hidden="true">
                    <Icon name={TILE_ICON[tile.id]} />
                  </span>
                  <span className="wiz-tick" aria-hidden="true">
                    {on ? <Icon name="check" size={12} /> : null}
                  </span>
                </span>
                <span>
                  <span className="wiz-opt-title">{tile.title}</span>
                  <span className="wiz-opt-plugins">{tile.plugins}</span>
                </span>
                <span className="wiz-opt-line">{tile.line}</span>
              </button>
            );
          })}
        </div>
        {picked.length > 0 ? (
          <div className="wiz-stack">
            {line ? (
              <div className="wiz-busy" data-boxed="true" role="status">
                <span className="wiz-pulse" data-done={line.done ? 'true' : undefined} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{line.line}</span>
                {tiles.includes('mail') ? <span className="wiz-busy-side">{SCRIPT.takeOn.builtIn}</span> : null}
              </div>
            ) : null}
            <div className="wiz-foot">{picked.map((tile) => tile.note).join(' ')}</div>
          </div>
        ) : (
          <div className="wiz-foot">{SCRIPT.takeOn.nothing}</div>
        )}
      </Ask>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 4. Reach me
 * ------------------------------------------------------------------ */

function ReachChapter({ answers, progress, onSettled, onBack }: QuestionProps): JSX.Element {
  const [phone, setPhone] = useState(answers.reach?.phone === true);
  const [mailbox, setMailbox] = useState(answers.reach?.mailbox === true);
  const [app, setApp] = useState(answers.reach?.app === true);
  const [browser, setBrowser] = useState<BrowserAnswer | undefined>(answers.browser);
  const taken = answers.takeOn ?? [];
  const mailWanted = taken.includes('mail');
  const submit = (): void => {
    const reach: OnboardingReach = { phone, mailbox, app, browser: browser === 'chrome' || browser === 'chromium' || browser === 'installed' };
    // The browser keeps its own step, as it always had: never a gate.
    if (browser !== undefined) void Promise.resolve().then(() => api.onboardingStep('browser')).catch(() => {});
    onSettled({ ...answers, reach, ...(browser !== undefined ? { browser } : {}) });
  };
  return (
    <>
      <Title>{SCRIPT.reach.title}</Title>
      <Buddi>
        <Said>{SCRIPT.reach.ask}</Said>
      </Buddi>
      <Ask
        actions={
          <>
            <Back onClick={onBack} />
            <Primary onClick={submit}>{SCRIPT.reach.submit}</Primary>
          </>
        }
      >
        <div className="wiz-rows">
          <PhoneRow paired={phone} owner={answers.name} onPaired={() => setPhone(true)} />
          <MailboxRow wanted={mailWanted} added={mailbox} onAdded={setMailbox} />
          {taken.includes('days') ? <CalendarRow progress={progress} /> : null}
          {taken.includes('money') ? <BankRow /> : null}
          <AppRow app={app} onApp={() => setApp(true)} browser={browser} onBrowser={setBrowser} />
          {phone ? (
            <Notice tone="good" role="status">
              {SCRIPT.reach.phone.hello}
            </Notice>
          ) : null}
        </div>
      </Ask>
    </>
  );
}

/**
 * The phone: already paired, or a sheet — the square from the bot that is
 * running, or the BotFather token first when there is no bot yet.
 */
function PhoneRow({ paired, owner, onPaired }: { paired: boolean; owner: string | undefined; onPaired: () => void }): JSX.Element {
  const [status, setStatus] = useState<{ configured: boolean; running: boolean; paired: boolean } | null>(null);
  const [sheet, setSheet] = useState(false);
  const done = useRef(onPaired);
  done.current = onPaired;
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.telegram())
      .then((view) => {
        if (cancelled || !view) return;
        setStatus(view);
        if (view.paired) done.current();
      })
      .catch(() => {
        if (!cancelled) setStatus({ configured: false, running: false, paired: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const ready = status?.configured === true && status.running === true;
  return (
    <div className="wiz-row">
      <span className="wiz-glyph" aria-hidden="true">
        <Icon name="chat" />
      </span>
      <span className="wiz-row-text">
        <span className="wiz-opt-title">{SCRIPT.reach.phone.title}</span>
        <span className="wiz-opt-line">{SCRIPT.reach.phone.line}</span>
      </span>
      <span className="wiz-row-side">
        {paired ? (
          <Pill tone="good" dot>
            {SCRIPT.reach.phone.paired}
          </Pill>
        ) : (
          <Button size="lg" disabled={status === null} onClick={() => setSheet(true)}>
            {ready ? SCRIPT.reach.phone.pair : SCRIPT.reach.phone.setUp}
          </Button>
        )}
      </span>
      {sheet ? (
        <Sheet title={SCRIPT.telegram.sheet} onClose={() => setSheet(false)}>
          <TelegramCard
            ready={ready}
            owner={owner}
            onPaired={onPaired}
            onDismiss={() => setSheet(false)}
          />
        </Sheet>
      ) : null}
    </div>
  );
}

/**
 * A mailbox: first run's own small sheet (provider, then only what that
 * provider needs), writing through the email plugin's `email.add_account` —
 * the full Mail settings stay on their page — and whether one is there now.
 */
function MailboxRow({
  wanted,
  added,
  onAdded,
}: {
  wanted: boolean;
  added: boolean;
  onAdded: (yes: boolean) => void;
}): JSX.Element {
  // Whether the email plugin is here at all: its settings page is how it says so.
  const ready = usePluginHere('email');
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    void Promise.resolve()
      .then(() => api.pageQuery<{ accounts?: Array<{ address?: string }> }>('email', 'accounts'))
      .then((answer) => {
        const first = answer?.data?.accounts?.[0]?.address ?? null;
        setAddress(first);
        onAdded(first !== null);
      })
      .catch(() => {});
    // `onAdded` is the chapter's setter; stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="wiz-row">
      <span className="wiz-glyph" data-tone="mail" aria-hidden="true">
        <Icon name="mail" />
      </span>
      <span className="wiz-row-text">
        <span className="wiz-opt-title">{wanted ? SCRIPT.reach.mailbox.forTriage : SCRIPT.reach.mailbox.title}</span>
        <span className="wiz-opt-line">{ready === false ? SCRIPT.reach.mailbox.unavailable : SCRIPT.reach.mailbox.line}</span>
      </span>
      <span className="wiz-row-side">
        {added || address ? (
          <Pill tone="good" dot mono={address !== null}>
            {address ?? SCRIPT.reach.mailbox.added}
          </Pill>
        ) : ready ? (
          <Button size="lg" onClick={() => setOpen(true)}>
            {SCRIPT.reach.mailbox.add}
          </Button>
        ) : null}
      </span>
      {open ? (
        <MailboxSheet
          onClose={() => setOpen(false)}
          onAdded={(next) => {
            setAddress(next);
            onAdded(true);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Is a plugin installed here, by whether it serves a settings page. Chapter 3
 * may still be fetching it when chapter 4 opens, so it is asked again as the
 * installs move on (`progress` changes). `undefined` until the first answer.
 */
function usePluginHere(plugin: string, progress?: TakeOnView | null): boolean | undefined {
  const [here, setHere] = useState<boolean | undefined>(undefined);
  const moved = progress?.plugins.map((p) => `${p.title}:${p.state}`).join(',') ?? '';
  useEffect(() => {
    if (here) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.pages())
      .then((view) => {
        if (!cancelled) setHere((view?.pages ?? []).some((p) => p.plugin === plugin && p.id === 'settings'));
      })
      .catch(() => {
        if (!cancelled) setHere(false);
      });
    return () => {
      cancelled = true;
    };
    // Asked once, then again only when the installs moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, moved]);
  return here;
}

/**
 * The calendar from chapter 3's My days: its private link, or Google's
 * sign-in, in first run's own sheet. Settings → Calendar keeps the rest.
 */
function CalendarRow({ progress }: { progress: TakeOnView | null }): JSX.Element {
  const ready = usePluginHere('calendar', progress);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CalendarRowState | null>(null);
  const [linked, setLinked] = useState(false);
  // The plugin's own reads: its accounts (`settings`) and a sign-in under way
  // (`sign_in`), asked again when the sheet closes and every two seconds while
  // Google is still answering.
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    void Promise.all([
      api.pageQuery<CalendarAccountsView>('calendar', 'settings').then((answer) => answer?.data ?? {}),
      api.pageQuery<{ waiting?: boolean }>('calendar', 'sign_in').then((answer) => answer?.data ?? {}).catch(() => ({})),
    ])
      .then(([settings, signIn]) => {
        if (!cancelled) setState(calendarRowState(settings, signIn));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ready, round, open]);
  useEffect(() => {
    if (state?.kind !== 'waiting') return undefined;
    const timer = window.setTimeout(() => setRound((n) => n + 1), SIGN_IN_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [state, round]);
  const shown: CalendarRowState | null = state ?? (linked ? { kind: 'linked', tone: 'good', label: SCRIPT.reach.calendar.linked } : null);
  const done = shown !== null && shown.kind !== 'expired';
  return (
    <div className="wiz-row">
      <span className="wiz-glyph" data-tone="calendar" aria-hidden="true">
        <Icon name="calendar" />
      </span>
      <span className="wiz-row-text">
        <span className="wiz-opt-title">{SCRIPT.reach.calendar.title}</span>
        <span className="wiz-opt-line">{ready === false ? SCRIPT.reach.calendar.waiting : SCRIPT.reach.calendar.line}</span>
      </span>
      <span className="wiz-row-side">
        {shown !== null ? (
          <Pill tone={shown.tone} dot mono={shown.kind === 'google' || shown.kind === 'expired'}>
            {shown.label}
          </Pill>
        ) : null}
        {done ? null : (
          <Button size="lg" disabled={!ready} onClick={() => setOpen(true)}>
            {SCRIPT.reach.calendar.add}
          </Button>
        )}
      </span>
      {open ? (
        <CalendarSheet
          onClose={() => setOpen(false)}
          onLinked={() => {
            setLinked(true);
            setRound((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/** What chapter 4's calendar row reads from the calendar plugin's `settings`. */
interface CalendarAccountsView {
  calendars?: unknown[];
  accounts?: Array<{ kind?: string; username?: string; needsSignIn?: boolean }>;
}

export type CalendarRowState =
  | { kind: 'waiting' | 'linked'; tone: 'accent' | 'good'; label: string }
  | { kind: 'google'; tone: 'good'; label: string }
  | { kind: 'expired'; tone: 'warning'; label: string };

/**
 * The calendar row's pill, from the plugin's own answers: a Google account
 * signed in says whose, one Google stopped accepting says to sign in again, a
 * sign-in under way says it is waiting, a private link says linked. Nothing
 * linked yet: null, and the row offers Link a calendar.
 */
export function calendarRowState(settings: CalendarAccountsView, signIn: { waiting?: boolean }): CalendarRowState | null {
  const google = (settings.accounts ?? []).filter((a) => a.kind === 'google');
  const expired = google.filter((a) => a.needsSignIn === true);
  const live = google.filter((a) => a.needsSignIn !== true);
  if (signIn.waiting === true) return { kind: 'waiting', tone: 'accent', label: SCRIPT.reach.calendar.googleWaiting };
  if (live.length > 0) return { kind: 'google', tone: 'good', label: SCRIPT.reach.calendar.google(live.map((a) => a.username ?? '').filter(Boolean).join(', ') || 'signed in') };
  if (expired.length > 0) return { kind: 'expired', tone: 'warning', label: SCRIPT.reach.calendar.googleExpired(expired.map((a) => a.username ?? '').filter(Boolean).join(', ')) };
  if ((settings.calendars?.length ?? 0) > 0) return { kind: 'linked', tone: 'good', label: SCRIPT.reach.calendar.linked };
  return null;
}

/** The bank, from chapter 3's My money: what Finance needs, said once. */
function BankRow(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  return (
    <div className="wiz-row">
      <span className="wiz-glyph" data-tone="finance" aria-hidden="true">
        <Icon name="money" />
      </span>
      <span className="wiz-row-text">
        <span className="wiz-opt-title">{SCRIPT.reach.bank.title}</span>
        <span className="wiz-opt-line">{SCRIPT.reach.bank.line}</span>
      </span>
      <span className="wiz-row-side">
        {seen ? (
          <Pill dot>{SCRIPT.reach.bank.later}</Pill>
        ) : (
          <Button size="lg" onClick={() => setOpen(true)}>
            {SCRIPT.reach.bank.add}
          </Button>
        )}
      </span>
      {open ? <BankSheet onClose={() => setOpen(false)} onUnderstood={() => setSeen(true)} /> : null}
    </div>
  );
}

/**
 * The app and the browser: the browser's own install prompt when it offered
 * one, and the agents' browser — Chrome used, Chromium fetched — launched
 * once to be sure it opens.
 */
function AppRow({
  app,
  onApp,
  browser,
  onBrowser,
}: {
  app: boolean;
  onApp: () => void;
  browser: BrowserAnswer | undefined;
  onBrowser: (answer: BrowserAnswer) => void;
}): JSX.Element {
  // Inside buddi.app it is in the Dock already: no install advice, Start at Login and the extension instead.
  const inApp = inBuddiApp();
  const browserPrompt = useInstallPrompt();
  const prompt = inApp ? null : browserPrompt;
  const hint = typeof navigator === 'undefined' ? null : installHint(navigator.userAgent);
  const [engine, setEngine] = useState<'chrome' | 'chromium' | 'none' | 'other' | null>(null);
  const [phase, setPhase] = useState<'idle' | 'installing' | 'launching' | 'failed'>('idle');
  const [line, setLine] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [progress, setProgress] = useState<BrowserInstallProgress | undefined>(undefined);
  const started = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    Promise.resolve()
      .then(() => api.browser())
      .then((status) => {
        if (!alive.current) return;
        const own = status?.browser;
        if (!own) setEngine('other');
        else if (own.install?.state === 'running') {
          setEngine('none');
          started.current = true;
          setPhase('installing');
          void follow();
        } else setEngine(own.engine);
      })
      .catch(() => {
        if (alive.current) setEngine('other');
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fail = (why: string, run?: string): void => {
    if (!alive.current) return;
    started.current = false;
    setPhase('failed');
    setLine(why);
    setCommand(run ?? null);
  };
  /** Launch it once and close it: a browser that cannot start is not one the owner has. */
  const launch = async (found: 'chrome' | 'chromium'): Promise<void> => {
    setPhase('launching');
    let check: BrowserLaunchCheck;
    try {
      check = await api.browserCheck();
    } catch (err) {
      return fail(err instanceof ApiError ? err.message : String(err));
    }
    if (!alive.current) return;
    if (check.ok) {
      setPhase('idle');
      setEngine(found);
      onBrowser(started.current ? 'installed' : found);
      return;
    }
    fail(check.message, check.command);
  };
  const follow = async (): Promise<void> => {
    let status;
    try {
      status = await api.browser();
    } catch (err) {
      return fail(err instanceof ApiError ? err.message : String(err));
    }
    if (!alive.current) return;
    const own = status.browser;
    if (!own) return fail(SCRIPT.browser.failed(''));
    if (own.install?.state === 'running') {
      setPhase('installing');
      setProgress(own.install.progress);
      window.setTimeout(() => void follow(), 1000);
      return;
    }
    if (own.engine !== 'none') return launch(own.engine);
    return fail(own.install?.line ?? '');
  };
  const use = (): void => {
    setCommand(null);
    if (engine === 'chrome' || engine === 'chromium') {
      void launch(engine);
      return;
    }
    // Nothing here: fetch it, and follow the installer.
    started.current = true;
    setPhase('installing');
    setProgress(undefined);
    void Promise.resolve()
      .then(() => api.browserInstall())
      .then(() => {
        if (alive.current) window.setTimeout(() => void follow(), 1000);
      })
      .catch((err: unknown) => fail(err instanceof ApiError ? err.message : String(err)));
  };
  const done = browser === 'chrome' || browser === 'chromium' || browser === 'installed';
  const busy = phase === 'installing' || phase === 'launching';
  return (
    <div className="wiz-row" data-wrap={phase !== 'idle' ? 'true' : undefined}>
      <span className="wiz-glyph" data-tone="good" aria-hidden="true">
        <Icon name="globe" />
      </span>
      <span className="wiz-row-text">
        <span className="wiz-opt-title">{inApp ? SCRIPT.reach.app.inApp.title : SCRIPT.reach.app.title}</span>
        <span className="wiz-opt-line">{inApp ? SCRIPT.reach.app.inApp.line : SCRIPT.reach.app.line}</span>
      </span>
      <span className="wiz-row-side">
        {inApp ? (
          <ButtonLink size="lg" href={STORE_URL} target="_blank" rel="noreferrer">
            {SCRIPT.reach.app.inApp.extension}
          </ButtonLink>
        ) : app ? (
          <Pill tone="good" dot>
            {SCRIPT.reach.app.installed}
          </Pill>
        ) : prompt ? (
          <Button
            size="lg"
            onClick={() => {
              void prompt
                .prompt()
                .then(() => prompt.userChoice)
                .then((choice) => {
                  if (!choice || choice.outcome === 'accepted') onApp();
                })
                .catch(() => {});
            }}
          >
            {SCRIPT.reach.app.install}
          </Button>
        ) : null}
        {done ? (
          <Pill tone="good" dot>
            {SCRIPT.reach.app.ready(browser === 'chrome' ? 'chrome' : 'chromium')}
          </Pill>
        ) : engine === null || engine === 'other' ? null : (
          <Button size="lg" disabled={busy} onClick={use}>
            {busy
              ? SCRIPT.browser.installing
              : phase === 'failed'
                ? SCRIPT.browser.retry
                : engine === 'chrome'
                  ? SCRIPT.reach.app.chrome
                  : engine === 'chromium'
                    ? SCRIPT.reach.app.chromium
                    : SCRIPT.reach.app.fetch}
          </Button>
        )}
      </span>
      {!app && !prompt && hint ? <span className="wiz-row-note">{hint}</span> : null}
      {phase === 'installing' ? (
        <div className="wiz-row-more">
          <span className="wiz-opt-line">{SCRIPT.browser.needs}</span>
          <InstallProgress progress={progress} />
        </div>
      ) : phase === 'launching' ? (
        <div className="wiz-row-more">
          <Thinking line={SCRIPT.browser.launching} />
        </div>
      ) : phase === 'failed' ? (
        <div className="wiz-row-more">
          <span className="wiz-opt-line">{SCRIPT.browser.failed(line ?? '')}</span>
          {command ? <CommandBlock command={command} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 5. Your assistant
 * ------------------------------------------------------------------ */

function AssistantChapter({ answers, existing, navigate, onSettled, onTrouble, onReload, onBack }: QuestionProps): JSX.Element {
  const [name, setName] = useState(() => existing?.name ?? DEFAULT_ASSISTANT_NAME);
  /*
   * A colour is a Blob, uploaded as the assistant's picture. An assistant
   * that already wears a picture or an emoji keeps it unless the owner picks
   * a colour: which Blob it was is not something the roster says, and
   * guessing would overwrite it.
   */
  const [colour, setColour] = useState<ColourId | null>(() => (existing?.picture || existing?.avatar ? null : 'buddi'));
  /*
   * A new assistant starts from the script's persona. An existing one shows
   * its own, read from its file — never its card line, which saved back would
   * overwrite the persona with one sentence — and only an edit is sent.
   */
  const [initialPurpose, setInitialPurpose] = useState<string | null>(existing ? null : SCRIPT.assistant.purposeValue);
  const [purpose, setPurpose] = useState<string>(existing ? '' : SCRIPT.assistant.purposeValue);
  useEffect(() => {
    if (!existing) return undefined;
    let cancelled = false;
    api.firstAgentPersona().then(
      (read) => { if (!cancelled) { setInitialPurpose(read.persona); setPurpose(read.persona); } },
      (err: unknown) => { if (!cancelled) onTrouble(err instanceof ApiError ? err.message : String(err)); },
    );
    return () => { cancelled = true; };
    // Read once per assistant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id]);
  const [saving, setSaving] = useState(false);
  /*
   * The server said no for good (409 `assistant-exists`: there is an
   * assistant already). Said as
   * a notice with the way out, and the button stays down: pressing it again
   * would only hear the same no.
   */
  const [refused, setRefused] = useState<string | null>(null);
  const mates = TAKE_ON.filter((tile) => (answers.takeOn ?? []).includes(tile.id) && 'mate' in tile).map((tile) => (tile as { mate: string }).mate);
  const chosen = COLOURS.find((c) => c.id === colour);

  /*
   * Two ways to save one answer.
   *
   * The first time there is no agent and this writes one, bound to the account
   * chapter 2 just tested. Afterwards — the owner took up "change any of it" —
   * writing a *first* agent is refused, and rightly: there is one, and the
   * change belongs in its file. Same name, same face, same persona, one
   * assistant either way. The Blob is a picture, uploaded once the agent exists.
   */
  const submit = (): void => {
    if (name.trim() === '' || saving) return;
    setSaving(true);
    // The persona is the agent's instructions; the card line is the server's
    // plain one unless the owner wrote their own.
    const persona = !existing || (initialPurpose !== null && purpose.trim() !== '' && purpose.trim() !== initialPurpose.trim()) ? { instructions: purpose.trim() } : {};
    const written = existing
      ? api.updateFirstAgent({ name: name.trim(), ...persona })
      : api.createFirstAgent({
          name: name.trim(),
          handle: idFor(name),
          description: '',
          ...persona,
          ...(answers.brain ? { accountId: answers.brain.accountId } : {}),
        });
    void (async () => {
      let saved: { id: string };
      try {
        saved = await written;
      } catch (err) {
        // Only the existing-assistant refusal is final. A taken handle or a
        // model account this install cannot run on also answer 409, and those
        // are fixed here and sent again.
        if (err instanceof ApiError && err.status === 409 && (err.detail as { code?: unknown } | undefined)?.code === 'assistant-exists') {
          setRefused(err.message);
          onTrouble(null);
        } else {
          onTrouble(err instanceof ApiError ? err.message : String(err));
        }
        setSaving(false);
        return;
      }
      // The agent exists either way from here; a picture that did not take is
      // said, and the assistant keeps its fallback face.
      let pictureTrouble: string | null = null;
      try {
        if (chosen) await api.uploadAgentPicture(saved.id, await mascotFile(chosen.role));
      } catch (err) {
        pictureTrouble = err instanceof ApiError ? err.message : String(err);
      }
      setSaving(false);
      onReload();
      onSettled({ ...answers, assistant: { id: saved.id, name: name.trim(), avatar: chosen ? '' : existing?.avatar ?? '' } });
      if (pictureTrouble) onTrouble(pictureTrouble);
    })();
  };

  return (
    <>
      <Title>{SCRIPT.assistant.title}</Title>
      <Buddi>
        <Said>
          {SCRIPT.assistant.ask}
          {mates.length > 0 ? SCRIPT.assistant.team(mates) : ''}
        </Said>
      </Buddi>
      <Ask
        actions={
          <>
            <Back onClick={onBack} disabled={saving} />
            <Primary onClick={submit} disabled={saving || refused !== null || name.trim() === '' || initialPurpose === null}>
              {SCRIPT.assistant.submit}
            </Primary>
          </>
        }
      >
        <div className="wiz-meet">
          <div className="wiz-face">
            {/* The face is the assistant, so it is shown at the size of a face. */}
            <span className="wiz-face-tile" data-agent={chosen?.id ?? 'buddi'} aria-hidden="true">
              {chosen ? (
                <img src={mascotUrl(chosen.role)} alt="" />
              ) : existing?.picture ? (
                <img src={existing.picture} alt="" />
              ) : (
                <span className="wiz-face-emoji">{existing?.avatar ?? ''}</span>
              )}
            </span>
            <div className="wiz-swatches" role="group" aria-label={SCRIPT.assistant.colour}>
              {COLOURS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="wiz-swatch"
                  data-agent={c.id}
                  aria-label={SCRIPT.assistant.swatch(c.label)}
                  aria-pressed={colour === c.id}
                  onClick={() => setColour(c.id)}
                />
              ))}
            </div>
            <span className="wiz-face-cap">{SCRIPT.assistant.colour}</span>
          </div>
          <div className="wiz-stack">
            <Field label={SCRIPT.assistant.name}>
              <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label={SCRIPT.assistant.purpose} hint={SCRIPT.assistant.purposeHint}>
              <textarea className="wiz-persona" value={purpose} maxLength={8000} rows={7} onChange={(event) => setPurpose(event.target.value)} />
            </Field>
          </div>
        </div>
        {refused ? (
          <Notice
            tone="warm"
            role="status"
            title={SCRIPT.assistant.refusedTitle}
            action={
              <ButtonLink
                href={AGENTS_ROUTE}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(AGENTS_ROUTE);
                }}
              >
                {SCRIPT.assistant.toAgents}
              </ButtonLink>
            }
          >
            {refused}
          </Notice>
        ) : null}
      </Ask>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The handover
 * ------------------------------------------------------------------ */

/**
 * The assistant speaks first.
 *
 * The runtime has no way to start a turn without one: a run is something a
 * message causes. So the card sends one message the owner never sees — the
 * instruction from the script, which the server fronts with what exists (the
 * clock, the weather at home, the mailbox) — and does not render it.
 * Everything after it is an ordinary conversation, in the owner's history
 * like any other. Under the hello: four first questions, each sent as the
 * owner's first message, and one warm card with what is still waiting.
 */
function Handover({ answers, assistantAgent, met, onMet, navigate, onPickAnotherBrain, onSpoken, progress, onProgress }: QuestionProps): JSX.Element {
  const assistant = answers.assistant;
  const [conversationId, setConversationId] = useState<string | null>(met);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [silent, setSilent] = useState(false);
  /** The run is alive and slow, and the owner has been watching for a minute. */
  const [patient, setPatient] = useState(false);
  const [running, setRunning] = useState(true);
  const [asking, setAsking] = useState(false);
  const started = useRef(false);
  const agents = useMemo<ChatAgent[]>(() => (assistantAgent ? [assistantAgent] : []), [assistantAgent]);
  useEffect(() => {
    onProgress();
    // Once, for the waiting card; the progress keeps itself fresh while it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant?.id, met]);

  /*
   * The answer, when it comes. Polled: a run outlives any one page.
   *
   * Waiting is not the failure. A model on this computer takes a minute to
   * load, and a first message that looks up the owner's profile before it
   * writes takes several turns — a fixed deadline told the owner their
   * assistant was not answering while it was demonstrably working. So the
   * transcript's own runs decide: while one is open the card stays patient
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
   * this conversation, and "Open buddi" lands them in it with the rail around
   * it. Replaced rather than pushed, because first run is not a place to go
   * back to.
   */
  const carriesOn = assistant && conversationId ? chatRoute(assistant.id, conversationId) : null;
  const spoken = messages.some(isSpoken);
  useEffect(() => {
    if (spoken && carriesOn) onSpoken(carriesOn);
  }, [spoken, carriesOn, onSpoken]);

  const tiles = answers.takeOn ?? [];
  const starters = SCRIPT.handover.starters({ days: tiles.includes('days'), mail: tiles.includes('mail'), mailbox: answers.reach?.mailbox === true });
  // "Who do you want on your team?": catalogue teammates picked from what chapters 3 and 4 set up.
  const setUp = { days: tiles.includes('days'), mailbox: answers.reach?.mailbox === true, money: tiles.includes('money'), pictures: tiles.includes('pictures') };
  const waiting = progress?.waiting ?? [];
  /**
   * Into the shell. The rail read the plugin pages when this page loaded,
   * before chapter 3's installs finished: it reads them again on the way in.
   */
  const leave = (route: string): void => {
    announcePagesChanged();
    navigate(route, true);
  };
  /** A first question, sent as the owner's first message; the conversation carries on in the shell. */
  const ask = (text: string): void => {
    if (!assistant || !conversationId || asking) return;
    setAsking(true);
    void Promise.resolve()
      .then(() => chatApi.send(assistant.id, { conversationId, text }))
      .then(() => leave(chatRoute(assistant.id, conversationId)))
      .catch(() => setAsking(false));
  };

  return (
    <>
      <div className="wiz-hello">
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
          {...(assistant ? { agentId: assistant.id } : {})}
          emptyHint={SCRIPT.handover.waiting}
          plain
          workingLine={SCRIPT.handover.looking(assistant?.name ?? '')}
        />
      </div>

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
          <Ask actions={<Primary onClick={onPickAnotherBrain}>{SCRIPT.handover.again}</Primary>} />
        </>
      ) : null}

      {spoken ? (
        <div className="wiz-starters" role="group" aria-label={SCRIPT.handover.starterLabel}>
          {starters.map((text) => (
            <button key={text} type="button" className="wiz-starter" disabled={asking} onClick={() => ask(text)}>
              {text}
            </button>
          ))}
        </div>
      ) : null}

      {spoken ? <HandoverTeam setUp={setUp} navigate={leave} /> : null}

      {spoken ? <WakesAfterRestart plugins={progress?.plugins ?? []} /> : null}

      {spoken && waiting.length > 0 ? (
        <Notice
          tone="warm"
          title={SCRIPT.handover.waitingTitle(waiting.length)}
          action={
            <Button variant="accent" onClick={() => leave(HOME_ROUTE)}>
              {SCRIPT.handover.home}
            </Button>
          }
        >
          {SCRIPT.handover.waitingBody(waiting)}
        </Notice>
      ) : null}

      {spoken && carriesOn ? (
        <Ask
          actions={
            <ButtonLink
              variant="accent"
              size="lg"
              href={carriesOn}
              onClick={(event) => {
                event.preventDefault();
                leave(carriesOn);
              }}
            >
              {SCRIPT.done.open}
            </ButtonLink>
          }
        />
      ) : null}
    </>
  );
}

/** A command the owner runs themselves, in a block, with a way to copy it. */
function CommandBlock({ command }: { command: string }): JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = (): void => {
    if (!navigator.clipboard?.writeText) { setCopied('failed'); return; }
    void navigator.clipboard.writeText(command).then(() => setCopied('done'), () => setCopied('failed'));
  };
  return (
    <Stack gap="sm">
      <Code label="The command to run">{command}</Code>
      <Toolbar align="end">
        {copied === 'failed' ? <span className="ui-toolbar-note">Select it to copy.</span> : null}
        <Button size="sm" onClick={copy}>{copied === 'done' ? 'Copied' : 'Copy'}</Button>
      </Toolbar>
    </Stack>
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
 * There is already a buddi, and this one is meant to become it
 * ------------------------------------------------------------------ */

/** Idle, being asked for, or under way. */
export type RestoreState = 'idle' | 'form' | 'running';

/**
 * Restoring, offered in chapter 1 and never after it: "I have a backup" under
 * the map opens this sheet. Almost nobody has a backup on the day they
 * install this, and the one person who does is looking for exactly those words.
 */
function RestoreForm({
  onCancel,
  onStarted,
  onTrouble,
}: {
  onCancel: () => void;
  onStarted: () => void;
  onTrouble: (message: string | null) => void;
}): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [sending, setSending] = useState(false);
  const send = (): void => {
    if (!file || sending) return;
    setSending(true);
    onTrouble(null);
    api
      .firstRunRestore(file, passphrase.trim())
      .then((answer) => {
        rememberRestore(answer.job.id);
        onStarted();
      })
      .catch((error: unknown) => onTrouble(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setSending(false));
  };
  return (
    <Sheet title={SCRIPT.restore.sheet} onClose={onCancel}>
      <div className="wiz-restore">
        <p className="wiz-foot">{SCRIPT.restore.lede}</p>
        <Field label={SCRIPT.restore.file}>
          <input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </Field>
        <Field label={SCRIPT.restore.passphrase} hint={SCRIPT.restore.passphraseHint}>
          <input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        </Field>
        <Toolbar align="end">
          <Button variant="ghost" onClick={onCancel}>
            {SCRIPT.restore.cancel}
          </Button>
          <Button variant="accent" disabled={sending || !file} onClick={send}>
            {SCRIPT.restore.submit}
          </Button>
        </Toolbar>
      </div>
    </Sheet>
  );
}

/**
 * A restore under way, said on the card in buddi's voice, phase by phase.
 *
 * The job outlives this page: halfway through, the gateway is stopped and
 * every request fails. A failed poll is therefore not news — only an answer
 * is — and the id that makes the answer findable is what the tab remembers.
 * Afterwards the wizard picks up at the brain: the one answer a backup can
 * never bring back, because it never carries a key.
 */
function RestoreRunning({ onDone, onFailed }: { onDone: (name: string | undefined) => void; onFailed: (message: string) => void }): JSX.Element {
  const [phases, setPhases] = useState<string[]>([]);
  const finish = useRef({ onDone, onFailed });
  finish.current = { onDone, onFailed };
  useEffect(() => {
    const jobId = rememberedRestore();
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
            void api.owner().then(
              (owner) => finish.current.onDone(owner.preferredName ?? undefined),
              () => finish.current.onDone(undefined),
            );
          } else if (job.phase === 'rolled-back' || job.phase === 'failed') {
            // Both are the end of this job. They differ in what is on disk
            // now, which is what the job's own error says, so it is preferred
            // over either standing sentence.
            stopped = true;
            rememberRestore(null);
            finish.current.onFailed(job.error ?? SCRIPT.restore.phases[job.phase]);
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
  }, []);
  const said = phases.filter((phase): phase is keyof typeof SCRIPT.restore.phases => phase in SCRIPT.restore.phases);
  return (
    <>
      <Title>{SCRIPT.restore.title}</Title>
      <Buddi>
        <Said>{SCRIPT.restore.started}</Said>
        {said.map((phase) => (
          <Said key={phase}>{SCRIPT.restore.phases[phase]}</Said>
        ))}
      </Buddi>
      <Thinking />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The phone, when there is no bot yet
 * ------------------------------------------------------------------ */

/**
 * Telegram, in chapter 4's sheet: the token from BotFather, then a square to
 * scan. "Not now" is always there: a row the owner opened by mistake has to
 * have a way back out of it. The pairing state is polled rather than assumed —
 * the sheet says the phone arrived when the phone says hello, and not before.
 * Its actions stay in the sheet: the wizard's dock belongs to the chapter.
 */
interface TelegramCardProps {
  /** A bot is configured and running: straight to the square, no token. */
  ready: boolean;
  /** The owner's first name, for "Paired with Amen's phone". */
  owner: string | undefined;
  onPaired: () => void;
  onDismiss: () => void;
}

function TelegramCard(props: TelegramCardProps): JSX.Element {
  return (
    <DockSlot.Provider value={null}>
      <div className="wiz-sheet-body">
        <TelegramSteps {...props} />
      </div>
    </DockSlot.Provider>
  );
}

/** How long "Paired with …" stays on screen before the sheet closes by itself. */
export const PAIRED_CLOSE_MS = 1_600;

function TelegramSteps({ ready, owner, onPaired, onDismiss }: TelegramCardProps): JSX.Element {
  const field = useOpened<HTMLInputElement>();
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [bot, setBot] = useState<string | null>(null);
  // First run asks whether any phone is paired: this is the first one.
  const { offer, square, paired, stale, ask } = useTelegramPairing(() => api.telegram().then((status) => status.paired), onPaired);
  const asked = useRef(false);
  // A running bot: its name for under the square, and a code at once.
  useEffect(() => {
    if (!ready || asked.current) return;
    asked.current = true;
    void Promise.resolve()
      .then(() => api.telegramBot())
      .then((view) => setBot(view?.username ?? null))
      .catch(() => {});
    void ask().catch((err: unknown) => setNote(err instanceof ApiError ? err.message : String(err)));
  }, [ready, ask]);
  // The phone said hello: say whose, a beat, then out of the way.
  const close = useRef(onDismiss);
  close.current = onDismiss;
  useEffect(() => {
    if (!paired) return undefined;
    const timer = window.setTimeout(() => close.current(), PAIRED_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [paired]);

  const save = (): void => {
    if (token.trim() === '' || saving) return;
    setSaving(true);
    setNote(null);
    void (async () => {
      try {
        const saved = await api.saveTelegramToken(token.trim());
        setToken('');
        setBot(saved.botUsername ?? null);
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

  if (offer) {
    return (
      <>
        <Buddi>
          <Said>{stale && !paired ? SCRIPT.telegram.expired : SCRIPT.telegram.scan}</Said>
        </Buddi>
        <Ask
          actions={
            paired ? (
              <Button variant="accent" onClick={onDismiss}>
                {SCRIPT.telegram.close}
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={onDismiss}>
                  {SCRIPT.telegram.notNow}
                </Button>
                {stale ? (
                  <Button variant="accent" onClick={again}>
                    {SCRIPT.telegram.newCode}
                  </Button>
                ) : null}
              </>
            )
          }
        >
          {stale && !paired ? null : (
            <PairingTile
              offer={offer}
              square={square}
              bot={bot}
              paired={paired}
              status={paired ? SCRIPT.telegram.pairedWith(owner) : SCRIPT.telegram.waiting}
            />
          )}
        </Ask>
      </>
    );
  }

  if (ready && !note) {
    return (
      <Buddi>
        <Thinking line={SCRIPT.telegram.making} />
      </Buddi>
    );
  }

  if (ready) {
    return (
      <>
        <Buddi>
          <Said>{note}</Said>
        </Buddi>
        <Ask
          actions={
            <>
              <Button variant="ghost" onClick={onDismiss}>
                {SCRIPT.telegram.notNow}
              </Button>
              <Button variant="accent" onClick={again}>
                {SCRIPT.telegram.newCode}
              </Button>
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <Buddi>
        <Said>{SCRIPT.telegram.how}</Said>
        {note ? <Said>{note}</Said> : null}
      </Buddi>
      <Ask
        actions={
          <>
            <Button variant="ghost" onClick={onDismiss}>
              {SCRIPT.telegram.notNow}
            </Button>
            <Button variant="accent" disabled={saving || token.trim() === ''} onClick={save}>
              {SCRIPT.telegram.submit}
            </Button>
          </>
        }
      >
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
      </Ask>
    </>
  );
}
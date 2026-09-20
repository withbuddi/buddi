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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  api,
  chatApi,
  type OllamaProbe,
  type PairingOffer,
  type ProviderAccountsView,
} from '../api';
import { Composer } from '../chat/Composer';
import { MessageList } from '../chat/MessageList';
import type { ChatAgent, ChatMessage } from '../chat/types';
import { HOME_ROUTE } from '../routes';
import { Avatar, Button, Field } from '../ui';
import {
  FACES,
  OPENING_INSTRUCTION,
  SCRIPT,
  SUGGESTED_NAMES,
} from './meet/script';
import {
  STEP_OF,
  answersFrom,
  firstOpen,
  idFor,
  keyKind,
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

/** How long the assistant has to say its first word before buddi says so. */
export const FIRST_MESSAGE_TIMEOUT_MS = 60_000;

/** How often the thread asks whether the answer has arrived. */
const POLL_MS = 1_500;

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

/** buddi's name and face, over a run of its bubbles. */
function Buddi({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="meet-turn">
      <div className="wb-msg-who">
        <Avatar id="buddi" name="buddi" size="sm" />
        <span>buddi</span>
      </div>
      {children}
    </div>
  );
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
  return <div className="meet-ask">{children}</div>;
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

  /** The zone this browser is in, which is what the question offers. */
  const browserZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
    } catch {
      return timezone;
    }
  }, [timezone]);

  /* ---- resume: replay what the server already knows ---- */
  const load = useCallback(async (): Promise<void> => {
    const [onboarding, owner, accountView, roster] = await Promise.all([
      api.onboarding().catch(() => undefined),
      api.owner().catch(() => undefined),
      api.providerAccounts().catch(() => undefined),
      chatApi.agents().catch(() => undefined),
    ]);
    setAccounts(accountView);
    setZones(owner?.zones ?? []);
    const own = roster?.agents.find((agent) => agent.id === roster.defaultAgentId) ?? roster?.agents[0];
    if (own) setAssistantAgent(own);
    const replayed = answersFrom({
      onboarding,
      owner,
      accounts: accountView,
      ...(own ? { assistant: { id: own.id, name: own.name, avatar: own.avatar?.kind === 'emoji' ? own.avatar.value : '' } } : {}),
    });
    setAnswers(replayed);
    setOpen((current) => current ?? firstOpen(replayed));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const record = (id: QuestionId): void => {
    void api.onboardingStep(STEP_OF[id]).catch(() => {});
  };

  /** One answer saved: keep it, record the step, move on. */
  const settle = (id: QuestionId, next: MeetAnswers): void => {
    setTrouble(null);
    setAnswers(next);
    record(id);
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

  const shown = open ? thread(answers, open) : [];

  return (
    <div className="meet">
      <div className="meet-column">
        <div className="meet-thread" data-testid="meet-thread">
          <Buddi>
            {SCRIPT.opening.map((line, at) => (
              <Said key={line} at={at}>
                {line}
              </Said>
            ))}
          </Buddi>

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
              onSettled={(next) => settle(id, next)}
              onChange={() => change(id)}
              onTrouble={setTrouble}
              onReload={() => void load()}
              onPickAnotherBrain={() => change('brain')}
            />
          ))}

          {trouble ? (
            <Buddi>
              <Said>{trouble}</Said>
            </Buddi>
          ) : null}
        </div>

        <footer className="meet-foot">
          <button className="meet-later" type="button" disabled={leaving} onClick={later}>
            {SCRIPT.later}
          </button>
        </footer>
      </div>
    </div>
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
        className="meet-input"
        aria-label={SCRIPT.name.placeholder}
        placeholder={SCRIPT.name.placeholder}
        maxLength={80}
        value={value}
        autoFocus
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

  /** Save the account, test it, and let buddi name the model it will think with. */
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
      const brain: BrainAnswer = { accountId: saved.id, label, model: body.defaultModel };
      onReload();
      onSettled({ ...answers, brain });
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (card === 'key') return <KeyCard busy={busy} problem={problem} onBack={() => setCard(null)} onUse={adopt} />;
  if (card === 'service') return <ServiceCard busy={busy} problem={problem} onBack={() => setCard(null)} onUse={adopt} />;
  if (card === 'ollama') {
    return <OllamaCard busy={busy} problem={problem} probe={ollama} onBack={() => setCard(null)} onUse={adopt} />;
  }
  if (card === 'claude') {
    return <ClaudeCard busy={busy} problem={problem} onBack={() => setCard(null)} {...props} />;
  }

  return (
    <div className="meet-cards" role="group" aria-label={SCRIPT.brain.ask}>
      {claudeOffered ? <BrainCard face="✦" card={SCRIPT.brain.cards.claude} onPick={() => setCard('claude')} /> : null}
      <BrainCard face="🔑" card={SCRIPT.brain.cards.key} onPick={() => setCard('key')} />
      <BrainCard
        face="🖥"
        card={SCRIPT.brain.cards.ollama}
        note={ollama === null ? SCRIPT.brain.ollama.looking : ollama.running ? SCRIPT.brain.ollama.found : SCRIPT.brain.ollama.missing}
        onPick={() => setCard('ollama')}
      />
      <BrainCard face="☁" card={SCRIPT.brain.cards.service} onPick={() => setCard('service')} />
    </div>
  );
}

function BrainCard({
  face,
  card,
  note,
  onPick,
}: {
  face: string;
  card: { title: string; line: string };
  note?: string;
  onPick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="meet-card" onClick={onPick}>
      <span className="meet-card-face" aria-hidden="true">
        {face}
      </span>
      <span className="meet-card-title">{card.title}</span>
      <span className="meet-card-line">{note ?? card.line}</span>
    </button>
  );
}

type Adopt = (body: Parameters<typeof api.saveProviderAccount>[0], label: string) => Promise<void>;

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
        defaultModel = probed.models.find((model) => model.isDefault)?.id ?? probed.models[0]?.id ?? defaultModel;
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
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={SCRIPT.brain.key.placeholder}
            value={secret}
            autoFocus
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
  onUse,
}: {
  busy: boolean;
  problem: string | null;
  probe: OllamaProbe | null;
  onBack: () => void;
  onUse: Adopt;
}): JSX.Element {
  const model = probe?.models[0] ?? '';
  const use = (): void => {
    void onUse(
      {
        label: SCRIPT.brain.cards.ollama.title,
        kind: 'openai-compatible',
        auth: 'none',
        baseUrl: 'http://localhost:11434/v1',
        defaultModel: model,
        enabled: true,
      },
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
          <Button variant="accent" disabled={busy || model === ''} onClick={use}>
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
  onBack,
  onUse,
}: {
  busy: boolean;
  problem: string | null;
  onBack: () => void;
  onUse: Adopt;
}): JSX.Element {
  const [address, setAddress] = useState('');
  const [secret, setSecret] = useState('');
  const submit = (): void => {
    if (address.trim() === '' || busy) return;
    void (async () => {
      let defaultModel = '';
      try {
        const probed = await api.probeModels({
          kind: 'openai-compatible',
          auth: secret.trim() ? 'api-key' : 'none',
          baseUrl: address.trim(),
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        });
        defaultModel = probed.models.find((model) => model.isDefault)?.id ?? probed.models[0]?.id ?? '';
      } catch {
        /* Said below by the save or the test, in its own words. */
      }
      await onUse(
        {
          label: SCRIPT.brain.cards.service.title,
          kind: 'openai-compatible',
          auth: secret.trim() ? 'api-key' : 'none',
          baseUrl: address.trim(),
          defaultModel,
          enabled: true,
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        },
        SCRIPT.brain.cards.service.title,
      );
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
            value={address}
            placeholder={SCRIPT.brain.service.addressPlaceholder}
            autoFocus
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
  answers,
  accounts,
  onSettled,
  onReload,
}: {
  busy: boolean;
  problem: string | null;
  onBack: () => void;
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
        onReload();
        onSettled({ ...answers, brain: { accountId: attempt.id, label: SCRIPT.brain.cards.claude.title, model } });
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
              <input type="password" autoComplete="off" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} />
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

/* ------------------------------------------------------------------ *
 * 4. The assistant
 * ------------------------------------------------------------------ */

function AssistantAsk({ answers, onSettled, onTrouble, onReload }: QuestionProps): JSX.Element {
  const [at] = useState(() => Math.floor(Math.random() * SUGGESTED_NAMES.length));
  const [name, setName] = useState(() => suggestedName(SUGGESTED_NAMES, at));
  const [face, setFace] = useState<string>(FACES[0]);
  const [purpose, setPurpose] = useState<string>(SCRIPT.assistant.purposeValue);
  const [saving, setSaving] = useState(false);

  const submit = (): void => {
    if (name.trim() === '' || saving) return;
    setSaving(true);
    api
      .createFirstAgent({
        name: name.trim(),
        handle: idFor(name),
        description: purpose.trim(),
        avatar: face,
        ...(answers.brain ? { accountId: answers.brain.accountId } : {}),
      })
      .then((created) => {
        onReload();
        onSettled({ ...answers, assistant: { id: created.id, name: name.trim(), avatar: face } });
      })
      .catch((err: unknown) => onTrouble(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <Ask>
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
function Handover({ answers, assistantAgent, onPickAnotherBrain }: QuestionProps): JSX.Element {
  const assistant = answers.assistant;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [silent, setSilent] = useState(false);
  const [running, setRunning] = useState(true);
  const [offers, setOffers] = useState<'open' | 'phone' | 'gone'>('open');
  const started = useRef(false);
  const agents = useMemo<ChatAgent[]>(() => (assistantAgent ? [assistantAgent] : []), [assistantAgent]);

  useEffect(() => {
    if (!assistant || started.current) return undefined;
    started.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const opened = await chatApi.startConversation(assistant.id);
        if (cancelled) return;
        setConversationId(opened.conversationId);
        await chatApi.send(assistant.id, { conversationId: opened.conversationId, text: OPENING_INSTRUCTION });
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
  }, [assistant?.id]);

  /* The answer, when it comes. Polled: a run outlives any one page. */
  useEffect(() => {
    if (!conversationId) return undefined;
    let cancelled = false;
    const read = (): void => {
      chatApi
        .conversation(conversationId)
        .then((transcript) => {
          if (cancelled) return;
          setMessages(transcript.messages);
          if (transcript.messages.some(isSpoken)) {
            setRunning(false);
            setSilent(false);
            void api.completeOnboarding().catch(() => {});
          }
        })
        .catch(() => {});
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    const deadline = window.setTimeout(() => {
      if (cancelled) return;
      setRunning(false);
      // Nothing said in a minute is the failure the script has words for; a
      // thread that has already spoken is simply idle.
      setMessages((current) => {
        if (!current.some(isSpoken)) setSilent(true);
        return current;
      });
    }, FIRST_MESSAGE_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(deadline);
    };
  }, [conversationId]);

  const send = (text: string): void => {
    if (!assistant || !conversationId) return;
    setRunning(true);
    void chatApi
      .send(assistant.id, { conversationId, text })
      .catch(() => setRunning(false));
  };

  const spoken = messages.filter((message) => !isOpeningInstruction(message));

  return (
    <>
      <MessageList
        messages={spoken}
        live={[]}
        now={Date.now()}
        onOpen={() => {}}
        working={running}
        agents={agents}
        agentName={assistant?.name ?? ''}
        emptyHint={SCRIPT.handover.waiting}
      />

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

      {messages.some(isSpoken) && offers !== 'gone' ? (
        <div className="wb-offers" data-testid="meet-offers">
          {offers === 'open' ? (
            <>
              <button type="button" className="ui-btn" onClick={() => setOffers('phone')}>
                {SCRIPT.offers.phone}
              </button>
              <button type="button" className="ui-btn" onClick={() => setOffers('gone')}>
                {SCRIPT.offers.notNow}
              </button>
            </>
          ) : (
            <TelegramCard />
          )}
        </div>
      ) : null}

      {assistant ? (
        <Composer
          disabled={!conversationId}
          running={running}
          onSend={(text) => send(text)}
          onStop={() => {
            if (conversationId) void chatApi.cancel(conversationId).catch(() => {});
          }}
          agentName={assistant.name}
        />
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

/** The turn the owner never wrote, and never sees. */
function isOpeningInstruction(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    (message.blocks ?? []).some((block) => block.type === 'text' && block.text.trim() === OPENING_INSTRUCTION)
  );
}

/* ------------------------------------------------------------------ *
 * The phone
 * ------------------------------------------------------------------ */

/**
 * Telegram, in the thread: the token from BotFather, then a square to scan.
 *
 * The pairing state is polled rather than assumed — the thread says the phone
 * arrived when the phone says hello, and not before.
 */
function TelegramCard(): JSX.Element {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [square, setSquare] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);

  const save = (): void => {
    if (token.trim() === '' || saving) return;
    setSaving(true);
    setNote(null);
    void (async () => {
      try {
        const saved = await api.saveTelegramToken(token.trim());
        setToken('');
        if (saved.restartNeeded) {
          setNote(SCRIPT.telegram.restart);
          return;
        }
        const pairing = await api.telegramPairing();
        setOffer(pairing);
        setSquare(await qrSvgDataUrl(pairing.link).catch(() => ''));
      } catch (err) {
        setNote(err instanceof ApiError ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    })();
  };

  useEffect(() => {
    if (!offer || paired) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      api
        .telegram()
        .then((status) => {
          if (!cancelled && status.paired) setPaired(true);
        })
        .catch(() => {});
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [offer, paired]);

  if (paired) {
    return (
      <Buddi>
        <Said>{SCRIPT.telegram.paired}</Said>
      </Buddi>
    );
  }

  if (offer) {
    return (
      <div className="meet-pair">
        <Buddi>
          <Said>{SCRIPT.telegram.scan}</Said>
        </Buddi>
        {square ? <img className="meet-qr" src={square} alt={offer.link} /> : null}
        <a className="meet-link" href={offer.link} target="_blank" rel="noreferrer">
          {offer.link}
        </a>
      </div>
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
        <Button variant="accent" disabled={saving || token.trim() === ''} onClick={save}>
          {SCRIPT.telegram.submit}
        </Button>
      </Ask>
    </>
  );
}

/**
 * The browser's owner moments as the kit draws them (buddi-design Browser.jsx,
 * `BrAsk`): one card at a time in the dock above the composer, the action on
 * it, nothing else.
 *
 * They arrive as ordinary questions (`ctx.ask` → `conversation.ask`), so every
 * surface already shows and answers them; this only recognises the five by
 * their labels and draws them the kit's way — Amazon needs your sign-in (Save
 * a login for next time · Use my Chrome · Take over), This page asks for a
 * human (Skip this site · Take over), I’m not sure that went through. Look?
 * (Carry on · Look), Keep going? (Stop here · Keep going), and while a Stop
 * holds, Browsing is paused (Keep paused · Resume). A tap answers with the
 * label, exactly as a tap on the plain question card would.
 */
import { useState } from 'react';
import { SECRETS_ADD_ROUTE } from '../routes';
import { Button, Spacer, Toolbar } from '../ui';
import { SecretRequestDock } from './SecretRequest';
import type { ChatQuestion, ChatQuestionOption, SecretRequestCard } from './types';

export type BrowserCardKind = 'signin' | 'human' | 'look' | 'budget' | 'paused';

export interface BrowserCard {
  kind: BrowserCardKind;
  title: string;
  line: string;
  /** "Save a login for next time": a link to Keys and secrets, not an answer. */
  saveLogin: ChatQuestionOption | null;
  /** The buttons, the recommended one last (on the right). */
  actions: ChatQuestionOption[];
}

const SAVE_LOGIN = 'Save a login for next time';
const QUIET = new Set(['Skip this site', 'Skip it', 'Keep paused', 'Leave it stopped']);
const CHROME = ['Use my Chrome', 'Use Chrome when it’s open', "Open Chrome and I'll use it there"];

/** Which of the five this question is, or null for any other question. */
export function browserCardOf(question: ChatQuestion | null | undefined): BrowserCard | null {
  if (!question || question.allowOther) return null;
  const labels = new Set(question.options.map((option) => option.label));
  const has = (...any: string[]) => any.some((label) => labels.has(label));
  const kind: BrowserCardKind | null =
    has('Look') && has('Carry on') ? 'look'
    : has('Keep going') && has('Stop here') ? 'budget'
    : has('Resume') && has('Keep paused', 'Leave it stopped') ? 'paused'
    : has('Take over') && has('Skip this site', 'Skip it') ? 'human'
    : has('Take over') && (has(SAVE_LOGIN, ...CHROME) || /sign-in|asks for a code/i.test(question.question)) ? 'signin'
    : null;
  if (!kind) return null;
  const [first, ...rest] = question.question.split('\n');
  // The kit's titles end without a full stop; an older gateway's question had one.
  const title = (first ?? '').trim().replace(/\.$/, '');
  const saveLogin = question.options.find((option) => option.label === SAVE_LOGIN) ?? null;
  const buttons = question.options.filter((option) => option.label !== SAVE_LOGIN);
  const actions = [...buttons.filter((option) => !option.recommended), ...buttons.filter((option) => option.recommended)];
  return { kind, title, line: rest.join(' ').trim(), saveLogin, actions };
}

export function BrowserAsk({ card, disabled, onAnswer, site, signIn }: {
  card: BrowserCard;
  disabled: boolean;
  onAnswer: (answer: string, optionId?: string) => void;
  /** The page's site, so Save a login opens with it filled in. */
  site?: string | undefined;
  /**
   * The sign-in card this browser card carries (docs/owner-secrets.md §6):
   * "Save a login for next time" opens it right here instead of a trip to
   * Settings, and it answers the card the way the agent's own does.
   */
  signIn?: { question: ChatQuestion; card: SecretRequestCard; phone: boolean; container: HTMLElement | null; onSettled: () => void } | undefined;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  if (expanded && signIn) {
    return <SecretRequestDock question={signIn.question} card={signIn.card} phone={signIn.phone} container={signIn.container} disabled={disabled} onSettled={signIn.onSettled} />;
  }
  const saveHref = `${SECRETS_ADD_ROUTE}${site ? `&site=${encodeURIComponent(site)}` : ''}`;
  return (
    <section className="wb-question br-ask" data-kind={card.kind} aria-label={card.kind === 'paused' ? 'Browsing is paused' : 'The agent needs you'} data-testid="browser-ask">
      <div className="br-ask-head">
        <span className="wb-question-kicker">{card.kind === 'paused' ? 'Paused' : 'Needs you'}</span>
        <strong>{card.title}</strong>
        {card.line ? <span className="br-ask-line">{card.line}</span> : null}
      </div>
      <div className="wb-dock-section">
        <Toolbar align="end">
          {card.saveLogin ? <>{signIn
            ? <button type="button" className="wb-link" aria-expanded={false} onClick={() => setExpanded(true)}>{card.saveLogin.label}</button>
            : <a className="wb-link" href={saveHref}>{card.saveLogin.label}</a>}<Spacer /></> : null}
          {card.actions.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={option.recommended ? 'accent' : QUIET.has(option.label) ? 'ghost' : undefined}
              disabled={disabled}
              title={option.hint ?? undefined}
              onClick={() => onAnswer(option.label, option.id)}
            >
              {option.label}
            </Button>
          ))}
        </Toolbar>
      </div>
    </section>
  );
}

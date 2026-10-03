/**
 * The composer's two popups: who `@` can name, and what `/` can run
 * (docs/dashboard.md, The composer).
 *
 * Both sit above the box at its width and never over the text being typed.
 * Each is a listbox the textarea points into with `aria-activedescendant`, so
 * focus never leaves the field: the arrows choose, Enter or Tab takes, Escape
 * closes. A pointer press is taken on mousedown so the field keeps its caret.
 */
import { Fragment, type CSSProperties } from 'react';
import { Avatar } from '../ui';
import type { CommandRow } from './commands';
import type { ChatAgent } from './types';

/** Someone `@` can name, and what naming them does. */
export interface Mentionable {
  id: string;
  handle: string;
  name: string;
  /** One sentence: "Borrows Agent Father for this message". */
  effect: string;
  /** The heading they are listed under: Borrow, Ask a teammate, In this room, Talk to. */
  group: string;
  accent: { 'data-agent': string; style?: CSSProperties };
  face?: ChatAgent;
}

export const optionId = (listId: string, index: number): string => `${listId}-opt-${index}`;

export function MentionPopup({ id, items, active, onPick, phone, maxHeight }: {
  id: string;
  items: readonly Mentionable[];
  active: number;
  onPick: (item: Mentionable) => void;
  phone: boolean;
  maxHeight?: number | undefined;
}): JSX.Element {
  // The groups say what a mention does; the row in focus says it once more, in full.
  let group: string | null = null;
  return (
    <div className="cv-pop" data-testid="mention-popup">
      <div className="cv-pop-list" id={id} role="listbox" aria-label="Mention someone" style={maxHeight ? { maxHeight } : undefined}>
        {items.map((m, i) => {
          const head = m.group !== group ? (group = m.group) : null;
          return (
            <Fragment key={m.id}>
              {head ? <div className="cv-pop-group" role="presentation">{head}</div> : null}
              <div
                id={optionId(id, i)}
                role="option"
                aria-selected={i === active}
                aria-label={`${m.name}, @${m.handle}. ${m.effect}`}
                className="cv-pop-row"
                data-mention="true"
                data-active={i === active || undefined}
                onMouseDown={(event) => { event.preventDefault(); onPick(m); }}
              >
                <Avatar id={m.id} name={m.name} size="sm" {...(m.face ? { face: m.face } : {})} />
                <span className="cv-pop-title">{m.name} <span className="cv-pop-handle">@{m.handle}</span></span>
                {i === active ? <span className="cv-pop-effect">{m.effect}</span> : null}
                {i === active && !phone ? <kbd className="cv-kbd">↵</kbd> : null}
              </div>
            </Fragment>
          );
        })}
      </div>
      {phone ? null : (
        <div className="cv-pop-foot" aria-hidden="true">
          <span><kbd className="cv-kbd">↑</kbd><kbd className="cv-kbd">↓</kbd> choose</span>
          <span><kbd className="cv-kbd">↵</kbd> or <kbd className="cv-kbd">Tab</kbd> mention</span>
          <span><kbd className="cv-kbd">Esc</kbd> close</span>
        </div>
      )}
    </div>
  );
}

export function CommandMenu({ id, items, active, onPick, phone, query, maxHeight }: {
  id: string;
  items: readonly CommandRow[];
  active: number;
  onPick: (row: CommandRow) => void;
  phone: boolean;
  query: string;
  maxHeight?: number | undefined;
}): JSX.Element {
  if (items.length === 0) {
    return (
      <div className="cv-pop" data-testid="command-menu">
        <div className="cv-pop-list" id={id} role="listbox" aria-label="Commands">
          <div className="cv-pop-empty" role="status">
            No command called <span className="mono">/{query}</span>. {phone ? 'Send sends it as text.' : 'Enter sends it as text.'}
          </div>
        </div>
      </div>
    );
  }
  let group: string | null = null;
  return (
    <div className="cv-pop" data-testid="command-menu">
      <div className="cv-pop-list" id={id} role="listbox" aria-label="Commands" style={maxHeight ? { maxHeight } : undefined}>
        {items.map((c, i) => {
          const head = c.group !== group ? (group = c.group) : null;
          return (
            <Fragment key={`${c.group}/${c.name}`}>
              {head ? <div className="cv-pop-group" role="presentation">{head}</div> : null}
              <div
                id={optionId(id, i)}
                role="option"
                aria-selected={i === active}
                aria-disabled={c.off || undefined}
                aria-label={`/${c.name}${c.args ? ` ${c.args}` : ''}: ${c.desc}`}
                className="cv-pop-row"
                data-cmd="true"
                data-active={i === active || undefined}
                data-off={c.off || undefined}
                onMouseDown={(event) => { event.preventDefault(); if (!c.off) onPick(c); }}
              >
                <span className="cv-pop-cmd">/{c.name}{c.args ? <span className="cv-pop-args"> {c.args}</span> : null}</span>
                <span className="cv-pop-desc">{c.desc}</span>
                {phone ? null : c.key ? <kbd className="cv-kbd">{c.key}</kbd> : i === active ? <kbd className="cv-kbd">↵</kbd> : null}
              </div>
            </Fragment>
          );
        })}
      </div>
      {phone ? null : (
        <div className="cv-pop-foot" aria-hidden="true">
          <span><kbd className="cv-kbd">↑</kbd><kbd className="cv-kbd">↓</kbd> choose</span>
          <span><kbd className="cv-kbd">↵</kbd> run</span>
          <span><kbd className="cv-kbd">Tab</kbd> add words</span>
          <span><kbd className="cv-kbd">Esc</kbd> close</span>
        </div>
      )}
    </div>
  );
}

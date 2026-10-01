/**
 * The `calendar` component: dated events as a week of hours, a month of days,
 * or a list of days, behind one switch — drawn from the design kit's Calendar
 * screen, with the kit's classes (`cal-*`, in `styles.css`) and the dashboard's
 * own primitives for everything else (Panel, List, ListRow, Segment, Button).
 *
 * `useCalendarState` holds where the owner is — the view and the day the range
 * is drawn around — so the page can ask the query for exactly those days;
 * `CalendarView` draws what came back. ←/→ move the range, T comes back to
 * today. The chosen view is kept per page in `localStorage`.
 */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Icon, List, ListRow, Panel, Segment } from '../ui';
import { useMediaQuery } from '../useMediaQuery';
import { fmtMonth } from '../format';
import {
  addDays,
  dayLabel,
  dayOfMonth,
  dayTitle,
  eventsOn,
  hm,
  lanesOf,
  MIN_DRAWN,
  move,
  rangeOf,
  rangeTitle,
  summaryOf,
  timeOf,
  weekdayName,
  type CalEvent,
  type CalendarView as View,
} from './calendar';

const VIEW_LABELS: Record<View, string> = { week: 'Week', month: 'Month', list: 'List' };
const ALL_VIEWS: View[] = ['week', 'month', 'list'];

/** Under this width a week of columns is too narrow to read: the list is the default. */
export const CALENDAR_NARROW_QUERY = '(max-width: 720px)';

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* a private window: the choice lasts as long as the page */
  }
}

export interface CalendarState {
  views: View[];
  view: View;
  setView: (view: View) => void;
  anchor: string;
  today: string;
  /** -1 back, 1 on, 0 today. */
  go: (dir: -1 | 0 | 1) => void;
  /** The first day shown, and how many. */
  from: string;
  days: number;
  /** The day after the last one shown: the query's `to`. */
  to: string;
  selected: string | null;
  select: (date: string | null) => void;
}

export function useCalendarState(opts: {
  views?: View[];
  default?: View;
  today: string;
  storageKey: string;
}): CalendarState {
  const views = opts.views && opts.views.length > 0 ? opts.views : ALL_VIEWS;
  const narrow = useMediaQuery(CALENDAR_NARROW_QUERY);
  const [chosen, setChosen] = useState<View | null>(() => {
    const stored = readStored(opts.storageKey);
    return stored !== null && (views as string[]).includes(stored) ? (stored as View) : null;
  });
  const fallback: View =
    narrow && views.includes('list') ? 'list' : opts.default && views.includes(opts.default) ? opts.default : (views[0] as View);
  const view = chosen ?? fallback;
  const [anchor, setAnchor] = useState(opts.today);
  const [selected, select] = useState<string | null>(null);
  const { from, days } = rangeOf(view, anchor);
  return {
    views,
    view,
    setView: (next) => {
      setChosen(next);
      writeStored(opts.storageKey, next);
      select(null);
    },
    anchor,
    today: opts.today,
    go: (dir) => {
      setAnchor(dir === 0 ? opts.today : move(view, anchor, dir));
      select(null);
    },
    from,
    days,
    to: addDays(from, days),
    selected,
    select,
  };
}

export function CalendarView({
  state,
  events,
  hours,
  empty,
  label,
}: {
  state: CalendarState;
  events: CalEvent[];
  hours?: [number, number] | undefined;
  /** The words for a day with nothing on it. */
  empty: string;
  /** The region's name for a screen reader: the component's title, or "Calendar". */
  label: string;
}): JSX.Element {
  const { view, anchor, today, from, days } = state;
  const dates = useMemo(() => Array.from({ length: days }, (_, i) => addDays(from, i)), [from, days]);
  const unit = view === 'month' ? 'month' : 'week';
  const monthSelected =
    state.selected ?? (anchor.slice(0, 7) === today.slice(0, 7) ? today : `${anchor.slice(0, 8)}01`);
  const shownDay = view === 'month' ? monthSelected : view === 'week' ? state.selected : null;
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') state.go(-1);
    else if (event.key === 'ArrowRight') state.go(1);
    else if (event.key === 't' || event.key === 'T') state.go(0);
    else return;
    event.preventDefault();
  };
  return (
    <div className="cal" role="region" aria-label={label} tabIndex={0} onKeyDown={onKey}>
      <div className="cal-bar">
        <Button size="sm" aria-label={`Previous ${unit}`} onClick={() => state.go(-1)}>
          <Icon name="chevron-left" size={14} />
        </Button>
        <Button size="sm" onClick={() => state.go(0)}>
          Today
        </Button>
        <Button size="sm" aria-label={`Next ${unit}`} onClick={() => state.go(1)}>
          <Icon name="chevron-right" size={14} />
        </Button>
        <h3 className="cal-title" aria-live="polite">
          {rangeTitle(view, anchor, from, days)}
        </h3>
        {state.views.length > 1 ? (
          <Segment
            label="View"
            options={state.views.map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
            value={view}
            onChange={state.setView}
          />
        ) : null}
      </div>
      {view === 'week' ? (
        <WeekGrid dates={dates} today={today} events={events} hours={hours ?? [7, 21]} onPick={state.select} />
      ) : null}
      {view === 'month' ? (
        <MonthGrid
          dates={dates}
          month={anchor.slice(0, 7)}
          today={today}
          events={events}
          selected={monthSelected}
          onPick={state.select}
        />
      ) : null}
      {view === 'list' ? (
        <div className="cal-list">
          {dates.map((date) => (
            <DayPanel key={date} date={date} today={today} events={events} empty={empty} />
          ))}
        </div>
      ) : null}
      {shownDay ? <DayPanel date={shownDay} today={today} events={events} empty={empty} /> : null}
    </div>
  );
}

function DayPanel({
  date,
  today,
  events,
  empty,
}: {
  date: string;
  today: string;
  events: CalEvent[];
  empty: string;
}): JSX.Element {
  const on = eventsOn(events, date);
  return (
    <Panel flush title={dayTitle(date, today)}>
      <List>
        {on.length === 0 ? (
          <ListRow title={<span className="muted">{empty}</span>} />
        ) : (
          on.map(({ event, part }) => (
            <ListRow
              key={event.id}
              lead={<span className="cal-dot" data-tone={event.tone} aria-hidden="true" />}
              title={event.title}
              sub={event.location || undefined}
              side={timeOf(event, part)}
            />
          ))
        )}
      </List>
    </Panel>
  );
}

function WeekGrid({
  dates,
  today,
  events,
  hours,
  onPick,
}: {
  dates: string[];
  today: string;
  events: CalEvent[];
  hours: [number, number];
  onPick: (date: string) => void;
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  // Open on the first hour of `hours`; the rest of the day is a scroll away.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = (el.scrollHeight / 24) * hours[0];
  }, [hours[0]]);
  const per = dates.map((date) => ({ date, items: eventsOn(events, date) }));
  const isToday = (date: string): 'true' | undefined => (date === today ? 'true' : undefined);
  return (
    <Panel flush>
      <div
        className="cal-week"
        role="grid"
        aria-label={`Week of ${dayLabel(dates[0] as string)}`}
        style={{ ['--cal-span' as string]: hours[1] - hours[0] }}
      >
        <div className="cal-row" role="row">
          <span className="cal-gutter" aria-hidden="true" />
          {dates.map((date) => (
            <div key={date} className="cal-day-head" role="columnheader" data-today={isToday(date)} aria-label={dayLabel(date)}>
              <span className="cal-wd">{weekdayName(date)}</span>
              <span className="cal-num">{dayOfMonth(date)}</span>
            </div>
          ))}
        </div>
        <div className="cal-row cal-allday" role="row">
          <span className="cal-gutter cal-gutter-label">All day</span>
          {per.map(({ date, items }) => (
            <div key={date} className="cal-allday-cell" role="gridcell" data-today={isToday(date)}>
              {items
                .filter((x) => x.part.allDay)
                .map(({ event, part }) => (
                  <button
                    key={event.id}
                    type="button"
                    className="cal-chip"
                    data-tone={event.tone}
                    aria-label={summaryOf(event, part, date)}
                    onClick={() => onPick(date)}
                  >
                    {event.title}
                  </button>
                ))}
            </div>
          ))}
        </div>
        <div className="cal-scroll" ref={scroller}>
          <div className="cal-row cal-times" role="row">
            <div className="cal-gutter cal-hours" aria-hidden="true">
              {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
                <span key={h} className="cal-hour-label" style={{ top: `calc(var(--cal-hour) * ${h})` }}>
                  {hm(h * 60)}
                </span>
              ))}
            </div>
            {per.map(({ date, items }) => (
              <div key={date} className="cal-col" role="gridcell" aria-label={dayLabel(date)} data-today={isToday(date)}>
                {lanesOf(items.filter((x) => !x.part.allDay)).map(({ event, part, lane, lanes }) => (
                  <button
                    key={event.id}
                    type="button"
                    className="cal-event"
                    data-tone={event.tone}
                    data-short={part.to - part.from < 60 ? 'true' : undefined}
                    data-lane={lane}
                    aria-label={summaryOf(event, part, date)}
                    onClick={() => onPick(date)}
                    style={{
                      top: `calc(var(--cal-hour) * ${part.from / 60})`,
                      height: `calc(var(--cal-hour) * ${Math.max(part.to - part.from, MIN_DRAWN) / 60})`,
                      left: `calc((100% - var(--space-1)) * ${lane / lanes} + var(--space-0))`,
                      width: `calc((100% - var(--space-1)) / ${lanes} - var(--space-0))`,
                    }}
                  >
                    <span className="cal-event-time">{timeOf(event, part)}</span>
                    <span className="cal-event-title">{event.title}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** How many events a month's day shows before "+N". */
export const MONTH_CELL_MAX = 3;

function MonthGrid({
  dates,
  month,
  today,
  events,
  selected,
  onPick,
}: {
  dates: string[];
  month: string;
  today: string;
  events: CalEvent[];
  selected: string;
  onPick: (date: string) => void;
}): JSX.Element {
  const weeks = Array.from({ length: 6 }, (_, w) => dates.slice(w * 7, w * 7 + 7));
  const [y, m] = month.split('-').map(Number) as [number, number];
  const name = fmtMonth(y, m);
  return (
    <Panel flush>
      <div className="cal-month" role="grid" aria-label={name}>
        <div className="cal-row" role="row">
          {dates.slice(0, 7).map((date) => (
            <div key={date} className="cal-wd-head" role="columnheader">
              {weekdayName(date)}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className="cal-row" role="row">
            {week.map((date) => {
              const items = eventsOn(events, date);
              const shown = items.slice(0, MONTH_CELL_MAX);
              const more = items.length - shown.length;
              const count = items.length === 0 ? 'nothing' : items.length === 1 ? '1 event' : `${items.length} events`;
              return (
                <div
                  key={date}
                  className="cal-cell"
                  role="gridcell"
                  aria-selected={date === selected}
                  data-date={date}
                  data-today={date === today ? 'true' : undefined}
                  data-outside={date.slice(0, 7) !== month ? 'true' : undefined}
                  data-selected={date === selected ? 'true' : undefined}
                  onClick={() => onPick(date)}
                >
                  <button type="button" className="cal-num" aria-label={`${dayLabel(date)}, ${count}`} aria-pressed={date === selected}>
                    {dayOfMonth(date)}
                  </button>
                  {shown.map(({ event, part }) => (
                    <button
                      key={event.id}
                      type="button"
                      className="cal-chip"
                      data-tone={event.tone}
                      data-timed={part.allDay ? undefined : 'true'}
                      aria-label={summaryOf(event, part, date)}
                    >
                      {part.allDay ? (
                        event.title
                      ) : (
                        <>
                          <span className="cal-dot" data-tone={event.tone} aria-hidden="true" />
                          <span className="cal-chip-time">{hm(part.from)}</span> {event.title}
                        </>
                      )}
                    </button>
                  ))}
                  {more > 0 ? (
                    <button type="button" className="cal-more" aria-label={`${more} more on ${dayLabel(date)}`}>
                      +{more}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Panel>
  );
}

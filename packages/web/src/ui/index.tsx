/**
 * The primitives: every shared piece of the dashboard, as components.
 *
 * A view composes these and never restyles them. Every one maps to a rule in
 * `ui.css` with the same name; variation is a prop that becomes a `data-*`
 * attribute the rule already knows. There is no `style` prop on purpose.
 */
import * as Dialog from '@radix-ui/react-dialog';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

export { useAsync } from './async';
export { Icon, ICON_NAMES, type IconName } from './Icon';
import { Icon, type IconName } from './Icon';
export { Avatar, AgentAvatar, Mascot, MascotProvider } from '../views/parts/Avatar';
import { Mascot } from '../views/parts/Avatar';

export type Tone = 'good' | 'warning' | 'critical' | 'accent' | 'muted';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ *
 * controls
 * ------------------------------------------------------------------ */

export type ButtonVariant = 'default' | 'accent' | 'good' | 'danger' | 'ghost';

export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'lg' }): JSX.Element {
  return (
    <button
      type={type}
      className={cx('ui-btn', className)}
      data-variant={variant && variant !== 'default' ? variant : undefined}
      data-size={size}
      {...rest}
    />
  );
}

/** A link that looks like a button: for going somewhere, not doing something. */
export function ButtonLink({
  variant,
  size,
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: 'sm' | 'lg' }): JSX.Element {
  return (
    <a
      className={cx('ui-btn', className)}
      data-variant={variant && variant !== 'default' ? variant : undefined}
      data-size={size}
      {...rest}
    />
  );
}

export function Toolbar({
  children,
  align,
  valign,
  className,
}: {
  children: ReactNode;
  align?: 'end';
  /** Bottom-align the row, for fields whose labels sit above their controls. */
  valign?: 'end';
  className?: string;
}): JSX.Element {
  return (
    <div className={cx('ui-toolbar', className)} data-align={align} data-valign={valign}>
      {children}
    </div>
  );
}

export function Spacer(): JSX.Element {
  return <span className="ui-toolbar-spacer" />;
}

/** A label, its control, and an optional hint beneath. The hint sits outside
 * the <label> so the control's accessible name is the label alone. */
export function Field({
  label,
  hint,
  inline,
  grow,
  wide,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  inline?: boolean;
  grow?: boolean;
  /** In a FormGrid, take the whole row: a long input, a textarea, a checkbox. */
  wide?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="ui-field"
      data-inline={inline ? 'true' : undefined}
      data-grow={grow ? 'true' : undefined}
      data-wide={wide ? 'true' : undefined}
    >
      <label className="ui-field-control">
        <span className="ui-field-label">{label}</span>
        {children}
      </label>
      {hint ? <span className="ui-field-hint">{hint}</span> : null}
    </div>
  );
}

/**
 * The one layout for a form's fields: equal columns, two on a panel's normal
 * width and one when it is narrow, every label starting on the same line. A
 * hint under one field never pushes its neighbour down, and a lone field on
 * its row keeps one column, so the grid reads as a grid and not as a wrap.
 * A field spans the row with `wide`.
 */
export function FormGrid({ children, dense }: { children: ReactNode; dense?: boolean }): JSX.Element {
  return <div className="ui-formgrid" data-dense={dense ? 'true' : undefined}>{children}</div>;
}

/* ------------------------------------------------------------------ *
 * words about state
 * ------------------------------------------------------------------ */

export function Pill({
  tone,
  mono,
  dot,
  children,
  className,
  title,
}: {
  tone?: Tone;
  mono?: boolean;
  /** A small dot of the tone before the word: a live state, like "ready". */
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}): JSX.Element {
  return (
    <span className={cx('ui-pill', mono && 'mono', className)} data-tone={tone} title={title}>
      {dot ? <span className="ui-pill-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** A very small all-caps word: what kind of thing this is. */
export function Tag({ children }: { children: ReactNode }): JSX.Element {
  return <span className="ui-tag">{children}</span>;
}

/** A job, occurrence, reminder or action state, in the tone it deserves. */
export function StatePill({ state }: { state: string }): JSX.Element {
  const tone: Tone | undefined =
    state === 'succeeded' || state === 'approved' || state === 'fired' || state === 'running' || state === 'leased'
      ? 'good'
      : state === 'failed' || state === 'rejected' || state === 'unknown' || state === 'error' ||
          state === 'refused'
        ? 'critical'
        : state === 'pending' || state === 'suspended' || state === 'expired' || state === 'paused'
          ? 'warning'
          : undefined;
  return <Pill tone={tone}>{state}</Pill>;
}

/** Something the page says once, in a box. Critical notices are announced. */
export function Notice({
  tone,
  title,
  children,
  role,
}: {
  tone?: Exclude<Tone, 'muted'>;
  title?: ReactNode;
  children?: ReactNode;
  role?: 'status' | 'alert';
}): JSX.Element {
  return (
    <div className="ui-notice" data-tone={tone} role={role}>
      {title ? <div className="ui-notice-title">{title}</div> : null}
      {children}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null | undefined }): JSX.Element | null {
  if (!message) return null;
  return (
    <Notice tone="critical" role="alert">
      {message}
    </Notice>
  );
}

/**
 * Nothing here, said quietly. `mascot` leaves room for the default agent's
 * uploaded face beside the words; without one the state reads exactly as
 * before. Reserve it for a page's own empty state, not a row inside a list.
 */
export function Empty({
  mascot,
  warm,
  title,
  action,
  children,
}: {
  mascot?: boolean;
  /** The kit's warm empty state: a sand ground, a title, a way forward. */
  warm?: boolean;
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  if (warm || title) {
    return (
      <div className="ui-empty" data-warm={warm ? 'true' : undefined}>
        {title ? <div className="ui-empty-title">{title}</div> : null}
        <div>{children}</div>
        {action}
      </div>
    );
  }
  if (!mascot) return <p className="ui-empty">{children}</p>;
  return (
    <div className="ui-empty" data-mascot="true">
      <Mascot size="sm" />
      <p>{children}</p>
    </div>
  );
}

/**
 * A region with nothing in it yet, said as a state rather than a problem:
 * neutral, centered in its region, an icon, a title, one line and at most one
 * way forward. For a page's or a section's own empty case — a loading line, or
 * a filter that matched nothing, stays `Empty`. Warning tones are for problems.
 */
export function EmptyState({
  icon,
  title,
  action,
  children,
}: {
  /** One of buddi's icons by name, or any small mark. */
  icon?: IconName | ReactNode;
  title: ReactNode;
  action?: ReactNode;
  /** The one line: what fills this, or where it comes from. */
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="ui-empty-state">
      {icon ? (
        <span className="ui-empty-state-icon">{typeof icon === 'string' ? <Icon name={icon as IconName} /> : icon}</span>
      ) : null}
      <div className="ui-empty-state-title">{title}</div>
      {children ? <p className="ui-empty-state-line">{children}</p> : null}
      {action ? <div className="ui-empty-state-action">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * containers
 * ------------------------------------------------------------------ */

/** A page: title, lede and actions, then whatever sections follow. */
export function Page({ children }: { children: ReactNode }): JSX.Element {
  return <div className="ui-page">{children}</div>;
}

export function PageHeader({
  title,
  lede,
  actions,
  before,
}: {
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  /** Something that sits inside the title, before the words — a back button. */
  before?: ReactNode;
}): JSX.Element {
  return (
    <header className="ui-page-head">
      <div className="ui-page-head-row">
        <h2 className="ui-page-title">
          {before}
          <span>{title}</span>
        </h2>
        {actions ? <div className="ui-page-actions">{actions}</div> : null}
      </div>
      {lede ? <p className="ui-page-lede">{lede}</p> : null}
    </header>
  );
}

/**
 * A page, or the body of one. `embedded` drops the head and the page gap so
 * the same view can sit inside a tab on another page.
 */
export function PageFrame({
  embedded,
  title,
  lede,
  actions,
  children,
}: {
  embedded?: boolean;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  if (embedded) {
    return (
      <div className="ui-stack" data-gap="lg">
        {actions ? <div className="ui-toolbar" data-align="end">{actions}</div> : null}
        {children}
      </div>
    );
  }
  return (
    <Page>
      <PageHeader title={title} lede={lede} actions={actions} />
      {children}
    </Page>
  );
}

/**
 * A titled group on a page.
 *
 * The head sits on the page's ground: the title on the left, a note (`aside`)
 * and what can be done to the section (`actions`) on the right. With `panel`,
 * what the section holds — a form, a table, rows — goes in one white panel
 * under the head, and `foot` is that panel's last row, right-aligned behind a
 * hairline: where a form's Save sits. Groups inside the panel are divided by
 * hairlines (`Stack divided`), never by a second panel.
 *
 * Without `panel` it is a plain group — inside a panel, a group of it.
 */
export function Section({
  title,
  aside,
  actions,
  panel,
  flush,
  foot,
  children,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
  /** Hold the content in a white panel under the head. */
  panel?: boolean;
  /** A table or a list in the panel meets its edges. */
  flush?: boolean;
  /** The panel's last row: its primary action, on the right. */
  foot?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const head = title || aside || actions ? (
    <div className="ui-section-head">
      {title ? <h3 className="ui-section-title">{title}</h3> : <span />}
      {aside || actions ? (
        <div className="ui-section-side">
          {aside ? <span className="ui-section-aside">{aside}</span> : null}
          {actions ? <div className="ui-section-actions">{actions}</div> : null}
        </div>
      ) : null}
    </div>
  ) : null;
  return (
    <section className="ui-section" data-panel={panel ? 'true' : undefined}>
      {head}
      {panel ? (
        /* The owner's rule, over the kit's: the title, its note and its
           actions stay on the ground above; the panel holds only the content. */
        <div className="ui-panel" data-flush={flush ? 'true' : undefined}>
          {children}
          {foot ? <div className="ui-panel-foot">{foot}</div> : null}
        </div>
      ) : (
        <>
          {children}
          {foot ? <div className="ui-toolbar" data-align="end">{foot}</div> : null}
        </>
      )}
    </section>
  );
}

/**
 * A raised box. `flush` lets a table inside it meet the edges.
 *
 * `tool` is a fact about the panel — a count, a stamp — and reads as a small
 * badge. `actions` is what can be *done* to what the panel holds, and sits on
 * the right of the head as controls, because a button in a badge is neither.
 */
export function Panel({
  title,
  tool,
  actions,
  flush,
  children,
}: {
  title?: ReactNode;
  tool?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="ui-panel" data-flush={flush ? 'true' : undefined}>
      {title || tool || actions ? (
        <header className="ui-panel-head">
          {title ? <h3 className="ui-panel-title">{title}</h3> : <span />}
          {tool ? <span className="ui-panel-tool">{tool}</span> : null}
          {actions ? <div className="ui-panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** One record, its border tinted in the tone of its state. */
export function Card({
  tone,
  title,
  meta,
  actions,
  children,
  foot,
  as: As = 'div',
}: {
  tone?: Tone;
  title?: ReactNode;
  /** Pills and short facts that sit on the title row. */
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
  as?: 'div' | 'section' | 'article';
}): JSX.Element {
  return (
    <As className="ui-card" data-tone={tone}>
      {title || meta || actions ? (
        <div className="ui-card-head">
          {title ? <h3 className="ui-card-title">{title}</h3> : null}
          {meta}
          {actions ? <div className="ui-card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
      {foot ? <div className="ui-card-foot">{foot}</div> : null}
    </As>
  );
}

export function Stack({ gap, divided, children }: { gap?: 'sm' | 'lg'; divided?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className="ui-stack" data-gap={gap} data-divided={divided ? 'true' : undefined}>
      {children}
    </div>
  );
}

export function Row({ children }: { children: ReactNode }): JSX.Element {
  return <div className="ui-row">{children}</div>;
}

/* ------------------------------------------------------------------ *
 * numbers and facts
 * ------------------------------------------------------------------ */

export function Stats({ inline, children }: { inline?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className="ui-stats" data-inline={inline ? 'true' : undefined}>
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  note,
  tone,
  size,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: Exclude<Tone, 'accent' | 'muted'>;
  size?: 'sm';
}): JSX.Element {
  return (
    <div className="ui-stat">
      <div className="ui-stat-k">{label}</div>
      <div className="ui-stat-v" data-tone={tone} data-size={size}>
        {value}
      </div>
      {note ? <div className="ui-stat-n">{note}</div> : null}
    </div>
  );
}

export function KV({ items }: { items: Array<{ label: ReactNode; value: ReactNode; key?: string }> }): JSX.Element {
  return (
    <dl className="ui-kv">
      {items.map((item, index) => (
        <div key={item.key ?? index} className="contents">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ *
 * tables and text blocks
 * ------------------------------------------------------------------ */

/** A table that scrolls sideways before it breaks the page. */
export function Table({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="ui-table-wrap">
      <table className="ui-table">{children}</table>
    </div>
  );
}

/**
 * How far something has got: a fill on a hairline track. `value` is a
 * percent; the fill moves without a transition under reduced motion.
 */
export function Progress({ value, label }: { value: number; label: string }): JSX.Element {
  const percent = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  return (
    <div
      className="ui-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
    >
      <div className="ui-progress-fill" style={{ inlineSize: `${percent}%` }} />
    </div>
  );
}

export function Code({ children, label }: { children: ReactNode; label?: string }): JSX.Element {
  return (
    <pre className="ui-code" aria-label={label}>
      {children}
    </pre>
  );
}

export function Details({
  summary,
  boxed,
  open,
  className,
  onToggle,
  children,
}: {
  summary: ReactNode;
  boxed?: boolean;
  open?: boolean;
  className?: string;
  /** Told when it opens or closes — for a body that is fetched when asked for. */
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <details
      className={cx('ui-details', className)}
      data-boxed={boxed ? 'true' : undefined}
      open={open}
      onToggle={onToggle ? (event) => onToggle((event.currentTarget as HTMLDetailsElement).open) : undefined}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/* ------------------------------------------------------------------ *
 * overlays
 * ------------------------------------------------------------------ */

/** A sheet from the right edge: the detail of one row. Escape and the overlay close it. */
export function Sheet({
  title,
  onClose,
  size,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  size?: 'wide';
  children: ReactNode;
}): JSX.Element {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-sheet-overlay" />
        <Dialog.Content className="ui-sheet" data-size={size} aria-describedby={undefined}>
          <div className="ui-sheet-head">
            <Dialog.Title className="ui-sheet-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button size="sm">Close</Button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ------------------------------------------------------------------ *
 * tabs and lists
 * ------------------------------------------------------------------ */

export function Tabs({ children }: { children: ReactNode }): JSX.Element {
  return <nav className="ui-tabs">{children}</nav>;
}

export function Tab({
  href,
  active,
  count,
  onClick,
  children,
}: {
  href: string;
  active: boolean;
  count?: number;
  onClick?: (event: { preventDefault: () => void }) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <a className="ui-tab" href={href} aria-current={active ? 'page' : undefined} onClick={onClick}>
      {children}
      {count ? <span className="ui-count">{count}</span> : null}
    </a>
  );
}

/**
 * A segmented control: two or three choices as one pill, the chosen one
 * raised. A radio group underneath, so the keyboard and a screen reader read
 * it as one question with one answer.
 */
export function Segment<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="ui-segment" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="ui-tab"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function List({ children }: { children: ReactNode }): JSX.Element {
  return <div className="ui-list">{children}</div>;
}

export function ListRow({
  href,
  onClick,
  lead,
  title,
  sub,
  side,
}: {
  href?: string;
  onClick?: () => void;
  lead?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  side?: ReactNode;
}): JSX.Element {
  const body = (
    <>
      {lead}
      <span className="ui-list-main">
        <span className="ui-list-title">{title}</span>
        {sub ? <span className="ui-list-sub">{sub}</span> : null}
      </span>
      {side ? <span className="ui-list-side">{side}</span> : null}
    </>
  );
  if (href) {
    return (
      <a className="ui-list-row" href={href} onClick={onClick ? (e) => { e.preventDefault(); onClick(); } : undefined}>
        {body}
      </a>
    );
  }
  return <div className="ui-list-row">{body}</div>;
}

/**
 * One row of a list that picks what the pane beside it shows — the roster's
 * row: the title in its weight with a fact (a time) on the right of the same
 * line, a second line under it, and the chosen one in the soft accent with
 * the active marker. The whole row is the link.
 */
export function PickRow({
  href,
  onClick,
  current,
  lead,
  title,
  meta,
  sub,
  snippet,
  side,
}: {
  href: string;
  onClick?: () => void;
  current?: boolean;
  lead?: ReactNode;
  title: ReactNode;
  /** A fact on the title's line, right-aligned: when. */
  meta?: ReactNode;
  sub?: ReactNode;
  /** One muted line under the rest. */
  snippet?: ReactNode;
  /** Pills, after the second line. */
  side?: ReactNode;
}): JSX.Element {
  return (
    <a
      className="ui-pick"
      href={href}
      aria-current={current ? 'true' : undefined}
      onClick={onClick ? (e) => { e.preventDefault(); onClick(); } : undefined}
    >
      {lead ? <span className="ui-pick-lead">{lead}</span> : null}
      <span className="ui-pick-main">
        <span className="ui-pick-top">
          <span className="ui-pick-title">{title}</span>
          {meta ? <span className="ui-pick-meta">{meta}</span> : null}
        </span>
        {sub || side ? (
          <span className="ui-pick-line">
            {sub ? <span className="ui-pick-sub">{sub}</span> : null}
            {side ? <span className="ui-pick-side">{side}</span> : null}
          </span>
        ) : null}
        {snippet ? <span className="ui-pick-snippet">{snippet}</span> : null}
      </span>
    </a>
  );
}

/**
 * A list and the one thing it is showing: the list in a white panel of its
 * own width that scrolls by itself, the reading pane a white panel filling
 * the rest. Below the narrow breakpoint they stack. `detail` absent draws the
 * pane's empty state, centred.
 */
export function Split({
  list,
  detail,
  empty,
  label,
  className,
}: {
  list: ReactNode;
  detail?: ReactNode;
  empty?: ReactNode;
  /** Names the list pane for a screen reader. */
  label?: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={cx('ui-split', className)} data-open={detail ? 'true' : undefined}>
      <section className="ui-split-list" aria-label={label}>{list}</section>
      <section className="ui-split-detail" data-empty={detail ? undefined : 'true'}>
        {detail ?? <p className="ui-empty ui-split-empty">{empty}</p>}
      </section>
    </div>
  );
}

/** A filter that is on, said as a word with a way to take it off. */
export function Chip({ children, onRemove, label }: { children: ReactNode; onRemove: () => void; label: string }): JSX.Element {
  return (
    <span className="ui-chip">
      {children}
      <button type="button" className="ui-chip-x" aria-label={`Remove ${label}`} onClick={onRemove}>
        ×
      </button>
    </span>
  );
}

/**
 * A search as one compact bar in a white panel: the main field grows, then
 * Filters, then the actions on the right. Enter searches. The filters open
 * in a row underneath; the ones that are on show as chips.
 */
export function SearchBar({
  main,
  filters,
  filtersOpen,
  onToggleFilters,
  active,
  chips,
  actions,
  onSubmit,
  label,
}: {
  main?: ReactNode;
  filters?: ReactNode;
  filtersOpen?: boolean;
  onToggleFilters?: () => void;
  /** How many filters are on: counted on the Filters button. */
  active?: number;
  chips?: ReactNode;
  actions?: ReactNode;
  onSubmit: () => void;
  label?: string;
}): JSX.Element {
  return (
    <form
      className="ui-panel ui-searchbar"
      role="search"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="ui-searchbar-row">
        {main ? <div className="ui-searchbar-main">{main}</div> : null}
        {filters && onToggleFilters ? (
          <Button aria-expanded={filtersOpen === true} aria-pressed={filtersOpen === true} onClick={onToggleFilters}>
            Filters{active ? <span className="ui-count">{active}</span> : null}
          </Button>
        ) : null}
        {!onToggleFilters && filters ? <div className="ui-searchbar-inline">{filters}</div> : null}
        {actions ? <div className="ui-searchbar-actions">{actions}</div> : null}
      </div>
      {filters && onToggleFilters && filtersOpen ? <div className="ui-searchbar-filters">{filters}</div> : null}
      {chips ? <div className="ui-searchbar-chips">{chips}</div> : null}
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * the field
 * ------------------------------------------------------------------ */

/**
 * The soft blue-to-sand field: first run, the Home hero band (`quiet`), a new
 * chat's opening. Text never sits on it except one short line in `--text`.
 */
/** The buddi mark: the rail's "b" tile. Decoration — the link or heading around it says buddi. */
export function Mark({ size }: { size?: 'sm' | 'lg' | 'xl' }): JSX.Element {
  return <span className="ui-mark" data-size={size} aria-hidden="true">b</span>;
}

export function GradientField({
  quiet,
  still,
  className,
  children,
}: {
  quiet?: boolean;
  still?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cx('ui-fieldbg', className)} data-quiet={quiet ? 'true' : undefined} data-still={still ? 'true' : undefined}>
      {children}
    </div>
  );
}

/** The one white card that floats on the field; `dock` is its actions under one hairline. */
export function FloatCard({ dock, className, children }: { dock?: ReactNode; className?: string; children: ReactNode }): JSX.Element {
  return (
    <div className={cx('ui-float', className)}>
      <div className="ui-float-body">{children}</div>
      {dock ? <div className="ui-float-dock">{dock}</div> : null}
    </div>
  );
}

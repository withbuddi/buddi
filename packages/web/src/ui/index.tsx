/**
 * The primitives: every shared piece of the dashboard, as components.
 *
 * A view composes these and never restyles them. Every one maps to a rule in
 * `ui.css` with the same name; variation is a prop that becomes a `data-*`
 * attribute the rule already knows. There is no `style` prop on purpose.
 */
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useId, useRef, useState } from 'react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';

export { useAsync } from './async';
export { Blob, type BlobSize } from './Blob';
export { Chart, chartGeometry, chartSummary, type ChartSeries } from './Chart';
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

/**
 * `danger-ghost` is the quiet destructive action at the far end of a row of
 * buttons (a sheet's "Remove…"): no border, the critical ink.
 */
export type ButtonVariant = 'default' | 'accent' | 'good' | 'danger' | 'danger-ghost' | 'ghost';

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
  group,
  action,
  after,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /**
   * A small button right after the control, outside its label so the
   * control's name stays the label's words: a select's play button.
   */
  action?: ReactNode;
  /** Under the field, outside its label: what that button just said. */
  after?: ReactNode;
  inline?: boolean;
  grow?: boolean;
  /** In a FormGrid, take the whole row: a long input, a textarea, a checkbox. */
  wide?: boolean;
  /**
   * The control is several controls (a ChipPicker): the label names a group
   * instead of wrapping it, so a click on the label presses nothing.
   */
  group?: boolean;
  children: ReactNode;
}): JSX.Element {
  const labelId = useId();
  return (
    <div
      className="ui-field"
      data-inline={inline ? 'true' : undefined}
      data-grow={grow ? 'true' : undefined}
      data-wide={wide ? 'true' : undefined}
    >
      {action ? (
        <div className="ui-field-row">
          <label className="ui-field-control">
            <span className="ui-field-label">{label}</span>
            {children}
          </label>
          {action}
        </div>
      ) : group ? (
        <div className="ui-field-control" role="group" aria-labelledby={labelId}>
          <span className="ui-field-label" id={labelId}>{label}</span>
          {children}
        </div>
      ) : (
        <label className="ui-field-control">
          <span className="ui-field-label">{label}</span>
          {children}
        </label>
      )}
      {hint ? <span className="ui-field-hint">{hint}</span> : null}
      {after}
    </div>
  );
}

/**
 * The one layout for a form's fields: equal columns, two on a panel's normal
 * width and one when it is narrow, every label starting on the same line. A
 * hint under one field never pushes its neighbour down, and a lone field on
 * its row keeps one column, so the grid reads as a grid and not as a wrap.
 * A field spans the row with `wide`. `columns={3}` puts three to a row on a
 * wide panel, still dropping to two and then one as it narrows.
 */
export function FormGrid({
  children,
  dense,
  columns,
}: {
  children: ReactNode;
  dense?: boolean;
  columns?: 2 | 3;
}): JSX.Element {
  return (
    <div
      className="ui-formgrid"
      data-dense={dense ? 'true' : undefined}
      data-columns={columns === 3 ? '3' : undefined}
    >
      {children}
    </div>
  );
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
  action,
}: {
  /** `warm`: a friendly aside on the sand ground, never a problem. */
  tone?: Exclude<Tone, 'muted'> | 'warm';
  title?: ReactNode;
  children?: ReactNode;
  role?: 'status' | 'alert';
  /** The one thing to do about it, on the right of the words: "Restart to load it". */
  action?: ReactNode;
}): JSX.Element {
  if (action) {
    return (
      <div className="ui-notice" data-tone={tone} role={role}>
        <div className="ui-notice-row">
          <div className="ui-notice-body">
            {title ? <div className="ui-notice-title">{title}</div> : null}
            {children}
          </div>
          {action}
        </div>
      </div>
    );
  }
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
  onClick,
  label,
  as: As = 'div',
}: {
  tone?: Tone;
  title?: ReactNode;
  /** Pills and short facts that sit on the title row. */
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
  /**
   * The whole card opens something (its detail). It lifts on hover and is
   * reachable by Tab and Enter; buttons inside keep their own clicks.
   */
  onClick?: () => void;
  /** Its name for a screen reader when it is clickable. */
  label?: string;
  as?: 'div' | 'section' | 'article';
}): JSX.Element {
  const interactive = onClick
    ? {
        'data-interactive': 'true',
        tabIndex: 0,
        'aria-label': label,
        onClick,
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          onClick();
        },
      }
    : {};
  return (
    <As className="ui-card" data-tone={tone} {...interactive}>
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
  foot,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  size?: 'wide';
  /** The sheet's last row, held at its bottom behind a hairline: its actions. */
  foot?: ReactNode;
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
          {foot ? <div className="ui-sheet-foot">{foot}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A small question centred over the page: one decision, asked once. Title,
 * a sentence or two, and the buttons in `foot` (the one that acts last, on
 * the right). Modal: focus stays in it, Escape and the overlay cancel. It may
 * open over a Sheet; closing it leaves the sheet where it was.
 */
export function Modal({
  title,
  onClose,
  foot,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  foot?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-sheet-overlay" data-layer="modal" />
        <Dialog.Content className="ui-modal" role="alertdialog" aria-describedby={undefined}>
          <Dialog.Title className="ui-modal-title">{title}</Dialog.Title>
          {children}
          {foot ? <div className="ui-modal-foot">{foot}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One thing a row's ⋯ menu does. */
export interface MenuAction {
  label: ReactNode;
  /** A short note on the right: what it keeps, what it undoes. */
  hint?: ReactNode;
  tone?: 'critical';
  onSelect: () => void;
}

/**
 * A row's other things to do, behind ⋯. `null` and `false` are skipped, so
 * a condition can sit in the list; `'separator'` draws a hairline. Clicks in
 * it never reach the row around it.
 */
export function ActionMenu({
  label,
  items,
  note,
  trigger,
}: {
  /** The button's name: "More for finance". */
  label: string;
  /** `{ heading }` starts a group with a quiet line: "As on Home". */
  items: Array<MenuAction | { heading: ReactNode } | 'separator' | null | false | undefined>;
  /** A quiet line over the items: where it comes from, when it was updated. */
  note?: ReactNode;
  /** A button of its own instead of ⋯: "Add a widget". It must take a ref (a plain button). */
  trigger?: ReactNode;
}): JSX.Element {
  const stop = (event: { stopPropagation: () => void }): void => event.stopPropagation();
  /*
   * An item that opens something (a dialog, a sheet) takes the focus there;
   * handing it back to ⋯ as the menu closes would pull it out of what opened.
   */
  const chose = useRef(false);
  return (
    <DropdownMenu.Root modal={false} onOpenChange={(open) => { if (open) chose.current = false; }}>
      <DropdownMenu.Trigger asChild>
        {trigger ?? (
          <button type="button" className="ui-icon-btn" data-size="sm" aria-label={label} title={label} onClick={stop}>
            <Icon name="more" />
          </button>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ui-menu"
          align="end"
          sideOffset={4}
          onClick={stop}
          onKeyDown={stop}
          onCloseAutoFocus={(event) => { if (chose.current) event.preventDefault(); }}
        >
          {note ? <DropdownMenu.Label className="ui-menu-label">{note}</DropdownMenu.Label> : null}
          {items.map((item, index) =>
            !item ? null : item === 'separator' ? (
              <DropdownMenu.Separator key={`sep-${index}`} className="ui-menu-sep" />
            ) : 'heading' in item ? (
              <DropdownMenu.Label key={`head-${index}`} className="ui-menu-label">{item.heading}</DropdownMenu.Label>
            ) : (
              <DropdownMenu.Item
                key={index}
                className="ui-menu-item"
                data-tone={item.tone}
                onSelect={() => {
                  chose.current = true;
                  item.onSelect();
                }}
              >
                <span>{item.label}</span>
                {item.hint ? <span className="ui-menu-item-hint">{item.hint}</span> : null}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * A small window docked in the bottom-right corner: a side conversation over
 * the page, not in place of it. Non-modal, so the page under it stays usable
 * and a click on it does not close the dock; Escape and Close do. A third of
 * the width on a desk, the full width on a phone.
 */
export function Dock({
  title,
  actions,
  onClose,
  onCloseAutoFocus,
  onOpenAutoFocus,
  label,
  children,
}: {
  title: ReactNode;
  /** Beside Close in the head: a link, a "New". */
  actions?: ReactNode;
  onClose: () => void;
  /** Where focus goes once the dock has gone; the caller's trigger, usually. */
  onCloseAutoFocus?: (event: Event) => void;
  /** What takes focus when it opens; by default the first control in it. */
  onOpenAutoFocus?: (event: Event) => void;
  /** The dialog's accessible name when `title` is not plain text. */
  label?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Dialog.Root open modal={false} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Content
          className="ui-dock"
          aria-describedby={undefined}
          {...(label ? { 'aria-label': label } : {})}
          onInteractOutside={(event) => event.preventDefault()}
          {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
          {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}
        >
          <div className="ui-dock-head">
            <Dialog.Title className="ui-dock-title">{title}</Dialog.Title>
            <div className="ui-dock-actions">
              {actions}
              <Dialog.Close asChild>
                <Button size="sm" variant="ghost">Close</Button>
              </Dialog.Close>
            </div>
          </div>
          <div className="ui-dock-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ------------------------------------------------------------------ *
 * tabs and lists
 * ------------------------------------------------------------------ */

/** A row of tabs. `secondary` is a row inside a tab: smaller, no rule under it. */
export function Tabs({ level, label, children }: { level?: 'secondary'; label?: string; children: ReactNode }): JSX.Element {
  return <nav className="ui-tabs" data-level={level} aria-label={label}>{children}</nav>;
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
  dimmed,
  label,
}: {
  href?: string;
  /**
   * Without `href`, the whole row opens something (its detail): it takes the
   * hover and the focus, and Enter on it is a click. Controls in `side` keep
   * their own clicks — they stop the event themselves.
   */
  onClick?: () => void;
  lead?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  side?: ReactNode;
  /** Off, but still here: a disabled plugin. The side stays at full strength. */
  dimmed?: boolean;
  /** The row's name for a screen reader when it is clickable. */
  label?: string;
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
  const dim = dimmed ? 'true' : undefined;
  if (href) {
    return (
      <a className="ui-list-row" data-dimmed={dim} href={href} onClick={onClick ? (e) => { e.preventDefault(); onClick(); } : undefined}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <div
        className="ui-list-row"
        data-interactive="true"
        data-dimmed={dim}
        tabIndex={0}
        aria-label={label}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          onClick();
        }}
      >
        {body}
      </div>
    );
  }
  return <div className="ui-list-row" data-dimmed={dim}>{body}</div>;
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
export function Chip({
  children,
  onRemove,
  label,
  disabled,
}: {
  children: ReactNode;
  onRemove: () => void;
  label: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <span className="ui-chip">
      {children}
      <button type="button" className="ui-chip-x" aria-label={`Remove ${label}`} onClick={onRemove} disabled={disabled}>
        ×
      </button>
    </span>
  );
}

/** Past this many options the Add list gets a filter field. */
const CHIP_PICKER_FILTER_AFTER = 8;

/**
 * Several choices from a list, said as chips: each chosen value with its ×,
 * then Add…, which opens the rest as a compact list (with a filter field when
 * there are more than eight). Backspace on an empty filter takes the last
 * chip off, Enter picks the highlighted option, Escape closes. At `max` the
 * Add control is greyed; saying why is the field's hint.
 */
export function ChipPicker({
  label,
  options,
  value,
  onChange,
  max,
  disabled,
  id,
}: {
  /** Names the list of options for a screen reader. */
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string[];
  onChange: (value: string[]) => void;
  max?: number;
  disabled?: boolean;
  id?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const listId = useId();

  const labelOf = (v: string): string => options.find((o) => o.value === v)?.label ?? v;
  const atCap = max !== undefined && value.length >= max;
  const remaining = options.filter((o) => !value.includes(o.value));
  const filterable = options.length > CHIP_PICKER_FILTER_AFTER;
  const needle = filter.trim().toLowerCase();
  const shown = needle === '' ? remaining : remaining.filter((o) => o.label.toLowerCase().includes(needle));
  const highlighted = Math.min(active, Math.max(0, shown.length - 1));

  const close = (refocus: boolean): void => {
    setOpen(false);
    setFilter('');
    setActive(0);
    if (refocus) addButton.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    (filterable ? filterInput.current : listbox.current)?.focus();
    const outside = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filterable]);

  const pick = (chosen: string): void => {
    const next = [...value, chosen];
    onChange(next);
    setFilter('');
    setActive(0);
    const full = max !== undefined && next.length >= max;
    if (full || next.length >= options.length) close(!full);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(shown.length === 0 ? 0 : (highlighted + 1) % shown.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(shown.length === 0 ? 0 : (highlighted - 1 + shown.length) % shown.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = shown[highlighted];
      if (option) pick(option.value);
    } else if (event.key === 'Backspace' && filter === '' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const optionId = (index: number): string => `${listId}-${index}`;
  const activeDescendant = open && shown.length > 0 ? optionId(highlighted) : undefined;

  return (
    <div className="ui-chippicker" ref={root} id={id}>
      {value.map((v) => (
        <Chip key={v} label={labelOf(v)} disabled={disabled} onRemove={() => onChange(value.filter((x) => x !== v))}>
          {labelOf(v)}
        </Chip>
      ))}
      <div className="ui-chippicker-add">
        <button
          ref={addButton}
          type="button"
          className="ui-btn"
          data-size="sm"
          data-variant="ghost"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          disabled={disabled || atCap || remaining.length === 0}
          onClick={() => (open ? close(false) : setOpen(true))}
        >
          Add…
        </button>
        {open ? (
          <div className="ui-menu ui-chippicker-menu" onKeyDown={onKeyDown}>
            {filterable ? (
              <input
                ref={filterInput}
                type="search"
                className="ui-chippicker-filter"
                aria-label={`Filter ${label}`}
                aria-controls={listId}
                aria-activedescendant={activeDescendant}
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setActive(0);
                }}
              />
            ) : null}
            <div
              ref={listbox}
              id={listId}
              role="listbox"
              aria-multiselectable="true"
              aria-label={label}
              aria-activedescendant={filterable ? undefined : activeDescendant}
              tabIndex={filterable ? -1 : 0}
              className="ui-chippicker-list"
            >
              {shown.map((option, index) => (
                <div
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected="false"
                  className="ui-menu-item"
                  data-highlighted={index === highlighted ? '' : undefined}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(option.value)}
                >
                  {option.label}
                </div>
              ))}
              {shown.length === 0 ? <p className="ui-menu-empty">Nothing matches</p> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One filter out of a few, said as pill buttons: the chosen one pressed.
 * A group of toggles rather than tabs, because the list under it is the same
 * list, narrowed.
 */
export function FilterChips<T extends string>({
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
    <div className="ui-filter-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="ui-btn ui-filter-chip"
          data-size="sm"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A search as one field that filters as you type. The placeholder says what
 * it searches; `label` names it for a screen reader. `grow` takes the row.
 */
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  grow,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  grow?: boolean;
}): JSX.Element {
  return (
    <span className="ui-search" data-grow={grow ? 'true' : undefined}>
      <input
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}

/**
 * A thing's face as a soft square: an app's icon. `svg` is markup the
 * gateway already sanitised (a market icon); it draws in `currentColor`, so it
 * takes the tile's accent. Without it, one of buddi's own icons on a quiet
 * tile. Decoration: the name beside it says what it is.
 */
export function AppIcon({
  svg,
  icon = 'plug',
  letter,
  size,
}: {
  svg?: string | undefined;
  icon?: IconName;
  /** A neutral monogram in the accent, for a service whose own logo is not ours to draw. */
  letter?: string | undefined;
  size?: 'lg';
}): JSX.Element {
  return (
    <span className="ui-app-icon" data-size={size} data-tone={svg || letter ? 'accent' : undefined} aria-hidden="true">
      {svg ? (
        <span className="ui-app-icon-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : letter ? (
        <span className="ui-app-icon-letter">{letter}</span>
      ) : (
        <Icon name={icon} />
      )}
    </span>
  );
}

/**
 * Where this is, as the steps to it: each step a link or a button, a chevron
 * after it, and the step you are on (`current`) plain. `inline` renders a
 * span for a place that takes no <nav>, such as inside a page title.
 */
export function Breadcrumb({
  items,
  label = 'Where this is',
  inline,
}: {
  items: Array<{ label: ReactNode; key?: string; href?: string; onClick?: () => void; current?: boolean }>;
  label?: string;
  inline?: boolean;
}): JSX.Element {
  const steps = items.map((item, index) => {
    const key = item.key ?? String(index);
    if (item.current) {
      return (
        <span key={key} className="ui-crumb" aria-current="page">
          {item.label}
        </span>
      );
    }
    const step = item.href ? (
      <a
        className="ui-crumb"
        href={item.href}
        onClick={item.onClick ? (event) => { event.preventDefault(); item.onClick?.(); } : undefined}
      >
        {item.label}
      </a>
    ) : (
      <button type="button" className="ui-crumb" onClick={item.onClick}>
        {item.label}
      </button>
    );
    return (
      <span key={key} className="ui-crumb-step">
        {step}
        <Icon name="chevron-right" size={12} />
      </span>
    );
  });
  return inline ? (
    <span className="ui-crumbs" aria-label={label}>{steps}</span>
  ) : (
    <nav className="ui-crumbs" aria-label={label}>{steps}</nav>
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

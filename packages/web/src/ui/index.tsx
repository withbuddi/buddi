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
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' }): JSX.Element {
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
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: 'sm' }): JSX.Element {
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
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  inline?: boolean;
  grow?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="ui-field" data-inline={inline ? 'true' : undefined} data-grow={grow ? 'true' : undefined}>
      <label className="ui-field-control">
        <span className="ui-field-label">{label}</span>
        {children}
      </label>
      {hint ? <span className="ui-field-hint">{hint}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * words about state
 * ------------------------------------------------------------------ */

export function Pill({
  tone,
  mono,
  children,
  className,
  title,
}: {
  tone?: Tone;
  mono?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}): JSX.Element {
  return (
    <span className={cx('ui-pill', mono && 'mono', className)} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

/** A job, occurrence, reminder or action state, in the tone it deserves. */
export function StatePill({ state }: { state: string }): JSX.Element {
  const tone: Tone | undefined =
    state === 'succeeded' || state === 'approved' || state === 'fired' || state === 'running' || state === 'leased'
      ? 'good'
      : state === 'failed' || state === 'rejected' || state === 'unknown' || state === 'error'
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

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <p className="ui-empty">{children}</p>;
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

/** A titled group on a page. */
export function Section({
  title,
  aside,
  children,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="ui-section">
      {title || aside ? (
        <div className="ui-section-head">
          {title ? <h3 className="ui-section-title">{title}</h3> : <span />}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A raised box. `flush` lets a table inside it meet the edges. */
export function Panel({
  title,
  tool,
  flush,
  children,
}: {
  title?: ReactNode;
  tool?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="ui-panel" data-flush={flush ? 'true' : undefined}>
      {title || tool ? (
        <header className="ui-panel-head">
          {title ? <h3 className="ui-panel-title">{title}</h3> : <span />}
          {tool ? <span className="ui-panel-tool">{tool}</span> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** One record, with a left rule in the tone of its state. */
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

export function Stack({ gap, children }: { gap?: 'sm' | 'lg'; children: ReactNode }): JSX.Element {
  return (
    <div className="ui-stack" data-gap={gap}>
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
  children,
}: {
  summary: ReactNode;
  boxed?: boolean;
  open?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <details className={cx('ui-details', className)} data-boxed={boxed ? 'true' : undefined} open={open}>
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
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-sheet-overlay" />
        <Dialog.Content className="ui-sheet" aria-describedby={undefined}>
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

/** @deprecated The old name. Pages still on it move to `Sheet` as they are redrawn. */
export const Drawer = Sheet;

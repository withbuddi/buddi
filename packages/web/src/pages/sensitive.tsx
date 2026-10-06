/**
 * Sensitive values on a plugin page (host API 1.31).
 *
 * A query may mark paths into its answer sensitive (`['netWorth',
 * 'accounts[].balance']`). Until the owner presses Show amounts, the page is
 * drawn from a copy of the answer with those values replaced by `MASK`, so
 * every place a value lands — a stat, a list's meta, a table cell, a hero, a
 * chart — shows the mask and none of them can forget to. What is drawn as text
 * goes through `MaskText`, which gives the mask a stable width and says
 * "hidden" to a screen reader.
 *
 * A write still sends the real value: each copied object remembers the one it
 * was copied from (`rawOf`), and the arguments a button sends are read from
 * that. The path walk mirrors core's `maskSensitiveValues`.
 */
import type { ReactNode } from 'react';
import { Button } from '../ui';
import { Icon } from '../ui/Icon';

/** What stands where a sensitive value is, until Show amounts. Always this wide. */
export const MASK = '••••';

const RAW = new WeakMap<object, object>();

/** The object a masked copy was made from, or the value itself. */
export function rawOf<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return (RAW.get(value as object) as T | undefined) ?? value;
}

type Step = { key: string } | { each: true };

function steps(path: string): Step[] {
  const out: Step[] = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\])*)$/.exec(part);
    if (!match) continue;
    if (match[1]) out.push({ key: match[1] });
    for (let i = 0; i < (match[2] ?? '').length / 2; i++) out.push({ each: true });
  }
  return out;
}

function remember<T extends object>(copy: T, from: object): T {
  RAW.set(copy, rawOf(from));
  return copy;
}

function maskAt(node: unknown, [step, ...rest]: Step[]): unknown {
  if (node === undefined || node === null) return node;
  if (step === undefined) return MASK;
  if ('each' in step) return Array.isArray(node) ? remember(node.map((item) => maskAt(item, rest)), node) : node;
  if (typeof node !== 'object' || Array.isArray(node) || !Object.prototype.hasOwnProperty.call(node, step.key)) return node;
  const record = node as Record<string, unknown>;
  return remember({ ...record, [step.key]: maskAt(record[step.key], rest) }, record);
}

/** The answer with the values at `paths` masked; the answer itself untouched. */
export function maskValues(data: unknown, paths: readonly string[] | undefined): unknown {
  if (!paths || paths.length === 0) return data;
  let out = data;
  for (const path of paths) out = maskAt(out, steps(path));
  return out;
}

/**
 * The mask, as drawn: four dots of a fixed width, and "hidden" to a screen
 * reader. Each dot is drawn rather than set as a bullet glyph, so it sits at
 * the middle of a figure's height in any font and at any size (a stat's
 * value line, a row's meta) instead of low and small beside the digits. The
 * bullets stay in the text for copying and for a page read without styles.
 */
export function Masked(): JSX.Element {
  return (
    <span className="pp-masked" role="img" aria-label="hidden">
      {[...MASK].map((dot, index) => (
        <span key={index} className="pp-mask-dot">
          {dot}
        </span>
      ))}
    </span>
  );
}

/**
 * The one control that shows what is masked and hides it again: a secondary
 * button with an eye, its words saying what pressing it does. A page head's
 * Show amounts, a sensitive section's Show and a Home block's Show are all
 * this, so they read alike.
 */
export function RevealToggle({
  shown,
  onToggle,
  show = 'Show',
  hide = 'Hide',
  size,
}: {
  shown: boolean;
  onToggle: () => void;
  show?: string;
  hide?: string;
  size?: 'sm';
}): JSX.Element {
  return (
    <Button className="pp-reveal" size={size} onClick={onToggle}>
      <Icon name="eye" size={size === 'sm' ? 14 : 16} />
      <span>{shown ? hide : show}</span>
    </Button>
  );
}

/**
 * Text that may hold the mask — a value on its own, or joined into a line
 * ("Checking · ••••"): each mask in it drawn as `Masked`.
 */
export function MaskText({ text }: { text: string | null | undefined }): JSX.Element | null {
  if (text === null || text === undefined) return null;
  if (!text.includes(MASK)) return <>{text}</>;
  const parts = text.split(MASK);
  const out: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (part) out.push(part);
    if (index < parts.length - 1) out.push(<Masked key={index} />);
  });
  return <>{out}</>;
}

/** True when a value, or anything in it, is masked. */
export function holdsMask(value: unknown): boolean {
  if (value === MASK) return true;
  if (Array.isArray(value)) return value.some(holdsMask);
  return false;
}

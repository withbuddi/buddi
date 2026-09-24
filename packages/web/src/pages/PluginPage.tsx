/**
 * One generic page, drawn from a descriptor.
 *
 * `docs/specs/plugin-pages.md` §5. Everything here is a *shape*: a section, a
 * list, a form, a detail. Nothing in this file knows a plugin, a tool or a
 * query by name — it is handed a tree, it draws it with the dashboard's own
 * primitives, and it asks the gateway for the data each piece names.
 *
 * Three rules decide almost every line below:
 *
 *  - **Reads are queries, writes are tools.** A component with a `query` asks
 *    `GET /api/pages/<plugin>/<query>`; a button posts `{ tool, args }` to the
 *    act route. When the tool is gated the answer is an approval id, and the
 *    page draws the very same `ApprovalCard` Home draws, in place.
 *  - **Untrusted content stays text.** Every value a query returns lands in a
 *    text node. There is no HTML here, no markdown and no link except the ones
 *    the descriptor builds out of a page id and an item id.
 *  - **The URL is the state.** The item of a list-detail is a route segment, a
 *    search's fields are page parameters, and a reload lands where the owner
 *    was — on a phone as much as on a desk.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type ApprovalRow } from '../api';
import { downloadUrl } from '../chat/attachments';
import { fmtValue } from '../canvas/format';
import { readPath, readRef } from '../canvas/resolve';
import { chatRoute, pluginPageRoute, pluginSettingsRoute, proposalsRoute } from '../routes';
import {
  Button,
  ButtonLink,
  Details,
  Empty,
  ErrorBanner,
  Field as FieldBox,
  FormGrid,
  KV,
  List,
  ListRow,
  Notice,
  PageFrame,
  PickRow,
  Pill,
  Section,
  Sheet,
  Spacer,
  Split,
  Chip,
  SearchBar,
  Stack,
  Stat,
  Stats,
  Table,
  Toolbar,
  useAsync,
} from '../ui';
import { ApprovalCard, useDecide } from '../views/parts/ApprovalCard';
import type {
  ArgRef,
  ColumnMap,
  Component,
  Field,
  ListComponent,
  ListItem,
  ParamRef,
  PluginPageDescriptor,
  QueryRef,
  RouteRef,
  PillRef,
  Tone,
  ToolRef,
  ValueRef,
  Visibility,
} from './types';

/* ------------------------------------------------------------------ *
 * The page's own scope: where it is, what it was asked, how to refresh
 * ------------------------------------------------------------------ */

interface PageScope {
  plugin: string;
  page: string;
  /** This plugin's pages, so a link knows whether its target is a tab. */
  pages: PluginPageDescriptor[];
  /** The item segment of the route, when the page is showing one. */
  item: string | null;
  /** Named parameters: the list-detail's item, a search's fields. */
  params: Record<string, string>;
  setParams: (patch: Record<string, string | null>) => void;
  navigate: (route: string) => void;
  timezone: string;
  /** Bumped by any successful write; every query depends on it. */
  version: number;
  refresh: () => void;
  /** This plugin's sensitive queries: what reads one is masked until asked. */
  sensitive: ReadonlySet<string>;
}

const Scope = createContext<PageScope | null>(null);

/** True under a sensitive section or gate that the owner has already opened. */
const Unmasked = createContext(false);

function useScope(): PageScope {
  const scope = useContext(Scope);
  if (!scope) throw new Error('a plugin page component outside a plugin page');
  return scope;
}

/* ------------------------------------------------------------------ *
 * Sensitive reads: masked as Home masks a sensitive block
 * ------------------------------------------------------------------ */

/** Every query a descriptor subtree reads, by name. */
function queriesOf(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) queriesOf(item, out);
  } else if (node && typeof node === 'object') {
    const query = (node as { query?: unknown }).query;
    if (typeof query === 'string') out.add(query);
    for (const value of Object.values(node)) queriesOf(value, out);
  }
  return out;
}

function readsSensitive(node: unknown, sensitive: ReadonlySet<string>): boolean {
  if (sensitive.size === 0) return false;
  for (const name of queriesOf(node)) if (sensitive.has(name)) return true;
  return false;
}

/**
 * Shown for this tab only. Leaving the window masks it again, so a screen
 * left unattended shows the shape of the page and none of its figures —
 * the rule Home's sensitive blocks follow.
 */
function useReveal(): [boolean, () => void] {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!revealed) return undefined;
    const hide = (): void => {
      if (document.visibilityState === 'hidden') setRevealed(false);
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('blur', hide);
    };
  }, [revealed]);
  return [revealed, () => setRevealed((v) => !v)];
}

function RevealButton({ revealed, onToggle }: { revealed: boolean; onToggle: () => void }): JSX.Element {
  return (
    <Button size="sm" variant="ghost" aria-pressed={revealed} onClick={onToggle}>
      {revealed ? 'Hide' : 'Show'}
    </Button>
  );
}

/** What stands where a masked read would be. Nothing is asked for until shown. */
function MaskedNote(): JSX.Element {
  return <p className="muted">Hidden until you show it.</p>;
}

/**
 * A piece outside any section that reads a sensitive query: its own Show,
 * right-aligned, above it.
 */
function SensitiveGate({ children }: { children: ReactNode }): JSX.Element {
  const [revealed, toggle] = useReveal();
  return (
    <Stack gap="sm">
      <Toolbar align="end">
        <RevealButton revealed={revealed} onToggle={toggle} />
      </Toolbar>
      {revealed ? <Unmasked.Provider value>{children}</Unmasked.Provider> : <MaskedNote />}
    </Stack>
  );
}

/** A tone the descriptor asked for, as a tone the primitives know. */
function noticeTone(tone: Tone | undefined): 'good' | 'warning' | 'critical' | 'accent' | undefined {
  return tone === undefined || tone === 'neutral' ? undefined : tone;
}

function pillTone(tone: Tone | undefined): 'good' | 'warning' | 'critical' | 'accent' | undefined {
  return noticeTone(tone);
}

/** A figure has no accent: a number is good, bad, or just a number. */
function statTone(tone: Tone | undefined): 'good' | 'warning' | 'critical' | undefined {
  const drawn = noticeTone(tone);
  return drawn === 'accent' ? undefined : drawn;
}

/**
 * Does this condition hold of the data?
 *
 * `equals` is one value, `in` is a set of them, `not` inverts whichever was
 * given. It is the only logic a descriptor may carry, and it is deliberately
 * not an expression language: a page that needs arithmetic needs a query that
 * returns the number.
 */
export function holds(data: unknown, condition: Visibility | undefined): boolean {
  if (!condition) return true;
  const value = readPath(data, condition.path);
  const matched = condition.in !== undefined ? condition.in.includes(value) : value === condition.equals;
  return condition.not === true ? !matched : matched;
}

/**
 * Where a route reference points, inside this plugin.
 *
 * A page that lives in Settings is a *tab*, not a place: linking to it with
 * `#/p/<plugin>/<page>` would open a page with no tabs around it and no way
 * back to the rest of the settings. So the descriptor says `{ page }` and the
 * engine works out which hash that is.
 */
function routeOf(scope: PageScope, to: RouteRef, data: unknown): string {
  /*
   * The one link that leaves the plugin: an agent's chat. `chat` is a value
   * read out of the data — an agent id a query answered — so what a descriptor
   * says is "the holder", not a URL. An id the data does not carry is no link
   * at all rather than a route to nowhere.
   */
  if ('chat' in to) {
    const agentId = readRef(data, to.chat);
    return agentId === null || agentId === undefined ? '' : chatRoute(String(agentId));
  }
  // The other: the owner's Proposals inbox, filtered to the plugin drawing this page.
  if ('proposals' in to) return proposalsRoute(scope.plugin);
  const target = scope.pages.find((page) => page.id === to.page);
  if (target?.place === 'settings') return pluginSettingsRoute(scope.plugin, to.page);
  const item = to.item === undefined ? null : readRef(data, to.item);
  return pluginPageRoute(scope.plugin, to.page, item === null || item === undefined ? null : String(item));
}

/**
 * The words on a button, with its blanks filled.
 *
 * `{count}` is how many rows the action is about, `{one|many}` is the word
 * that goes with it, and `{field}` is read out of the row — "Remove
 * {address}?" asks about the thing in front of the owner. Anything the data
 * does not answer is left as an empty string rather than printed raw.
 */
export function fill(text: string, source: { count?: number; row?: unknown }): string {
  return text
    .replace(/\{count\}/g, String(source.count ?? 0))
    .replace(/\{([^{}|]+)\|([^{}|]+)\}/g, (_all, one: string, many: string) => ((source.count ?? 0) === 1 ? one : many))
    .replace(/\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (_all, path: string) => {
      const value = readPath(source.row, path);
      return value === undefined || value === null ? '' : String(value);
    });
}

/** A tone the descriptor named, or one the row carries. */
function toneFrom(tone: Tone | ValueRef | undefined, row: unknown): Tone | undefined {
  if (tone === undefined) return undefined;
  if (typeof tone === 'string') return tone;
  const value = readRef(row, tone);
  return value === 'good' || value === 'warning' || value === 'critical' || value === 'neutral' ? value : undefined;
}

/** A query's parameters, resolved against the data, the route and the page. */
function resolveParams(
  params: Record<string, ParamRef> | undefined,
  data: unknown,
  scope: PageScope,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(params ?? {})) {
    let value: unknown;
    if ('param' in ref) value = scope.params[ref.param];
    else if ('route' in ref) value = ref.route === 'plugin' ? scope.plugin : ref.route === 'page' ? scope.page : scope.item;
    else value = readRef(data, ref);
    // An absent parameter is left out rather than sent as an empty string: the
    // plugin's schema decides whether it was optional.
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

/** What a tool call is given, from wherever the descriptor says it comes. */
function resolveArgs(
  args: Record<string, ArgRef> | undefined,
  source: {
    data: unknown;
    row?: unknown;
    fields?: Record<string, unknown>;
    /** The field definitions behind those values, for what "empty" means. */
    shape?: Field[];
    /** Field names the form is not asking for: hidden, or greyed. */
    omit?: ReadonlySet<string>;
    selected?: string[];
    scope: PageScope;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, ref] of Object.entries(args ?? {})) {
    if ('row' in ref) out[key] = readPath(source.row, ref.row);
    else if ('field' in ref) {
      // A field the owner cannot see or cannot change is a field they said
      // nothing about: it is left out, and the tool's own default stands.
      if (source.omit?.has(ref.field)) continue;
      const value = source.fields?.[ref.field];
      const field = source.shape?.find((f) => f.name === ref.field);
      /*
       * A number field nobody touched holds `''`, and a `z.number()` tool
       * refuses that with a message about a string. An untouched optional
       * field is a field the owner said nothing about, so it is left out and
       * the tool's own default stands.
       */
      if (value === '' && field?.required !== true && (field === undefined || field.type === 'number')) continue;
      out[key] = value;
    } else if ('selected' in ref) out[key] = source.selected ?? [];
    else if ('param' in ref) out[key] = source.scope.params[ref.param];
    else out[key] = readRef(source.data, ref);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Reads and writes
 * ------------------------------------------------------------------ */

function usePageQuery(ref: QueryRef | undefined, data: unknown): { data: unknown; error: string | null; loading: boolean } {
  const scope = useScope();
  const params = ref ? resolveParams(ref.params, data, scope) : {};
  const key = JSON.stringify([ref?.query ?? null, params, scope.version]);
  const state = useAsync<unknown>(
    () => (ref ? api.pageQuery(scope.plugin, ref.query, params).then((body) => body.data) : Promise.resolve(undefined)),
    [key],
  );
  return { data: state.data, error: state.error, loading: state.loading };
}

interface ActState {
  /** The tool now running, by name, or null. */
  running: string | null;
  busy: boolean;
  error: string | null;
  /** What the descriptor said to say once it worked. */
  done: string | null;
  approvalId: string | null;
  /** The descriptor's sentence for the action now waiting on that approval. */
  waiting: string | null;
  /** Decided: apply what the pending action's `then` asked for, or let it go. */
  settle: (outcome?: { decision: 'approve' | 'reject'; state?: string; result?: unknown }) => void;
  run: (ref: ToolRef, args: Record<string, unknown>, onDone?: () => void) => Promise<void>;
}

/**
 * One write, and what happens next.
 *
 * `then` is the descriptor's answer to "and then?": refresh the queries (the
 * default), close the drawer this was in, or go somewhere. A gated tool
 * answers with an approval instead, and nothing has happened yet — which is
 * exactly what the card the caller then draws says.
 */
function useAct(): ActState {
  const scope = useScope();
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  /** What a gated action asked to happen *after* — held until it has. */
  const [pending, setPending] = useState<{ then: ToolRef['then']; ref: ToolRef; onDone?: () => void } | null>(null);

  /** The sentence for a write that worked, from the descriptor or the result. */
  const saidDone = (ref: ToolRef, result: unknown): string | null => {
    if (ref.done === undefined) return null;
    if (typeof ref.done === 'string') return ref.done;
    const value = readRef(result, ref.done);
    return value === undefined || value === null ? null : String(value);
  };

  /** Do what `then` says. Only ever called when something actually happened. */
  const apply = (then: ToolRef['then'], result: unknown, onDone?: () => void): void => {
    const what = then ?? 'refresh';
    if (typeof what === 'object') {
      // A route the data could not answer — `{ chat }` over a null id — is no
      // route: refreshing where the owner is beats navigating to nowhere.
      const to = routeOf(scope, what.route, result);
      if (to === '') scope.refresh();
      else scope.navigate(to);
      return;
    }
    if (what === 'close') onDone?.();
    scope.refresh();
  };

  const run = async (ref: ToolRef, args: Record<string, unknown>, onDone?: () => void): Promise<void> => {
    setRunning(ref.tool);
    setError(null);
    setDone(null);
    try {
      const out = await api.pageAct(scope.plugin, { tool: ref.tool, args });
      if (out.approvalId) {
        /*
         * A gated tool: **nothing has happened yet**. Closing the drawer or
         * navigating away now would tell the owner their draft was sent while
         * the approval is still sitting there, so `then` is held and applied
         * only once the decision has executed.
         */
        setApprovalId(out.approvalId);
        setPending({ then: ref.then, ref, ...(onDone ? { onDone } : {}) });
        return;
      }
      setApprovalId(null);
      setPending(null);
      setDone(saidDone(ref, out.result));
      apply(ref.then, out.result, onDone);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      /*
       * A write that failed usually failed *about* something: a draft
       * somebody else has already moved past, a row that is gone. So the
       * component re-reads while the banner stays — the owner sees the
       * sentence and, underneath it, what is actually there now.
       */
      scope.refresh();
    } finally {
      setRunning(null);
    }
  };

  const settle = (outcome?: { decision: 'approve' | 'reject'; state?: string; result?: unknown }): void => {
    /*
     * Nothing was decided — the decision call itself failed — so nothing is
     * settled: the card stays, and so does what it was going to do next. The
     * owner can press again; the alternative is an approval that quietly
     * disappears from the page while it is still pending on the server.
     */
    if (!outcome) {
      scope.refresh();
      return;
    }
    const held = pending;
    setApprovalId(null);
    setPending(null);
    // Approved *and* executed is the only outcome in which the thing the
    // action was about has actually happened. Anything else just refreshes.
    if (held && outcome.decision === 'approve' && outcome.state === 'succeeded') {
      // Only now is the sentence true: the effect has happened — and it is
      // read out of what the approval's own execution returned.
      setDone(saidDone(held.ref, outcome.result));
      apply(held.then, undefined, held.onDone);
      return;
    }
    scope.refresh();
  };

  return { running, busy: running !== null, error, done, approvalId, waiting: pending?.ref.pending ?? null, settle, run };
}

/**
 * A button that does something, and asks first when the descriptor says to.
 *
 * The confirmation is drawn in the page rather than in a browser dialog: it
 * says which sentence the owner is agreeing to, and the primary answer sits on
 * the right like every other primary action.
 */
function ActionButton({
  action,
  args,
  disabled,
  running,
  count,
  row,
  onRun,
}: {
  action: ToolRef;
  args: Record<string, unknown>;
  disabled?: boolean;
  /** This action is the one in flight: it says so instead of its label. */
  running?: boolean;
  /** How many rows this is about, for `{count}` and `{one|many}`. */
  count?: number;
  /** The row it sits on, for `{field}` in its words. */
  row?: unknown;
  onRun: (ref: ToolRef, args: Record<string, unknown>) => void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const words = (text: string): string => fill(text, { ...(count === undefined ? {} : { count }), row });
  const label = words(action.label);
  if (asking && action.confirm) {
    return (
      <>
        <span className="ui-toolbar-note">{words(action.confirm)}</span>
        <Button variant="ghost" onClick={() => setAsking(false)}>
          Cancel
        </Button>
        <Button
          variant={action.tone === 'danger' ? 'danger' : 'accent'}
          disabled={disabled}
          onClick={() => {
            setAsking(false);
            onRun(action, args);
          }}
        >
          Yes, {label.toLowerCase()}
        </Button>
      </>
    );
  }
  return (
    <Button
      variant={action.tone === 'danger' ? 'danger' : action.tone === 'accent' ? 'accent' : undefined}
      disabled={disabled}
      onClick={() => (action.confirm ? setAsking(true) : onRun(action, args))}
    >
      {running && action.busy ? action.busy : label}
    </Button>
  );
}

/**
 * One approval, by id: the card Home draws, drawn here.
 *
 * `onDecided` is told what the decision *did* — approved and executed, or
 * anything else — because a caller waiting to apply a `then` may only apply it
 * when the thing has actually happened.
 */
function ApprovalById({
  id,
  onDecided,
}: {
  id: string;
  onDecided?: (outcome?: { decision: 'approve' | 'reject'; state?: string; result?: unknown }) => void;
}): JSX.Element {
  const scope = useScope();
  const action = useAsync<ApprovalRow>(() => api.approval(id), [id, scope.version]);
  const { busy, note, failure, decide } = useDecide((outcome) => {
    if (onDecided) onDecided(outcome);
    else scope.refresh();
  });
  if (action.error) return <ErrorBanner message={action.error} />;
  if (!action.data) return <Empty>Loading the approval…</Empty>;
  return (
    <Stack>
      <ApprovalCard
        action={action.data}
        timezone={scope.timezone}
        busy={busy === id}
        onDecide={(actionId, decision, scopeChoice, choices) => {
          void decide(actionId, decision, scopeChoice, choices);
        }}
      />
      {note ? <Notice tone="good" role="status">{note}</Notice> : null}
      <ErrorBanner message={failure} />
    </Stack>
  );
}

/** The bit every write shows: what went wrong, or what is now waiting. */
function ActOutcome({ act }: { act: ActState }): JSX.Element | null {
  if (act.error) return <ErrorBanner message={act.error} />;
  if (act.approvalId) {
    // What the button has *not* done yet, above the card that will do it.
    if (!act.waiting) return <ApprovalById id={act.approvalId} onDecided={act.settle} />;
    return (
      <Stack>
        <Notice role="status">{act.waiting}</Notice>
        <ApprovalById id={act.approvalId} onDecided={act.settle} />
      </Stack>
    );
  }
  if (act.done) {
    return (
      <Notice tone="good" role="status">
        {act.done}
      </Notice>
    );
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Fields
 * ------------------------------------------------------------------ */

type Values = Record<string, unknown>;

/** What a form starts with: each field's `from` path, or an empty control. */
function initialValues(fields: Field[], data: unknown): Values {
  const values: Values = {};
  for (const field of fields) {
    const found = field.from === undefined ? undefined : readPath(data, field.from);
    values[field.name] =
      found !== undefined ? found : field.type === 'checkbox' ? false : field.type === 'number' ? '' : '';
  }
  return values;
}

/**
 * A select's options, when a query rather than the descriptor knows them.
 *
 * Read when the form opens and again whenever one of `dependsOn` changes,
 * with those fields' current values as the parameters — which is how "the
 * mailbox, then the conversations in it" is one form and not two screens.
 * Unconditionally a hook: a field with no `optionsFrom` simply asks nothing.
 */
function useFieldOptions(
  field: Field,
  values: Values,
  data: unknown,
): { options: Array<{ value: string; label: string }>; loading: boolean } {
  const scope = useScope();
  const from = field.optionsFrom;
  const params = from
    ? {
        ...resolveParams(from.query.params, data, scope),
        ...Object.fromEntries(
          (from.dependsOn ?? [])
            .map((name) => [name, String(values[name] ?? '')] as const)
            .filter(([, value]) => value !== ''),
        ),
      }
    : {};
  const key = JSON.stringify([from?.query.query ?? null, params, scope.version]);
  const state = useAsync<unknown>(
    () =>
      from ? api.pageQuery(scope.plugin, from.query.query, params).then((body) => body.data) : Promise.resolve(undefined),
    [key],
  );
  if (!from) return { options: field.options ?? [], loading: false };
  return {
    options: rowsOf(state.data, from.rows).map((row) => ({
      value: String(readPath(row, from.value) ?? ''),
      label: String(readPath(row, from.label) ?? ''),
    })),
    loading: state.loading,
  };
}

function FieldControl({
  field,
  value,
  values,
  data,
  disabled,
  compact,
  onChange,
}: {
  field: Field;
  /** In a search bar: the hint is a placeholder and a tooltip, not a line under the field. */
  compact?: boolean;
  value: unknown;
  /** Every value on this form, for `optionsFrom.dependsOn`. */
  values: Values;
  /** What the query answered, for a `ValueRef` in the options' parameters. */
  data: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const choices = useFieldOptions(field, values, data);
  const shared = {
    id: `f-${field.name}`,
    required: field.required,
    name: field.name,
    disabled,
    ...(compact && field.hint ? { title: field.hint } : {}),
  };
  const hint = compact ? undefined : field.hint;
  if (field.type === 'select') {
    return (
      <FieldBox label={field.label} hint={hint}>
        <select {...shared} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">{choices.loading ? 'Loading…' : '—'}</option>
          {choices.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FieldBox>
    );
  }
  if (field.type === 'textarea') {
    return (
      <FieldBox label={field.label} hint={hint} wide>
        <textarea {...shared} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} rows={6} />
      </FieldBox>
    );
  }
  if (field.type === 'checkbox') {
    return (
      <FieldBox label={field.label} hint={hint} inline wide={!compact}>
        <input {...shared} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      </FieldBox>
    );
  }
  const type = field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : field.type;
  return (
    <FieldBox label={field.label} hint={hint}>
      <input
        {...shared}
        type={type}
        value={value === null || value === undefined ? '' : String(value)}
        min={field.min}
        max={field.max}
        step={field.step}
        {...(compact && field.hint ? { placeholder: field.hint } : {})}
        onChange={(e) => onChange(field.type === 'number' ? numberOrText(e.target.value) : e.target.value)}
      />
    </FieldBox>
  );
}

/** A number field holds a number when it can, and the typing otherwise. */
function numberOrText(raw: string): unknown {
  if (raw.trim() === '') return '';
  const value = Number(raw);
  return Number.isFinite(value) ? value : raw;
}

/**
 * What the form is asking *now*: its own values over the data behind it.
 *
 * A path that names a field reads what the owner has just typed; anything
 * else reads what the query answered. One object, computed the same way
 * wherever a field's conditions are asked, so what is drawn and what is
 * submitted can never disagree.
 */
function askedOf(values: Values, data: unknown): Record<string, unknown> {
  return { ...(typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}), ...values };
}

/**
 * Fields the form is not really asking for: hidden by `when`, or greyed by
 * `disabledWhen`.
 *
 * They are not required — a form that will not submit because of a field
 * nobody can see is a dead end — and their values are not sent: the owner
 * said nothing about them, and a tool must not be handed the leftovers of a
 * branch that is not taken.
 */
function inactiveFields(fields: Field[], values: Values, data: unknown): Set<string> {
  const asked = askedOf(values, data);
  return new Set(
    fields
      .filter(
        (field) =>
          (field.when !== undefined && !holds(asked, field.when)) ||
          (field.disabledWhen !== undefined && holds(asked, field.disabledWhen)),
      )
      .map((field) => field.name),
  );
}

function Fields({
  fields,
  values,
  data,
  disabled,
  compact,
  onChange,
}: {
  fields: Field[];
  /** The search bar's filters: a dense grid, hints as tooltips. */
  compact?: boolean;
  values: Values;
  /** What `when` and `disabledWhen` are asked of, under the form's own values. */
  data?: unknown;
  /** Every field at once: an editor the descriptor says is read-only. */
  disabled?: boolean;
  onChange: (name: string, value: unknown) => void;
}): JSX.Element {
  /*
   * The form's own values sit *over* the loaded data — see `askedOf`. That is
   * what makes "show the host fields when Advanced is ticked" work without a
   * round trip, and why the values win: on this form, the field is the more
   * recent truth about itself.
   */
  const asked = askedOf(values, data);
  return (
    <FormGrid dense={compact}>
      {fields
        .filter((field) => field.when === undefined || holds(asked, field.when))
        .map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            compact={compact}
            value={values[field.name]}
            values={values}
            data={data}
            disabled={disabled === true || (field.disabledWhen !== undefined && holds(asked, field.disabledWhen))}
            onChange={(value) => onChange(field.name, value)}
          />
        ))}
    </FormGrid>
  );
}

/* ------------------------------------------------------------------ *
 * The components
 * ------------------------------------------------------------------ */

/**
 * True for a piece drawn at the top of a settings page. It keeps its head on
 * the ground and what it holds in one white panel under it; anything inside
 * that panel is a group of it, divided by hairlines, never a second panel.
 */
const Boxed = createContext(false);

/** True directly inside a boxed piece's panel: a form's Save is that panel's foot. */
const PanelTop = createContext(false);

/** True for the list of a list-detail: its rows pick what the pane beside it shows. */
const InSplit = createContext(false);

/** A piece's titled group: a panel under its head when it is boxed. */
function PieceSection({
  title,
  note,
  actions,
  children,
}: {
  title?: string | undefined;
  note?: string | undefined;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const boxed = useContext(Boxed);
  return (
    <Section title={title} aside={note} actions={actions} panel={boxed}>
      <Boxed.Provider value={false}>
        <PanelTop.Provider value={boxed}>{children}</PanelTop.Provider>
      </Boxed.Provider>
    </Section>
  );
}

function Piece({
  component,
  data,
  choose,
  chosen,
}: {
  component: Component;
  data: unknown;
  /** Only ever set on the list of a `local` list-detail. */
  choose?: (key: string) => void;
  chosen?: string | null;
}): JSX.Element | null {
  const scope = useScope();
  const unmasked = useContext(Unmasked);
  // `when` is the only logic a descriptor may carry.
  if (!holds(data, component.when)) return null;
  // A section masks itself; anything else that reads a sensitive query, and
  // is not inside a section that has already been shown, gets a gate of its own.
  if (component.kind !== 'section' && !unmasked && readsSensitive(component, scope.sensitive)) {
    return (
      <SensitiveGate>
        <Piece component={component} data={data} {...(choose ? { choose } : {})} {...(chosen === undefined ? {} : { chosen })} />
      </SensitiveGate>
    );
  }
  switch (component.kind) {
    case 'section':
      return <SectionPiece component={component} data={data} />;
    case 'notice':
      return (
        <Notice tone={noticeTone(component.tone)} title={component.title}>
          {typeof component.text === 'string' ? component.text : String(readRef(data, component.text) ?? '')}
        </Notice>
      );
    case 'link':
      return <LinkPiece component={component} data={data} />;
    case 'stats':
      return <StatsPiece component={component} data={data} />;
    case 'list':
      return (
        <ListPiece
          component={component}
          data={data}
          {...(choose ? { onChoose: choose } : {})}
          {...(chosen === undefined ? {} : { chosen })}
        />
      );
    case 'table':
      return <TablePiece component={component} data={data} />;
    case 'detail':
      return <DetailPiece component={component} data={data} />;
    case 'form':
      return <FormPiece component={component} data={data} />;
    case 'search':
      return <SearchPiece component={component} data={data} />;
    case 'list-detail':
      return <ListDetailPiece component={component} data={data} />;
    case 'repeat':
      return <RepeatPiece component={component} data={data} />;
    case 'expand':
      return <ExpandPiece component={component} data={data} />;
    case 'button':
      return <ButtonPiece component={component} data={data} />;
    case 'approval':
      return <ApprovalPiece component={component} data={data} />;
    case 'artifact':
      return <ArtifactPiece component={component} data={data} />;
    case 'editor':
      return <EditorPiece component={component} data={data} />;
    default:
      return null;
  }
}

type Of<K extends Component['kind']> = Extract<Component, { kind: K }>;

/**
 * A section, masked while it reads a sensitive query: the Show sits at the
 * right of its heading, after the section's own actions, and nothing inside
 * is asked for until it is pressed.
 */
function SectionPiece({ component, data }: { component: Of<'section'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const unmasked = useContext(Unmasked);
  const [revealed, toggle] = useReveal();
  const gated = !unmasked && readsSensitive(component.body, scope.sensitive);
  const masked = gated && !revealed;
  const boxed = useContext(Boxed);
  /*
   * Boxed, a button, a link or a drawer's button that ends the body is something done to the
   * section rather than a row of it: it moves up into the head, where the
   * section's own actions are, instead of sitting alone at the panel's foot.
   */
  let end = component.body.length;
  const headable = (piece: Component): boolean =>
    piece.kind === 'button' || piece.kind === 'link' || (piece.kind === 'form' && piece.drawer !== undefined && !piece.title);
  while (boxed && end > 0 && headable(component.body[end - 1]!)) end -= 1;
  const body = component.body.slice(0, end);
  const actions = [...(component.actions ?? []), ...component.body.slice(end)];
  return (
    <PieceSection
      title={component.title}
      note={component.note}
      /*
       * The right of the heading: where this section's own way out goes —
       * "Mailboxes and rules" — rather than a button lost at the bottom of a
       * list.
       */
      actions={
        actions.length > 0 || gated ? (
          <>
            {actions.map((action, index) => (
              <Piece key={index} component={action} data={data} />
            ))}
            {gated ? <RevealButton revealed={revealed} onToggle={toggle} /> : null}
          </>
        ) : undefined
      }
    >
      <Stack gap="lg" divided={boxed}>
        {masked ? (
          <MaskedNote />
        ) : (
          <Unmasked.Provider value={unmasked || gated}>
            {body.map((child, index) => (
              <Piece key={index} component={child} data={data} />
            ))}
          </Unmasked.Provider>
        )}
      </Stack>
    </PieceSection>
  );
}

function LinkPiece({ component, data }: { component: Of<'link'>; data: unknown }): JSX.Element | null {
  const scope = useScope();
  const href = routeOf(scope, component.to, data);
  /*
   * No route, no link. `{ chat }` reads an agent id out of the data, and a
   * query that answered null for it has said there is nobody to go to — a
   * button that navigates to the empty hash is worse than no button.
   */
  if (href === '') return null;
  return (
    <Toolbar>
      <ButtonLink
        href={href}
        onClick={(e) => {
          e.preventDefault();
          scope.navigate(href);
        }}
      >
        {component.label}
      </ButtonLink>
    </Toolbar>
  );
}

function StatsPiece({ component, data }: { component: Of<'stats'>; data: unknown }): JSX.Element {
  const query = usePageQuery(component.query, data);
  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      {query.data === undefined ? (
        <Empty>{component.empty ?? 'Loading…'}</Empty>
      ) : (
        <Stats>
          {component.items.map((item, index) => (
            <Stat
              key={index}
              label={item.label}
              value={fmtValue(readRef(query.data, item.value), item.unit ?? 'text', null)}
              tone={statTone(item.tone)}
            />
          ))}
        </Stats>
      )}
    </PieceSection>
  );
}

/**
 * One line of a list, drawn from the descriptor's `item`.
 *
 * The link is on the *title*, never on the row: a row may also carry a
 * checkbox and a button, and neither of those may live inside an anchor.
 */
function itemRow(
  scope: PageScope,
  item: ListItem,
  row: unknown,
  /** When the list chooses in the page rather than in the URL, there is no link. */
  local?: (key: string) => void,
): { title: ReactNode; sub: ReactNode; side: ReactNode; pills: ReactNode; meta: string; href: string | null; text: string } {
  const meta = (item.meta ?? []).map((ref) => String(readRef(row, ref) ?? '')).filter((text) => text !== '');
  const text = String(readRef(row, item.title) ?? '');
  const href = item.to && !local ? routeOf(scope, item.to, row) : null;
  const pills: PillRef[] = [...(item.pill ? [item.pill] : []), ...(item.pills ?? [])];
  const drawnPills = pills.map((pill, index) => {
    const value = readRef(row, pill.value);
    if (value === undefined || value === null || value === '') return null;
    const said = pillWords(pill, value, row);
    return (
      <Pill key={index} tone={pillTone(said.tone)}>
        {said.text}
      </Pill>
    );
  });
  return {
    text,
    href,
    pills: <>{drawnPills}</>,
    meta: meta.join(' · '),
    title: href ? (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          scope.navigate(href);
        }}
      >
        {text}
      </a>
    ) : (
      text
    ),
    sub: item.sub ? String(readRef(row, item.sub) ?? '') : null,
    side: (
      <>
        {drawnPills}
        {meta.length > 0 ? <span className="muted"> {meta.join(' · ')}</span> : null}
      </>
    ),
  };
}

/**
 * A pill's words and tone for one value: the descriptor's `labels` turn a
 * slug into what the owner reads, and its `tones` say which values catch the
 * eye — over the `tone` it names for every value. A value it does not list
 * is drawn as it came.
 */
export function pillWords(
  pill: { tone?: Tone | ValueRef; labels?: Record<string, string>; tones?: Record<string, Tone> },
  value: unknown,
  row: unknown,
): { text: string; tone: Tone | undefined } {
  const key = String(value);
  const labels = pill.labels ?? {};
  const tones = pill.tones ?? {};
  return {
    text: Object.prototype.hasOwnProperty.call(labels, key) ? (labels[key] as string) : key,
    tone: Object.prototype.hasOwnProperty.call(tones, key) ? tones[key] : toneFrom(pill.tone, row),
  };
}

function rowsOf(data: unknown, path: string): unknown[] {
  const rows = readPath(data, path);
  return Array.isArray(rows) ? rows : [];
}

/**
 * The rows, each with what makes it itself — and never its position.
 *
 * A row keyed by its index collides across a grouped list, across the folded
 * rows, and across two answers a moment apart: the owner ticks one thing and
 * another is sent to the tool. So a row whose key is missing or repeated is
 * *left out*, and the page says so in the console naming the plugin, the page
 * and the component, because a plugin's descriptor and its query disagreeing
 * is the plugin author's bug to find.
 */
function keyedRows(
  rows: readonly unknown[],
  keyPath: string | undefined,
  where: { plugin: string; page: string; component: string },
): Array<{ key: string; row: unknown }> {
  const out: Array<{ key: string; row: unknown }> = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const raw = keyPath === undefined ? undefined : readPath(row, keyPath);
    const key = raw === undefined || raw === null || raw === '' ? null : String(raw);
    if (key === null) {
      console.warn(
        `buddi: plugin ${where.plugin}, page ${where.page}, ${where.component}: row ${index} has no value at "${keyPath ?? '(no key)'}" — not drawn`,
      );
      return;
    }
    if (seen.has(key)) {
      console.warn(
        `buddi: plugin ${where.plugin}, page ${where.page}, ${where.component}: two rows share the key "${key}" — the second is not drawn`,
      );
      return;
    }
    seen.add(key);
    out.push({ key, row });
  });
  return out;
}

function ListPiece({
  component,
  data,
  onChoose,
  chosen,
}: {
  component: ListComponent;
  data: unknown;
  /** A list-detail that keeps its selection in the page rather than the URL. */
  onChoose?: (key: string) => void;
  chosen?: string | null;
}): JSX.Element {
  const scope = useScope();
  const inSplit = useContext(InSplit);
  const query = usePageQuery(component.query, data);
  const act = useAct();
  const [selected, setSelected] = useState<string[]>([]);
  /*
   * The list beside a reading pane is the roster's: a whole row is the link,
   * the chosen one marked. A list that also ticks rows or carries buttons
   * keeps the plain rows — a checkbox cannot live inside a link.
   */
  const pick =
    inSplit && !component.select && (component.actions ?? []).length === 0 && (component.bulk ?? []).length === 0;
  const rows = rowsOf(query.data, component.rows);
  const folded = component.collapsed ? rowsOf(query.data, component.collapsed.rows) : [];

  /*
   * What makes each row itself, decided once for the whole list — the shown
   * rows and the folded ones together, so a key repeated across the two is
   * caught as the collision it is.
   */
  const where = { plugin: scope.plugin, page: scope.page, component: `list "${component.title ?? component.rows}"` };
  const keyed = keyedRows([...rows, ...folded], component.key ?? component.select?.key, where);
  const keyByRow = new Map(keyed.map((entry) => [entry.row, entry.key]));
  const drawable = new Set(keyed.map((entry) => entry.row));
  /** The rows the owner may act on: ticked, still present, and still enabled. */
  const enabled = new Set(
    keyed
      .filter(({ row }) => component.select?.disabledWhen === undefined || !holds(row, component.select.disabledWhen))
      .map(({ key }) => key),
  );
  const actionable = selected.filter((key) => enabled.has(key));

  const groups = useMemo(() => {
    const shown = rows.filter((row) => drawable.has(row));
    if (!component.groupBy) return [{ label: null as string | null, rows: shown }];
    const by = new Map<string, unknown[]>();
    for (const row of shown) {
      const key = String(readPath(row, component.groupBy.key) ?? '');
      by.set(key, [...(by.get(key) ?? []), row]);
    }
    return [...by].map(([key, group]) => ({ label: component.groupBy?.labels?.[key] ?? key, rows: group }));
  }, [rows, component.groupBy, keyed.length]);

  const lines = (group: unknown[]): JSX.Element[] =>
    group.map((row) => {
      const drawn = itemRow(scope, component.item, row, onChoose);
      const key = keyByRow.get(row) as string;
      if (pick && (onChoose || drawn.href)) {
        return (
          <PickRow
            key={key}
            href={drawn.href ?? '#'}
            current={chosen === key}
            onClick={() => (onChoose ? onChoose(key) : scope.navigate(drawn.href as string))}
            title={drawn.text}
            meta={drawn.meta}
            sub={drawn.sub}
            side={drawn.pills}
          />
        );
      }
      const disabled = component.select?.disabledWhen !== undefined && holds(row, component.select.disabledWhen);
      const actions = (component.actions ?? []).filter((action) => holds(row, action.when));
      return (
        <ListRow
          key={key}
          lead={
            component.select ? (
              <input
                type="checkbox"
                aria-label={`Select ${drawn.text}`}
                disabled={disabled}
                checked={selected.includes(key)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  setSelected((current) =>
                    e.target.checked ? [...current, key] : current.filter((id) => id !== key),
                  )
                }
              />
            ) : undefined
          }
          title={
            onChoose ? (
              <a
                href="#"
                aria-current={chosen === key ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  onChoose(key);
                }}
              >
                {drawn.text}
              </a>
            ) : (
              drawn.title
            )
          }
          sub={drawn.sub}
          side={
            <>
              {drawn.side}
              {actions.map((action, i) => (
                <ActionButton
                  key={i}
                  action={action}
                  args={resolveArgs(action.args, { data: query.data, row, scope })}
                  disabled={act.busy}
                  running={act.running === action.tool}
                  row={row}
                  onRun={(ref, args) => void act.run(ref, args)}
                />
              ))}
            </>
          }
        />
      );
    });

  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      <ActOutcome act={act} />
      {groups.every((group) => group.rows.length === 0) ? (
        <Empty>{query.loading ? 'Loading…' : (component.empty ?? 'Nothing here.')}</Empty>
      ) : (
        <List>
          {component.select ? (
            <ListRow
              lead={
                <input
                  type="checkbox"
                  aria-label="Select every row"
                  checked={enabled.size > 0 && actionable.length === enabled.size}
                  disabled={enabled.size === 0}
                  onChange={(e) => setSelected(e.target.checked ? [...enabled] : [])}
                />
              }
              title={<span className="muted">{enabled.size} to choose from</span>}
            />
          ) : null}
          {groups.map((group, index) => (
            <div key={index}>
              {group.label ? <div className="ui-list-group">{group.label}</div> : null}
              {lines(group.rows)}
            </div>
          ))}
        </List>
      )}
      {component.collapsed && folded.some((row) => drawable.has(row)) ? (
        <Details summary={`${component.collapsed.label} (${folded.filter((row) => drawable.has(row)).length})`}>
          <List>{lines(folded.filter((row) => drawable.has(row)))}</List>
        </Details>
      ) : null}
      {component.bulk && component.bulk.length > 0 ? (
        <Toolbar align="end">
          <span className="ui-toolbar-note">{actionable.length} selected</span>
          {component.bulk.map((action, index) => {
            /*
             * With nothing ticked, an `all` action is about every row the
             * owner may act on — a button that says "Keep all 12" and means
             * it, rather than one that is there and does nothing.
             */
            const over = actionable.length > 0 || action.all !== true ? actionable : [...enabled];
            return (
              <ActionButton
                key={index}
                action={action}
                /*
                 * The selection as it stands *now*: a row that was ticked and
                 * has since gone, or become one the owner may not act on, is
                 * not sent to the tool.
                 */
                args={resolveArgs(action.args, { data: query.data, selected: over, scope })}
                count={over.length}
                disabled={act.busy || over.length === 0}
                running={act.running === action.tool}
                onRun={(ref, args) => {
                  setSelected([]);
                  void act.run(ref, args);
                }}
              />
            );
          })}
        </Toolbar>
      ) : null}
    </PieceSection>
  );
}

function TablePiece({ component, data }: { component: Of<'table'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const query = usePageQuery(component.query, data);
  const act = useAct();
  const rows = rowsOf(query.data, component.rows);
  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      <ActOutcome act={act} />
      {rows.length === 0 ? (
        <Empty>{query.loading ? 'Loading…' : (component.empty ?? 'Nothing here.')}</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              {component.columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
              {component.actions && component.actions.length > 0 ? <th aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {component.columns.map((column) => (
                  <td key={column.key}>
                    {column.pill ? (
                      <PillCell column={column} row={row} />
                    ) : (
                      fmtValue(readPath(row, column.key), column.type ?? 'text', null)
                    )}
                  </td>
                ))}
                {component.actions && component.actions.length > 0 ? (
                  <td>
                    <Toolbar align="end">
                      {component.actions
                        .filter((action) => holds(row, action.when))
                        .map((action, i) => (
                          <ActionButton
                            key={i}
                            action={action}
                            args={resolveArgs(action.args, { data: query.data, row, scope })}
                            disabled={act.busy}
                            running={act.running === action.tool}
                            row={row}
                            onRun={(ref, args) => void act.run(ref, args)}
                          />
                        ))}
                    </Toolbar>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </PieceSection>
  );
}

/**
 * A cell drawn as state rather than as text.
 *
 * One pill for one value — in the tone the column named, which may itself be
 * a path — and one pill *per item* when the cell holds an array of
 * `{ value, tone }`: an account that is switched off and configured from the
 * environment is two facts about it, not a sentence to be parsed.
 */
function PillCell({ column, row }: { column: ColumnMap; row: unknown }): JSX.Element {
  const value = readPath(row, column.key);
  if (Array.isArray(value)) {
    return (
      <>
        {value.map((item, index) => {
          const one = item as { value?: unknown; tone?: unknown };
          const text = typeof one === 'object' && one !== null ? one.value : item;
          if (text === undefined || text === null || text === '') return null;
          const tone = typeof one === 'object' && one !== null ? one.tone : undefined;
          const labels = column.pill?.labels;
          const words =
            labels && Object.prototype.hasOwnProperty.call(labels, String(text))
              ? labels[String(text)]
              : fmtValue(text, column.type ?? 'text', null);
          return (
            <Pill key={index} tone={pillTone(toneFrom(typeof tone === 'string' ? (tone as Tone) : undefined, row))}>
              {words}
            </Pill>
          );
        })}
      </>
    );
  }
  const labels = column.pill?.labels;
  const key = String(value);
  const text =
    labels && Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : fmtValue(value, column.type ?? 'text', null);
  return <Pill tone={pillTone(toneFrom(column.pill?.tone, row))}>{text}</Pill>;
}

function DetailPiece({ component, data }: { component: Of<'detail'>; data: unknown }): JSX.Element {
  const query = usePageQuery(component.query, data);
  if (query.error) return <ErrorBanner message={query.error} />;
  if (query.data === undefined) return <Empty>{component.empty ?? 'Loading…'}</Empty>;
  return (
    <PieceSection title={component.title} note={component.note}>
      <Stack gap="lg">
        {component.fields.length > 0 ? (
          <KV
            items={component.fields.map((field) => ({
              key: field.label,
              label: field.label,
              value: fmtValue(readRef(query.data, field.value), field.unit ?? 'text', null),
            }))}
          />
        ) : null}
        {component.body.map((child, index) => (
          <Piece key={index} component={child} data={query.data} />
        ))}
      </Stack>
    </PieceSection>
  );
}

function FormPiece({ component, data }: { component: Of<'form'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const initial = usePageQuery(component.initial, data);
  const act = useAct();
  const [open, setOpen] = useState(false);
  // Remounting on the initial data is what makes "Save" show what was saved:
  // the key changes when the query answers again.
  const key = JSON.stringify([initial.data ?? null, scope.version]);
  const body = (
    <FormBody
      key={key}
      component={component}
      data={data}
      initialData={initial.data}
      act={act}
      onDone={() => setOpen(false)}
    />
  );
  if (!component.drawer) {
    return (
      <PieceSection title={component.title} note={component.note}>
        <ErrorBanner message={initial.error} />
        {body}
      </PieceSection>
    );
  }
  return (
    // No panel: what it holds is a button, and a panel with nothing in it
    // until a write answers is a white box saying nothing.
    <Section
      title={component.title}
      aside={component.note}
      actions={
        <Button variant="accent" onClick={() => setOpen(true)}>
          {component.drawer.button}
        </Button>
      }
    >
      {/*
        What the write said, on the page rather than in the sheet: a form whose
        `then` is `close` has no sheet left to say it in, and "Rule added" is
        the one thing the owner is waiting to read.
      */}
      <ActOutcome act={act} />
      {open ? (
        <Sheet title={component.drawer.title} onClose={() => setOpen(false)}>
          {body}
        </Sheet>
      ) : null}
    </Section>
  );
}

function FormBody({
  component,
  data,
  initialData,
  act,
  onDone,
}: {
  component: Of<'form'>;
  data: unknown;
  initialData: unknown;
  act: ActState;
  onDone: () => void;
}): JSX.Element {
  const top = useContext(PanelTop);
  const scope = useScope();
  const [values, setValues] = useState<Values>(() => initialValues(component.fields, initialData));
  /*
   * A field the form is not asking for cannot hold it back: two required
   * fields under opposite `when`s are two branches, and the owner only ever
   * fills the one they are on.
   */
  const inactive = inactiveFields(component.fields, values, initialData);
  const missing = component.fields.some(
    (field) =>
      field.required &&
      !inactive.has(field.name) &&
      (values[field.name] === '' || values[field.name] === undefined),
  );
  return (
    <Stack>
      <Fields
        fields={component.fields}
        values={values}
        data={initialData}
        onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
      />
      {component.drawer ? null : <ActOutcome act={act} />}
      <Toolbar align="end" className={top ? 'ui-panel-foot' : undefined}>
        <ActionButton
          action={component.submit}
          args={resolveArgs(component.submit.args, {
            data,
            fields: values,
            shape: component.fields,
            omit: inactive,
            scope,
          })}
          disabled={act.busy || missing}
          running={act.running === component.submit.tool}
          onRun={(ref, args) => void act.run(ref, args, onDone)}
        />
      </Toolbar>
    </Stack>
  );
}

/** What a filter that is on says about itself, as a chip. */
function chipWords(field: Field, value: string): string {
  if (field.type === 'checkbox') return field.label;
  const option = field.options?.find((o) => o.value === value);
  return `${field.label}: ${option ? option.label : value}`;
}

/** A value that means "this filter is on". */
function isOn(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== false && value !== 'false';
}

/**
 * A search, as one compact bar.
 *
 * The first text field is the bar's own and grows; the rest are filters,
 * behind Filters in a dense row underneath, and the ones the answer was
 * asked with show as chips that take themselves off. Clear and Search sit on
 * the right, and Enter searches. A search with no text field — a picker —
 * keeps its fields in the bar itself.
 */
function SearchPiece({ component, data }: { component: Of<'search'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const [values, setValues] = useState<Values>(() => initialValues(component.fields, data));
  const [asked, setAsked] = useState(component.auto === true);
  const [open, setOpen] = useState(false);
  const ready = component.fields.every((field) => !field.required || String(values[field.name] ?? '') !== '');
  const query = usePageQuery(asked && ready ? component.query : undefined, data);
  const rows = rowsOf(query.data, component.rows);
  const count = component.count === undefined ? undefined : readPath(query.data, component.count);
  const note = component.note === undefined ? undefined : readPath(query.data, component.note);
  const main = component.fields.find((field) => field.type === 'text' || field.type === 'email') ?? null;
  const filters = component.fields.filter((field) => field !== main);

  /** Put the fields into the page's parameters, which is what the query reads. */
  const ask = (next: Values): void => {
    scope.setParams(
      Object.fromEntries(component.fields.map((field) => [field.name, String(next[field.name] ?? '') || null])),
    );
    setAsked(true);
  };
  const change = (name: string, value: unknown): void => {
    const next = { ...values, [name]: value };
    setValues(next);
    // A picker asks again on every change; a search box waits to be told.
    if (component.auto) ask(next);
  };
  const clear = (): void => {
    /*
     * Clear means *cleared*: the fields, the parameters the query reads them
     * from, and the results underneath. A picker that asks on every change
     * asks again with nothing; a search box goes back to having been asked
     * nothing.
     */
    const empty = initialValues(component.fields, null);
    setValues(empty);
    if (component.auto) ask(empty);
    else {
      scope.setParams(Object.fromEntries(component.fields.map((field) => [field.name, null])));
      setAsked(false);
    }
  };

  // What the answer was asked with, not what is being typed: a chip is a
  // filter that is *on*.
  const applied = asked ? filters.filter((field) => isOn(scope.params[field.name])) : [];
  const chips = main
    ? applied.map((field) => (
        <Chip
          key={field.name}
          label={field.label}
          onRemove={() => {
            const next = { ...values, [field.name]: field.type === 'checkbox' ? false : '' };
            setValues(next);
            ask(next);
          }}
        >
          {chipWords(field, String(scope.params[field.name]))}
        </Chip>
      ))
    : [];
  const on = filters.filter((field) => isOn(values[field.name])).length;

  const actions =
    component.auto && !component.reset ? null : (
      <>
        {component.reset ? (
          <Button variant="ghost" onClick={clear}>
            Clear
          </Button>
        ) : null}
        {component.auto ? null : (
          <Button type="submit" variant="accent" disabled={!ready}>
            Search
          </Button>
        )}
      </>
    );

  const item = component.results.to
    ? component.results
    : component.to
      ? { ...component.results, to: component.to }
      : component.results;

  return (
    <PieceSection title={component.title}>
      <Stack>
        <SearchBar
          label={component.title ?? 'Search'}
          onSubmit={() => {
            if (!component.auto && ready) ask(values);
          }}
          main={
            main ? (
              <input
                id={`f-${main.name}`}
                name={main.name}
                type={main.type === 'email' ? 'email' : 'search'}
                aria-label={main.label}
                placeholder={main.hint ?? main.label}
                title={main.hint}
                required={main.required}
                value={String(values[main.name] ?? '')}
                onChange={(e) => change(main.name, e.target.value)}
              />
            ) : undefined
          }
          filters={
            filters.length > 0 ? (
              <Fields fields={filters} values={values} data={data} compact onChange={change} />
            ) : undefined
          }
          {...(main && filters.length > 0
            ? { filtersOpen: open, onToggleFilters: () => setOpen((v) => !v), active: on }
            : {})}
          chips={chips.length > 0 ? chips : undefined}
          actions={actions}
        />
        <ErrorBanner message={query.error} />
        {/*
          What the answer says about itself — "the newest 500" — is as true of
          an empty answer as of a full one, and on an empty one it is the whole
          explanation. So it is drawn above the results, either way.
        */}
        {asked && (count !== undefined || note !== undefined) ? (
          <p className="ui-card-meta">
            {count === undefined ? '' : `${fmtValue(count, 'number', null)} in all. `}
            {note === undefined ? '' : String(note)}
          </p>
        ) : null}
        {asked ? (
          rows.length === 0 ? (
            <Empty>{query.loading ? 'Searching…' : (component.empty ?? 'Nothing matches.')}</Empty>
          ) : (
            <div className="ui-panel" data-flush="true">
              <List>
                {rows.map((row, index) => {
                  // `results.to` when the row says where it goes, else the
                  // search's own `to` — the common case: one page, one item id.
                  const drawn = itemRow(scope, item, row);
                  return <ListRow key={index} title={drawn.title} sub={drawn.sub} side={drawn.side} />;
                })}
              </List>
            </div>
          )
        ) : null}
      </Stack>
    </PieceSection>
  );
}

/**
 * The list, and the one thing it is showing.
 *
 * Above 900px they sit side by side; below it — a phone — the list is above
 * the detail, which is why this is one grid with one breakpoint rather than
 * two components fighting over the width.
 */
function ListDetailPiece({ component, data }: { component: Of<'list-detail'>; data: unknown }): JSX.Element {
  const scope = useScope();
  /*
   * `local` is for a second level *inside* a detail the route already owns:
   * two list-details cannot both put their item in the one route segment, so
   * the inner one keeps its choice in the page. The outer one stays in the
   * URL, which is what makes a thread something the owner can link to.
   */
  const local = component.selection === 'local';
  const [here, setHere] = useState<string | null>(null);
  const chosen = local ? here : (scope.params[component.param] ?? scope.item);
  const inner = local && here !== null ? { ...scope, params: { ...scope.params, [component.param]: here } } : null;
  const detail = (
    <Stack gap="lg" divided>
      {component.detail.map((child, index) => (
        <Piece key={index} component={child} data={data} />
      ))}
    </Stack>
  );
  return (
    <Boxed.Provider value={false}>
    <Split
      list={
        <InSplit.Provider value>
          <Piece component={component.list} data={data} chosen={chosen ?? null} {...(local ? { choose: setHere } : {})} />
        </InSplit.Provider>
      }
      detail={chosen ? inner ? <Scope.Provider value={inner}>{detail}</Scope.Provider> : detail : undefined}
      empty={component.empty ?? 'Choose one to see it here.'}
    />
    </Boxed.Provider>
  );
}

/**
 * The same sub-tree, once per row.
 *
 * Every child is drawn with that row as its data, so a message's `expand`
 * fetches *its* body and a row's `artifact` links *its* file — the one thing
 * the component set could not express before.
 */
function RepeatPiece({ component, data }: { component: Of<'repeat'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const query = usePageQuery(component.query, data);
  const rows = rowsOf(query.data, component.rows);
  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      {rows.length === 0 ? (
        <Empty>{query.loading ? 'Loading…' : (component.empty ?? 'Nothing here.')}</Empty>
      ) : (
        <Stack gap="lg" divided>
          {keyedRows(rows, component.key, {
            plugin: scope.plugin,
            page: scope.page,
            component: `repeat "${component.title ?? component.rows}"`,
          }).map(({ key, row }) => (
            <Section key={key}>
              <Stack>
                {component.body.map((child, i) => (
                  <Piece key={i} component={child} data={row} />
                ))}
              </Stack>
            </Section>
          ))}
        </Stack>
      )}
    </PieceSection>
  );
}

function ExpandPiece({ component, data }: { component: Of<'expand'>; data: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  const query = usePageQuery(open ? component.query : undefined, data);
  const summary =
    typeof component.label === 'string' ? component.label : String(readRef(data, component.label) ?? '');
  return (
    <Details summary={summary} boxed onToggle={(isOpen) => setOpen(isOpen)}>
      <ErrorBanner message={query.error} />
      {query.data === undefined ? (
        <Empty>Loading…</Empty>
      ) : (
        <Stack>
          {component.body.map((child, index) => (
            <Piece key={index} component={child} data={query.data} />
          ))}
        </Stack>
      )}
    </Details>
  );
}

/**
 * One button, drawn wherever the descriptor put it.
 *
 * Its arguments resolve against the data it is standing in — the row, inside a
 * `repeat` — which is what lets an attachment be one block: Fetch here, and
 * the download link beside it under a `when`.
 */
function ButtonPiece({ component, data }: { component: Of<'button'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const act = useAct();
  return (
    <>
      <Toolbar align="end">
        <ActionButton
          action={component.action}
          args={resolveArgs(component.action.args, { data, row: data, scope })}
          disabled={act.busy}
          running={act.running === component.action.tool}
          /* Inside a `repeat` the data *is* the row, so "Fetch {name}" works. */
          row={data}
          onRun={(ref, args) => void act.run(ref, args)}
        />
      </Toolbar>
      <ActOutcome act={act} />
    </>
  );
}

function ApprovalPiece({ component, data }: { component: Of<'approval'>; data: unknown }): JSX.Element | null {
  const id = readPath(data, component.path);
  if (typeof id !== 'string' || id === '') return null;
  return <ApprovalById id={id} />;
}

function ArtifactPiece({ component, data }: { component: Of<'artifact'>; data: unknown }): JSX.Element | null {
  const id = readPath(data, component.path);
  if (typeof id !== 'string' || id === '') return null;
  return (
    <Toolbar>
      <a href={downloadUrl(id)}>{component.label}</a>
    </Toolbar>
  );
}

function EditorPiece({ component, data }: { component: Of<'editor'>; data: unknown }): JSX.Element {
  const query = usePageQuery(component.query, data);
  /*
   * The write lives *here*, outside the body that remounts when the answer
   * changes. A save refused because somebody else moved the draft on refreshes
   * this query; if the banner lived in the body it would be wiped by the very
   * reload it asked for, and the owner would see a changed draft with no
   * explanation.
   */
  const act = useAct();
  if (query.error) return <ErrorBanner message={query.error} />;
  if (query.data === undefined) return <Empty>{component.empty ?? 'Loading…'}</Empty>;
  return (
    <>
      <ActOutcome act={act} />
      <EditorBody key={JSON.stringify(query.data)} component={component} data={data} loaded={query.data} act={act} />
    </>
  );
}

function EditorBody({
  component,
  data,
  loaded,
  act,
}: {
  component: Of<'editor'>;
  data: unknown;
  loaded: unknown;
  act: ActState;
}): JSX.Element {
  const scope = useScope();
  const [values, setValues] = useState<Values>(() => initialValues(component.fields, loaded));
  /*
   * The version travels with the save as the implicit field `version`: it is
   * the stamp the tool refuses a stale write against, and it is read from the
   * same answer the fields were filled from — never from a clock here.
   */
  const withVersion = { ...values, version: readPath(loaded, component.version) };
  /** Hidden or greyed fields are not sent, here as on a form. */
  const inactive = inactiveFields(component.fields, values, loaded);
  /** Nothing to press, and nothing to type: what it holds is a record now. */
  const readOnly = component.readOnlyWhen !== undefined && holds(loaded, component.readOnlyWhen);
  /** Discard on the left, then the spacer, then Save and Send on the right. */
  const leading = (component.actions ?? []).filter((action) => action.placement === 'leading');
  const trailing = (component.actions ?? []).filter((action) => action.placement !== 'leading');
  const button = (action: ToolRef, index: number): JSX.Element => (
    <ActionButton
      key={`${action.tool}-${index}`}
      action={action}
      args={resolveArgs(action.args, { data, fields: withVersion, shape: component.fields, omit: inactive, scope })}
      disabled={act.busy}
      running={act.running === action.tool}
      onRun={(ref, args) => void act.run(ref, args)}
    />
  );
  return (
    <PieceSection title={component.title} note={component.note}>
      <Stack>
        <Fields
          fields={component.fields}
          values={values}
          data={loaded}
          disabled={readOnly}
          onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
        />
        {/*
          Discard on the left, then a spacer, then Save, then whatever else the
          descriptor listed — the primary of the editor sits under the owner's
          thumb, and the action that leaves the room (Send) is last.
        */}
        {readOnly ? null : (
          <Toolbar align="end">
            {leading.map(button)}
            {leading.length > 0 ? <Spacer /> : null}
            {button(component.save, -1)}
            {trailing.map(button)}
          </Toolbar>
        )}
        {component.footnote ? <p className="ui-toolbar-note">{component.footnote}</p> : null}
      </Stack>
    </PieceSection>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export function PluginPage({
  page,
  item,
  navigate,
  timezone,
  embedded,
  siblings,
}: {
  page: PluginPageDescriptor;
  /** The item segment of the route, when there is one. */
  item?: string | null;
  navigate: (route: string, replace?: boolean) => void;
  timezone: string;
  /** Inside a settings tab: no page header, no page gap. */
  embedded?: boolean;
  /**
   * This plugin's other pages. A link to one whose place is `settings` has to
   * become a settings tab rather than a place of its own, and only the
   * descriptors know which is which.
   */
  siblings?: PluginPageDescriptor[];
}): JSX.Element {
  const [params, setParamsState] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const scope: PageScope = {
    plugin: page.plugin,
    page: page.id,
    pages: siblings ?? [page],
    item: item ?? null,
    // The item of the route is a page parameter under whichever name the
    // list-detail gave it, and under `item` besides.
    params: { ...params, ...(item ? { item } : {}), ...itemParams(page, item) },
    setParams: (patch) =>
      setParamsState((current) => {
        const next = { ...current };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        return next;
      }),
    navigate,
    timezone,
    version,
    refresh: () => setVersion((n) => n + 1),
    sensitive: new Set(page.sensitive ?? []),
  };
  /*
   * A notice that opens a page of its own is the page's intro: one muted
   * line under the title, as every core page has, rather than a grey box
   * before anything else. Anywhere else — later on, conditional, toned, or
   * inside a Settings tab — a notice stays a Notice.
   */
  const first = page.body[0];
  const lede =
    !embedded &&
    first?.kind === 'notice' &&
    typeof first.text === 'string' &&
    first.when === undefined &&
    first.title === undefined &&
    (first.tone === undefined || first.tone === 'neutral')
      ? first.text
      : undefined;
  const shown = lede === undefined ? page : { ...page, body: page.body.slice(1) };
  return (
    <Scope.Provider value={scope}>
      <PageFrame embedded={embedded} title={page.title} lede={lede}>
        <PageBody page={shown} boxed={embedded === true} />
      </PageFrame>
    </Scope.Provider>
  );
}

/**
 * The page's own read, and the body drawn against it.
 *
 * A `when` at the top of a page has to be about *something*: without
 * `PageDescriptor.data` it could only ever compare against nothing, which is
 * how "show this when the mailbox is unreachable" silently became "never".
 * Its own component so the hook is unconditional whether or not the descriptor
 * declares one.
 */
function PageBody({ page, boxed }: { page: PluginPageDescriptor; boxed: boolean }): JSX.Element {
  const scope = useScope();
  // A page whose own read is sensitive is masked whole: every `when` and
  // every notice on it is drawn against that read.
  if (page.data && scope.sensitive.has(page.data.query)) {
    return (
      <SensitiveGate>
        <PageBodyShown page={page} boxed={boxed} />
      </SensitiveGate>
    );
  }
  return <PageBodyShown page={page} boxed={boxed} />;
}

function PageBodyShown({ page, boxed }: { page: PluginPageDescriptor; boxed: boolean }): JSX.Element {
  const root = usePageQuery(page.data, null);
  /*
   * In a Settings tab each piece at the top is a panel under its own head,
   * as every core tab is, so the air between them is the division; on a
   * place of its own the page stays dense, on the plain ground, with
   * hairlines between.
   */
  return (
    <Stack gap="lg" divided={!boxed}>
      <ErrorBanner message={root.error} />
      <Boxed.Provider value={boxed}>
        {page.body.map((component, index) => (
          <Piece key={index} component={component} data={root.data ?? null} />
        ))}
      </Boxed.Provider>
    </Stack>
  );
}

/** The route's item, under the name the page's list-detail gave it. */
function itemParams(page: PluginPageDescriptor, item?: string | null): Record<string, string> {
  if (!item) return {};
  const names: string[] = [];
  const walk = (components: Component[]): void => {
    for (const component of components) {
      if (component.kind === 'list-detail') {
        names.push(component.param);
        walk(component.detail);
      } else if (component.kind === 'section' || component.kind === 'detail' || component.kind === 'expand') {
        walk(component.body);
      }
    }
  };
  walk(page.body);
  return Object.fromEntries(names.map((name) => [name, item]));
}

/** A plugin page, drawn inside a Settings tab. */
export function PluginSettingsPage(props: {
  page: PluginPageDescriptor;
  navigate: (route: string, replace?: boolean) => void;
  timezone: string;
  siblings?: PluginPageDescriptor[];
}): JSX.Element {
  return <PluginPage {...props} embedded />;
}

export { Scope as PluginPageScope };

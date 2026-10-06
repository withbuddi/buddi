/**
 * One generic page, drawn from a descriptor.
 *
 * `docs/plugin-pages.md` §5. Everything here is a *shape*: a section, a
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
import { createContext, useContext, useEffect, useId, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { api, type ApprovalRow } from '../api';
import { downloadUrl, previewUrl } from '../chat/attachments';
import { FileTile } from '../chat/FileTile';
import { fmtMoment } from '../format';
import { MessageBody } from './mail/MessageBody';
import { fmtDay, fmtValue } from '../canvas/format';
import { asNumber, readPath, readRef, resolveTiles, tileIcon } from '../canvas/resolve';
import { Tiles } from '../canvas/views/Tiles';
import { tileGlyph } from '../canvas/tileIcons';
import { chatRoute, fileRoute, pluginPageRoute, pluginSettingsRoute, proposalsRoute } from '../routes';
import {
  Button,
  ButtonLink,
  Chart,
  Details,
  Empty,
  ErrorBanner,
  ChipPicker,
  Field as FieldBox,
  FormGrid,
  KV,
  List,
  ListRow,
  Notice,
  PageFrame,
  PickRow,
  Pill,
  Progress,
  Section,
  Sheet,
  Spacer,
  Split,
  Chip,
  SearchBar,
  Stack,
  Stat,
  Stats,
  Segment,
  Table,
  Toolbar,
  useAsync,
  EmptyState,
  Icon,
  ActionMenu,
  Modal,
  Tag,
} from '../ui';
import { AgentOffer } from '../views/parts/AgentOffer';
import { PluginTeammatePanel } from '../views/parts/CatalogueSuggest';
import { ApprovalCard, useDecide } from '../views/parts/ApprovalCard';
import { messageOf, playOf, playSound, stopSound, usePlaying } from './play';
import { todayIn, toEvents, whenOf, type CalEvent } from './calendar';
import { askInCorner } from '../shell/ask';
import { CHAT_ROUTE } from '../routes';
import { CalendarView, useCalendarState } from './CalendarPiece';
import { SeriesPanel } from './SeriesPanel';
import { AssetImage, assetSrc } from './AssetImage';
import { usePluginDataChanged } from './usePages';
import type {
  ArgRef,
  ColumnMap,
  Component,
  Field,
  FieldAction,
  ListComponent,
  ImageList,
  ImageRef,
  ListItem,
  PageMessage,
  PageMessageAddress,
  PageMessageAttachment,
  ParamRef,
  PluginPageDescriptor,
  QueryRef,
  RouteRef,
  PillRef,
  RowAction,
  RowChoice,
  StoryRow,
  StoryWay,
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
/**
 * An address a page may link out to (`{ href }`, host API 1.27): absolute,
 * `https:`, with a host. Anything else — a relative path, `javascript:`,
 * plain `http:` — is no link. It is only ever followed by the owner, in a new
 * tab; the page never fetches it.
 */
export function outsideHref(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A row's pictures (host API 1.27), as the News kit draws a card's head: up
 * to three logos overlapping, then who they are in words — "Reuters and 3
 * more". Fixed slots or an array in the row; a slot with no label is left out.
 */
function RowImages({ plugin, images, row }: { plugin: string; images: ImageRef[] | ImageList; row: unknown }): JSX.Element | null {
  const items: Array<{ asset: unknown; label: string }> = Array.isArray(images)
    ? images.map((slot) => ({ asset: readRef(row, slot.asset), label: String(readRef(row, slot.label) ?? '').trim() }))
    : (() => {
        const list = readPath(row, images.from);
        return (Array.isArray(list) ? list : []).map((entry) => ({
          asset: readPath(entry, images.asset),
          label: String(readPath(entry, images.label) ?? '').trim(),
        }));
      })();
  const shown = items.filter((item) => item.label !== '');
  if (shown.length === 0) return null;
  const words = shown.length === 1 ? shown[0]!.label : `${shown[0]!.label} and ${shown.length - 1} more`;
  return (
    <span className="pl-stack" data-testid="row-images">
      <span className="pl-stack-logos">
        {shown.slice(0, 3).map((item, index) => (
          <AssetImage key={index} src={assetSrc(plugin, item.asset)} label={item.label} />
        ))}
      </span>
      <span className="pl-stack-words">{words}</span>
    </span>
  );
}

/** A link that leaves buddi: a new tab, no opener, no referrer, and the mark that says so. */
function OutsideLink({ href, children, className }: { href: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={(e) => e.stopPropagation()}>
      {children}
      <span className="wb-src-out" aria-hidden="true">↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function routeOf(scope: PageScope, to: RouteRef, data: unknown): string {
  // The one road out (1.27): an https address read from the data, or nothing.
  if ('href' in to) return outsideHref(readRef(data, to.href)) ?? '';
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
    /** The option a row's choice was just moved to (1.28). */
    choice?: string;
    scope: PageScope;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, ref] of Object.entries(args ?? {})) {
    if ('row' in ref) out[key] = readPath(source.row, ref.row);
    else if ('choice' in ref) out[key] = source.choice;
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

function usePageQuery(
  ref: QueryRef | undefined,
  data: unknown,
  pollMs?: number,
  /** Parameters the component itself adds: a calendar's `from` and `to`. */
  extra?: Record<string, string>,
): { data: unknown; error: string | null; loading: boolean } {
  const scope = useScope();
  const own = ref ? resolveParams(ref.params, data, scope) : {};
  const params = ref ? { ...own, ...extra } : {};
  /*
   * Which question this is: the query and the parameters the descriptor
   * names (another thread is another question), and never shown another
   * question's answer. Not the refresh counter, and not what the component
   * adds itself (a calendar's range), so a refresh or a step to next month
   * keeps the last answer up until the new one lands.
   */
  const asked = JSON.stringify([ref?.query ?? null, own]);
  const key = JSON.stringify([ref?.query ?? null, params, scope.version]);
  const state = useAsync<{ asked: string; data: unknown }>(
    () =>
      ref
        ? api.pageQuery(scope.plugin, ref.query, params).then((body) => ({ asked, data: body.data }))
        : Promise.resolve({ asked, data: undefined }),
    [key],
    pollMs,
  );
  const current = state.data !== undefined && state.data.asked === asked;
  return {
    data: current ? state.data!.data : undefined,
    error: current || !state.loading ? state.error : null,
    loading: state.loading,
  };
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
  /** True when the tool ran and worked; false when it failed or waits on an approval. */
  run: (ref: ToolRef, args: Record<string, unknown>, onDone?: () => void) => Promise<boolean>;
  /** Forget what the last write said: a sheet cancelled after a refusal. */
  reset: () => void;
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
  /** Whose sound it is, when a result of this action is playing. */
  const speaker = useId();
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
      // route: refreshing where the owner is beats navigating to nowhere. A
      // link out is never followed by itself: the owner follows it.
      const to = 'href' in what.route ? '' : routeOf(scope, what.route, result);
      if (to === '') scope.refresh();
      else scope.navigate(to);
      return;
    }
    if (what === 'close') onDone?.();
    scope.refresh();
  };

  const run = async (ref: ToolRef, args: Record<string, unknown>, onDone?: () => void): Promise<boolean> => {
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
        return false;
      }
      setApprovalId(null);
      setPending(null);
      /*
       * A result with a sound in it is played, not stored (`PagePlay`); its
       * `message` is the sentence when the descriptor wrote none.
       */
      const play = playOf(out.result);
      setDone(saidDone(ref, out.result) ?? (play ? messageOf(out.result) : null));
      if (play) await playSound(play, speaker);
      apply(ref.then, out.result, onDone);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      /*
       * A write that failed usually failed *about* something: a draft
       * somebody else has already moved past, a row that is gone. So the
       * component re-reads while the banner stays — the owner sees the
       * sentence and, underneath it, what is actually there now.
       */
      scope.refresh();
      return false;
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

  const reset = (): void => {
    setError(null);
    setDone(null);
  };

  return { running, busy: running !== null, error, done, approvalId, waiting: pending?.ref.pending ?? null, settle, run, reset };
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
    values[field.name] = field.multiple
      ? Array.isArray(found)
        ? found.map(String)
        : []
      : found !== undefined
        ? found
        : field.type === 'checkbox'
          ? false
          : '';
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
  fields,
  value,
  values,
  data,
  disabled,
  compact,
  onChange,
}: {
  field: Field;
  /** Every field on this form, for a field `action`'s arguments. */
  fields?: Field[];
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
  if (field.type === 'select' && field.multiple) {
    const chosen = Array.isArray(value) ? value.map(String) : [];
    const atCap = field.max !== undefined && chosen.length >= field.max;
    const capNote = atCap ? `Up to ${field.max}; remove one to add another.` : undefined;
    return (
      <FieldBox label={field.label} hint={compact ? undefined : [hint, capNote].filter(Boolean).join(' ') || undefined} group>
        <ChipPicker
          id={shared.id}
          label={field.label}
          options={choices.options}
          value={chosen}
          max={field.max}
          disabled={disabled}
          onChange={onChange}
        />
      </FieldBox>
    );
  }
  if (field.type === 'select') {
    const select = (
      <select {...shared} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">{choices.loading ? 'Loading…' : '—'}</option>
        {choices.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
    if (field.action && !compact) {
      return (
        <FieldWithAction
          field={field}
          action={field.action}
          fields={fields ?? [field]}
          values={values}
          data={data}
          disabled={disabled}
          hint={hint}
        >
          {select}
        </FieldWithAction>
      );
    }
    return (
      <FieldBox label={field.label} hint={hint}>
        {select}
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

/**
 * A select with its own small button: try the choice before saving it.
 *
 * The tool is given the form's values as they stand now — the owner has not
 * saved them, and that is the point — and nothing is refreshed afterwards, so
 * those choices stay on the form. A `play` in the answer is played here
 * (`./play.ts`); while it plays the button is a stop button, and pressing it
 * stops the sound. A gated tool's card is drawn under the field.
 */
function FieldWithAction({
  field,
  action,
  fields,
  values,
  data,
  disabled,
  hint,
  children,
}: {
  field: Field;
  action: FieldAction;
  fields: Field[];
  values: Values;
  data: unknown;
  disabled?: boolean;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  const scope = useScope();
  const key = useId();
  const playing = usePlaying() === key;
  const [running, setRunning] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  // A sound nobody can stop any more is a sound nobody asked for.
  useEffect(() => () => stopSound(key), [key]);
  const omit = inactiveFields(fields, values, data);
  const args =
    action.args !== undefined
      ? resolveArgs(action.args, { data, fields: values, shape: fields, omit, scope })
      : Object.fromEntries(Object.entries(values).filter(([name, value]) => !omit.has(name) && value !== ''));
  const press = async (): Promise<void> => {
    if (playing) {
      stopSound(key);
      return;
    }
    setRunning(true);
    setSaid(null);
    setError(null);
    setApprovalId(null);
    try {
      const out = await api.pageAct(scope.plugin, { tool: action.tool, args });
      if (out.approvalId) {
        setApprovalId(out.approvalId);
        return;
      }
      setSaid(messageOf(out.result));
      const play = playOf(out.result);
      if (play) await playSound(play, key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };
  const label = playing ? 'Stop' : action.label;
  return (
    <FieldBox
      label={field.label}
      hint={hint}
      action={
        <Button
          data-shape="icon"
          aria-label={running ? `${action.label}: working` : label}
          title={label}
          aria-busy={running || undefined}
          aria-pressed={action.icon === 'play' ? playing : undefined}
          disabled={disabled === true || running}
          onClick={() => void press()}
        >
          {running ? (
            <span className="ui-spinner" aria-hidden="true" />
          ) : (
            <Icon name={playing ? 'stop' : action.icon ?? 'arrow'} />
          )}
        </Button>
      }
      after={
        error ? (
          <ErrorBanner message={error} />
        ) : approvalId ? (
          <ApprovalById id={approvalId} onDecided={() => setApprovalId(null)} />
        ) : said ? (
          <span className="ui-field-hint" role="status">
            {said}
          </span>
        ) : null
      }
    >
      {children}
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
  columns,
  onChange,
}: {
  fields: Field[];
  /** The search bar's filters: a dense grid, hints as tooltips. */
  compact?: boolean;
  /** A form's `columns`: fields to a row on a wide panel. */
  columns?: 2 | 3;
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
    <FormGrid dense={compact} columns={columns}>
      {fields
        .filter((field) => field.when === undefined || holds(asked, field.when))
        .map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            fields={fields}
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
  // `where` (1.28): this computer's browser, or another one.
  if (component.where !== undefined && component.where !== (isLocalBrowser() ? 'local' : 'remote')) return null;
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
      return <NoticePiece component={component} data={data} />;
    case 'link':
      return <LinkPiece component={component} data={data} />;
    case 'progress':
      return <ProgressPiece component={component} data={data} />;
    case 'chart':
      return <ChartPiece component={component} data={data} />;
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
    case 'calendar':
      return <CalendarPiece component={component} data={data} />;
    case 'tiles':
      return <TilesPiece component={component} data={data} />;
    case 'series-panel':
      return <SeriesPanelPiece component={component} data={data} />;
    case 'hero':
      return <HeroPiece component={component} data={data} />;
    case 'tabs':
      return <TabsPiece component={component} data={data} />;
    case 'expand':
      return <ExpandPiece component={component} data={data} />;
    case 'button':
      return <ButtonPiece component={component} data={data} />;
    case 'menu':
      return <MenuPiece component={component} data={data} />;
    case 'approval':
      return <ApprovalPiece component={component} data={data} />;
    case 'artifact':
      return <ArtifactPiece component={component} data={data} />;
    case 'message':
      return <MessagePiece component={component} data={data} />;
    case 'editor':
      return <EditorPiece component={component} data={data} />;
    case 'agent-offer':
      return <AgentOfferPiece component={component} />;
    case 'stories':
      return <StoriesPiece component={component} data={data} />;
    default:
      // A component this build does not know: the plugin is newer than the
      // page. Say so instead of drawing nothing; the build check reloads soon.
      return (
        <Notice>
          This page uses a part this dashboard does not know yet. Reload buddi to see it.
        </Notice>
      );
  }
}

type Of<K extends Component['kind']> = Extract<Component, { kind: K }>;

/**
 * A section, masked while it reads a sensitive query: the Show sits at the
 * right of its heading, after the section's own actions, and nothing inside
 * is asked for until it is pressed.
 */
function SectionPiece({ component, data: given }: { component: Of<'section'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const unmasked = useContext(Unmasked);
  const [revealed, toggle] = useReveal();
  // The section's own query counts too: a sensitive read in the head is as
  // masked as one in the body, and is not asked for until Show.
  const gated = !unmasked && readsSensitive([component.query, component.body], scope.sensitive);
  const masked = gated && !revealed;
  // 1.30: a section that reads a query draws its body against the answer.
  const read = usePageQuery(masked ? undefined : component.query, given);
  const data = component.query ? read.data : given;
  const heading = component.heading && !masked ? readRef(data, component.heading) : undefined;
  const title = heading === undefined || heading === null || heading === '' ? component.title : String(heading);
  const boxed = useContext(Boxed);
  /*
   * Boxed, a button, a link or a drawer's button that ends the body is something done to the
   * section rather than a row of it: it moves up into the head, where the
   * section's own actions are, instead of sitting alone at the panel's foot.
   */
  let end = component.body.length;
  const headable = (piece: Component): boolean =>
    piece.kind === 'button' ||
    piece.kind === 'link' ||
    piece.kind === 'menu' ||
    (piece.kind === 'form' && piece.drawer?.button !== undefined && !piece.title);
  while (boxed && end > 0 && headable(component.body[end - 1]!)) end -= 1;
  const body = component.body.slice(0, end);
  const actions = [...(component.actions ?? []), ...component.body.slice(end)];
  // What a menu in the head said (1.28): drawn at the top of the body, not in the head.
  const [headNote, setHeadNote] = useState<ReactNode>(null);
  return (
    <HeadNote.Provider value={setHeadNote}>
    <PieceSection
      title={title}
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
        {headNote}
        {component.query && !masked ? <ErrorBanner message={read.error} /> : null}
        {masked ? (
          <MaskedNote />
        ) : component.query && read.data === undefined && !read.error ? (
          <Empty>Loading…</Empty>
        ) : (
          <Unmasked.Provider value={unmasked || gated}>
            <HeadNote.Provider value={null}>
              {body.map((child, index) => (
                <Piece key={index} component={child} data={data} />
              ))}
            </HeadNote.Provider>
          </Unmasked.Provider>
        )}
      </Stack>
    </PieceSection>
    </HeadNote.Provider>
  );
}

/** Where a head's menu puts what its tool said: the section's body, under the head (1.28). */
const HeadNote = createContext<((note: ReactNode) => void) | null>(null);

/** Is the dashboard open in a browser on the computer buddi runs on? (`where`, 1.28) */
export function isLocalBrowser(): boolean {
  const host = typeof location === 'undefined' ? '' : location.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * One button that opens a short menu (1.28): each item runs a tool, or opens a
 * drawer form of the page by its id — through the page parameter `open`, so a
 * link can open it too. Hints sit under the items' words.
 */
function MenuPiece({ component, data }: { component: Of<'menu'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const act = useAct();
  const report = useContext(HeadNote);
  const items = component.items
    .filter((item) => holds(data, item.when))
    .map((item) => ({
      label: item.label,
      ...(item.hint ? { hint: item.hint } : {}),
      onSelect: () => {
        if (item.open !== undefined) scope.setParams({ open: item.open });
        else if (item.action) void act.run(item.action, resolveArgs(item.action.args, { data, row: data, scope }));
      },
    }));
  const running = component.items.find((item) => item.action?.tool === act.running)?.action;
  const outcome = act.error || act.done || act.approvalId ? <ActOutcome act={act} /> : null;
  useEffect(() => {
    if (report) report(outcome);
    // Only when what the write said changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act.error, act.done, act.approvalId, act.waiting]);
  useEffect(() => () => report?.(null), [report]);
  return (
    <>
      <ActionMenu
        label={component.label}
        items={items}
        stacked={component.items.some((item) => item.hint !== undefined)}
        trigger={
          // A plain button: the menu's trigger needs one that takes a ref.
          <button type="button" className="ui-btn pl-menu-btn" data-variant={component.tone === 'accent' ? 'accent' : undefined} disabled={act.busy}>
            {running?.busy ?? component.label}
            <Icon name="chevron-down" size={12} />
          </button>
        }
      />
      {report ? null : outcome}
    </>
  );
}

/**
 * A sentence in a box, or — `look: 'quiet'` (1.27) — one faint line with a
 * small glyph, ending with a link: "Fetched at 10:00 from 31 sources · next
 * at 10:15 · 2 aren't answering". `action` is one button on the box's right.
 */
function NoticePiece({ component, data }: { component: Of<'notice'>; data: unknown }): JSX.Element | null {
  const scope = useScope();
  const act = useAct();
  const text = typeof component.text === 'string' ? component.text : String(readRef(data, component.text) ?? '');
  const link = component.link && holds(data, component.link.when) ? component.link : undefined;
  const linkHref = link ? routeOf(scope, link.to, data) : '';
  const linkLabel = link ? (typeof link.label === 'string' ? link.label : String(readRef(data, link.label) ?? '')) : '';
  const linked =
    link && linkHref !== '' && linkLabel !== '' ? (
      'href' in link.to ? (
        <OutsideLink href={linkHref}>{linkLabel}</OutsideLink>
      ) : (
        <a
          href={linkHref}
          onClick={(e) => {
            e.preventDefault();
            scope.navigate(linkHref);
          }}
        >
          {linkLabel}
        </a>
      )
    ) : null;
  if (component.look === 'quiet') {
    if (text === '' && !linked) return null;
    return (
      <p className="pl-quiet" data-tone={component.tone}>
        {component.icon ? <Icon name={component.icon} size={14} /> : null}
        <span>
          {text}
          {linked ? (
            <>
              {text ? ' · ' : null}
              {linked}
            </>
          ) : null}
        </span>
      </p>
    );
  }
  const action = component.action;
  return (
    <>
      <Notice
        tone={noticeTone(component.tone)}
        title={component.title}
        action={
          action ? (
            <ActionButton
              action={action}
              args={resolveArgs(action.args, { data, scope })}
              disabled={act.busy}
              running={act.running === action.tool}
              /* Inside a `repeat` the data is the row: "{undoLine}" in a confirm reads it. */
              row={data}
              onRun={(ref, args) => void act.run(ref, args)}
            />
          ) : undefined
        }
      >
        {text}
        {linked ? <> {linked}</> : null}
      </Notice>
      <ActOutcomeQuiet act={act} />
    </>
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
  if ('href' in component.to) {
    return (
      <Toolbar>
        <ButtonLink href={href} target="_blank" rel="noopener noreferrer" variant={component.tone === 'accent' ? 'accent' : undefined}>
          {component.label}
          <span className="wb-src-out" aria-hidden="true">↗</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </ButtonLink>
      </Toolbar>
    );
  }
  return (
    <Toolbar>
      <ButtonLink
        href={href}
        variant={component.tone === 'accent' ? 'accent' : undefined}
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

/** "252 MB": decimal megabytes, as a download is counted. */
function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

/**
 * How far something has got, as the first-run install draws it: the label,
 * the bar, and "7 of 252 MB · 2%" — or, once it is full, the `done` line
 * in place of the bar.
 */
function progressView(
  component: Pick<Of<'progress'>, 'value' | 'total'>,
  data: unknown,
): { percent: number; full: boolean; line: string } {
  const value = asNumber(readRef(data, component.value)) ?? 0;
  const total = component.total ? asNumber(readRef(data, component.total)) : null;
  const fraction = component.total ? (total && total > 0 ? value / total : 0) : value;
  const clamped = Math.max(0, Math.min(1, fraction));
  const percent = Math.floor(clamped * 100);
  const full = fraction >= 1;
  const line =
    component.total && total && total > 0
      ? `${megabytes(value)} of ${Math.max(1, megabytes(total))} MB · ${percent}%`
      : `${percent}%`;
  return { percent, full, line };
}

function ProgressPiece({ component, data }: { component: Of<'progress'>; data: unknown }): JSX.Element {
  const text = (ref: string | ValueRef | undefined): string =>
    ref === undefined ? '' : typeof ref === 'string' ? ref : String(readRef(data, ref) ?? '');
  const label = text(component.label);
  const done = text(component.done);
  const { percent, full, line } = progressView(component, data);
  return (
    <Stack gap="sm">
      {label ? <span>{label}</span> : null}
      {full && done ? (
        <span role="status">{done}</span>
      ) : (
        <>
          <Progress value={percent} label={label || 'Progress'} />
          <span role="status">{line}</span>
        </>
      )}
    </Stack>
  );
}

/**
 * A small chart of a query's rows. `rows` names the array, or the answer is
 * the array; each row gives an x and one number per series. A row whose y is
 * not a number is a gap in the line, not a zero. The x reads as a day when it
 * is a date.
 */
function ChartPiece({ component, data }: { component: Of<'chart'>; data: unknown }): JSX.Element {
  const query = usePageQuery(component.query, data);
  const rows = component.rows === undefined ? (Array.isArray(query.data) ? (query.data as unknown[]) : []) : rowsOf(query.data, component.rows);
  const xs = rows.map((row) => String(readPath(row, component.x) ?? ''));
  const values = (path: string): Array<number | null> => rows.map((row) => asNumber(readPath(row, path)) ?? null);
  // `series` draws a line and bars together, each on its own scale; else `y`, one kind.
  const mixed = component.series !== undefined;
  const paths = component.y === undefined ? [] : Array.isArray(component.y) ? component.y : [component.y];
  const series = mixed
    ? component.series!.map((s) => ({ label: s.label, values: values(s.y), type: s.type, ...(s.unit ? { unit: s.unit } : {}) }))
    : paths.map((path) => ({ label: paths.length === 1 ? component.label ?? path : path, values: values(path) }));
  const target = component.target ? asNumber(readRef(query.data, component.target)) ?? null : null;
  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      {rows.length === 0 ? (
        query.loading || query.data === undefined ? <Empty>Loading…</Empty> : <EmptyPiece text={component.empty ?? 'Nothing recorded yet.'} />
      ) : (
        <Chart
          xs={xs}
          series={series}
          type={mixed ? 'mixed' : component.type ?? 'line'}
          target={target}
          {...(component.label ? { label: component.label } : {})}
          formatX={(x) => (/^\d{4}-\d{2}-\d{2}/.test(x) ? fmtDay(x) : x)}
          formatY={(y) => fmtValue(y, 'number', null)}
        />
      )}
    </PieceSection>
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
): { title: ReactNode; sub: ReactNode; side: ReactNode; pills: ReactNode; meta: string; href: string | null; outside: boolean; text: string; lead: ReactNode; preview: string; strong: boolean | undefined } {
  const meta = (item.meta ?? []).map((ref) => String(readRef(row, ref) ?? '')).filter((text) => text !== '');
  const text = String(readRef(row, item.title) ?? '');
  const routed = item.to && !local ? routeOf(scope, item.to, row) : null;
  // `{ href }` over a value that is not an https address is no link at all.
  const href = routed === '' ? null : routed;
  const outside = href !== null && item.to !== undefined && 'href' in item.to;
  const images = item.images ? <RowImages plugin={scope.plugin} images={item.images} row={row} /> : null;
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
  const linked = href && outside ? (
    <OutsideLink href={href}>{text}</OutsideLink>
  ) : href ? (
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
  );
  // 1.27: a short word after the title ("FR"), a sentence under the row in its tone, a logo leading it.
  const tagValue = item.tag ? readRef(row, item.tag) : undefined;
  const tag = tagValue === undefined || tagValue === null || tagValue === '' ? null : <span className="pl-row-tag">{String(tagValue)}</span>;
  const statusValue = item.status ? readRef(row, item.status.text) : undefined;
  const statusTone = item.status ? toneFrom(item.status.tone, row) : undefined;
  const status =
    statusValue === undefined || statusValue === null || statusValue === '' ? null : (
      <span className="pl-row-status" data-tone={statusTone}>
        {String(statusValue)}
      </span>
    );
  const subText = item.sub ? String(readRef(row, item.sub) ?? '') : '';
  const swatch = item.swatch ? readPath(row, item.swatch) : undefined;
  const lead = item.logo ? (
    <AssetImage className="pl-logo-lg" src={assetSrc(scope.plugin, readRef(row, item.logo.asset))} label={String(readRef(row, item.logo.label) ?? '')} />
  ) : item.swatch ? (
    // 1.28: the row's own colour; a hollow dot when it has none, so the names line up.
    typeof swatch === 'string' && SWATCH.test(swatch) ? (
      <span className="pl-swatch" aria-hidden="true" style={{ '--swatch': swatch } as CSSProperties} />
    ) : (
      <span className="pl-swatch" data-none="true" aria-hidden="true" />
    )
  ) : null;
  // 1.30: a faint line under the row, and a heavier title while `strong` holds.
  const preview = item.preview ? String(readRef(row, item.preview) ?? '') : '';
  return {
    text,
    href,
    outside,
    lead,
    preview,
    strong: item.strong ? holds(row, item.strong) : undefined,
    pills: <>{drawnPills}</>,
    meta: meta.join(' · '),
    // The pictures sit above the title, as a card's head: logos, then who they are.
    title: images ? (
      <>
        {images}
        <span className="pl-row-title">{linked}</span>
        {tag}
      </>
    ) : tag ? (
      <>
        {linked}
        {tag}
      </>
    ) : (
      linked
    ),
    sub: status ? (
      <>
        {subText ? <span className="pl-row-line">{subText}</span> : null}
        {status}
      </>
    ) : item.sub ? subText : null,
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

/**
 * ↑ and ↓ move between the rows of a list beside a reading pane (1.30);
 * Enter opens the focused one, as a link does. Home and End go to the ends.
 */
export function moveAmongPicks(event: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a.ui-pick'));
  if (rows.length === 0) return;
  const at = rows.findIndex((row) => row === document.activeElement);
  const current = at >= 0 ? at : rows.findIndex((row) => row.getAttribute('aria-current') === 'true');
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(rows.length - 1, current + 1)
          : Math.max(0, current < 0 ? 0 : current - 1);
  event.preventDefault();
  rows[next]?.focus();
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
  const rowForm = useRowForm(component.actions, rows, act);

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
    if (!component.groupBy) return [{ label: null as string | null, aside: null as string | null, asideTone: undefined as string | undefined, rows: shown }];
    const by = new Map<string, unknown[]>();
    for (const row of shown) {
      const key = String(readPath(row, component.groupBy.key) ?? '');
      by.set(key, [...(by.get(key) ?? []), row]);
    }
    const words = (key: string, first: unknown): string => {
      const named = component.groupBy?.labels?.[key];
      if (named !== undefined) return named;
      const read = component.groupBy?.label ? readPath(first, component.groupBy.label) : undefined;
      return read === undefined || read === null || read === '' ? key : String(read);
    };
    return [...by].map(([key, group]) => {
      const aside = component.groupBy?.aside ? readPath(group[0], component.groupBy.aside) : undefined;
      const tone = component.groupBy?.asideTone ? readPath(group[0], component.groupBy.asideTone) : undefined;
      return {
        label: words(key, group[0]),
        aside: aside === undefined || aside === null || aside === '' ? null : String(aside),
        asideTone: tone === 'warning' || tone === 'critical' ? (tone as string) : undefined,
        rows: group,
      };
    });
  }, [rows, component.groupBy, keyed.length]);

  const lines = (group: unknown[]): JSX.Element[] =>
    group.map((row) => {
      const drawn = itemRow(scope, component.item, row, onChoose);
      const key = keyByRow.get(row) as string;
      if (pick && (onChoose || (drawn.href && !drawn.outside))) {
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
            snippet={drawn.preview || undefined}
            strong={drawn.strong}
          />
        );
      }
      const disabled = component.select?.disabledWhen !== undefined && holds(row, component.select.disabledWhen);
      const offered = (component.actions ?? []).filter((action) => holds(row, action.when));
      const actions = offered.filter((action) => action.menu !== true);
      const menu = offered.filter((action) => action.menu === true);
      return (
        <ListRow
          key={key}
          lead={
            drawn.lead ? drawn.lead : component.select ? (
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
          sub={
            drawn.preview ? (
              <>
                {drawn.sub ? <span className="pl-row-line">{drawn.sub}</span> : null}
                <span className="pl-row-preview">{drawn.preview}</span>
              </>
            ) : (
              drawn.sub
            )
          }
          side={
            <>
              {drawn.side}
              {component.item.choice ? <RowChoiceControl choice={component.item.choice} row={row} data={query.data} act={act} /> : null}
              {actions.map((action, i) => (
                <RowActionButton key={i} action={action} row={row} data={query.data} act={act} onForm={rowForm.show} />
              ))}
              {menu.length > 0 ? <RowMenu actions={menu} row={row} title={drawn.text} data={query.data} act={act} onForm={rowForm.show} /> : null}
            </>
          }
        />
      );
    });

  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      {rowForm.open ? null : <ActOutcome act={act} />}
      {rowForm.open ? <RowFormSheet open={rowForm.open} data={query.data} act={act} onClose={rowForm.close} onDone={rowForm.finish} /> : null}
      {groups.every((group) => group.rows.length === 0) ? (
        query.loading ? <Empty>Loading…</Empty> : <EmptyPiece text={component.empty ?? 'Nothing here yet.'} />
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
          {groups.map((group, index) =>
            component.groupBy?.actions || component.groupBy?.asideTone ? (
              // 1.28: a head of its own — the group's words, its aside, and its actions on the right.
              <section key={index} className="pl-group" aria-label={group.label ?? undefined}>
                <header className="pl-group-head">
                  <span className="pl-group-title">{group.label}</span>
                  {group.aside ? (
                    <span className="pl-group-aside" data-tone={group.asideTone}>
                      {group.aside}
                    </span>
                  ) : null}
                  <GroupActions actions={component.groupBy.actions ?? []} row={group.rows[0]} title={group.label ?? ''} data={query.data} act={act} onForm={rowForm.show} />
                </header>
                {lines(group.rows)}
              </section>
            ) : (
              <div key={index}>
                {group.label ? (
                  <div className="ui-list-group" data-aside={group.aside ? 'true' : undefined}>
                    {group.label}
                    {group.aside ? <span className="pl-group-aside">{group.aside}</span> : null}
                  </div>
                ) : null}
                {lines(group.rows)}
              </div>
            ),
          )}
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

/** A group head's actions (1.28): read against the group's first row, buttons then the ⋯. */
function GroupActions({
  actions,
  row,
  title,
  data,
  act,
  onForm,
}: {
  actions: RowAction[];
  row: unknown;
  title: string;
  data: unknown;
  act: ActState;
  onForm: (action: RowAction, row: unknown) => void;
}): JSX.Element | null {
  const offered = actions.filter((action) => holds(row, action.when));
  if (offered.length === 0) return null;
  const buttons = offered.filter((action) => action.menu !== true);
  const menu = offered.filter((action) => action.menu === true);
  return (
    <span className="pl-group-act">
      {buttons.map((action, i) => (
        <RowActionButton key={i} action={action} row={row} data={data} act={act} onForm={onForm} />
      ))}
      {menu.length > 0 ? <RowMenu actions={menu} row={row} title={title} data={data} act={act} onForm={onForm} /> : null}
    </span>
  );
}

/**
 * A row's segmented choice (1.28): Not linked · Read · Read and change. The
 * pick shows at once and the tool runs with it; the next answer says what
 * stands, and a refusal puts the old choice back with its sentence above the
 * list. An option the row cannot take is greyed, its hint saying why.
 */
function RowChoiceControl({ choice, row, data, act }: { choice: RowChoice; row: unknown; data: unknown; act: ActState }): JSX.Element {
  const scope = useScope();
  const current = String(readPath(row, choice.value) ?? '');
  const [picked, setPicked] = useState<string | null>(null);
  // What the data says wins as soon as it says something new.
  useEffect(() => setPicked(null), [current]);
  const shown = picked ?? current;
  const options = choice.options.filter((option) => holds(row, option.when));
  return (
    <span
      className="ui-segment pl-choice"
      role="radiogroup"
      aria-label={fill(choice.label, { row })}
      aria-busy={picked !== null && act.running === choice.tool ? 'true' : undefined}
    >
      {options.map((option) => {
        const locked = option.disabledWhen !== undefined && holds(row, option.disabledWhen);
        const why = locked && option.hint ? fill(option.hint, { row }) : undefined;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            className="ui-tab"
            aria-checked={shown === option.value}
            disabled={locked || act.busy}
            title={why}
            aria-description={why}
            onClick={() => {
              if (option.value === shown) return;
              setPicked(option.value);
              const args = resolveArgs(choice.args, { data, row, choice: option.value, scope });
              void act.run(choice, args).then((worked) => {
                if (!worked) setPicked(null);
              });
            }}
          >
            {option.label}
          </button>
        );
      })}
    </span>
  );
}

/** Whether a row form's `openWhen` holds of the page's parameters, on this row. */
function opensOn(openWhen: Record<string, string | { row: string }>, params: Record<string, string>, row: unknown): boolean {
  return Object.entries(openWhen).every(([key, want]) => {
    const value = typeof want === 'string' ? want : readPath(row, want.row);
    return value !== undefined && value !== null && params[key] === String(value);
  });
}

/** The row form open now: which action, on which row. */
interface OpenRowForm {
  action: RowAction;
  row: unknown;
}

/**
 * Which row form is open, opened by a button or by the page's parameters.
 *
 * A link that names a row (`?account=<id>&set=password`) opens that row's form
 * once the rows have arrived; the parameters are then forgotten, so a refresh
 * after the write does not open it again.
 */
function useRowForm(actions: RowAction[] | undefined, rows: unknown[], act: ActState): {
  open: OpenRowForm | null;
  show: (action: RowAction, row: unknown) => void;
  /** Cancelled: what the last attempt said goes with the sheet. */
  close: () => void;
  /** It worked: the sheet goes and the page says so. */
  finish: () => void;
} {
  const scope = useScope();
  const [open, setOpen] = useState<OpenRowForm | null>(null);
  useEffect(() => {
    if (open !== null || rows.length === 0) return;
    for (const action of actions ?? []) {
      const when = action.form?.openWhen;
      if (!when) continue;
      const row = rows.find((candidate) => holds(candidate, action.when) && opensOn(when, scope.params, candidate));
      if (row === undefined) continue;
      setOpen({ action, row });
      scope.setParams(Object.fromEntries(Object.keys(when).map((key) => [key, null])));
      return;
    }
    // Only when the rows or the parameters change: an open form is not re-opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, JSON.stringify(scope.params)]);
  return {
    open,
    show: (action, row) => {
      act.reset();
      setOpen({ action, row });
    },
    close: () => {
      act.reset();
      setOpen(null);
    },
    finish: () => setOpen(null),
  };
}

/** A row action's button: the tool, or the sheet that asks for its fields first. */
function RowActionButton({
  action,
  row,
  data,
  act,
  onForm,
}: {
  action: RowAction;
  row: unknown;
  data: unknown;
  act: ActState;
  onForm: (action: RowAction, row: unknown) => void;
}): JSX.Element {
  const scope = useScope();
  if (action.form) {
    return (
      <Button disabled={act.busy} onClick={() => onForm(action, row)}>
        {fill(action.label, { row })}
      </Button>
    );
  }
  return (
    <ActionButton
      action={action}
      args={resolveArgs(action.args, { data, row, scope })}
      disabled={act.busy}
      running={act.running === action.tool}
      row={row}
      onRun={(ref, args) => void act.run(ref, args)}
    />
  );
}

/**
 * A row's ⋯ (host API 1.27): the actions marked `menu`, each with its quiet
 * hint and a heading over its group. One that asks first asks in a small
 * window — the sentence, Cancel, and the action on the right.
 */
function RowMenu({
  actions,
  row,
  title,
  data,
  act,
  onForm,
}: {
  actions: RowAction[];
  row: unknown;
  title: string;
  data: unknown;
  act: ActState;
  onForm: (action: RowAction, row: unknown) => void;
}): JSX.Element {
  const scope = useScope();
  const [asking, setAsking] = useState<RowAction | null>(null);
  const run = (action: RowAction): void => void act.run(action, resolveArgs(action.args, { data, row, scope }));
  const items: Array<{ label: string; hint?: string; tone?: 'critical'; onSelect: () => void } | { heading: string } | 'separator'> = [];
  let group: string | undefined;
  actions.forEach((action, index) => {
    if (action.group !== group) {
      if (index > 0) items.push('separator');
      if (action.group) items.push({ heading: action.group });
      group = action.group;
    } else if (action.tone === 'danger' && index > 0) {
      items.push('separator');
    }
    items.push({
      label: fill(action.label, { row }),
      ...(action.hint ? { hint: fill(action.hint, { row }) } : {}),
      ...(action.tone === 'danger' ? { tone: 'critical' as const } : {}),
      onSelect: () => (action.form ? onForm(action, row) : action.confirm ? setAsking(action) : run(action)),
    });
  });
  return (
    <>
      <ActionMenu label={`More for ${title}`} items={items} sheet={{ title }} />
      {asking ? (
        <Modal
          title={fill(asking.confirm ?? asking.label, { row })}
          onClose={() => setAsking(null)}
          foot={
            <>
              <Button variant="ghost" onClick={() => setAsking(null)}>
                Cancel
              </Button>
              <Button
                variant={asking.tone === 'danger' ? 'danger' : 'accent'}
                onClick={() => {
                  const chosen = asking;
                  setAsking(null);
                  run(chosen);
                }}
              >
                {fill(asking.label, { row })}
              </Button>
            </>
          }
        />
      ) : null}
    </>
  );
}

/**
 * The small sheet a row action opens: its fields, Cancel, and the submit on
 * the right. A refusal stays here with its sentence and the owner's input;
 * success closes it and the page says what happened.
 */
function RowFormSheet({
  open,
  data,
  act,
  onClose,
  onDone,
}: {
  open: OpenRowForm;
  data: unknown;
  act: ActState;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const scope = useScope();
  const { action, row } = open;
  const form = action.form!;
  const [values, setValues] = useState<Values>(() => initialValues(form.fields, row));
  const missing = form.fields.some((field) => field.required && (values[field.name] === '' || values[field.name] === undefined));
  // The submit is the action without its row-button words or a second question.
  const { confirm: _confirm, ...rest } = action;
  const submit: ToolRef = { ...rest, label: form.submit };
  return (
    <Sheet
      title={fill(form.title, { row })}
      onClose={onClose}
      foot={
        <Toolbar align="end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <ActionButton
            action={submit}
            args={resolveArgs(action.args, { data, row, fields: values, shape: form.fields, scope })}
            disabled={act.busy || missing}
            running={act.running === action.tool}
            row={row}
            onRun={(ref, args) => void act.run(ref, args, onDone)}
          />
        </Toolbar>
      }
    >
      <Stack>
        <Fields
          fields={form.fields}
          values={values}
          data={row}
          onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
        />
        <ErrorBanner message={act.error} />
      </Stack>
    </Sheet>
  );
}

function TablePiece({ component, data }: { component: Of<'table'>; data: unknown }): JSX.Element {
  const query = usePageQuery(component.query, data);
  const act = useAct();
  const rows = rowsOf(query.data, component.rows);
  const rowForm = useRowForm(component.actions, rows, act);
  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      {rowForm.open ? null : <ActOutcome act={act} />}
      {rowForm.open ? <RowFormSheet open={rowForm.open} data={query.data} act={act} onClose={rowForm.close} onDone={rowForm.finish} /> : null}
      {rows.length === 0 ? (
        query.loading ? <Empty>Loading…</Empty> : <EmptyPiece text={component.empty ?? 'Nothing here yet.'} />
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
                {component.columns.map((column) => {
                  const text = column.pill ? null : fmtValue(readPath(row, column.key), column.type ?? 'text', null);
                  return (
                    <td key={column.key} data-fit={column.fit} title={cellTitle(column, row, text)}>
                      {column.pill ? null : <Swatch column={column} row={row} />}
                      {column.pill ? (
                        <PillCell column={column} row={row} />
                      ) : column.fit === 'truncate' ? (
                        <span className="ui-table-cut">{text}</span>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
                {component.actions && component.actions.length > 0 ? (
                  <td>
                    <Toolbar align="end">
                      {component.actions
                        .filter((action) => holds(row, action.when))
                        .map((action, i) => (
                          <RowActionButton
                            key={i}
                            action={action}
                            row={row}
                            data={query.data}
                            act={act}
                            onForm={rowForm.show}
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

/** A colour the row names, as `#rgb`, `#rrggbb` or `#rrggbbaa`: nothing else is drawn. */
const SWATCH = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The row's own colour as a dot before the cell's text (`swatch`, host API
 * 1.26): a calendar's colour beside its name. A value that is not a plain hex
 * colour draws nothing, so a row cannot style the page.
 */
function Swatch({ column, row }: { column: ColumnMap; row: unknown }): JSX.Element | null {
  if (!column.swatch) return null;
  const value = readPath(row, column.swatch);
  if (typeof value !== 'string' || !SWATCH.test(value)) return null;
  return <span className="ui-table-swatch" aria-hidden="true" style={{ '--swatch': value } as CSSProperties} />;
}

/**
 * A cell's tooltip: the column's `hint` read from the row, or — for a cell cut
 * to one line — the whole of what was cut.
 */
function cellTitle(column: ColumnMap, row: unknown, text: string | null): string | undefined {
  if (column.hint) {
    const hint = readPath(row, column.hint);
    if (hint !== undefined && hint !== null && hint !== '') return String(hint);
  }
  return column.fit === 'truncate' && text ? text : undefined;
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
  const [pressed, setPressed] = useState(false);
  // 1.28: a drawer with an `id` also opens from the page parameter `open` (a menu item, a link).
  const byId = component.drawer?.id !== undefined && scope.params.open === component.drawer.id;
  const open = pressed || byId;
  const setOpen = (next: boolean): void => {
    setPressed(next);
    if (!next && byId) scope.setParams({ open: null });
  };
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
  if (component.drawer.button === undefined && !component.title) {
    // Opened only by a menu or a link (1.28): nothing on the page but what the write said.
    return (
      <>
        <ActOutcome act={act} />
        {open ? (
          <Sheet title={component.drawer.title} onClose={() => setOpen(false)}>
            {body}
          </Sheet>
        ) : null}
      </>
    );
  }
  return (
    // No panel: what it holds is a button, and a panel with nothing in it
    // until a write answers is a white box saying nothing.
    <Section
      title={component.title}
      aside={component.note}
      actions={
        component.drawer.button !== undefined ? (
          <Button variant="accent" onClick={() => setOpen(true)}>
            {component.drawer.button}
          </Button>
        ) : undefined
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
      (values[field.name] === '' ||
        values[field.name] === undefined ||
        (Array.isArray(values[field.name]) && (values[field.name] as unknown[]).length === 0)),
  );
  return (
    <Stack>
      <Fields
        fields={component.fields}
        columns={component.columns}
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
  /*
   * Keyed by the chosen item: a new choice is a new subtree, so nothing the
   * last thread drew (its buttons, its open sheets) can stand while the next
   * one loads and act on the wrong conversation.
   */
  const detail = (
    <Stack key={chosen ?? ''} gap="lg" divided>
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
          {/* 1.30: ↑ and ↓ move between the rows, Enter opens one. */}
          <div className="pl-picks" onKeyDown={moveAmongPicks}>
            <Piece component={component.list} data={data} chosen={chosen ?? null} {...(local ? { choose: setHere } : {})} />
          </div>
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
  // `poll`: this query alone is asked again while its own answer says so.
  const [polling, setPolling] = useState(false);
  const query = usePageQuery(component.query, data, polling && component.poll ? component.poll.seconds * 1000 : undefined);
  const shouldPoll = component.poll !== undefined && query.data !== undefined && holds(query.data, component.poll.while);
  useEffect(() => setPolling(shouldPoll), [shouldPoll]);
  const rows = rowsOf(query.data, component.rows);
  /*
   * `finish` (1.28): a row that has reached its end — a sign-in whose answer
   * came back — has its tool run once, by itself. Once per row: a run that
   * failed is said here and not tried again until the row is another.
   */
  const finish = component.poll?.finish;
  const act = useAct();
  const [finished, setFinished] = useState<ReadonlySet<string>>(() => new Set());
  // The first due row not already finished: a finished row that stays due
  // (its answer still says so) does not hide the next one behind it.
  const due = finish
    ? rows.find((row) => {
        if (!holds(row, finish.when)) return false;
        const key = String(readPath(row, component.key) ?? '');
        return key !== '' && !finished.has(key);
      })
    : undefined;
  const dueKey = due === undefined ? null : String(readPath(due, component.key) ?? '');
  useEffect(() => {
    if (!finish || due === undefined || dueKey === null || dueKey === '' || finished.has(dueKey) || act.busy) return;
    setFinished((done) => new Set([...done, dueKey]));
    void act.run(finish.action, resolveArgs(finish.action.args, { data: due, row: due, scope }));
    // When another row becomes due, and again once a busy action clears (a
    // row that came due while busy was skipped, not dropped).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dueKey, act.busy]);
  const finishing = finish !== undefined && act.running === finish.action.tool;
  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      {finishing ? (
        <p className="pl-wait" role="status">
          <span className="pl-spin" aria-hidden="true" />
          {finish.action.busy ?? finish.action.label}
        </p>
      ) : (
        <ActOutcome act={act} />
      )}
      {finishing ? null : rows.length === 0 ? (
        query.loading ? <Empty>Loading…</Empty> : <EmptyPiece text={component.empty ?? 'Nothing here yet.'} />
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

/**
 * A calendar: its own range is two parameters of its own query, so moving a
 * week asks that query again and nothing else on the page — the `repeat` and
 * `poll` rule. The last answer stays drawn while the next one loads.
 */
function CalendarPiece({ component, data }: { component: Of<'calendar'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const state = useCalendarState({
    ...(component.views ? { views: component.views } : {}),
    ...(component.default ? { default: component.default } : {}),
    today: todayIn(scope.timezone),
    storageKey: `buddi.calendar-view:${scope.plugin}/${scope.page}`,
  });
  const query = usePageQuery(component.query, data, undefined, { from: state.from, to: state.to });
  const events = useMemo(
    () =>
      toEvents(
        rowsOf(query.data, component.events),
        component.map,
        scope.timezone,
        `plugin ${scope.plugin}, page ${scope.page}, calendar`,
      ),
    [query.data, component.events, component.map, scope.timezone, scope.plugin, scope.page],
  );
  // 1.28: an event opens its own sheet, kept by id so a refresh keeps it open on the same event.
  const [openId, setOpenId] = useState<string | null>(null);
  const open = component.sheet && openId !== null ? (events.find((event) => event.id === openId) ?? null) : null;
  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      <CalendarView
        state={state}
        events={events}
        hours={component.hours}
        empty={component.empty ?? 'Nothing.'}
        label={component.title ?? 'Calendar'}
        onEvent={component.sheet ? (event) => setOpenId(event.id) : undefined}
        count={component.count && query.data !== undefined ? events.length : undefined}
      />
      {open && component.sheet ? <EventSheet event={open} sheet={component.sheet} onClose={() => setOpenId(null)} /> : null}
    </PieceSection>
  );
}

/**
 * One event, in a sheet on the right (a full-width one on a phone), as the
 * News story opens (1.28): the title, when and how long, its calendar with
 * its colour, the place linked out to a map, the notes, a link to it where it
 * lives, and asks that open the corner chat with the request written in — a
 * change goes through an agent and its card, never straight from here.
 */
function EventSheet({ event, sheet, onClose }: { event: CalEvent; sheet: NonNullable<Of<'calendar'>['sheet']>; onClose: () => void }): JSX.Element {
  const scope = useScope();
  const row = event.row;
  const read = (path: string | undefined): string => {
    if (path === undefined) return '';
    const value = readPath(row, path);
    return value === undefined || value === null ? '' : String(value);
  };
  const when = whenOf(event);
  const color = read(sheet.color);
  const notes = read(sheet.notes);
  const map = outsideHref(read(sheet.mapHref));
  const openHref = sheet.open ? outsideHref(read(sheet.open.href)) : null;
  const openLabel = sheet.open ? read(sheet.open.label) : '';
  const ask = (text: string): void => {
    const filled = fill(text.replace(/\{when\}/g, when), { row: { ...(row as object), title: event.title, calendar: event.calendar, location: event.location } });
    onClose();
    if (!askInCorner(filled)) scope.navigate(CHAT_ROUTE);
  };
  return (
    <Sheet
      title={event.title}
      onClose={onClose}
      foot={
        sheet.asks && sheet.asks.length > 0 ? (
          <Toolbar align="end">
            {sheet.asks.map((item, index) => (
              <Button key={index} onClick={() => ask(item.text)}>
                {item.label}
              </Button>
            ))}
          </Toolbar>
        ) : undefined
      }
    >
      <div className="pl-event-sheet">
        <p className="pl-event-when">{when}</p>
        {event.calendar ? (
          <p className="pl-event-cal">
            {color && SWATCH.test(color) ? (
              <span className="pl-swatch" aria-hidden="true" style={{ '--swatch': color } as CSSProperties} />
            ) : (
              <span className="cal-dot" data-tone={event.tone} aria-hidden="true" />
            )}
            {event.calendar}
          </p>
        ) : null}
        {event.location ? (
          <p className="pl-event-where">
            <Icon name="pin" size={14} />
            {map ? <OutsideLink href={map}>{event.location}</OutsideLink> : <span>{event.location}</span>}
          </p>
        ) : null}
        {notes ? <p className="pl-event-notes">{notes}</p> : null}
        {openHref && openLabel ? (
          <p className="pl-event-open">
            <OutsideLink href={openHref} className="wb-src-link">
              {openLabel}
            </OutsideLink>
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * The canvas tiles, on a page: one card per item of the query's answer. With
 * `select`, each card is a button that writes the item's key into the page
 * parameter, and the chosen one is marked — the first until the owner picks,
 * written into the parameter as soon as it is drawn.
 */
function TilesPiece({ component, data }: { component: Of<'tiles'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const query = usePageQuery(component.query, data);
  const map = {
    items: '$',
    icon: component.icon,
    value: component.value,
    label: component.label,
    ...(component.lines ? { lines: component.lines } : {}),
    ...(component.tone ? { tone: component.tone } : {}),
  };
  // One item at a time, so a card and its key stay together when an item draws no card.
  const cards = rowsOf(query.data, component.items).flatMap((item) => {
    const tile = resolveTiles([item], map).tiles[0];
    return tile ? [{ tile, key: component.select ? String(readPath(item, component.select.key) ?? '') : '' }] : [];
  });
  const select = component.select;
  const chosen = select ? Math.max(0, cards.findIndex((card) => card.key === scope.params[select.param])) : null;
  /*
   * The first card is chosen until the owner picks, and its key is in the
   * parameter too, so what reads it below — the hours of the chosen day — is
   * about the card that is marked rather than about nothing.
   */
  const firstKey = cards[0]?.key ?? '';
  const held = select ? scope.params[select.param] : undefined;
  const heldShown = cards.some((card) => card.key === held);
  useEffect(() => {
    if (select && firstKey !== '' && !heldShown) scope.setParams({ [select.param]: firstKey });
  }, [select?.param, firstKey, heldShown]);
  return (
    <PieceSection title={component.title} note={component.note}>
      <ErrorBanner message={query.error} />
      {query.data === undefined ? (
        <Empty>Loading…</Empty>
      ) : cards.length === 0 ? (
        <EmptyPiece text={component.empty ?? 'Nothing to show.'} />
      ) : (
        <Tiles
          props={{ tiles: cards.map((card) => card.tile), notice: false, empty: '' }}
          {...(component.layout ? { layout: component.layout } : {})}
          {...(select
            ? { selected: chosen, onPick: (index: number) => scope.setParams({ [select.param]: cards[index]?.key || null }) }
            : {})}
        />
      )}
    </PieceSection>
  );
}

/**
 * A day in one panel: the chart of its series and the strip of its hours,
 * both drawn from the same points, so a point and its tile share an index —
 * a point that draws no tile still keeps its place in the strip.
 */
function SeriesPanelPiece({ component, data }: { component: Of<'series-panel'>; data: unknown }): JSX.Element {
  const query = usePageQuery(component.query, data);
  const points = rowsOf(query.data, component.points);
  if (query.data === undefined || points.length === 0) {
    return (
      <PieceSection title={component.title} note={component.note}>
        <ErrorBanner message={query.error} />
        {query.data === undefined ? <Empty>Loading…</Empty> : <EmptyPiece text={component.empty ?? 'Nothing to show.'} />}
      </PieceSection>
    );
  }
  const xs = points.map((point) => String(readPath(point, component.x) ?? ''));
  const map = {
    items: '$',
    icon: component.tiles.icon,
    value: component.tiles.value,
    label: component.tiles.label,
    ...(component.tiles.lines ? { lines: component.tiles.lines } : {}),
  };
  const tiles = points.map(
    (point, index) =>
      resolveTiles([point], map).tiles[0] ?? { icon: null, value: '', label: xs[index] ?? '', lines: [], tone: 'neutral' as const, link: null },
  );
  const series = component.series.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    ...(s.unit ? { unit: s.unit } : {}),
    values: points.map((point) => asNumber(readPath(point, s.y)) ?? null),
  }));
  return (
    <>
      <ErrorBanner message={query.error} />
      <SeriesPanel
        {...(component.title ? { title: component.title } : {})}
        {...(component.note ? { note: component.note } : {})}
        {...(component.labelEvery ? { labelEvery: component.labelEvery } : {})}
        xs={xs}
        series={series}
        tiles={tiles}
      />
    </>
  );
}

/** Now, large: the glyph, the value and its word, and the facts beside past a hairline. */
function HeroPiece({ component, data }: { component: Of<'hero'>; data: unknown }): JSX.Element {
  const query = usePageQuery(component.query, data);
  const text = (path: string): string => {
    const value = readPath(query.data, path);
    return value === undefined || value === null ? '' : String(value);
  };
  if (query.data === undefined || query.data === null) {
    return (
      <>
        <ErrorBanner message={query.error} />
        <Empty>{query.loading ? 'Loading…' : (component.empty ?? 'Nothing to show.')}</Empty>
      </>
    );
  }
  const value = text(component.value);
  const title = text(component.title);
  const facts = component.facts.map((fact) => ({ label: fact.label, value: text(fact.path) })).filter((fact) => fact.value !== '');
  return (
    <section className="pg-hero" aria-label={[value, title, ...facts.map((fact) => `${fact.label} ${fact.value}`)].filter(Boolean).join(', ')}>
      <div className="pg-hero-main" aria-hidden="true">
        <span className="pg-hero-icon">
          <Icon name={tileGlyph(tileIcon(readRef(query.data, component.icon)))} size={44} />
        </span>
        <span className="pg-hero-value">{value}</span>
        {title ? <span className="pg-hero-title">{title}</span> : null}
      </div>
      {facts.length > 0 ? (
        <dl className="pg-hero-facts" aria-hidden="true">
          {facts.map((fact) => (
            <div key={fact.label} className="pg-hero-fact">
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/**
 * Views behind a switch at the right of a bar, and the pick at its left: the
 * pick writes a page parameter the queries below read, the switch draws one
 * tab's components and leaves the others unasked.
 */
function TabsPiece({ component, data }: { component: Of<'tabs'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const [own, setOwn] = useState(component.default ?? component.tabs[0]!.id);
  // 1.27: the chosen tab may live in a page parameter, so a query reads it and a button moves it.
  const tabParam = component.param;
  const tab = tabParam ? scope.params[tabParam] ?? component.default ?? component.tabs[0]!.id : own;
  const setTab = (id: string): void => (tabParam ? scope.setParams({ [tabParam]: id }) : setOwn(id));
  const pick = component.pick;
  const { options } = useFieldOptions(
    { name: pick?.param ?? '', label: pick?.label ?? '', type: 'select', ...(pick?.options ? { options: pick.options } : {}), ...(pick?.optionsFrom ? { optionsFrom: pick.optionsFrom } : {}) },
    {},
    data,
  );
  const current = pick ? (options.some((o) => o.value === scope.params[pick.param]) ? scope.params[pick.param]! : options[0]?.value ?? '') : '';
  const shown = component.tabs.find((t) => t.id === tab) ?? component.tabs[0]!;
  const chips = pick?.look === 'chips';
  const addHref = pick?.add ? routeOf(scope, pick.add.to, data) : '';
  return (
    <div className="pg-tabs">
      {/* One tab and a pick (host API 1.22): the bar is the pick alone, a filter over one view, on the left where a pick sits. */}
      <div className="pg-tabs-bar" data-only={component.tabs.length === 1 ? 'pick' : undefined} data-chips={chips ? 'true' : undefined}>
        {pick && chips && options.length > 0 ? (
          <div className="pl-chips" role="group" aria-label={pick.label}>
            {options.map((option) => (
              <Button key={option.value} size="sm" aria-pressed={option.value === current} onClick={() => scope.setParams({ [pick.param]: option.value })}>
                {option.label}
              </Button>
            ))}
            {pick.add && addHref !== '' ? (
              <ButtonLink
                size="sm"
                variant="ghost"
                href={addHref}
                onClick={(e) => {
                  e.preventDefault();
                  scope.navigate(addHref);
                }}
              >
                <Icon name="plus" size={12} />
                {pick.add.label}
              </ButtonLink>
            ) : null}
          </div>
        ) : pick && options.length > 1 ? (
          <Segment label={pick.label} options={options} value={current} onChange={(value) => scope.setParams({ [pick.param]: value })} />
        ) : null}
        {component.tabs.length > 1 ? (
          <span className="pg-tabs-switch">
            <Segment label={component.title ?? 'View'} options={component.tabs.map((t) => ({ value: t.id, label: t.label }))} value={shown.id} onChange={setTab} />
          </span>
        ) : null}
      </div>
      {shown.body.map((child, index) => (
        <Piece key={`${shown.id}-${index}`} component={child} data={data} />
      ))}
    </div>
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

/**
 * One of this plugin's proposed agents, offered in place: the plugin's line,
 * and the same accept the Plugins page runs. The click creates the agent, and
 * the line says so; the page's next read lets a `when` over the roster take it
 * away.
 */
function AgentOfferPiece({ component }: { component: Of<'agent-offer'> }): JSX.Element {
  const scope = useScope();
  return (
    <AgentOffer
      plugin={scope.plugin}
      agent={component.agent}
      text={component.text}
      label={component.label}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Stories (host API 1.27): the News page's feed
 * ------------------------------------------------------------------ */

/** A row the page can draw as a story: an id, a title, and its outlets. */
function asStory(raw: unknown): StoryRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<StoryRow>;
  if (typeof row.id !== 'string' || row.id === '' || typeof row.title !== 'string') return null;
  return { ...row, outlets: Array.isArray(row.outlets) ? row.outlets.filter((o) => o && typeof o.name === 'string') : [] } as StoryRow;
}

/** "Reuters", or "Reuters and 3 more". */
function outletWords(outlets: StoryRow['outlets']): string {
  if (outlets.length === 0) return '';
  return outlets.length === 1 ? outlets[0]!.name : `${outlets[0]!.name} and ${outlets.length - 1} more`;
}

/** A way's arguments: literals and paths read against the story, `{ row }` the story, `{ item }` the element. */
function wayArgs(args: StoryWay['args'], row: unknown, item: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, ref] of Object.entries(args)) {
    if ('row' in ref) out[key] = readPath(row, ref.row);
    else if ('item' in ref) out[key] = readPath(item, ref.item);
    else out[key] = readRef(row, ref);
  }
  return out;
}

/** A card the owner just turned away: its sentence and Undo stand where it was for eight seconds. */
interface GoneStory {
  id: string;
  group: string | null;
  /** Where it stood in its group, so the sentence keeps its place after the list is read again. */
  index: number;
  text: string;
  undo?: { tool: string; label: string; args: Record<string, unknown> };
}

/** How long a turned-away card leaves its Undo in place. */
const UNDO_MS = 8000;

/** One item of a story's ⋯ menu, or of the sheet's Less of this…. */
type StoryMenuItem = { label: string; hint?: string; onSelect: () => void } | { heading: string } | 'separator';

function storyMenu(
  ways: StoryWay[],
  row: StoryRow,
  onPick: (way: StoryWay, item: unknown) => void,
): StoryMenuItem[] {
  const items: StoryMenuItem[] = [];
  let lastGroup: string | undefined | null = null;
  ways.forEach((way, index) => {
    if (!holds(row, way.when)) return;
    const elements = way.each ? (Array.isArray(readPath(row, way.each)) ? (readPath(row, way.each) as unknown[]).slice(0, 4) : []) : [undefined];
    if (elements.length === 0) return;
    // A new group, or the end of one, is a hairline — the kit's Not interested · Mute an outlet · Quiet and Mute.
    if (index > 0 && items.length > 0 && way.group !== lastGroup) items.push('separator');
    if (way.group && way.group !== lastGroup) items.push({ heading: way.group });
    lastGroup = way.group;
    for (const element of elements) {
      items.push({
        label: fill(way.label, { row: element === undefined ? row : element }),
        ...(way.hint ? { hint: fill(way.hint, { row }) } : {}),
        onSelect: () => onPick(way, element),
      });
    }
  });
  return items;
}

function StoriesPiece({ component, data }: { component: Of<'stories'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const query = usePageQuery(component.query, data);
  const act = useAct();
  const param = component.param ?? 'story';
  const [gone, setGone] = useState<GoneStory | null>(null);
  useEffect(() => {
    if (!gone) return;
    const timer = setTimeout(() => setGone(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [gone]);

  const rows = rowsOf(query.data, component.rows)
    .map(asStory)
    .filter((row): row is StoryRow => row !== null);
  const ways = component.ways ?? [];
  const openId = scope.params[param];
  const open = openId ? rows.find((row) => row.id === openId) ?? null : null;

  const pick = async (way: StoryWay, row: StoryRow, item: unknown, groupIndex: number): Promise<void> => {
    const args = wayArgs(way.args, row, item);
    // A way names its tool and words as a ToolRef does; its arguments were resolved above.
    const worked = await act.run({ tool: way.tool, label: way.label, ...(way.done !== undefined ? { done: way.done } : {}), ...(way.then ? { then: way.then } : {}) }, args);
    if (!worked || !way.hides) return;
    if (openId === row.id) scope.setParams({ [param]: null });
    const words = typeof way.done === 'string' ? fill(way.done, { row: item === undefined ? row : item }) : 'Hidden.';
    setGone({
      id: row.id,
      group: row.group?.id ?? null,
      index: groupIndex,
      text: words,
      ...(way.undo ? { undo: { tool: way.undo.tool, label: way.undo.label, args: wayArgs(way.undo.args, row, item) } } : {}),
    });
  };

  const undo = (): void => {
    const held = gone;
    setGone(null);
    if (held?.undo) void act.run({ tool: held.undo.tool, label: held.undo.label }, held.undo.args);
  };

  /** The groups, in the order the rows came; one group whose id the pick already names has no head. */
  const groups: Array<{ id: string | null; name: string | null; rows: StoryRow[] }> = [];
  for (const row of rows) {
    if (gone && row.id === gone.id) continue;
    const id = component.groups && row.group ? row.group.id : null;
    let group = groups.find((g) => g.id === id);
    if (!group) {
      group = { id, name: component.groups && row.group ? row.group.name : null, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  if (gone && !groups.some((g) => g.id === gone.group)) groups.push({ id: gone.group, name: null, rows: [] });
  const groupsParam = component.groups?.param;
  const heads = !(groups.length === 1 && groupsParam !== undefined && scope.params[groupsParam] === groups[0]!.id);

  const card = (row: StoryRow, index: number): JSX.Element => (
    <StoryCard
      key={row.id}
      row={row}
      plugin={scope.plugin}
      menu={storyMenu(ways, row, (way, item) => void pick(way, row, item, index))}
      onOpen={() => scope.setParams({ [param]: row.id })}
    />
  );
  const hiddenCard = (held: GoneStory): JSX.Element => (
    <div key={`gone-${held.id}`} className="pl-story-gone" role="status">
      <span>{held.text}</span>
      {held.undo ? (
        <>
          <span className="pl-story-gone-sep" aria-hidden="true">·</span>
          <Button size="sm" variant="ghost" onClick={undo}>
            {held.undo.label}
          </Button>
        </>
      ) : null}
    </div>
  );
  const cards = (group: { id: string | null; rows: StoryRow[] }): JSX.Element[] => {
    const drawn = group.rows.map(card);
    if (gone && gone.group === group.id) drawn.splice(Math.min(gone.index, drawn.length), 0, hiddenCard(gone));
    return drawn;
  };

  let body: ReactNode;
  if (query.data === undefined && query.loading) {
    body = (
      <div className="pl-story-grid" aria-busy="true" aria-label="Fetching stories">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="ui-card pl-story cat-skel pl-story-skel">
            <span className="pl-story-head">
              <i className="cat-skel-face pl-story-skel-logo" />
              <i className="cat-skel-line" data-w="30" />
            </span>
            <i className="cat-skel-line" data-w="90" />
            <i className="cat-skel-line" data-w="70" />
            <i className="cat-skel-line" data-w="40" />
          </div>
        ))}
      </div>
    );
  } else if (rows.length === 0 && !gone) {
    const state = (component.emptyStates ?? []).find((candidate) => holds(query.data, candidate.when));
    if (state) {
      const words = (ref: string | ValueRef | undefined): string =>
        ref === undefined ? '' : typeof ref === 'string' ? ref : String(readRef(query.data, ref) ?? '');
      const actions = (state.actions ?? []).map((action, index, all) => {
        // The last is the primary: beside another, or alone on a first time's warm ground.
        const primary = index === all.length - 1 && (all.length > 1 || state.warm === true);
        if (action.set) {
          return (
            <Button key={index} size="sm" variant={primary ? 'accent' : 'ghost'} onClick={() => scope.setParams(action.set!)}>
              {action.label}
            </Button>
          );
        }
        const href = action.to ? routeOf(scope, action.to, query.data) : '';
        if (href === '') return null;
        return (
          <ButtonLink
            key={index}
            size="sm"
            variant={primary ? 'accent' : 'ghost'}
            href={href}
            onClick={(e) => {
              e.preventDefault();
              scope.navigate(href);
            }}
          >
            {action.label}
          </ButtonLink>
        );
      });
      body = (
        <Empty warm={state.warm === true} title={words(state.title)} action={actions.length > 0 ? <Toolbar>{actions}</Toolbar> : undefined}>
          {words(state.text)}
        </Empty>
      );
    } else {
      body = <EmptyPiece text={component.empty ?? 'Nothing here yet.'} />;
    }
  } else {
    body = groups.map((group) => (
      <section key={group.id ?? 'all'} className="pl-story-group" aria-label={group.name ?? component.title ?? 'Stories'}>
        {heads && group.name ? (
          <header className="pl-story-group-head">
            <h2 className="pl-story-group-title">{group.name}</h2>
            {groupsParam && group.id ? (
              <a
                href="#"
                className="pl-story-group-aside"
                onClick={(e) => {
                  e.preventDefault();
                  scope.setParams({ [groupsParam]: group.id });
                }}
              >
                {component.groups?.label ?? 'See all'}
                <Icon name="arrow" size={12} />
              </a>
            ) : null}
          </header>
        ) : null}
        <div className="pl-story-grid">{cards(group)}</div>
      </section>
    ));
  }

  const hideWay = ways.find((way) => way.hides && !way.each && holds(open, way.when));
  const lessWays = ways.filter((way) => way !== hideWay);
  return (
    <div className="pl-stories">
      <ErrorBanner message={query.error} />
      <ActOutcomeQuiet act={act} />
      {body}
      {open ? (
        <Sheet
          title={open.kicker ?? open.group?.name ?? component.title ?? 'Story'}
          onClose={() => scope.setParams({ [param]: null })}
          foot={
            <Toolbar>
              {hideWay ? (
                <Button variant="ghost" disabled={act.busy} onClick={() => void pick(hideWay, open, undefined, 0)}>
                  {fill(hideWay.label, { row: open })}
                </Button>
              ) : null}
              {lessWays.length > 0 ? (
                <ActionMenu
                  label={`Less of this: ${open.title}`}
                  trigger={
                    // A plain button: the menu's trigger takes a ref.
                    <button type="button" className="ui-btn" data-variant="ghost" disabled={act.busy}>
                      Less of this…
                    </button>
                  }
                  items={storyMenu(lessWays, open, (way, item) => void pick(way, open, item, 0))}
                  stacked
                />
              ) : null}
              <Spacer />
              {component.ask && holds(open, component.ask.when) ? (
                <StoryLink to={component.ask.to} row={open} label={component.ask.label} accent />
              ) : null}
            </Toolbar>
          }
        >
          <StorySheet row={open} plugin={scope.plugin} edition={component.edition} />
        </Sheet>
      ) : null}
    </div>
  );
}

/** A write's refusal or its waiting approval, without the sentence a way's own placeholder says. */
function ActOutcomeQuiet({ act }: { act: ActState }): JSX.Element | null {
  if (act.error) return <ErrorBanner message={act.error} />;
  if (act.approvalId) return <ActOutcome act={act} />;
  return null;
}

/** A descriptor's route as a button, read against one story. */
function StoryLink({ to, row, label, accent }: { to: RouteRef; row: unknown; label: string; accent?: boolean }): JSX.Element | null {
  const scope = useScope();
  const href = routeOf(scope, to, row);
  if (href === '') return null;
  if ('href' in to) {
    return (
      <ButtonLink variant={accent ? 'accent' : 'ghost'} href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </ButtonLink>
    );
  }
  return (
    <ButtonLink
      variant={accent ? 'accent' : 'ghost'}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        scope.navigate(href);
      }}
    >
      {label}
    </ButtonLink>
  );
}

/** The quiet marks under a card: Opinion, the languages, told or new since. */
function StoryMarks({ row }: { row: StoryRow }): JSX.Element | null {
  const told = row.mark?.kind === 'told';
  if (!row.opinion && !row.languages && !row.mark) return null;
  return (
    <span className="pl-story-marks">
      {row.opinion ? <Tag>Opinion</Tag> : null}
      {row.languages ? <span className="pl-story-lang">{row.languages}</span> : null}
      {row.mark ? (
        told ? (
          <span className="pl-story-told">
            <Icon name="check" size={12} />
            {row.mark.text}
          </span>
        ) : (
          <span className="pl-story-new">{row.mark.text}</span>
        )
      ) : null}
    </span>
  );
}

/** Up to three logos overlapping, then who they are in words. */
function StoryLogos({ plugin, outlets }: { plugin: string; outlets: StoryRow['outlets'] }): JSX.Element | null {
  if (outlets.length === 0) return null;
  return (
    <span className="pl-stack" aria-label={outletWords(outlets)}>
      <span className="pl-stack-logos">
        {outlets.slice(0, 3).map((outlet, index) => (
          <AssetImage key={index} src={assetSrc(plugin, outlet.logo)} label={outlet.name} />
        ))}
      </span>
      <span className="pl-stack-words">{outletWords(outlets)}</span>
    </span>
  );
}

function StoryCard({
  row,
  plugin,
  menu,
  onOpen,
}: {
  row: StoryRow;
  plugin: string;
  menu: StoryMenuItem[];
  onOpen: () => void;
}): JSX.Element {
  const words = outletWords(row.outlets);
  return (
    <article
      className="ui-card pl-story"
      data-told={row.quiet ? 'true' : undefined}
      data-opinion={row.opinion ? 'true' : undefined}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.key !== 'Enter') return;
        event.preventDefault();
        onOpen();
      }}
      aria-label={`${row.opinion ? 'Opinion: ' : ''}${row.title}.${words ? ` ${words}` : ''}${row.ago ? `, ${row.ago}` : ''}.`}
    >
      <header className="pl-story-head">
        <StoryLogos plugin={plugin} outlets={row.outlets} />
        {row.ago ? <span className="pl-story-time">{row.ago}</span> : null}
        {menu.length > 0 ? (
          <span className="pl-story-more" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <ActionMenu
              label={`Ways out for ${row.title}`}
              items={menu.map((item) => (typeof item === 'string' || 'heading' in item ? item : { label: item.label, ...(item.hint ? { hint: item.hint } : {}), onSelect: item.onSelect }))}
              sheet={{ title: row.title, sub: [row.kicker ?? row.group?.name, words].filter(Boolean).join(' · ') }}
              stacked
            />
          </span>
        ) : null}
      </header>
      <h3 className="pl-story-title">{row.title}</h3>
      {row.lead ? <p className="pl-story-lead">{row.lead}</p> : null}
      <StoryMarks row={row} />
    </article>
  );
}

/** A story's sheet: what happened, who reported it, how it moved. */
function StorySheet({ row, plugin, edition }: { row: StoryRow; plugin: string; edition?: Of<'stories'>['edition'] }): JSX.Element {
  const sources = Array.isArray(row.sources) ? row.sources.filter((s) => s && typeof s.title === 'string') : [];
  const timeline = Array.isArray(row.timeline) ? row.timeline.filter((t) => t && typeof t.text === 'string') : [];
  const editionLink = edition && holds(row, edition.when) ? edition : undefined;
  return (
    <div className="pl-story-sheet">
      <div className="pl-story-sheet-lead">
        {row.opinion ? <Tag>Opinion</Tag> : null}
        <h3 className="pl-story-sheet-title">{row.title}</h3>
        {row.summary ?? row.lead ? <p className="pl-story-sheet-summary">{row.summary ?? row.lead}</p> : null}
        {row.update ? (
          <p className="pl-story-sheet-update">
            {row.mark && row.mark.kind === 'new' ? <span className="pl-story-new">{row.mark.text}</span> : null}
            {row.update}
          </p>
        ) : null}
        {row.meta || editionLink ? (
          <p className="pl-story-sheet-meta">
            {row.meta}
            {editionLink ? (
              <>
                {row.meta ? ' · ' : null}
                <StoryInlineLink to={editionLink.to} row={row} label={editionLink.label} />
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      {sources.length > 0 ? (
        <section className="pl-story-sheet-block">
          <h4 className="pl-story-sheet-head">Sources</h4>
          <ul className="pl-story-sources">
            {sources.map((source, index) => {
              const href = outsideHref(source.url);
              return (
                <li key={index} className="pl-story-source">
                  <AssetImage className="pl-logo-md" src={assetSrc(plugin, source.logo)} label={source.outlet} />
                  <span className="pl-story-source-text">
                    {href ? (
                      <OutsideLink href={href} className="wb-src-link pl-story-source-title">
                        {source.title}
                      </OutsideLink>
                    ) : (
                      <span className="pl-story-source-title">{source.title}</span>
                    )}
                    {source.meta ? <span className="pl-story-source-meta">{source.meta}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {timeline.length > 0 ? (
        <section className="pl-story-sheet-block">
          <h4 className="pl-story-sheet-head">How it moved</h4>
          <ol className="pl-story-timeline">
            {timeline.map((step, index) => (
              <li
                key={index}
                className="pl-story-tl"
                data-told={step.told ? 'true' : undefined}
                data-last={index === timeline.length - 1 ? 'true' : undefined}
              >
                <span className="pl-story-tl-at">{step.at}</span>
                <span className="pl-story-tl-dot" aria-hidden="true" />
                <span className="pl-story-tl-what">{step.text}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

/** A descriptor's route as a link in a line of text. */
function StoryInlineLink({ to, row, label }: { to: RouteRef; row: unknown; label: string }): JSX.Element | null {
  const scope = useScope();
  const href = routeOf(scope, to, row);
  if (href === '') return null;
  if ('href' in to) return <OutsideLink href={href}>{label}</OutsideLink>;
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        scope.navigate(href);
      }}
    >
      {label}
    </a>
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

/* ------------------------------------------------------------------ *
 * One email (1.30)
 * ------------------------------------------------------------------ */

function addressOf(raw: unknown): PageMessageAddress | null {
  if (typeof raw === 'string') return raw.trim() === '' ? null : { address: raw.trim() };
  if (raw && typeof raw === 'object' && typeof (raw as PageMessageAddress).address === 'string') {
    const a = raw as PageMessageAddress;
    return { address: a.address, name: typeof a.name === 'string' && a.name.trim() !== '' ? a.name.trim() : null };
  }
  return null;
}

function addressesOf(raw: unknown): PageMessageAddress[] {
  return Array.isArray(raw) ? raw.map(addressOf).filter((a): a is PageMessageAddress => a !== null) : [];
}

/** "Ana Duarte <ana@studio.test>", or the address alone. */
export function addressWords(a: PageMessageAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** The message as the data has it, every field checked: a row is untrusted. */
export function asMessage(raw: unknown): PageMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const from = addressOf(r.from);
  if (!from) return null;
  const text = (key: string): string | null => (typeof r[key] === 'string' ? (r[key] as string) : null);
  const attachments = Array.isArray(r.attachments)
    ? (r.attachments as unknown[]).filter(
        (a): a is PageMessageAttachment => !!a && typeof a === 'object' && typeof (a as PageMessageAttachment).name === 'string',
      )
    : [];
  return {
    ...(typeof r.id === 'string' ? { id: r.id } : {}),
    from,
    to: addressesOf(r.to),
    cc: addressesOf(r.cc),
    at: text('at'),
    html: text('html'),
    text: text('text'),
    snippet: text('snippet'),
    note: text('note'),
    attachments,
  };
}

/** The first letter a face shows: of the name, else of the address. */
function initialOf(a: PageMessageAddress): string {
  const source = (a.name ?? a.address).replace(/^["'\s]+/, '');
  return (source.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
}

/** One of the six faces, the same one for the same address every time. */
function faceOf(address: string): number {
  let hash = 0;
  for (const ch of address.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (hash % 6) + 1;
}

function MessagePiece({ component, data }: { component: Of<'message'>; data: unknown }): JSX.Element | null {
  const scope = useScope();
  const row = component.path ? readPath(data, component.path) : data;
  const startsFolded = component.folded !== undefined && holds(row, component.folded);
  const [open, setOpen] = useState(!startsFolded);
  const [details, setDetails] = useState(false);
  const read = usePageQuery(open ? component.query : undefined, row);
  const head = asMessage(row);
  const full = component.query ? asMessage(read.data) : head;
  const message = full ?? head;
  if (!message) return null;
  const sender = message.from;
  const when = message.at ? fmtMoment(new Date(message.at), scope.timezone) : '';
  const recipients = [...(message.to ?? []), ...(message.cc ?? [])];
  const face = (
    <span className="ui-avatar pl-mail-face" data-face={faceOf(sender.address)} aria-hidden="true">
      {initialOf(sender)}
    </span>
  );
  if (!open) {
    return (
      <button
        type="button"
        className="pl-mail-folded"
        onClick={() => setOpen(true)}
        aria-label={`Open the message from ${sender.name ?? sender.address}`}
      >
        {face}
        <span className="pl-mail-folded-who">{sender.name ?? sender.address}</span>
        <span className="pl-mail-folded-snippet">{message.snippet ?? ''}</span>
        <span className="pl-mail-when">{when}</span>
      </button>
    );
  }
  return (
    <article className="pl-mail" aria-label={`Message from ${sender.name ?? sender.address}`}>
      <header className="pl-mail-head">
        {face}
        <span className="pl-mail-who">
          <span className="pl-mail-from">
            {sender.name ? <span className="pl-mail-name">{sender.name}</span> : null}
            <span className="pl-mail-address">{sender.name ? `<${sender.address}>` : sender.address}</span>
          </span>
          {recipients.length > 0 ? (
            <button type="button" className="pl-mail-to-toggle" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
              to {recipients.map((a) => a.name ?? a.address).join(', ')}
            </button>
          ) : null}
        </span>
        <span className="pl-mail-when">
          {startsFolded ? (
            <button type="button" className="pl-mail-fold" onClick={() => setOpen(false)} title="Fold this message">
              {when}
            </button>
          ) : (
            when
          )}
        </span>
      </header>
      {details ? (
        <dl className="pl-mail-recipients">
          {(message.to ?? []).length > 0 ? (
            <>
              <dt>To</dt>
              <dd>{(message.to ?? []).map(addressWords).join(', ')}</dd>
            </>
          ) : null}
          {(message.cc ?? []).length > 0 ? (
            <>
              <dt>Cc</dt>
              <dd>{(message.cc ?? []).map(addressWords).join(', ')}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <ErrorBanner message={read.error} />
      {component.query && !full && !read.error ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          {message.note ? <p className="pl-mail-note">{message.note}</p> : null}
          <MessageBody
            html={message.html}
            text={message.text}
            sender={sender.address}
            attachments={message.attachments}
            cidSrc={previewUrl}
          />
          {(message.attachments ?? []).length > 0 ? (
            <MessageFiles attachments={message.attachments ?? []} fetch={component.fetch} />
          ) : null}
        </>
      )}
    </article>
  );
}

/** A message's files as file rows: open on the library entry, or Fetch while there is no file yet. */
function MessageFiles({ attachments, fetch }: { attachments: PageMessageAttachment[]; fetch: ToolRef | undefined }): JSX.Element {
  const scope = useScope();
  const act = useAct();
  return (
    <div className="pl-mail-files">
      <div className="wb-msg-files" role="list" aria-label="Attachments">
        {attachments.map((file, index) => (
          <span role="listitem" key={`${index}-${file.name}`} className="pl-mail-file">
            <FileTile
              name={file.name}
              mime={file.mime}
              sizeBytes={typeof file.size === 'number' ? file.size : null}
              {...(file.artifactId ? { onOpen: () => scope.navigate(fileRoute(file.artifactId)) } : {})}
            />
            {!file.artifactId && fetch ? (
              <ActionButton
                action={fetch}
                args={resolveArgs(fetch.args, { data: file, row: file, scope })}
                disabled={act.busy}
                running={act.running === fetch.tool}
                row={file}
                onRun={(ref, args) => void act.run(ref, args)}
              />
            ) : null}
          </span>
        ))}
      </div>
      <ActOutcome act={act} />
    </div>
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
  params: routeParams,
}: {
  page: PluginPageDescriptor;
  /** The item segment of the route, when there is one. */
  item?: string | null;
  /** The parameters after the hash's `?`: what a link asked this page to open. */
  params?: Record<string, string>;
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
  const [params, setParamsState] = useState<Record<string, string>>(() => ({ ...routeParams }));
  /*
   * A link followed while the page is already showing — the recovery
   * checklist's Fix, a second time — lands its parameters too.
   */
  const routeKey = JSON.stringify(routeParams ?? {});
  useEffect(() => {
    if (routeParams && Object.keys(routeParams).length > 0) setParamsState((current) => ({ ...current, ...routeParams }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);
  const [version, setVersion] = useState(0);
  // The plugin's own tools wrote (an agent recorded balances in chat): every
  // query on the page asks again, keeping its last answer up meanwhile.
  usePluginDataChanged(page.plugin, () => setVersion((n) => n + 1));
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
  // 1.27: the intro may be read from the page's own data (`{ path }`), a sentence the plugin writes.
  const lede =
    !embedded &&
    first?.kind === 'notice' &&
    first.look !== 'quiet' &&
    first.link === undefined &&
    first.action === undefined &&
    first.when === undefined &&
    first.title === undefined &&
    (first.tone === undefined || first.tone === 'neutral')
      ? first.text
      : undefined;
  const shown = lede === undefined ? page : { ...page, body: page.body.slice(1) };
  return (
    <Scope.Provider value={scope}>
      <PageWithData page={shown} embedded={embedded === true} lede={lede} />
    </Scope.Provider>
  );
}

/**
 * The page's own read, asked once, and what is drawn against it: the head's
 * actions (1.27) — Sources, Latest edition — and the body.
 */
function PageWithData({ page, embedded, lede: given }: { page: PluginPageDescriptor; embedded: boolean; lede: string | ValueRef | undefined }): JSX.Element {
  const scope = useScope();
  // A sensitive read is asked only once the owner shows the page: the gate below asks it then.
  const gated = page.data !== undefined && scope.sensitive.has(page.data.query);
  const root = usePageQuery(gated ? undefined : page.data, null);
  const rootData = root.data ?? null;
  const read = given === undefined || typeof given === 'string' ? given : readRef(rootData, given);
  const lede = read === undefined || read === null || read === '' ? undefined : String(read);
  const actions = !embedded && page.actions && page.actions.length > 0 ? (
    <>
      {page.actions.map((action, index) => (
        <HeadAction key={index} component={action} data={rootData} />
      ))}
    </>
  ) : undefined;
  return (
    <PageFrame embedded={embedded} title={page.title} lede={lede} actions={actions}>
      {/*
        The plugin's own place on the rail, while the catalogue agent that
        would use it is not on the team: "Nobody keeps your books yet · Add
        CFO", first, with Not now. Its settings tab draws the same line.
      */}
      {!embedded && page.place === 'rail' ? (
        <PluginTeammatePanel key={page.plugin} plugin={page.plugin} navigate={scope.navigate} dismissible />
      ) : null}
      <PageBody page={page} boxed={embedded} root={gated ? undefined : root} />
    </PageFrame>
  );
}

/** One of the head's actions: a link drawn as a button (ghost, or the accent primary), or a button. */
function HeadAction({ component, data }: { component: Of<'link'> | Of<'button'> | Of<'menu'>; data: unknown }): JSX.Element | null {
  const scope = useScope();
  if (!holds(data, component.when)) return null;
  if (component.kind === 'button') return <ButtonPiece component={component} data={data} />;
  if (component.kind === 'menu') return <MenuPiece component={component} data={data} />;
  const href = routeOf(scope, component.to, data);
  if (href === '') return null;
  const variant = component.tone === 'accent' ? 'accent' : 'ghost';
  if ('href' in component.to) {
    return (
      <ButtonLink variant={variant} href={href} target="_blank" rel="noopener noreferrer">
        {component.label}
        <span className="wb-src-out" aria-hidden="true">↗</span>
      </ButtonLink>
    );
  }
  return (
    <ButtonLink
      variant={variant}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        scope.navigate(href);
      }}
    >
      {component.label}
    </ButtonLink>
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
function PageBody({ page, boxed, root }: { page: PluginPageDescriptor; boxed: boolean; root: PageRead | undefined }): JSX.Element {
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
  return <PageBodyShown page={page} boxed={boxed} root={root} />;
}

type PageRead = { data: unknown; error: string | null; loading: boolean };

function PageBodyShown({ page, boxed, root: given }: { page: PluginPageDescriptor; boxed: boolean; root?: PageRead | undefined }): JSX.Element {
  const asked = usePageQuery(given ? undefined : page.data, null);
  const root = given ?? asked;
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
      } else if (component.kind === 'tabs') {
        // A list-detail inside a tab (the Mail page's Show bar) names the item too.
        for (const tab of component.tabs) walk(tab.body);
      }
    }
  };
  walk(page.body);
  return Object.fromEntries(names.map((name) => [name, item]));
}

/** A plugin page, drawn inside a Settings tab. */
export function PluginSettingsPage(props: {
  page: PluginPageDescriptor;
  params?: Record<string, string>;
  navigate: (route: string, replace?: boolean) => void;
  timezone: string;
  siblings?: PluginPageDescriptor[];
}): JSX.Element {
  return <PluginPage {...props} embedded />;
}

export { Scope as PluginPageScope };

/**
 * A descriptor's `empty` sentence as an empty state: its first sentence is the
 * title and the rest, when there is any, the one line under it.
 */
export function EmptyPiece({ text }: { text: string }): JSX.Element {
  const at = text.search(/[.!?]\s/);
  const title = at === -1 ? text.replace(/[.]$/, '') : text.slice(0, at + (text[at] === '.' ? 0 : 1));
  const rest = at === -1 ? '' : text.slice(at + 1).trim();
  return <EmptyState title={title}>{rest || null}</EmptyState>;
}

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
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, type ApprovalRow } from '../api';
import { downloadUrl } from '../chat/attachments';
import { fmtValue } from '../canvas/format';
import { readPath, readRef } from '../canvas/resolve';
import { pluginPageRoute } from '../routes';
import {
  Button,
  ButtonLink,
  Details,
  Empty,
  ErrorBanner,
  Field as FieldBox,
  KV,
  List,
  ListRow,
  Notice,
  PageFrame,
  Pill,
  Section,
  Sheet,
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
  Component,
  Field,
  ListComponent,
  ListItem,
  ParamRef,
  PluginPageDescriptor,
  QueryRef,
  RouteRef,
  Tone,
  ToolRef,
} from './types';

/* ------------------------------------------------------------------ *
 * The page's own scope: where it is, what it was asked, how to refresh
 * ------------------------------------------------------------------ */

interface PageScope {
  plugin: string;
  page: string;
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
}

const Scope = createContext<PageScope | null>(null);

function useScope(): PageScope {
  const scope = useContext(Scope);
  if (!scope) throw new Error('a plugin page component outside a plugin page');
  return scope;
}

/** A tone the descriptor asked for, as a tone the primitives know. */
function noticeTone(tone: Tone | undefined): 'good' | 'warning' | 'critical' | undefined {
  return tone === undefined || tone === 'neutral' ? undefined : tone;
}

function pillTone(tone: Tone | undefined): 'good' | 'warning' | 'critical' | undefined {
  return noticeTone(tone);
}

/** Where a route reference points, inside this plugin. */
function routeOf(scope: PageScope, to: RouteRef, data: unknown): string {
  const item = to.item === undefined ? null : readRef(data, to.item);
  return pluginPageRoute(scope.plugin, to.page, item === null || item === undefined ? null : String(item));
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
  source: { data: unknown; row?: unknown; fields?: Record<string, unknown>; selected?: string[]; scope: PageScope },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, ref] of Object.entries(args ?? {})) {
    if ('row' in ref) out[key] = readPath(source.row, ref.row);
    else if ('field' in ref) out[key] = source.fields?.[ref.field];
    else if ('selected' in ref) out[key] = source.selected ?? [];
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
  busy: boolean;
  error: string | null;
  approvalId: string | null;
  run: (ref: ToolRef, args: Record<string, unknown>, onDone?: () => void) => Promise<void>;
  clear: () => void;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const run = async (ref: ToolRef, args: Record<string, unknown>, onDone?: () => void): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.pageAct(scope.plugin, { tool: ref.tool, args });
      if (out.approvalId) {
        setApprovalId(out.approvalId);
        return;
      }
      setApprovalId(null);
      const then = ref.then ?? 'refresh';
      if (typeof then === 'object') scope.navigate(routeOf(scope, then.route, out.result));
      else {
        if (then === 'close') onDone?.();
        scope.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, approvalId, run, clear: () => setApprovalId(null) };
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
  onRun,
}: {
  action: ToolRef;
  args: Record<string, unknown>;
  disabled?: boolean;
  onRun: (ref: ToolRef, args: Record<string, unknown>) => void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  if (asking && action.confirm) {
    return (
      <>
        <span className="ui-toolbar-note">{action.confirm}</span>
        <Button
          variant={action.tone === 'danger' ? 'danger' : 'accent'}
          disabled={disabled}
          onClick={() => {
            setAsking(false);
            onRun(action, args);
          }}
        >
          Yes, {action.label.toLowerCase()}
        </Button>
        <Button variant="ghost" onClick={() => setAsking(false)}>
          Cancel
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
      {action.label}
    </Button>
  );
}

/** One approval, by id: the card Home draws, drawn here. */
function ApprovalById({ id, onDecided }: { id: string; onDecided?: () => void }): JSX.Element {
  const scope = useScope();
  const action = useAsync<ApprovalRow>(() => api.approval(id), [id, scope.version]);
  const { busy, note, failure, decide } = useDecide(() => {
    onDecided?.();
    scope.refresh();
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
  if (act.approvalId) return <ApprovalById id={act.approvalId} onDecided={act.clear} />;
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

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const shared = { id: `f-${field.name}`, required: field.required, name: field.name };
  if (field.type === 'select') {
    return (
      <FieldBox label={field.label} hint={field.hint}>
        <select {...shared} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
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
      <FieldBox label={field.label} hint={field.hint}>
        <textarea {...shared} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} rows={6} />
      </FieldBox>
    );
  }
  if (field.type === 'checkbox') {
    return (
      <FieldBox label={field.label} hint={field.hint} inline>
        <input {...shared} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      </FieldBox>
    );
  }
  const type = field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : field.type;
  return (
    <FieldBox label={field.label} hint={field.hint}>
      <input
        {...shared}
        type={type}
        value={value === null || value === undefined ? '' : String(value)}
        min={field.min}
        max={field.max}
        step={field.step}
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

function Fields({
  fields,
  values,
  onChange,
}: {
  fields: Field[];
  values: Values;
  onChange: (name: string, value: unknown) => void;
}): JSX.Element {
  return (
    <Stack gap="sm">
      {fields.map((field) => (
        <FieldControl
          key={field.name}
          field={field}
          value={values[field.name]}
          onChange={(value) => onChange(field.name, value)}
        />
      ))}
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * The components
 * ------------------------------------------------------------------ */

/** A header for a component that asked for one, and its one line. */
function Heading({ title, note }: { title?: string; note?: string }): JSX.Element | null {
  if (!title && !note) return null;
  return (
    <div className="ui-section-head">
      {title ? <h3 className="ui-section-title">{title}</h3> : <span />}
      {note ? <span className="muted">{note}</span> : null}
    </div>
  );
}

function Piece({ component, data }: { component: Component; data: unknown }): JSX.Element | null {
  // `when` is the only logic a descriptor may carry, and it is an equality.
  if (component.when && readPath(data, component.when.path) !== component.when.equals) return null;
  switch (component.kind) {
    case 'section':
      return (
        <Section title={component.title} aside={component.note ? <span className="muted">{component.note}</span> : undefined}>
          <Stack gap="lg">
            {component.body.map((child, index) => (
              <Piece key={index} component={child} data={data} />
            ))}
          </Stack>
        </Section>
      );
    case 'notice':
      return (
        <Notice tone={noticeTone(component.tone)} title={component.title}>
          {component.text}
        </Notice>
      );
    case 'link':
      return <LinkPiece component={component} data={data} />;
    case 'stats':
      return <StatsPiece component={component} data={data} />;
    case 'list':
      return <ListPiece component={component} data={data} />;
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
    case 'expand':
      return <ExpandPiece component={component} data={data} />;
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

function LinkPiece({ component, data }: { component: Of<'link'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const href = routeOf(scope, component.to, data);
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
    <Section title={component.title} aside={component.note ? <span className="muted">{component.note}</span> : undefined}>
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
              tone={noticeTone(item.tone)}
            />
          ))}
        </Stats>
      )}
    </Section>
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
): { title: ReactNode; sub: ReactNode; side: ReactNode; href: string | null; text: string } {
  const meta = (item.meta ?? []).map((ref) => String(readRef(row, ref) ?? '')).filter((text) => text !== '');
  const text = String(readRef(row, item.title) ?? '');
  const href = item.to ? routeOf(scope, item.to, row) : null;
  return {
    text,
    href,
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
        {item.pill ? <Pill tone={pillTone(item.pill.tone)}>{String(readRef(row, item.pill.value) ?? '')}</Pill> : null}
        {meta.length > 0 ? <span className="muted"> {meta.join(' · ')}</span> : null}
      </>
    ),
  };
}

function rowsOf(data: unknown, path: string): unknown[] {
  const rows = readPath(data, path);
  return Array.isArray(rows) ? rows : [];
}

function ListPiece({ component, data }: { component: ListComponent; data: unknown }): JSX.Element {
  const scope = useScope();
  const query = usePageQuery(component.query, data);
  const act = useAct();
  const [selected, setSelected] = useState<string[]>([]);
  const rows = rowsOf(query.data, component.rows);
  const folded = component.collapsed ? rowsOf(query.data, component.collapsed.rows) : [];

  const groups = useMemo(() => {
    if (!component.groupBy) return [{ label: null as string | null, rows }];
    const by = new Map<string, unknown[]>();
    for (const row of rows) {
      const key = String(readPath(row, component.groupBy.key) ?? '');
      by.set(key, [...(by.get(key) ?? []), row]);
    }
    return [...by].map(([key, group]) => ({ label: component.groupBy?.labels?.[key] ?? key, rows: group }));
  }, [rows, component.groupBy]);

  const lines = (group: unknown[]): JSX.Element[] =>
    group.map((row, index) => {
      const drawn = itemRow(scope, component.item, row);
      const key = component.select ? String(readPath(row, component.select.key) ?? index) : String(index);
      const disabled =
        component.select?.disabledWhen !== undefined &&
        readPath(row, component.select.disabledWhen.path) === component.select.disabledWhen.equals;
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
          title={drawn.title}
          sub={drawn.sub}
          side={
            <>
              {drawn.side}
              {(component.actions ?? []).map((action, i) => (
                <ActionButton
                  key={i}
                  action={action}
                  args={resolveArgs(action.args, { data: query.data, row, scope })}
                  disabled={act.busy}
                  onRun={(ref, args) => void act.run(ref, args)}
                />
              ))}
            </>
          }
        />
      );
    });

  return (
    <Section title={component.title} aside={component.note ? <span className="muted">{component.note}</span> : undefined}>
      <ErrorBanner message={query.error} />
      <ActOutcome act={act} />
      {rows.length === 0 ? (
        <Empty>{query.loading ? 'Loading…' : (component.empty ?? 'Nothing here.')}</Empty>
      ) : (
        <List>
          {groups.map((group, index) => (
            <div key={index}>
              {group.label ? <div className="ui-list-group">{group.label}</div> : null}
              {lines(group.rows)}
            </div>
          ))}
        </List>
      )}
      {component.collapsed && folded.length > 0 ? (
        <Details summary={`${component.collapsed.label} (${folded.length})`}>
          <List>{lines(folded)}</List>
        </Details>
      ) : null}
      {component.bulk && component.bulk.length > 0 ? (
        <Toolbar align="end">
          <span className="ui-toolbar-note">{selected.length} selected</span>
          {component.bulk.map((action, index) => (
            <ActionButton
              key={index}
              action={action}
              args={resolveArgs(action.args, { data: query.data, selected, scope })}
              disabled={act.busy || selected.length === 0}
              onRun={(ref, args) => {
                setSelected([]);
                void act.run(ref, args);
              }}
            />
          ))}
        </Toolbar>
      ) : null}
    </Section>
  );
}

function TablePiece({ component, data }: { component: Of<'table'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const query = usePageQuery(component.query, data);
  const act = useAct();
  const rows = rowsOf(query.data, component.rows);
  return (
    <Section title={component.title} aside={component.note ? <span className="muted">{component.note}</span> : undefined}>
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
                  <td key={column.key}>{fmtValue(readPath(row, column.key), column.type ?? 'text', null)}</td>
                ))}
                {component.actions && component.actions.length > 0 ? (
                  <td>
                    <Toolbar align="end">
                      {component.actions.map((action, i) => (
                        <ActionButton
                          key={i}
                          action={action}
                          args={resolveArgs(action.args, { data: query.data, row, scope })}
                          disabled={act.busy}
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
    </Section>
  );
}

function DetailPiece({ component, data }: { component: Of<'detail'>; data: unknown }): JSX.Element {
  const query = usePageQuery(component.query, data);
  if (query.error) return <ErrorBanner message={query.error} />;
  if (query.data === undefined) return <Empty>{component.empty ?? 'Loading…'}</Empty>;
  return (
    <Section title={component.title} aside={component.note ? <span className="muted">{component.note}</span> : undefined}>
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
    </Section>
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
      <Section title={component.title} aside={component.note ? <span className="muted">{component.note}</span> : undefined}>
        <ErrorBanner message={initial.error} />
        {body}
      </Section>
    );
  }
  return (
    <Section title={component.title} aside={component.note ? <span className="muted">{component.note}</span> : undefined}>
      <Toolbar align="end">
        <Button variant="accent" onClick={() => setOpen(true)}>
          {component.drawer.button}
        </Button>
      </Toolbar>
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
  const scope = useScope();
  const [values, setValues] = useState<Values>(() => initialValues(component.fields, initialData));
  const missing = component.fields.some(
    (field) => field.required && (values[field.name] === '' || values[field.name] === undefined),
  );
  return (
    <Stack>
      <Fields fields={component.fields} values={values} onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))} />
      <ActOutcome act={act} />
      <Toolbar align="end">
        <ActionButton
          action={component.submit}
          args={resolveArgs(component.submit.args, { data, fields: values, scope })}
          disabled={act.busy || missing}
          onRun={(ref, args) => void act.run(ref, args, onDone)}
        />
      </Toolbar>
    </Stack>
  );
}

function SearchPiece({ component, data }: { component: Of<'search'>; data: unknown }): JSX.Element {
  const scope = useScope();
  const [values, setValues] = useState<Values>(() => initialValues(component.fields, data));
  const [asked, setAsked] = useState(false);
  const ready = component.fields.every((field) => !field.required || String(values[field.name] ?? '') !== '');
  const query = usePageQuery(asked ? component.query : undefined, data);
  const rows = rowsOf(query.data, 'items');
  return (
    <Section title={component.title} aside={component.note ? <span className="muted">{component.note}</span> : undefined}>
      <Stack>
        <Fields fields={component.fields} values={values} onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))} />
        <Toolbar align="end">
          <Button
            variant="accent"
            disabled={!ready}
            onClick={() => {
              scope.setParams(
                Object.fromEntries(
                  component.fields.map((field) => [field.name, String(values[field.name] ?? '') || null]),
                ),
              );
              setAsked(true);
            }}
          >
            Search
          </Button>
        </Toolbar>
        <ErrorBanner message={query.error} />
        {asked ? (
          rows.length === 0 ? (
            <Empty>{query.loading ? 'Searching…' : (component.empty ?? 'Nothing matches.')}</Empty>
          ) : (
            <List>
              {rows.map((row, index) => {
                const drawn = itemRow(scope, component.results, row);
                return (
                  <ListRow
                    key={index}
                    title={drawn.title}
                    sub={drawn.sub}
                    side={drawn.side}
                  />
                );
              })}
            </List>
          )
        ) : null}
      </Stack>
    </Section>
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
  const chosen = scope.params[component.param] ?? scope.item;
  return (
    <div className="ui-split">
      <div className="ui-split-list">
        <Piece component={component.list} data={data} />
      </div>
      <div className="ui-split-detail">
        {chosen ? (
          <Stack gap="lg">
            {component.detail.map((child, index) => (
              <Piece key={index} component={child} data={data} />
            ))}
          </Stack>
        ) : (
          <Empty>{component.empty ?? 'Choose one to see it here.'}</Empty>
        )}
      </div>
    </div>
  );
}

function ExpandPiece({ component, data }: { component: Of<'expand'>; data: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  const query = usePageQuery(open ? component.query : undefined, data);
  return (
    <Details summary={component.label} boxed onToggle={(isOpen) => setOpen(isOpen)}>
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
  if (query.error) return <ErrorBanner message={query.error} />;
  if (query.data === undefined) return <Empty>{component.empty ?? 'Loading…'}</Empty>;
  return (
    <EditorBody
      key={JSON.stringify(query.data)}
      component={component}
      data={data}
      loaded={query.data}
    />
  );
}

function EditorBody({
  component,
  data,
  loaded,
}: {
  component: Of<'editor'>;
  data: unknown;
  loaded: unknown;
}): JSX.Element {
  const scope = useScope();
  const act = useAct();
  const [values, setValues] = useState<Values>(() => initialValues(component.fields, loaded));
  /*
   * The version travels with the save as the implicit field `version`: it is
   * the stamp the tool refuses a stale write against, and it is read from the
   * same answer the fields were filled from — never from a clock here.
   */
  const withVersion = { ...values, version: readPath(loaded, component.version) };
  return (
    <Section title={component.title} aside={component.note ? <span className="muted">{component.note}</span> : undefined}>
      <Stack>
        <Fields fields={component.fields} values={values} onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))} />
        <ActOutcome act={act} />
        <Toolbar align="end">
          {(component.actions ?? []).map((action, index) => (
            <ActionButton
              key={index}
              action={action}
              args={resolveArgs(action.args, { data, fields: withVersion, scope })}
              disabled={act.busy}
              onRun={(ref, args) => void act.run(ref, args)}
            />
          ))}
          <ActionButton
            action={component.save}
            args={resolveArgs(component.save.args, { data, fields: withVersion, scope })}
            disabled={act.busy}
            onRun={(ref, args) => void act.run(ref, args)}
          />
        </Toolbar>
      </Stack>
    </Section>
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
}: {
  page: PluginPageDescriptor;
  /** The item segment of the route, when there is one. */
  item?: string | null;
  navigate: (route: string, replace?: boolean) => void;
  timezone: string;
  /** Inside a settings tab: no page header, no page gap. */
  embedded?: boolean;
}): JSX.Element {
  const [params, setParamsState] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const scope: PageScope = {
    plugin: page.plugin,
    page: page.id,
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
  };
  return (
    <Scope.Provider value={scope}>
      <PageFrame embedded={embedded} title={page.title}>
        <Stack gap="lg" divided>
          {page.body.map((component, index) => (
            <Piece key={index} component={component} data={null} />
          ))}
        </Stack>
      </PageFrame>
    </Scope.Provider>
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
}): JSX.Element {
  return <PluginPage {...props} embedded />;
}

export { Scope as PluginPageScope };

/**
 * The generic tool-result card: what a tool with no view of its own looks
 * like on the Canvas.
 *
 * Its head is the result's owner-facing name with the agent's face beside
 * it, and a ⋯ menu that holds the raw JSON — one click away, never in the
 * way. Its body is picked by the result's shape (`../result-shape.ts`): a
 * profile leads with who it names, a list of items is one line per item
 * (its name and a fact or two), settings are rows with their value on the
 * right, and anything else is a definition grid of its fields — booleans and
 * states as badges, short lists as chips, longer ones as compact rows,
 * nested objects folded, days and times the owner's way.
 *
 * What is not an object at all (a table of rows, a command's output) is
 * handed back to `Structured`, inside the same card.
 */
import { useState, type ReactNode } from 'react';
import { ActionMenu, Details, Pill } from '../../ui';
import { fmtDay, fmtNumber, fmtTime, json } from '../../format';
import { humanise } from '../resolve';
import { commandResult } from '../command-result';
import {
  CHIP_COUNT,
  fieldKind,
  identityKey,
  isPlainObject,
  itemsShape,
  resultViewFor,
  type ItemsShape,
} from '../result-shape';
import { Structured } from './Structured';

export interface ToolResultProps {
  value: unknown;
  title: string;
  tool: string;
  /** The agent's face, small, drawn before the title. */
  face?: ReactNode;
  timezone: string;
}

export function ToolResult({ value, title, tool, face, timezone }: ToolResultProps): JSX.Element {
  const [raw, setRaw] = useState(false);
  // A command's output and a result with files keep their own drawing.
  const view = commandResult(value) || hasArtifacts(value) ? 'other' : resultViewFor(value);
  return (
    <div className="wb-result" data-testid="tool-result" data-view={view}>
      <header className="ui-panel-head wb-result-head">
        {face ? <span className="wb-result-face" aria-hidden="true">{face}</span> : null}
        <h2 className="ui-panel-title wb-result-title" title={tool}>{title}</h2>
        <ActionMenu
          label={`More for ${title}`}
          items={[{ label: raw ? 'Show readable' : 'Raw JSON', onSelect: () => setRaw((current) => !current) }]}
        />
      </header>
      {raw ? <pre className="ui-code">{json(value)}</pre> : <Body view={view} value={value} timezone={timezone} />}
    </div>
  );
}

function hasArtifacts(value: unknown): boolean {
  return isPlainObject(value) && Array.isArray(value.artifacts);
}

function Body({ view, value, timezone }: { view: ReturnType<typeof resultViewFor>; value: unknown; timezone: string }): JSX.Element {
  switch (view) {
    case 'items': return <Items shape={itemsShape(value)!} timezone={timezone} />;
    case 'profile': return <ProfileCard value={value as Record<string, unknown>} timezone={timezone} />;
    case 'settings': return <Settings value={value as Record<string, unknown>} timezone={timezone} />;
    case 'fields': return <Fields value={value as Record<string, unknown>} timezone={timezone} depth={0} />;
    default: return <Structured props={{ value }} bare />;
  }
}

/* ------------------------------------------------------------------ *
 * The purpose-built views.
 * ------------------------------------------------------------------ */

/** Someone, or something that names itself: the name first, the rest as facts. */
function ProfileCard({ value, timezone }: { value: Record<string, unknown>; timezone: string }): JSX.Element {
  const key = identityKey(value)!;
  const rest = Object.fromEntries(Object.entries(value).filter(([field]) => field !== key));
  return (
    <div className="wb-result-profile">
      <p className="wb-result-lead">
        <span className="wb-result-lead-k">{humanise(key)}</span>
        <span className="wb-result-lead-v">{String(value[key])}</span>
      </p>
      <Fields value={rest} timezone={timezone} depth={0} />
    </div>
  );
}

/** One line per item: its name, and a fact or two after it. */
function Items({ shape, timezone }: { shape: ItemsShape; timezone: string }): JSX.Element {
  const [all, setAll] = useState(false);
  const limit = shape.rows.length <= 25 ? shape.rows.length : 20;
  const shown = all ? shape.rows : shape.rows.slice(0, limit);
  return (
    <div className="wb-result-items">
      {shape.label || shape.extras.length ? (
        <p className="wb-result-items-head">
          {shape.label ? <span className="wb-result-items-label">{shape.label}</span> : null}
          {shape.extras.map(([key, child]) => (
            <span key={key} className="wb-result-items-extra">{humanise(key)} <Value field={key} value={child} timezone={timezone} /></span>
          ))}
        </p>
      ) : null}
      <ul className="wb-result-rows">
        {shown.map((row, index) => (
          <li key={index} className="wb-result-row">
            <span className="wb-result-row-name">{String(row[shape.name] ?? '—')}</span>
            {shape.facts.length ? (
              <span className="wb-result-row-facts">
                {shape.facts.filter((fact) => row[fact] !== undefined && row[fact] !== null && row[fact] !== '').map((fact) => (
                  <span key={fact} className="wb-result-row-fact" title={humanise(fact)}>
                    <Value field={fact} value={row[fact]} timezone={timezone} />
                  </span>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {shape.rows.length > shown.length ? (
        <p className="wb-note wb-note-row">
          <span>Showing {shown.length} of {shape.rows.length}</span>
          <button type="button" className="ui-btn" data-size="sm" onClick={() => setAll(true)}>Show all {shape.rows.length}</button>
        </p>
      ) : null}
    </div>
  );
}

/** Switches and short values: one row each, the value on the right. */
function Settings({ value, timezone }: { value: Record<string, unknown>; timezone: string }): JSX.Element {
  return (
    <dl className="wb-result-settings">
      {Object.entries(value).map(([key, child]) => (
        <div key={key} className="wb-result-setting">
          <dt>{humanise(key)}</dt>
          <dd><Value field={key} value={child} timezone={timezone} /></dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ *
 * The definition grid, and one value drawn by its kind.
 * ------------------------------------------------------------------ */

/** Past this depth a group shows its JSON: three levels in, a grid helps nobody. */
const GROUP_DEPTH = 3;

function Fields({ value, timezone, depth }: { value: Record<string, unknown>; timezone: string; depth: number }): JSX.Element {
  const entries = Object.entries(value);
  if (entries.length === 0) return <p className="wb-note">Nothing to show.</p>;
  return (
    <dl className="wb-result-grid">
      {entries.map(([key, child]) => {
        const kind = fieldKind(key, child);
        if (kind.kind === 'group') {
          const size = Object.keys(kind.value).length;
          return (
            <div key={key} className="wb-result-group">
              <Details summary={<><span className="wb-result-group-k">{humanise(key)}</span> <span className="wb-result-group-n">{size} {size === 1 ? 'field' : 'fields'}</span></>} open={depth === 0 && size <= 4}>
                {depth + 1 >= GROUP_DEPTH ? <pre className="ui-code">{json(kind.value)}</pre> : <Fields value={kind.value} timezone={timezone} depth={depth + 1} />}
              </Details>
            </div>
          );
        }
        return (
          <div key={key} className="contents">
            <dt>{humanise(key)}</dt>
            <dd><Value field={key} value={child} timezone={timezone} /></dd>
          </div>
        );
      })}
    </dl>
  );
}

function Value({ field, value, timezone }: { field: string; value: unknown; timezone: string }): JSX.Element {
  const kind = fieldKind(field, value);
  switch (kind.kind) {
    case 'empty': return <span className="wb-result-empty">{Array.isArray(value) ? 'None' : '—'}</span>;
    case 'boolean': return <Pill tone={kind.value ? 'good' : undefined} dot>{kind.value ? 'Yes' : 'No'}</Pill>;
    case 'number': return <span className="tnum">{Number.isInteger(kind.value) ? fmtNumber(kind.value) : String(Math.round(kind.value * 100) / 100)}</span>;
    case 'day': return <span>{fmtDay(kind.value, { year: true })}</span>;
    case 'moment': return <time dateTime={kind.value}>{fmtTime(kind.value, timezone)}</time>;
    case 'link': return <a href={kind.value} target="_blank" rel="noopener noreferrer">{kind.value}</a>;
    case 'enum': return <Pill>{kind.value.replace(/_/g, ' ')}</Pill>;
    case 'text': return <span className="wb-result-text">{kind.value}</span>;
    case 'chips': return (
      <span className="wb-result-chips">
        {kind.values.map((chip, index) => <Pill key={`${chip}-${index}`}>{chip}</Pill>)}
      </span>
    );
    case 'rows': return <CompactRows values={kind.values} timezone={timezone} />;
    case 'group': return <span className="wb-result-empty">{Object.keys(kind.value).length} fields</span>;
  }
}

/** A longer list: one quiet row each, the first few shown and the rest counted. */
function CompactRows({ values, timezone }: { values: unknown[]; timezone: string }): JSX.Element {
  const [all, setAll] = useState(false);
  const shown = all ? values : values.slice(0, CHIP_COUNT);
  return (
    <span className="wb-result-compact">
      <ul>
        {shown.map((item, index) => (
          <li key={index}>{rowLine(item, timezone)}</li>
        ))}
      </ul>
      {values.length > shown.length ? (
        <button type="button" className="ui-btn" data-variant="ghost" data-size="sm" onClick={() => setAll(true)}>
          {values.length - shown.length} more
        </button>
      ) : null}
    </span>
  );
}

/** One element of a longer list, said on one line. */
function rowLine(item: unknown, timezone: string): ReactNode {
  if (isPlainObject(item)) {
    const key = identityKey(item);
    const facts = Object.entries(item)
      .filter(([field, child]) => field !== key && (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean'))
      .slice(0, 2);
    return (
      <>
        {key ? <span className="wb-result-row-name">{String(item[key])}</span> : null}
        {facts.map(([field, child]) => (
          <span key={field} className="wb-result-row-fact" title={humanise(field)}> <Value field={field} value={child} timezone={timezone} /></span>
        ))}
      </>
    );
  }
  return <Value field="" value={item} timezone={timezone} />;
}

/**
 * The tools an agent may call, as boxes to tick instead of names to type.
 *
 * Every installed tool, grouped by the plugin that ships it, each with its own
 * one-line description. Nothing here knows a tool by name: which group a tool
 * is in, what a whole group saves as, which tools are never grantable from the
 * dashboard, which are core and what a plugin suggests all arrive from
 * `GET /api/agents/:id/tools`.
 *
 *  - A group with every tool ticked saves as its family glob, when the server
 *    offered one; otherwise as names. Saving what was loaded changes nothing.
 *  - The tools that create, change and remove agents are drawn and disabled:
 *    the server refuses them from every door but a text editor.
 *  - Removing a core tool asks once, because an agent without them forgets.
 *  - A plugin's newer suggestions sit on top, each one click to add, and none
 *    of them is applied by itself.
 *  - Every group starts folded: its header says how much of it is granted.
 *    A search unfolds the groups with a match and shows only the matching
 *    rows; clearing it folds them all again. Nothing is remembered.
 */
import { useId, useState } from 'react';
import type { PickerGroup, ToolPickerView } from '../../api';
import { Button, Empty, Notice, Pill } from '../../ui';

/** Where the grant a set of ticked names saves as: globs for whole groups, names otherwise. */
export function grantFrom(groups: readonly PickerGroup[], chosen: readonly string[]): string[] {
  const picked = new Set(chosen);
  const grant: string[] = [];
  const known = new Set<string>();
  for (const group of groups) {
    for (const tool of group.tools) known.add(tool.name);
    const ticked = group.tools.filter((t) => picked.has(t.name));
    if (ticked.length === 0) continue;
    if (group.glob && ticked.length === group.tools.length) grant.push(group.glob);
    else grant.push(...ticked.map((t) => t.name));
  }
  // A grant the picker cannot draw (a tool no longer installed) is kept as it was.
  grant.push(...chosen.filter((name) => !known.has(name)));
  return grant;
}

export function sameTools(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join(',') === [...b].sort().join(',');
}

const FORGETS = 'This agent will not remember anything between conversations.';

export function ToolPicker({
  view,
  chosen,
  onChange,
  disabled,
}: {
  view: ToolPickerView;
  chosen: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<{ plugin: string; names: string[] } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (plugin: string): void =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(plugin)) next.delete(plugin);
      else next.add(plugin);
      return next;
    });
  const search = (value: string): void => {
    setQuery(value);
    // A new search starts from its own matches; an empty one folds everything.
    setOpen(new Set());
  };
  const base = useId();
  const picked = new Set(chosen);
  const coreNames = new Set(view.groups.flatMap((g) => g.tools.filter((t) => t.core).map((t) => t.name)));

  /** Take names out, asking first when any of them is core. */
  const remove = (plugin: string, names: string[]): void => {
    const leaving = names.filter((n) => picked.has(n));
    if (leaving.length === 0) return;
    if (leaving.some((n) => coreNames.has(n))) {
      setPending({ plugin, names: leaving });
      return;
    }
    onChange(chosen.filter((n) => !leaving.includes(n)));
  };
  const add = (names: string[]): void => {
    onChange([...chosen, ...names.filter((n) => !picked.has(n))]);
  };

  const needle = query.trim().toLowerCase();
  const matches = (name: string, description: string): boolean =>
    needle === '' || name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle);
  const groups = view.groups
    .map((group) => ({ group, tools: group.tools.filter((t) => matches(t.name, t.description)) }))
    .filter((g) => g.tools.length > 0);
  const suggested = (view.suggested?.tools ?? []).filter((t) => !picked.has(t.name));

  return (
    <div className="tool-picker">
      {view.suggested && suggested.length > 0 ? (
        <div className="tool-picker-group" role="group" aria-labelledby={`${base}-suggested`}>
          <div className="tool-picker-head">
            <span id={`${base}-suggested`} className="tool-picker-plugin">{view.suggested.label}</span>
          </div>
          <ul className="ui-list tool-picker-list" aria-label={view.suggested.label}>
            {suggested.map((tool) => (
              <li key={tool.name} className="ui-list-row">
                <span className="ui-list-main">
                  <span className="ui-list-title mono">{tool.name}</span>
                  <span className="ui-list-sub">{tool.description}</span>
                </span>
                <Button size="sm" disabled={disabled} aria-label={`Add ${tool.name}`} onClick={() => add([tool.name])}>
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="tool-picker-search">
        <span className="ui-field-label">Find a tool</span>
        <input type="search" value={query} placeholder="Name or what it does" onChange={(e) => search(e.target.value)} />
      </label>

      {groups.length === 0 ? <Empty>No installed tool matches “{query.trim()}”.</Empty> : null}

      {groups.map(({ group, tools }) => {
        const grantable = group.tools.filter((t) => t.grantable).map((t) => t.name);
        const held = group.tools.filter((t) => picked.has(t.name)).length;
        const whole = Boolean(group.glob) && held === group.tools.length;
        const headId = `${base}-${group.plugin}`;
        const listId = `${base}-${group.plugin}-list`;
        // Searching unfolds whatever matched; otherwise the owner's clicks decide.
        const expanded = needle !== '' ? !open.has(group.plugin) : open.has(group.plugin);
        return (
          <div
            key={group.plugin}
            className="tool-picker-group"
            role="group"
            aria-labelledby={headId}
            data-open={expanded ? 'true' : undefined}
          >
            <div className="tool-picker-head">
              <button
                type="button"
                className="tool-picker-toggle"
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => toggle(group.plugin)}
              >
                <ChevronIcon />
                <span id={headId} className="tool-picker-plugin">{group.plugin}</span>
                <span className="muted">
                  {whole ? `all ${group.tools.length}` : `${held} of ${group.tools.length} granted`}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`All ${group.plugin} tools`}
                disabled={disabled || grantable.every((n) => picked.has(n))}
                onClick={() => add(grantable)}
              >
                all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`No ${group.plugin} tools`}
                disabled={disabled || !grantable.some((n) => picked.has(n))}
                onClick={() => remove(group.plugin, grantable)}
              >
                none
              </Button>
            </div>
            {pending?.plugin === group.plugin ? (
              <Notice tone="warning" role="alert">
                <div className="tool-picker-confirm">
                  <span>{FORGETS}</span>
                  <span className="ui-toolbar-spacer" />
                  <Button size="sm" onClick={() => setPending(null)}>Keep</Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      onChange(chosen.filter((n) => !pending.names.includes(n)));
                      setPending(null);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </Notice>
            ) : null}
            <ul id={listId} className="ui-list tool-picker-list" hidden={!expanded}>
              {tools.map((tool) => {
                const id = `${base}-${tool.name}`;
                return (
                  <li key={tool.name} className="ui-list-row">
                    <input
                      type="checkbox"
                      id={id}
                      checked={picked.has(tool.name)}
                      disabled={disabled || !tool.grantable}
                      onChange={(e) => (e.target.checked ? add([tool.name]) : remove(group.plugin, [tool.name]))}
                    />
                    <label htmlFor={id} className="ui-list-main">
                      <span className="ui-list-title">
                        <span className="mono">{tool.name}</span>
                        {tool.core ? <Pill tone="accent">core</Pill> : null}
                        {tool.gated ? <Pill tone="warning">asks you</Pill> : null}
                      </span>
                      <span className="ui-list-sub">
                        {tool.grantable ? tool.description : `${tool.description} Granted only by editing the file by hand.`}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ChevronIcon(): JSX.Element {
  return (
    <svg className="tool-picker-chevron" viewBox="0 0 11 11" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.8 4.2 5.5 6.9l2.7-2.7" />
    </svg>
  );
}

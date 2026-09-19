/**
 * The event log, live-ish.
 *
 * Polled every five seconds rather than streamed: the log is durable state and
 * a socket would be a second, weaker copy of it. Filters are a kind and a
 * substring of the payload; a row opens a sheet with the whole envelope.
 */
import { useEffect, useState } from 'react';
import { api, type EventPage, type EventRow } from '../api';
import { fmtRelative, fmtTime, json, truncate } from '../format';
import { Button, Code, Empty, ErrorBanner, PageFrame, Panel, Sheet, Table, Toolbar, useAsync } from '../ui';

const POLL_MS = 5_000;
const PAGE = 50;

export function Events({ timezone, embedded }: { timezone: string; embedded?: boolean }): JSX.Element {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<EventRow | null>(null);

  const kinds = useAsync(() => api.eventKinds(), []);
  const { data, error } = useAsync<EventPage>(
    () => api.events({ kind: kind || undefined, q: q || undefined, limit: PAGE }),
    [kind, q],
    POLL_MS,
  );
  // Older pages, fetched on request and kept while the first page keeps
  // polling for the newest. A filter change starts over.
  const [older, setOlder] = useState<{ events: EventRow[]; cursor: string | null; busy: boolean; error: string | null }>({ events: [], cursor: null, busy: false, error: null });
  useEffect(() => { setOlder({ events: [], cursor: null, busy: false, error: null }); }, [kind, q]);
  const cursor = older.events.length > 0 ? older.cursor : (data?.nextCursor ?? null);
  const loadOlder = async (): Promise<void> => {
    if (!cursor) return;
    setOlder((o) => ({ ...o, busy: true, error: null }));
    try {
      const page = await api.events({ kind: kind || undefined, q: q || undefined, before: cursor, limit: PAGE });
      setOlder((o) => ({ events: [...o.events, ...page.events], cursor: page.nextCursor, busy: false, error: null }));
    } catch (err) {
      setOlder((o) => ({ ...o, busy: false, error: err instanceof Error ? err.message : String(err) }));
    }
  };
  const seen = new Set((data?.events ?? []).map((e) => e.id));
  const rows = [...(data?.events ?? []), ...older.events.filter((e) => !seen.has(e.id))];

  return (
    <PageFrame
      embedded={embedded}
      title="Events"
      lede="The append-only log. Everything the installation did, including what you do here."
    >

      <Toolbar>
        <select aria-label="Event kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">every kind</option>
          {(kinds.data?.kinds ?? []).map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.kind} ({k.count})
            </option>
          ))}
        </select>
        <input
          aria-label="Payload contains"
          placeholder="payload contains…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          size={28}
        />
        {kind || q ? (
          <Button
            onClick={() => {
              setKind('');
              setQ('');
            }}
          >
            Clear
          </Button>
        ) : null}
        <span className="muted">refreshes every {POLL_MS / 1000}s</span>
      </Toolbar>

      <ErrorBanner message={error} />

      <Panel flush>
        {!data || rows.length === 0 ? (
          <Empty>No events match.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>#</th>
                <th>When</th>
                <th>Kind</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((event) => (
                <tr key={event.id} data-clickable="true" onClick={() => setSelected(event)}>
                  <td className="mono muted">{event.id}</td>
                  <td className="nowrap">
                    {fmtTime(event.createdAt, timezone)}
                    <div className="sub">{fmtRelative(event.createdAt)}</div>
                  </td>
                  <td className="mono nowrap">{event.kind}</td>
                  <td className="mono muted">{truncate(json(event.payload).replace(/\s+/g, ' '), 120)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {cursor || older.error ? (
        <Toolbar>
          <span className="muted">{rows.length} shown{cursor ? ', older ones are kept' : ''}.</span>
          <span className="ui-toolbar-spacer" />
          {older.error ? <span className="critical">{older.error}</span> : null}
          {cursor ? <Button disabled={older.busy} onClick={() => void loadOlder()}>{older.busy ? 'Loading…' : 'Load older'}</Button> : null}
        </Toolbar>
      ) : null}

      {selected ? (
        <Sheet title={selected.kind} onClose={() => setSelected(null)}>
          <p className="muted">
            Event {selected.id} · {fmtTime(selected.createdAt, timezone)}
            {selected.conversationId ? (
              <>
                {' · '}
                <a href={`#/conversations/${selected.conversationId}`}>conversation</a>
              </>
            ) : null}
          </p>
          <Code>{json(selected.payload)}</Code>
        </Sheet>
      ) : null}
    </PageFrame>
  );
}

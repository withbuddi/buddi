/**
 * The event log, live-ish.
 *
 * Polled every five seconds rather than streamed: the log is durable state and
 * a socket would be a second, weaker copy of it. Filters are a kind and a
 * substring of the payload; a row opens a drawer with the whole envelope.
 */
import { useState } from 'react';
import { api, type EventPage, type EventRow } from '../api';
import { fmtRelative, fmtTime, json, truncate } from '../format';
import { Drawer, Empty, ErrorBanner, useAsync } from '../ui';

const POLL_MS = 5_000;

export function Events({ timezone }: { timezone: string }): JSX.Element {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<EventRow | null>(null);

  const kinds = useAsync(() => api.eventKinds(), []);
  const { data, error } = useAsync<EventPage>(
    () => api.events({ kind: kind || undefined, q: q || undefined, limit: 200 }),
    [kind, q],
    POLL_MS,
  );

  return (
    <>
      <h2>Events</h2>
      <p className="lede">
        The append-only log. Everything the installation did, including what you do here.
      </p>

      <div className="bar">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">every kind</option>
          {(kinds.data?.kinds ?? []).map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.kind} ({k.count})
            </option>
          ))}
        </select>
        <input
          placeholder="payload contains…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: '220px' }}
        />
        {kind || q ? (
          <button
            onClick={() => {
              setKind('');
              setQ('');
            }}
          >
            clear
          </button>
        ) : null}
        <span className="muted">refreshes every {POLL_MS / 1000}s</span>
      </div>

      <ErrorBanner message={error} />

      <div className="wrap">
        {!data || data.events.length === 0 ? (
          <Empty>No events match.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: '70px' }}>#</th>
                <th style={{ width: '160px' }}>When</th>
                <th style={{ width: '190px' }}>Kind</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                <tr key={event.id} className="clickable" onClick={() => setSelected(event)}>
                  <td className="mono muted">{event.id}</td>
                  <td>
                    {fmtTime(event.createdAt, timezone)}
                    <div className="muted">{fmtRelative(event.createdAt)}</div>
                  </td>
                  <td className="mono">{event.kind}</td>
                  <td className="mono muted">{truncate(json(event.payload).replace(/\s+/g, ' '), 120)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected ? (
        <Drawer title={selected.kind} onClose={() => setSelected(null)}>
          <p className="muted">
            Event {selected.id} · {fmtTime(selected.createdAt, timezone)}
            {selected.conversationId ? (
              <>
                {' · '}
                <a href={`#/conversations/${selected.conversationId}`}>conversation</a>
              </>
            ) : null}
          </p>
          <pre>{json(selected.payload)}</pre>
        </Drawer>
      ) : null}
    </>
  );
}

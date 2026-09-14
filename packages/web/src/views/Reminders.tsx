/**
 * One-off nudges the agents set. A pending one can be cancelled; a fired,
 * cancelled or expired one is history and stays visible as such.
 */
import { useState } from 'react';
import { api } from '../api';
import { fmtRelative, fmtTime, json } from '../format';
import { Empty, ErrorBanner, StatePill, useAsync } from '../ui';

export function Reminders({ timezone }: { timezone: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.reminders(), [], 30_000);
  const [failure, setFailure] = useState<string | null>(null);

  const cancel = async (id: string): Promise<void> => {
    setFailure(null);
    try {
      await api.cancelReminder(id);
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <h2>Reminders</h2>
      <p className="lede">
        A reminder wakes an agent with a note and the instruction to check before it speaks — never a message queued
        for delivery.
      </p>
      <ErrorBanner message={error ?? failure} />
      <div className="wrap">
        {!data || data.reminders.length === 0 ? (
          <Empty>No reminders.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Due</th>
                <th>Agent</th>
                <th>Note</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.reminders.map((reminder) => (
                <tr key={reminder.id}>
                  <td>
                    {fmtTime(reminder.dueAt, timezone)}
                    <div className="muted">{fmtRelative(reminder.dueAt)}</div>
                  </td>
                  <td className="mono">{reminder.agentId}</td>
                  <td>
                    {reminder.text}
                    {reminder.context ? (
                      <details>
                        <summary className="muted">context</summary>
                        <pre>{json(reminder.context)}</pre>
                      </details>
                    ) : null}
                  </td>
                  <td>
                    <StatePill state={reminder.state} />
                    {reminder.cancelReason ? <div className="muted">{reminder.cancelReason}</div> : null}
                  </td>
                  <td>
                    {reminder.state === 'pending' ? (
                      <button className="danger" onClick={() => cancel(reminder.id)}>
                        cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

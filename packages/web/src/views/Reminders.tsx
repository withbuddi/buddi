/**
 * One-off nudges the agents set. A pending one can be cancelled; a fired,
 * cancelled or expired one is history and stays visible as such.
 */
import { useState } from 'react';
import { api } from '../api';
import { fmtRelative, fmtTime, json } from '../format';
import { Button, Code, Details, Empty, ErrorBanner, Page, PageHeader, Panel, StatePill, Table, useAsync } from '../ui';

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
    <Page>
      <PageHeader
        title="Reminders"
        lede="A reminder wakes an agent with a note and the instruction to check before it speaks — never a message queued for delivery."
      />
      <ErrorBanner message={error ?? failure} />
      <Panel flush>
        {!data || data.reminders.length === 0 ? (
          <Empty>No reminders.</Empty>
        ) : (
          <Table>
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
                  <td className="nowrap">
                    {fmtTime(reminder.dueAt, timezone)}
                    <div className="sub">{fmtRelative(reminder.dueAt)}</div>
                  </td>
                  <td className="mono">{reminder.agentId}</td>
                  <td>
                    {reminder.text}
                    {reminder.context ? (
                      <Details summary="context">
                        <Code>{json(reminder.context)}</Code>
                      </Details>
                    ) : null}
                  </td>
                  <td>
                    <StatePill state={reminder.state} />
                    {reminder.cancelReason ? <div className="sub">{reminder.cancelReason}</div> : null}
                  </td>
                  <td>
                    {reminder.state === 'pending' ? (
                      <Button size="sm" variant="danger" onClick={() => cancel(reminder.id)}>
                        Cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  );
}

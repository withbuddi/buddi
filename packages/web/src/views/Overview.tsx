/**
 * The landing page: the numbers, and — above them — anything waiting on a
 * human. Pending approvals, failed jobs and open urgent findings are the three
 * things the owner is the only one who can clear, so they come first and the
 * balance sheet comes second.
 */
import { api, type Overview as OverviewData } from '../api';
import { fmtMoney, fmtNumber, fmtRelative, fmtTime } from '../format';
import { Button, Empty, ErrorBanner, Notice, Page, PageHeader, Panel, Stat, Stats, Table, useAsync } from '../ui';

export function Overview({
  timezone,
  onNavigate,
}: {
  timezone: string;
  onNavigate: (route: string) => void;
}): JSX.Element {
  const { data, error, reload } = useAsync<OverviewData>(() => api.overview(), [], 15_000);

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  const failedJobs = data.jobs.failed ?? 0;
  const attention: Array<{ text: string; route: string; bad?: boolean }> = [];
  if (data.approvals.pending > 0) {
    attention.push({
      text: `${data.approvals.pending} approval${data.approvals.pending === 1 ? '' : 's'} waiting for you${
        data.approvals.oldestPendingAt ? ` (oldest ${fmtRelative(data.approvals.oldestPendingAt)})` : ''
      }`,
      route: '#/approvals',
      bad: true,
    });
  }
  if (failedJobs > 0) {
    attention.push({ text: `${failedJobs} failed job${failedJobs === 1 ? '' : 's'}`, route: '#/jobs', bad: true });
  }
  if (data.sentinels.openUrgent > 0) {
    attention.push({
      text: `${data.sentinels.openUrgent} open urgent finding${data.sentinels.openUrgent === 1 ? '' : 's'}`,
      route: '#/sentinels',
      bad: true,
    });
  }
  if (data.paused) {
    attention.push({ text: 'The installation is paused — nothing is being claimed', route: '#/jobs' });
  }
  for (const err of data.sentinels.errors) {
    attention.push({ text: `sentinel ${err.sentinelId}: ${err.error}`, route: '#/sentinels' });
  }
  for (const source of data.mail) {
    if (source.lastError) {
      attention.push({ text: `source ${source.sourceId}: ${source.lastError}`, route: '#/events' });
    }
  }

  const currency = data.finance.currency;

  return (
    <Page>
      <PageHeader
        title="Overview"
        lede={`${fmtTime(data.now, timezone)} · ${data.timezone}`}
        actions={
          <>
            <Button size="sm" onClick={reload}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant={data.paused ? 'accent' : undefined}
              onClick={() => {
                void api.setPaused(!data.paused).then(reload);
              }}
            >
              {data.paused ? 'Resume' : 'Pause'}
            </Button>
          </>
        }
      />

      {attention.length > 0 ? (
        <Notice tone={attention.some((a) => a.bad) ? 'critical' : 'warning'} title="Needs attention">
          <ul>
            {attention.map((item, i) => (
              <li key={i}>
                <a
                  href={item.route}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(item.route);
                  }}
                >
                  {item.text}
                </a>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {data.finance.available ? (
        <Stats>
          <Stat label="Cash" value={fmtMoney(data.finance.cashTotal, currency)} note="spendable accounts" />
          <Stat label="Net worth" value={fmtMoney(data.finance.netWorth, currency)} note="cash + held − debt" />
          <Stat label="Debt" value={fmtMoney(data.finance.totalDebt, currency)} note="recorded liabilities" />
          <Stat
            label="Low point (14d)"
            value={fmtMoney(data.finance.minBalance, currency)}
            note={data.finance.minBalanceDate ?? ''}
            tone={data.finance.breachesFloor ? 'critical' : undefined}
          />
        </Stats>
      ) : null}

      <Stats>
        <Stat
          label="Approvals"
          value={fmtNumber(data.approvals.pending)}
          note="pending"
          tone={data.approvals.pending > 0 ? 'warning' : undefined}
        />
        <Stat
          label="Queue"
          value={`${fmtNumber(data.jobs.pending ?? 0)} / ${fmtNumber(data.jobs.leased ?? 0)}`}
          note={`pending / running · ${fmtNumber(data.jobs.suspended ?? 0)} suspended · ${fmtNumber(failedJobs)} failed`}
          tone={failedJobs > 0 ? 'critical' : undefined}
        />
        <Stat
          label="Missions"
          value={`${fmtNumber(data.missions.enabled)} / ${fmtNumber(data.missions.total)}`}
          note={data.missions.nextRun ? `next ${fmtRelative(data.missions.nextRun)}` : 'nothing scheduled'}
        />
        <Stat
          label="Reminders"
          value={fmtNumber(data.reminders.pending)}
          note={data.reminders.nextDueAt ? `next ${fmtRelative(data.reminders.nextDueAt)}` : 'none pending'}
        />
        <Stat
          label="Sentinels"
          value={`${fmtNumber(data.sentinels.openUrgent)} / ${fmtNumber(data.sentinels.openInfo)}`}
          note={
            data.sentinels.lastRunAt ? `urgent / info · last ran ${fmtRelative(data.sentinels.lastRunAt)}` : 'never run'
          }
          tone={data.sentinels.openUrgent > 0 ? 'critical' : undefined}
        />
        <Stat label="State" value={data.paused ? 'paused' : 'running'} tone={data.paused ? 'warning' : 'good'} />
      </Stats>

      <Panel title="Next 14 days" flush>
        {data.finance.upcoming.length === 0 ? (
          <Empty>
            {data.finance.available
              ? 'Nothing scheduled in the next fortnight.'
              : (data.finance.note ??
                'Nothing in this installation reports balances yet — install a plugin that provides them.')}
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th className="num">Amount</th>
                <th className="num">Balance after</th>
              </tr>
            </thead>
            <tbody>
              {data.finance.upcoming.map((day) =>
                day.events.map((event, i) => (
                  <tr key={`${day.date}-${i}`}>
                    <td className="mono">{i === 0 ? day.date : ''}</td>
                    <td>{event.name}</td>
                    <td className={`num ${event.amount < 0 ? 'critical' : 'good'}`}>
                      {fmtMoney(event.amount, currency)}
                    </td>
                    <td className="num muted">{i === day.events.length - 1 ? fmtMoney(day.balance, currency) : ''}</td>
                  </tr>
                )),
              )}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel title="Mail and sources" flush>
        {data.mail.length === 0 ? (
          <Empty>No sources are installed.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Last poll</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {data.mail.map((source) => (
                <tr key={source.sourceId}>
                  <td className="mono">{source.sourceId}</td>
                  <td>
                    {fmtTime(source.lastRunAt, timezone)} <span className="muted">{fmtRelative(source.lastRunAt)}</span>
                  </td>
                  <td className={source.lastError ? 'critical' : 'muted'}>{source.lastError ?? 'none'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  );
}

/**
 * How this plugin's results should be drawn on the dashboard canvas.
 *
 * The domain knowledge lives here, with the plugin that owns it, and crosses to
 * the browser as *data*: the page ships a handful of generic renderers — a
 * line, a table, a bar, a list of figures — and learns from these descriptors
 * which of them a `finance.project_cashflow` result is. Nothing in the web
 * package knows the word "cashflow", and an installation without this plugin
 * serves none of this.
 *
 * The rule for what earns a descriptor: a result whose *shape* carries meaning
 * the digits do not. A projection is a line because the question is "when does
 * it dip". Utilization is bars against their limits because the question is
 * "how close to the edge". A summary is a table of categories because the
 * question is "where did it go". Everything else falls back to `structured`,
 * which is a readable view of the JSON and is often the honest answer.
 */
import type { ViewDescriptor } from '@buddi/core';

/** The currency every finance result reports, read from the result itself. */
const currency = { path: 'currency' } as const;

export const financeViews: ViewDescriptor[] = [
  /*
   * The projection. The whole point of the chart is the low point and whether
   * it crosses the floor, so both are drawn rather than left to be read: the
   * floor is a reference line, the days below it are shaded, and the minimum is
   * marked. The events beside it are the days that actually move money —
   * `compressDays` already dropped the quiet ones.
   */
  {
    tool: 'finance.project_cashflow',
    renderer: 'timeseries',
    title: 'Projected balance',
    map: {
      points: 'days',
      x: 'date',
      y: 'balance',
      unit: 'currency',
      currency,
      label: { path: 'scope' },
      referenceLines: [{ value: { path: 'safetyFloor' }, label: 'Safety floor', tone: 'warning' }],
      shadeBelow: { path: 'safetyFloor' },
      mark: 'min',
      events: { parent: 'events', at: 'date', label: 'name', amount: 'amount' },
    },
  },

  /*
   * Utilization is a number that only means something against its limit, so
   * every row carries its own bar scaled to that card's limit, with the two
   * thresholds the scoring models actually use marked in tone. The totals above
   * are the figure the owner is usually after.
   */
  {
    tool: 'finance.credit_utilization',
    renderer: 'table',
    title: 'Credit utilization',
    map: {
      rows: 'cards',
      columns: [
        { key: 'name', label: 'Card' },
        { key: 'balance', label: 'Balance', type: 'currency', currency },
        { key: 'creditLimit', label: 'Limit', type: 'currency', currency },
        {
          key: 'utilization',
          label: 'Used',
          type: 'percent',
          bar: {
            max: { path: 'creditLimit' },
            thresholds: [
              { atLeast: 0, tone: 'good' },
              { atLeast: 0.3, tone: 'warning' },
              { atLeast: 0.5, tone: 'critical' },
            ],
          },
        },
        { key: 'targetBalanceFor30', label: 'To reach 30%', type: 'currency', currency },
        { key: 'apr', label: 'APR', type: 'percent' },
      ],
      summary: [
        { label: 'Total balance', value: { path: 'totalBalance' }, unit: 'currency', currency },
        { label: 'Total limit', value: { path: 'totalLimit' }, unit: 'currency', currency },
        { label: 'Overall', value: { path: 'overallUtilization' }, unit: 'percent' },
        { label: 'To reach 30%', value: { path: 'totalToReach30' }, unit: 'currency', currency },
      ],
      empty: 'No credit cards are recorded yet.',
    },
  },

  /*
   * What closes when. The column that matters is `forecastBalance` — what the
   * card is on course to *report*, which is the figure utilization is scored on
   * and the one that differs from the balance sitting there today.
   */
  {
    tool: 'finance.upcoming_statements',
    renderer: 'table',
    title: 'Upcoming statements',
    map: {
      rows: 'statements',
      columns: [
        { key: 'name', label: 'Card' },
        { key: 'statementDate', label: 'Closes', type: 'date' },
        { key: 'daysUntil', label: 'In', type: 'number' },
        { key: 'payBefore', label: 'Pay before', type: 'date' },
        { key: 'balance', label: 'Balance', type: 'currency', currency },
        { key: 'forecastBalance', label: 'Will report', type: 'currency', currency },
        { key: 'forecastUtilization', label: 'At', type: 'percent' },
      ],
      summary: [{ label: 'Statements ahead', value: { path: 'count' }, unit: 'number' }],
      empty: 'No card has a statement day recorded.',
    },
  },

  /*
   * A card's own history, month by month: charges against payments is the
   * shape of the question ("am I paying this down?"), so it is a timeseries of
   * the balance change rather than a table of transactions. The transactions
   * are in the result and the model can quote them.
   */
  {
    tool: 'finance.card_activity',
    renderer: 'timeseries',
    title: 'Card activity',
    map: {
      points: 'months',
      x: 'month',
      y: 'netBalanceChange',
      unit: 'currency',
      currency,
      label: { path: 'liability' },
      referenceLines: [{ value: { const: 0 }, label: 'Break even', tone: 'neutral' }],
      mark: 'max',
    },
  },

  /*
   * Where the money went. Categories are parts of one month, which is what
   * bars are for; the totals are in the result and the answer quotes them.
   */
  {
    tool: 'finance.summary',
    renderer: 'bars',
    title: 'Spending by category',
    map: {
      bars: 'byCategory',
      category: 'category',
      value: 'total',
      unit: 'currency',
      currency,
    },
  },

  /*
   * A staged import is a decision, not a report: nothing has been written, and
   * the owner is being asked. So it is drawn as the handful of figures that
   * decide it — how many rows are new, what they add up to, what window they
   * cover — rather than as the rows themselves.
   */
  {
    tool: 'finance.stage_import',
    renderer: 'keyvalue',
    title: 'Staged import',
    map: {
      pairs: [
        { label: 'Rows parsed', value: { path: 'summary.rows' }, unit: 'number' },
        { label: 'New rows', value: { path: 'summary.newRows' }, unit: 'number' },
        { label: 'Duplicates', value: { path: 'summary.duplicates' }, unit: 'number' },
        { label: 'Pending', value: { path: 'summary.pending' }, unit: 'number' },
        { label: 'From', value: { path: 'summary.dateRange.from' }, unit: 'date' },
        { label: 'To', value: { path: 'summary.dateRange.to' }, unit: 'date' },
        { label: 'Money in', value: { path: 'summary.totalIn' }, unit: 'currency' },
        { label: 'Money out', value: { path: 'summary.totalOut' }, unit: 'currency' },
        { label: 'Expires', value: { path: 'expiresAt' }, unit: 'date', tone: 'warning' },
      ],
    },
  },
];

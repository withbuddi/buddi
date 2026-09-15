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
 *
 * The order is not arbitrary: the empty canvas introduces the plugin with the
 * first three descriptors declared here, so those three lead — the projection,
 * the accounts, the month's spending — one of each shape, and between them the
 * three questions anyone arrives with (what is coming, where I stand, where it
 * went). Everything narrower, the credit material included, follows.
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
   * The accounts. Split on purpose, because the whole point of this result is
   * that retirement money is not spendable money: the rows are grouped by
   * whether they count as cash, and the three totals are named separately
   * above rather than added into one figure nobody should quote.
   */
  {
    tool: 'finance.list_accounts',
    renderer: 'table',
    title: 'Accounts',
    map: {
      rows: 'accounts',
      groupBy: {
        key: 'includeInCashflow',
        labels: { true: 'Spendable', false: 'Not spendable' },
      },
      columns: [
        { key: 'name', label: 'Account' },
        { key: 'kind', label: 'Kind' },
        { key: 'institution', label: 'Institution' },
        { key: 'balance', label: 'Balance', type: 'currency', currency },
        { key: 'balanceAsOf', label: 'As of', type: 'date' },
      ],
      summary: [
        { label: 'Spendable cash', value: { path: 'cashTotal' }, unit: 'currency', currency },
        { label: 'Not spendable', value: { path: 'excludedTotal' }, unit: 'currency', currency },
        { label: 'Debts', value: { path: 'totalLiabilities' }, unit: 'currency', currency },
        { label: 'Net worth', value: { path: 'netWorth' }, unit: 'currency', currency },
      ],
      empty: 'No accounts are recorded yet.',
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
          // The tool reports utilization in percentage points (45.2, not
          // 0.452), so the bar is scaled against 100 and the thresholds are
          // the ones the scoring models use, in the same units. Scaling it
          // against the credit limit — which is money — drew every card at
          // zero and toned every one of them 'good'.
          bar: {
            max: { const: 100 },
            thresholds: [
              { atLeast: 0, tone: 'good' },
              { atLeast: 30, tone: 'warning' },
              { atLeast: 50, tone: 'critical' },
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

  /*
   * What repeats, and when. The question behind it is almost always "what is
   * still to come this month", which is a list you read down — so a table,
   * with the cash figures above it. `billedTo` earns its column because a
   * charge billed to a card is the one row in the list that does *not* move
   * cash on its date, and the owner cannot see that anywhere else.
   */
  {
    tool: 'finance.list_recurring',
    renderer: 'table',
    title: 'Recurring items',
    map: {
      rows: 'items',
      groupBy: { key: 'kind', labels: { income: 'Income', charge: 'Charges' } },
      columns: [
        { key: 'name', label: 'Item' },
        { key: 'amount', label: 'Amount', type: 'currency', currency },
        { key: 'cadence', label: 'Repeats' },
        { key: 'anchorDate', label: 'Anchor', type: 'date' },
        { key: 'account', label: 'From account' },
        { key: 'billedTo', label: 'Billed to card' },
        { key: 'category', label: 'Category' },
      ],
      summary: [
        { label: 'Items', value: { path: 'count' }, unit: 'number' },
        { label: 'Monthly net (cash)', value: { path: 'monthlyNet' }, unit: 'currency', currency },
        { label: 'Billed to a card', value: { path: 'cardBilledCount' }, unit: 'number' },
      ],
      empty: 'Nothing recurring is recorded yet.',
    },
  },

  /*
   * The debts. Utilization is the column that changes a decision, so it is
   * drawn as a bar against 100% with the scoring thresholds in tone; a loan
   * has no limit and simply leaves that cell empty.
   */
  {
    tool: 'finance.list_liabilities',
    renderer: 'table',
    title: 'Debts',
    map: {
      rows: 'liabilities',
      columns: [
        { key: 'name', label: 'Debt' },
        { key: 'kind', label: 'Kind' },
        { key: 'balance', label: 'Owed', type: 'currency', currency },
        { key: 'creditLimit', label: 'Limit', type: 'currency', currency },
        {
          key: 'utilization',
          label: 'Used',
          type: 'percent',
          bar: {
            max: { const: 100 },
            thresholds: [
              { atLeast: 0, tone: 'good' },
              { atLeast: 30, tone: 'warning' },
              { atLeast: 50, tone: 'critical' },
            ],
          },
        },
        { key: 'minimumPayment', label: 'Minimum', type: 'currency', currency },
        { key: 'dueDay', label: 'Due day', type: 'number' },
        { key: 'apr', label: 'APR', type: 'percent' },
        { key: 'paidFrom', label: 'Paid from' },
      ],
      summary: [
        { label: 'Total owed', value: { path: 'totalDebt' }, unit: 'currency', currency },
        { label: 'Minimums', value: { path: 'totalMinimumPayments' }, unit: 'currency', currency },
        { label: 'Card utilization', value: { path: 'creditUtilization' }, unit: 'percent' },
      ],
      empty: 'No debts are recorded yet.',
    },
  },

  /*
   * Receipts, newest first, each beside the charge it was matched to. The
   * empty "Charge" cell is the finding — a receipt with no transaction is
   * either a charge that has not posted or one that was never billed — so the
   * column stays even when most of it is full.
   */
  {
    tool: 'finance.list_receipts',
    renderer: 'table',
    title: 'Receipts',
    map: {
      rows: 'receipts',
      columns: [
        { key: 'occurredOn', label: 'Date', type: 'date' },
        { key: 'merchant', label: 'Merchant' },
        { key: 'total', label: 'Total', type: 'currency', currency },
        { key: 'transaction.description', label: 'Charge' },
        { key: 'transaction.occurredOn', label: 'Charged on', type: 'date' },
        { key: 'transaction.status', label: 'Status' },
        { key: 'notes', label: 'Notes' },
      ],
      summary: [{ label: 'Receipts', value: { path: 'count' }, unit: 'number' }],
      empty: 'No receipts have been recorded yet.',
    },
  },

  /*
   * Payment history. The on-time rate is the figure the score actually turns
   * on, so it leads; the rows below are there to show *which* ones went wrong,
   * which is the only useful thing a rate cannot tell you.
   */
  {
    tool: 'finance.payment_history',
    renderer: 'table',
    title: 'Payment history',
    map: {
      rows: 'payments',
      columns: [
        { key: 'dueOn', label: 'Due', type: 'date' },
        { key: 'liability', label: 'Debt' },
        { key: 'amount', label: 'Amount', type: 'currency', currency },
        { key: 'status', label: 'Status' },
        { key: 'paidOn', label: 'Paid', type: 'date' },
      ],
      summary: [
        { label: 'On time', value: { path: 'onTimeRate' }, unit: 'percent', tone: 'good' },
        { label: 'Late', value: { path: 'late' }, unit: 'number', tone: 'warning' },
        { label: 'Missed', value: { path: 'missed' }, unit: 'number', tone: 'critical' },
        { label: 'Still scheduled', value: { path: 'scheduled' }, unit: 'number' },
        { label: 'Months', value: { path: 'months' }, unit: 'number' },
      ],
      empty: 'No payments have been recorded yet.',
    },
  },

  /*
   * The score history is a trend, and a line would be the obvious drawing —
   * but the result is newest-first and mixes sources (a Experian pull and a
   * card issuer's estimate are two different series), and a single line
   * through both, drawn backwards, would be a lie told neatly. A table keeps
   * the source beside every score and puts the move against the previous
   * reading from that same source in its own column, which is the number the
   * owner was asking about.
   */
  {
    tool: 'finance.credit_score_history',
    renderer: 'table',
    title: 'Credit scores',
    map: {
      rows: 'scores',
      columns: [
        { key: 'observedOn', label: 'Observed', type: 'date' },
        { key: 'source', label: 'Source' },
        { key: 'score', label: 'Score', type: 'number' },
        { key: 'delta', label: 'Change', type: 'number' },
        { key: 'model', label: 'Model' },
        { key: 'note', label: 'Note' },
      ],
      summary: [
        { label: 'Latest', value: { path: 'latest.score' }, unit: 'number' },
        { label: 'From', value: { path: 'latest.source' }, unit: 'text' },
        { label: 'On', value: { path: 'latest.observedOn' }, unit: 'date' },
        { label: 'Readings', value: { path: 'count' }, unit: 'number' },
      ],
      empty: 'No credit score has been recorded yet.',
    },
  },

  /*
   * The baseline. The headline is one figure — what a typical month of
   * variable spending costs — and the breakdown exists to answer "made of
   * what". Each category carries a bar against the headline, so the two or
   * three categories that *are* the burn are visible before they are read.
   * The median and the mean are both shown because the gap between them is
   * itself the finding.
   */
  {
    tool: 'finance.spending_baseline',
    renderer: 'table',
    title: 'Spending baseline',
    map: {
      rows: 'byCategory',
      columns: [
        { key: 'category', label: 'Category' },
        {
          key: 'avgMonthly',
          label: 'Typical month',
          type: 'currency',
          currency,
          bar: { max: { path: 'avgMonthlyVariableOut' } },
        },
      ],
      summary: [
        { label: 'Typical month', value: { path: 'avgMonthlyVariableOut' }, unit: 'currency', currency },
        { label: 'Mean month', value: { path: 'meanMonthlyVariableOut' }, unit: 'currency', currency },
        { label: 'Daily burn', value: { path: 'dailyBurn' }, unit: 'currency', currency },
        { label: 'Months used', value: { path: 'monthsUsed' }, unit: 'number' },
        { label: 'Transactions', value: { path: 'sampleSize' }, unit: 'number' },
      ],
      empty: 'Not enough spending has been recorded to measure a baseline.',
    },
  },
];

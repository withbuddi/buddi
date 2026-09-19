/**
 * The Money block on the dashboard's Home page.
 *
 * The same numbers an agent would quote, through the same two tools, so the
 * page and the agent never disagree about the week. Formatted here, in the
 * owner's currency, because the page that draws it must not know what a
 * currency is.
 */
import type { HomeContribution, ToolContext } from '@buddi/core';
import { listAccounts } from './tools/accounts.js';
import { projectCashflow } from './tools/cashflow.js';

export const HOME_HORIZON_DAYS = 14;

function money(value: unknown, currency: string | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD', maximumFractionDigits: 0 }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

export const financeHome: HomeContribution = {
  id: 'finance.money',
  title: 'Money',
  async produce(ctx: ToolContext) {
    const a = (await listAccounts.execute({}, ctx)) as Record<string, unknown>;
    const currency = typeof a.currency === 'string' ? a.currency : null;
    const stats = [
      { label: 'Cash', value: money(a.cashTotal, currency), note: 'spendable accounts' },
      { label: 'Net worth', value: money(a.netWorth, currency), note: 'cash + held − debt' },
      { label: 'Debt', value: money(a.totalLiabilities, currency), note: 'recorded liabilities' },
    ];
    const rows: Array<{ title: string; sub?: string; side?: string; tone?: 'good' | 'critical' }> = [];
    let note: string | undefined;
    try {
      const p = (await projectCashflow.execute({ horizonDays: HOME_HORIZON_DAYS, includeBaseline: false } as never, ctx)) as Record<string, unknown>;
      stats.push({
        label: `Low point (${HOME_HORIZON_DAYS}d)`,
        value: money(p.minBalance, currency),
        note: typeof p.minBalanceDate === 'string' ? p.minBalanceDate : '',
        ...(p.breachesFloor === true ? { tone: 'critical' as const } : {}),
      });
      const days = Array.isArray(p.days) ? (p.days as Array<Record<string, unknown>>) : [];
      for (const day of days) {
        const events = Array.isArray(day.events) ? (day.events as Array<Record<string, unknown>>) : [];
        events.forEach((event, i) => {
          const amount = Number(event.amount ?? 0);
          rows.push({
            title: String(event.name ?? ''),
            sub: i === events.length - 1 ? `${String(day.date)}, balance after ${money(day.balance, currency)}` : String(day.date),
            side: money(amount, currency),
            tone: amount < 0 ? 'critical' : 'good',
          });
        });
      }
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
    }
    return { id: 'finance.money', title: 'Money', ...(note ? { note } : {}), stats, rows, rowsTitle: `Next ${HOME_HORIZON_DAYS} days`, sensitive: true };
  },
};

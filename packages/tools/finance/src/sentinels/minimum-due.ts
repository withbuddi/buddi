/**
 * minimum-due — a minimum payment lands within three days and nothing pays it.
 *
 * Payment history is the heaviest factor in a credit score and the slowest to
 * repair, so this is the one sentinel that is always urgent. It is also the
 * one that must not cry wolf: a payment already recorded, or an autopay the
 * owner told us about as a recurring charge on an account the cash flow can
 * see, means the money is accounted for and nothing needs saying.
 */
import { nextDayOfMonth } from '../credit.js';
import { num, loadPreferences, today } from '../tools/shared.js';
import { minimumDueFindings, type LiabilityDue, type RecurringCharge } from './helpers.js';
import { EVERY_6H, type Finding, type Sentinel, type SentinelContext } from './types.js';

export const minimumDue: Sentinel = {
  id: 'finance.minimum-due',
  description:
    'Reports every active liability whose minimum payment falls due within three days with no payment recorded and no modelled autopay.',
  every: EVERY_6H,
  async run(ctx: SentinelContext): Promise<Finding[]> {
    const day = today(ctx);
    const prefs = await loadPreferences(ctx.db);

    // Every liability, plus the due dates a payment_events row already marks
    // paid. The comparison is on the exact upcoming due date, computed the
    // same way everywhere else computes it, so a payment for last cycle can
    // never silence this one.
    const { rows } = await ctx.db.query(
      `select l.name, l.minimum_payment, l.due_day, l.balance,
              coalesce(
                array_agg(to_char(p.due_on, 'YYYY-MM-DD')) filter (where p.id is not null),
                '{}'
              ) as paid_due_dates
         from finance.liabilities l
         left join finance.payment_events p
           on p.liability_id = l.id and p.status in ('paid_on_time', 'paid_late')
        where l.active and l.minimum_payment > 0
        group by l.id, l.name, l.minimum_payment, l.due_day, l.balance
        order by l.due_day, l.name`,
    );

    const liabilities: LiabilityDue[] = rows.map((r) => {
      const dueDay = Number(r.due_day);
      const paidDueDates: string[] = (r.paid_due_dates as string[]) ?? [];
      return {
        name: r.name as string,
        minimumPayment: num(r.minimum_payment),
        dueDay,
        balance: num(r.balance),
        paid: paidDueDates.includes(nextDayOfMonth(day, dueDay)),
      };
    });
    if (liabilities.length === 0) return [];

    // Autopay we model: an active recurring charge whose account the cash flow
    // believes in (or no account at all, which is assumed to hit the cash).
    const { rows: itemRows } = await ctx.db.query(
      `select r.name, (a.id is null or a.include_in_cashflow) as included
         from finance.recurring_items r
         left join finance.accounts a on a.id = r.account_id
        where r.active and r.kind = 'charge'`,
    );
    const items: RecurringCharge[] = itemRows.map((r) => ({
      name: r.name as string,
      includedInCashflow: r.included === true,
    }));

    const findings: Finding[] = minimumDueFindings(liabilities, {
      today: day,
      currency: prefs.currency,
      items,
    });
    return findings;
  },
};

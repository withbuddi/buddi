/**
 * statement-closing — a card reports its balance in three days, still over 30%.
 *
 * Information, never urgent: nothing breaks if it is missed, but the window is
 * real and it closes. The issuer snapshots the balance on the closing day, so
 * a payment made after it is a payment made for next cycle as far as the
 * bureaus are concerned.
 */
import { num, loadPreferences, today } from '../tools/shared.js';
import { statementClosingFindings, type ClosingCard } from './helpers.js';
import { EVERY_12H, type Finding, type Sentinel, type SentinelContext } from './types.js';

export const statementClosing: Sentinel = {
  id: 'finance.statement-closing',
  description:
    'Reports credit cards whose statement closes within three days while utilization is still above 30%.',
  every: EVERY_12H,
  async run(ctx: SentinelContext): Promise<Finding[]> {
    const day = today(ctx);
    const prefs = await loadPreferences(ctx.db);
    const { rows } = await ctx.db.query(
      `select name, balance, credit_limit, statement_day
         from finance.liabilities
        where active and kind = 'credit_card'
          and statement_day is not null and credit_limit is not null and credit_limit > 0
        order by name`,
    );
    const cards: ClosingCard[] = rows.map((r) => ({
      name: r.name as string,
      balance: num(r.balance),
      creditLimit: r.credit_limit === null ? null : num(r.credit_limit),
      statementDay: r.statement_day === null ? null : Number(r.statement_day),
    }));
    const findings: Finding[] = statementClosingFindings(cards, {
      today: day,
      currency: prefs.currency,
    });
    return findings;
  },
};

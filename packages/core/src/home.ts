/**
 * What a plugin may put on the dashboard's Home page.
 *
 * A contribution is a block: a title, a few stats, an optional list of rows.
 * Every value arrives already formatted, in the plugin's own units and
 * currency, so the page that draws it knows nothing about the domain: it
 * draws blocks, and an installation with no finance plugin has no Money block
 * and no idea one could exist. The same rule the Canvas views follow.
 */
import type { ToolContext } from './tools.js';

export interface HomeStat {
  label: string;
  /** Already formatted: "$2,691", "12", "3 days". */
  value: string;
  note?: string;
  tone?: 'good' | 'warning' | 'critical';
}

export interface HomeRow {
  title: string;
  sub?: string;
  /** The right-hand figure, already formatted. */
  side?: string;
  tone?: 'good' | 'critical';
}

export interface HomeBlock {
  /** Stable, namespaced: `finance.money`. */
  id: string;
  title: string;
  /** One line under the title, when the block has something to say about itself. */
  note?: string;
  stats: HomeStat[];
  rows: HomeRow[];
  /** A heading for the rows, when they are not obviously what the stats are about. */
  rowsTitle?: string;
}

export interface HomeContribution {
  id: string;
  title: string;
  /**
   * Produce the block for this owner now, or null when there is nothing to
   * show (no data yet). Read-only by contract: nothing here may write.
   */
  produce(ctx: ToolContext): Promise<HomeBlock | null>;
}

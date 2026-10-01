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
import type { TileIcon, TileLink } from './views.js';

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
  /**
   * Draw it masked until the owner asks. For blocks a passer-by should not
   * read off the screen: balances, not car mileage. The plugin decides.
   */
  sensitive?: boolean;
}

/**
 * One line beside the date under Home's greeting: "☁ 18°C Lyon". A glyph
 * from the pinned set, at most sixty characters of already formatted text,
 * and optionally a page of the same plugin it opens. The owner can hide any
 * glance; at most three are drawn, in plugin order.
 */
export interface HomeGlance {
  icon: TileIcon;
  /** Already formatted, at most `HOME_GLANCE_MAX` characters; longer is cut. */
  text: string;
  link?: { route: TileLink };
  /**
   * The same glance as a card: a figure, a quiet line, a short run of numbers
   * drawn as a sparkline, and a foot. Since host API 1.17 Home offers it as a
   * small widget under the glance's id (`widgets.ts`), unless the plugin
   * declares a widget with that id; while it is on Home the line steps aside.
   * A dashboard from before widgets draws it beside the greeting.
   */
  card?: HomeGlanceCard;
}

export interface HomeGlanceCard {
  /** The figure, already formatted: "70°F". At most `HOME_CARD_VALUE_MAX` characters. */
  value: string;
  /** One quiet line under it: "Clear · Somerset". At most `HOME_CARD_LINE_MAX`. */
  caption?: string;
  /** Numbers in order (the next hours, say), drawn as a line with no axis; two to `HOME_CARD_TREND_MAX`. */
  trend?: { label: string; points: number[] };
  /** The last line: "High 74° · Low 58°". At most `HOME_CARD_LINE_MAX`. */
  foot?: string;
}

export const HOME_GLANCE_MAX = 60;
export const HOME_CARD_VALUE_MAX = 12;
export const HOME_CARD_LINE_MAX = 40;
export const HOME_CARD_TREND_MAX = 48;

export interface HomeBlockContribution {
  id: string;
  title: string;
  /** A block on the page. The default. */
  placement?: 'block';
  /**
   * Produce the block for this owner now, or null when there is nothing to
   * show (no data yet). Read-only by contract: nothing here may write.
   */
  produce(ctx: ToolContext): Promise<HomeBlock | null>;
}

export interface HomeGlanceContribution {
  /** Stable, namespaced: `weather.now`. What the owner's hide remembers. */
  id: string;
  /** What Settings → Appearance lists it as. */
  title: string;
  placement: 'glance';
  /** The line for now, or null when there is nothing worth saying. Read-only, as a block. */
  produce(ctx: ToolContext): Promise<HomeGlance | null>;
}

/** A block (the default) or a glance, told apart by `placement`. */
export type HomeContribution = HomeBlockContribution | HomeGlanceContribution;

/**
 * The seam between this plugin and the network.
 *
 * The forecast service is a parameter, not an import: the tool and the sentinel
 * both take it, so every test in this package runs against a stub and opens no
 * socket. `@buddi/tool-email` does the same thing with IMAP and SMTP.
 */

/** One day of forecast, as this plugin understands a day. */
export interface DailyForecast {
  /** `YYYY-MM-DD` in the owner's timezone. */
  date: string;
  lowC: number;
  highC: number;
  summary: string;
}

export interface ForecastQuery {
  latitude: number;
  longitude: number;
  timezone: string;
  days: number;
}

export type FetchForecast = (query: ForecastQuery) => Promise<DailyForecast[]>;

#!/usr/bin/env node
/**
 * Throwaway analysis: which recorded transactions *look* like recurring items?
 *
 *   node packages/tools/finance/scripts/recurring-candidates.mjs [--account "PNC Spend"]
 *                                                               [--min-occurrences 3]
 *                                                               [--large 2000] [--json]
 *
 * It reads finance.transactions directly (read-only — it creates nothing), groups
 * rows by a normalised description and direction, and reports the groups whose
 * amount is stable (within ±15% of the median) and whose spacing matches a
 * weekly / biweekly / monthly cadence to within ±3 days. Large one-off movements
 * are listed apart so a single big transfer is never read as a pattern.
 *
 * Deliberately generic: no merchant, category or account name is hardcoded.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

try {
  for (const line of readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env: rely on the ambient environment */
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

// ---------------------------------------------------------------- options

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const ACCOUNT = option('account', null);
const MIN_OCCURRENCES = Number(option('min-occurrences', 3));
const LARGE = Number(option('large', 2000));
const AS_JSON = process.argv.includes('--json');

const AMOUNT_TOLERANCE = 0.15; // ±15% of the median
const DAY_TOLERANCE = 3; // ±3 days on the cadence
const CADENCES = [
  { name: 'weekly', days: 7 },
  { name: 'biweekly', days: 14 },
  { name: 'monthly', days: 30.44 },
];

// ---------------------------------------------------------------- helpers

/** Strip digits, punctuation, card/reference tails so 'ACME #4471' == 'Acme'. */
function normalize(description) {
  return description
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DAY = 86_400_000;
const toDay = (iso) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const fromDay = (d) => new Date(Math.round(d) * DAY).toISOString().slice(0, 10);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Add whole months where the cadence is monthly, so 31 Jan → 28 Feb behaves. */
function addCadence(iso, cadence) {
  if (cadence !== 'monthly') {
    return fromDay(toDay(iso) + CADENCES.find((c) => c.name === cadence).days);
  }
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // last day of month m (1-based)
  const nextLast = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, nextLast))).toISOString().slice(0, 10);
}

/**
 * Best cadence for a series of dates: the one whose expected spacing matches the
 * most gaps within ±3 days. Returns null when no cadence explains most of them.
 */
function guessCadence(dates) {
  const gaps = dates.slice(1).map((d, i) => toDay(d) - toDay(dates[i]));
  if (gaps.length === 0) return null;
  let best = null;
  for (const { name, days } of CADENCES) {
    const hits = gaps.filter((g) => Math.abs(g - days) <= DAY_TOLERANCE).length;
    const drift = gaps.reduce((acc, g) => acc + Math.abs(g - days), 0) / gaps.length;
    if (!best || hits > best.hits || (hits === best.hits && drift < best.drift)) {
      best = { cadence: name, days, hits, total: gaps.length, drift };
    }
  }
  return best && best.hits / best.total >= 2 / 3 ? best : null;
}

// ---------------------------------------------------------------- analysis

const { createPool } = await import(path.join(repoRoot, 'packages/core/dist/index.js'));
const pool = createPool(process.env.DATABASE_URL);

try {
  const { rows } = await pool.query(
    `select t.occurred_on, t.amount, t.description, t.category, a.name as account
       from finance.transactions t
       left join finance.accounts a on a.id = t.account_id
      where ($1::text is null or a.name = $1)
      order by t.occurred_on, t.description`,
    [ACCOUNT],
  );

  const txs = rows.map((r) => ({
    date: (r.occurred_on instanceof Date
      ? new Date(
          Date.UTC(
            r.occurred_on.getFullYear(),
            r.occurred_on.getMonth(),
            r.occurred_on.getDate(),
          ),
        ).toISOString()
      : String(r.occurred_on)
    ).slice(0, 10),
    amount: Number(r.amount),
    description: r.description,
    category: r.category,
    account: r.account,
  }));

  // Group by normalised description + direction: money in and money out under
  // the same name are two different rhythms.
  const groups = new Map();
  for (const t of txs) {
    const key = `${normalize(t.description)}|${t.amount >= 0 ? 'income' : 'charge'}`;
    const g = groups.get(key) ?? { label: t.description, kind: t.amount >= 0 ? 'income' : 'charge', items: [] };
    g.items.push(t);
    groups.set(key, g);
  }

  const candidates = [];
  const oneOffs = [];

  for (const g of groups.values()) {
    const items = g.items.sort((a, b) => a.date.localeCompare(b.date));
    const amounts = items.map((t) => Math.abs(t.amount));
    const typical = median(amounts);

    // One large movement that never repeats is not a pattern.
    if (items.length < MIN_OCCURRENCES) {
      for (const t of items) {
        if (Math.abs(t.amount) > LARGE) {
          oneOffs.push({
            date: t.date,
            description: t.description,
            kind: t.amount >= 0 ? 'inflow' : 'outflow',
            amount: t.amount,
            category: t.category,
          });
        }
      }
      continue;
    }

    // The stable series is the subset sitting within ±15% of the median; an
    // occasional off-size payment (a bonus, a catch-up charge) is an outlier,
    // not a reason to throw the whole rhythm away.
    const stable = items.filter(
      (t) => Math.abs(Math.abs(t.amount) - typical) <= typical * AMOUNT_TOLERANCE,
    );
    const amountScore = stable.length / items.length;
    if (stable.length < MIN_OCCURRENCES || amountScore < 0.5) continue;

    const dates = [...new Set(stable.map((t) => t.date))];
    const fit = guessCadence(dates);
    if (!fit) continue;

    const last = dates[dates.length - 1];
    const intervalScore = fit.hits / fit.total;
    const driftScore = Math.max(0, 1 - fit.drift / (DAY_TOLERANCE * 2));
    const depthScore = Math.min(stable.length / 4, 1);
    const confidence =
      Math.round((0.35 * amountScore + 0.35 * intervalScore + 0.15 * driftScore + 0.15 * depthScore) * 100) / 100;

    candidates.push({
      description: g.label,
      kind: g.kind,
      typicalAmount: Math.round(typical * 100) / 100,
      spread: (() => {
        const a = stable.map((t) => Math.abs(t.amount));
        return `${Math.round(Math.min(...a) * 100) / 100}–${Math.round(Math.max(...a) * 100) / 100}`;
      })(),
      cadence: fit.hits === fit.total ? fit.cadence : `${fit.cadence} (partial)`,
      occurrences: stable.length,
      outliers: items.length - stable.length,
      lastDate: last,
      nextDate: addCadence(last, fit.cadence),
      confidence,
      category: stable[stable.length - 1].category,
      account: stable[stable.length - 1].account,
    });
  }

  // Large one-offs inside an otherwise repeating group count too.
  for (const g of groups.values()) {
    if (g.items.length < MIN_OCCURRENCES) continue;
    for (const t of g.items) {
      const typical = median(g.items.map((x) => Math.abs(x.amount)));
      if (Math.abs(t.amount) > LARGE && Math.abs(Math.abs(t.amount) - typical) > typical * AMOUNT_TOLERANCE) {
        oneOffs.push({
          date: t.date,
          description: t.description,
          kind: t.amount >= 0 ? 'inflow' : 'outflow',
          amount: t.amount,
          category: t.category,
        });
      }
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence || Math.abs(b.typicalAmount) - Math.abs(a.typicalAmount));
  oneOffs.sort((a, b) => a.date.localeCompare(b.date));

  if (AS_JSON) {
    console.log(JSON.stringify({ candidates, oneOffs, scanned: txs.length }, null, 2));
  } else {
    const pad = (s, n) => String(s).padEnd(n).slice(0, n);
    const padL = (s, n) => String(s).padStart(n);
    console.log(`scanned ${txs.length} transactions${ACCOUNT ? ` in ${ACCOUNT}` : ''}\n`);
    console.log(`recurring candidates (${candidates.length})`);
    console.log(
      [pad('description', 30), pad('kind', 7), padL('typical', 10), pad('  cadence', 20), pad('last', 12), pad('next', 12), padL('n', 3), padL('conf', 6)].join(''),
    );
    for (const c of candidates) {
      console.log(
        [
          pad(c.description, 30),
          pad(c.kind, 7),
          padL(c.typicalAmount.toFixed(2), 10),
          pad(`  ${c.cadence}`, 20),
          pad(c.lastDate, 12),
          pad(c.nextDate, 12),
          padL(c.occurrences, 3),
          padL(c.confidence.toFixed(2), 6),
        ].join(''),
      );
    }
    console.log(`\nlarge one-off movements over ${LARGE} (${oneOffs.length})`);
    for (const o of oneOffs) {
      console.log(
        [pad(o.date, 12), pad(o.description, 34), pad(o.kind, 9), padL(o.amount.toFixed(2), 12)].join(''),
      );
    }
  }
} finally {
  await pool.end();
}

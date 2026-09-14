/**
 * Bank CSV parsing. CSV drop is the primary v1 intake, so the parser is
 * deliberately forgiving: it sniffs the delimiter, matches columns by header
 * name across a few locales, carries the bank's own category column through
 * when there is one, accepts dot and comma decimals, and reports
 * unparseable rows as warnings instead of throwing away the whole file.
 */

export interface BankCsvRow {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed: positive = money in, negative = money out. */
  amount: number;
  description: string;
  /** The bank's own category, when the export carries one. */
  category?: string;
  /**
   * 'pending' when the export marks the row as an unsettled authorisation —
   * either in its own status column or as a marker written into the date
   * column ('PENDING', '09/12/2026 PENDING'). Absent means posted.
   */
  status?: 'pending' | 'posted';
}

export interface BankCsvResult {
  rows: BankCsvRow[];
  warnings: string[];
}

const DELIMITERS = [';', ',', '\t', '|'] as const;

const DATE_HEADERS = [
  'date',
  'datum',
  'date_op',
  'dateop',
  'bookingdate',
  'booking date',
  'transactiondate',
  'transaction date',
  'valuedate',
  'value date',
  'dateoperation',
  "dated'operation",
  'dateofvaleur',
  'postingdate',
  'posted date',
];
const AMOUNT_HEADERS = ['amount', 'montant', 'betrag', 'value', 'sum', 'somme', 'importe'];
const DEBIT_HEADERS = ['debit', 'withdrawal', 'withdrawals', 'sortie', 'sorties', 'soll', 'paid out'];
const CREDIT_HEADERS = ['credit', 'deposit', 'deposits', 'entree', 'entrees', 'haben', 'paid in'];
const CATEGORY_HEADERS = [
  'category',
  'categorie',
  'kategorie',
  'categoria',
  'rubrique',
  'classification',
];
const STATUS_HEADERS = [
  'status',
  'statut',
  'state',
  'etat',
  'transactionstatus',
  'transaction status',
  'postingstatus',
];
const DESCRIPTION_HEADERS = [
  'description',
  'libelle',
  'label',
  'memo',
  'details',
  'detail',
  'narrative',
  'payee',
  'wording',
  'verwendungszweck',
  'buchungstext',
  'reference',
  'nature',
];

/**
 * How a bank says "this has not settled yet". Matched against the status
 * column and against the date cell, because plenty of exports write the marker
 * where the date belongs and leave the real date to a second column.
 */
const PENDING_RE =
  /(pending|en\s*attente|autoris|authoriz|unposted|not\s*posted|processing|on\s*hold)/i;

/** True when a cell carries a pending marker. */
export function isPendingMarker(raw: string): boolean {
  return PENDING_RE.test(raw);
}

/** Lowercase, strip accents/BOM/punctuation so 'Libellé' matches 'libelle'. */
function normalizeHeader(h: string): string {
  return h
    .replace(/^\ufeff/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[_\-.]+/g, '')
    .trim();
}

function matchHeader(
  headers: string[],
  candidates: string[],
  exclude: ReadonlySet<number> = new Set(),
): number {
  const norm = headers.map(normalizeHeader);
  const wanted = candidates.map((c) => normalizeHeader(c));
  const ok = (i: number): boolean => i !== -1 && !exclude.has(i);
  for (const w of wanted) {
    const exact = norm.findIndex((h, i) => h === w && !exclude.has(i));
    if (ok(exact)) return exact;
  }
  for (const w of wanted) {
    const partial = norm.findIndex(
      (h, i) => h.length > 0 && !exclude.has(i) && (h.includes(w) || w.includes(h)),
    );
    if (ok(partial)) return partial;
  }
  return -1;
}

/** Split one CSV line on `delimiter`, honouring "" quoting. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delimiter) count += 1;
  }
  return count;
}

function detectDelimiter(headerLine: string): string {
  let best: string = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const c = countOutsideQuotes(headerLine, d);
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Parse an amount written in any of the common bank styles:
 * `1.234,56`, `1,234.56`, `-45,50`, `(120.00)`, `1 234,56 EUR`, `+ 90`.
 */
export function parseAmount(raw: string): number | undefined {
  let s = raw.trim();
  if (s === '') return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Drop currency symbols/codes and grouping spaces (incl. NBSP/narrow NBSP).
  s = s.replace(/\s/g, '').replace(/[^\d.,+-]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s === '' || /[^\d.,]/.test(s)) return undefined;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever comes last is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const decimals = s.length - lastComma - 1;
    // "1,234" is grouping; "45,5" and "45,50" are decimals.
    s = decimals === 3 && s.indexOf(',') === lastComma && lastComma > 0 && /^\d{1,3}$/.test(s.slice(0, lastComma))
      ? s.replace(/,/g, '')
      : s.replace(/,/g, '.');
  }
  if (s.split('.').length > 2) s = s.replace(/\.(?=.*\.)/g, '');

  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return negative ? -n : n;
}

/** Parse `YYYY-MM-DD`, `DD/MM/YYYY`, `DD.MM.YYYY` (and `MM/DD/YYYY` when unambiguous). */
export function parseCsvDate(raw: string): string | undefined {
  const s = raw.trim();
  if (s === '') return undefined;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(s);
  if (parts) {
    let a = Number(parts[1]);
    let b = Number(parts[2]);
    let year = Number(parts[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    // Default DD/MM; swap only when that reading is impossible.
    if (a > 12 && b <= 12) return build(year, b, a);
    if (b > 12 && a <= 12) return build(year, a, b);
    return build(year, b, a);
  }
  return undefined;

  function build(y: number, m: number, d: number): string | undefined {
    if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      return undefined;
    }
    return dt.toISOString().slice(0, 10);
  }
}

export function parseBankCsv(text: string): BankCsvResult {
  const warnings: string[] = [];
  const rows: BankCsvRow[] = [];

  const lines = text
    .replace(/^\ufeff/, '')
    .split(/\r\n|\n|\r/)
    .filter((l, i) => l.trim() !== '' || i === 0);
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === '') {
    return { rows, warnings: ['empty file: no header row'] };
  }

  const delimiter = detectDelimiter(headerLine);
  const headers = splitLine(headerLine, delimiter);

  const dateIdx = matchHeader(headers, DATE_HEADERS);
  const taken = new Set<number>();
  if (dateIdx !== -1) taken.add(dateIdx);
  const amountIdx = matchHeader(headers, AMOUNT_HEADERS, taken);
  if (amountIdx !== -1) taken.add(amountIdx);
  const debitIdx = matchHeader(headers, DEBIT_HEADERS, taken);
  if (debitIdx !== -1) taken.add(debitIdx);
  const creditIdx = matchHeader(headers, CREDIT_HEADERS, taken);
  if (creditIdx !== -1) taken.add(creditIdx);
  // Category is matched before description so a 'category' column is never
  // mistaken for the free-text one.
  const categoryIdx = matchHeader(headers, CATEGORY_HEADERS, taken);
  if (categoryIdx !== -1) taken.add(categoryIdx);
  // Status is matched before description so a 'status' column is never read as
  // the free-text one.
  const statusIdx = matchHeader(headers, STATUS_HEADERS, taken);
  if (statusIdx !== -1) taken.add(statusIdx);
  const descIdx = matchHeader(headers, DESCRIPTION_HEADERS, taken);

  if (dateIdx === -1) {
    return {
      rows,
      warnings: [`no date column found in header: ${headers.join(delimiter)}`],
    };
  }
  const hasSplit = debitIdx !== -1 || creditIdx !== -1;
  if (amountIdx === -1 && !hasSplit) {
    return {
      rows,
      warnings: [`no amount (or debit/credit) column found in header: ${headers.join(delimiter)}`],
    };
  }

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    const lineNo = i + 1;
    const fields = splitLine(line, delimiter);
    const at = (idx: number): string => (idx >= 0 ? fields[idx] ?? '' : '');

    // A pending marker can live in its own column or inside the date cell; in
    // the second case it is stripped back out before the date is parsed.
    const rawDate = at(dateIdx);
    const pending = isPendingMarker(rawDate) || isPendingMarker(at(statusIdx));
    const dateCell = isPendingMarker(rawDate)
      ? rawDate.replace(PENDING_RE, ' ').replace(/[()[\]]/g, ' ').trim()
      : rawDate;

    const date = parseCsvDate(dateCell);
    if (date === undefined) {
      warnings.push(`line ${lineNo}: unparseable date ${JSON.stringify(rawDate)} — skipped`);
      continue;
    }

    let amount: number | undefined;
    if (amountIdx !== -1 && at(amountIdx) !== '') {
      amount = parseAmount(at(amountIdx));
    } else if (hasSplit) {
      const debit = parseAmount(at(debitIdx)) ?? 0;
      const credit = parseAmount(at(creditIdx)) ?? 0;
      if (at(debitIdx) === '' && at(creditIdx) === '') amount = undefined;
      else amount = Math.abs(credit) - Math.abs(debit);
    }
    if (amount === undefined || !Number.isFinite(amount)) {
      warnings.push(`line ${lineNo}: unparseable amount in ${JSON.stringify(line)} — skipped`);
      continue;
    }

    const category = at(categoryIdx);
    rows.push({
      date,
      amount: Math.round(amount * 100) / 100,
      description: at(descIdx) || '(no description)',
      ...(category === '' ? {} : { category }),
      ...(pending ? { status: 'pending' as const } : {}),
    });
  }

  return { rows, warnings };
}

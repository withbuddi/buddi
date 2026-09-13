import { describe, expect, it } from 'vitest';
import { parseAmount, parseBankCsv, parseCsvDate } from './csv.js';

const FRENCH = [
  'Date;Libellé;Montant',
  '13/09/2026;VIREMENT SALAIRE;3 200,00',
  '15/09/2026;"PRELEVEMENT EDF, CONTRAT 42";-89,90',
  '01/10/2026;LOYER;-1.200,50',
].join('\r\n');

const US = [
  'Date,Description,Amount',
  '2026-09-13,"ACME PAYROLL, INC",3200.00',
  '2026-09-15,Coffee Shop,-4.75',
  '09/20/2026,"Laptop, refurbished","-1,199.99"',
].join('\n');

const SPLIT = [
  'Booking date;Description;Debit;Credit',
  '13.09.2026;Salary;;3200,00',
  '15.09.2026;Rent;1200,00;',
  '16.09.2026;Refund;;12,30',
].join('\n');

describe('parseAmount', () => {
  it('handles both decimal conventions and grouping', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('-45,50')).toBe(-45.5);
    expect(parseAmount('3 200,00')).toBe(3200);
    expect(parseAmount('1,234')).toBe(1234);
    expect(parseAmount('12,3')).toBe(12.3);
    expect(parseAmount('(120.00)')).toBe(-120);
    expect(parseAmount('89,90 EUR')).toBe(89.9);
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('n/a')).toBeUndefined();
  });
});

describe('parseCsvDate', () => {
  it('accepts ISO, slash and dot formats', () => {
    expect(parseCsvDate('2026-09-13')).toBe('2026-09-13');
    expect(parseCsvDate('13/09/2026')).toBe('2026-09-13');
    expect(parseCsvDate('13.09.2026')).toBe('2026-09-13');
    expect(parseCsvDate('09/20/2026')).toBe('2026-09-20'); // only MM/DD is possible
    expect(parseCsvDate('32/01/2026')).toBeUndefined();
    expect(parseCsvDate('not a date')).toBeUndefined();
  });
});

describe('parseBankCsv', () => {
  it('parses a French-style ; file with decimal commas', () => {
    const { rows, warnings } = parseBankCsv(FRENCH);
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      { date: '2026-09-13', amount: 3200, description: 'VIREMENT SALAIRE' },
      { date: '2026-09-15', amount: -89.9, description: 'PRELEVEMENT EDF, CONTRAT 42' },
      { date: '2026-10-01', amount: -1200.5, description: 'LOYER' },
    ]);
  });

  it('parses a US-style comma file with quoted fields', () => {
    const { rows, warnings } = parseBankCsv(US);
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      { date: '2026-09-13', amount: 3200, description: 'ACME PAYROLL, INC' },
      { date: '2026-09-15', amount: -4.75, description: 'Coffee Shop' },
      { date: '2026-09-20', amount: -1199.99, description: 'Laptop, refurbished' },
    ]);
  });

  it('parses a debit/credit split file into signed amounts', () => {
    const { rows, warnings } = parseBankCsv(SPLIT);
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      { date: '2026-09-13', amount: 3200, description: 'Salary' },
      { date: '2026-09-15', amount: -1200, description: 'Rent' },
      { date: '2026-09-16', amount: 12.3, description: 'Refund' },
    ]);
  });

  it('warns about unparseable rows instead of throwing', () => {
    const { rows, warnings } = parseBankCsv(
      ['Date;Libellé;Montant', 'nope;BAD DATE;10,00', '13/09/2026;NO AMOUNT;', '14/09/2026;OK;5,00'].join(
        '\n',
      ),
    );
    expect(rows).toEqual([{ date: '2026-09-14', amount: 5, description: 'OK' }]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/line 2: unparseable date/);
    expect(warnings[1]).toMatch(/line 3: unparseable amount/);
  });

  it('reports a missing column set rather than inventing data', () => {
    const { rows, warnings } = parseBankCsv('foo;bar\n1;2');
    expect(rows).toEqual([]);
    expect(warnings[0]).toMatch(/no date column/);
  });

  it('tolerates a BOM, CRLF line endings and blank lines', () => {
    const { rows, warnings } = parseBankCsv(
      '﻿Date,Description,Amount\r\n2026-09-13,Salary,10.00\r\n\r\n',
    );
    expect(warnings).toEqual([]);
    expect(rows).toEqual([{ date: '2026-09-13', amount: 10, description: 'Salary' }]);
  });

  it("carries the bank's own category column through", () => {
    const { rows, warnings } = parseBankCsv(
      [
        'date,amount,description,category',
        '2026-09-11,-20.56,Amazon Marketplace,General Merchandise',
        '2026-09-10,1000.00,Transfer from Zelle,Transfers',
        '2026-09-09,-4.25,Corner shop,',
      ].join('\n'),
    );
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      {
        date: '2026-09-11',
        amount: -20.56,
        description: 'Amazon Marketplace',
        category: 'General Merchandise',
      },
      {
        date: '2026-09-10',
        amount: 1000,
        description: 'Transfer from Zelle',
        category: 'Transfers',
      },
      { date: '2026-09-09', amount: -4.25, description: 'Corner shop' },
    ]);
  });

  it('does not mistake the category column for the description', () => {
    const { rows } = parseBankCsv('Date,Category,Amount,Memo\n2026-09-13,Groceries,-9.99,Bakery');
    expect(rows).toEqual([
      { date: '2026-09-13', amount: -9.99, description: 'Bakery', category: 'Groceries' },
    ]);
  });

  it('keeps identical rows instead of collapsing them', () => {
    const { rows } = parseBankCsv(
      [
        'date,amount,description',
        '2026-08-31,1000.00,Transfer from Zelle',
        '2026-08-31,1000.00,Transfer from Zelle',
        '2026-08-31,1000.00,Transfer from Zelle',
      ].join('\n'),
    );
    expect(rows).toHaveLength(3);
  });
});

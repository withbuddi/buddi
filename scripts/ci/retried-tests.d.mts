import type { Reporter } from 'vitest/reporters';

/** See retried-tests.mjs: appends one line per test that needed a retry to `file`. */
export default class RetriedTests implements Reporter {
  constructor(file: string, label: string);
}

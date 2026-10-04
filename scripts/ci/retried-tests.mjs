/**
 * A vitest reporter that keeps flaky tests visible while `retry` hides them.
 *
 * The web and install suites retry on CI as a stopgap (see their
 * vitest.config.ts). A test that passed only on a retry is still a race, so
 * this appends one line per such test to the file `VITEST_RETRIED` names, and
 * the gate turns those lines into warnings and its job summary
 * (.github/workflows/gate.yml). vitest 2's JSON reporter does not carry the
 * retry count, which is why this reads the tasks itself.
 */
import { appendFileSync } from 'node:fs';

function* tests(tasks) {
  for (const task of tasks) {
    if (task.type === 'test') yield task;
    if (Array.isArray(task.tasks)) yield* tests(task.tasks);
  }
}

function fullName(task) {
  const names = [];
  for (let t = task; t !== undefined && t !== task.file; t = t.suite) names.unshift(t.name);
  return names.join(' > ');
}

export default class RetriedTests {
  /**
   * @param {string} file where the lines go
   * @param {string} label the package, since test files are named from its root
   */
  constructor(file, label) {
    this.file = file;
    this.label = label;
  }

  onFinished(files = []) {
    const lines = [];
    for (const task of tests(files)) {
      const retries = task.result?.retryCount ?? 0;
      if (retries === 0) continue;
      const outcome = task.result?.state === 'pass' ? 'passed' : 'failed';
      lines.push(`${this.label}/${task.file?.name ?? '?'} > ${fullName(task)} (retry x${retries}, ${outcome})\n`);
    }
    if (lines.length > 0) appendFileSync(this.file, lines.join(''));
  }
}

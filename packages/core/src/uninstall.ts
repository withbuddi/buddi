/**
 * `buddi uninstall`, the part a packaged install and a source checkout share:
 * print what will go, ask once, take the last backup, remove each thing, and
 * say what could not be removed.
 *
 * What goes differs by installation, so each builds its own plan (the
 * launcher in `@buddi/install`, the CLI for a checkout) and hands it here.
 *
 * This module is deliberately a leaf: no imports, no path constants, no
 * environment. That is what lets `@buddi/install` take a value import from it
 * (through the `@buddi/core/uninstall` subpath) without loading anything that
 * reads the environment before `environment()` has run.
 */

/** One thing the uninstall removes: one line in the plan, one action. */
export interface RemovalStep {
  /** What the plan prints for it, on one line, with the real path. */
  line: string;
  /** Removes it, or throws with a sentence saying why it could not. */
  run: () => Promise<void>;
  /** A failure is said, but does not make the command fail (the Telegram menu). */
  bestEffort?: boolean;
}

export interface UninstallPlan {
  /** The first line: "This removes buddi from this Mac:". */
  heading: string;
  /** In the order they run. */
  steps: RemovalStep[];
  /** Printed under the steps, before the question: the backup, what stays. */
  notes: string[];
  /**
   * Runs after the owner said yes and before anything is removed: the last
   * backup. Returns lines to print. Throwing stops the uninstall with nothing
   * removed, which is the point of taking the backup first.
   */
  prepare?: () => Promise<string[]>;
  /** Printed at the very end, whatever happened. */
  last?: string;
}

export interface UninstallIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** One typed line, or undefined when there is no terminal to ask. */
  ask: (question: string) => Promise<string | undefined>;
}

/** Print the plan, ask, prepare, remove. 0 when everything went; 1 otherwise. */
export async function runUninstallPlan(plan: UninstallPlan, opts: { yes: boolean }, io: UninstallIo): Promise<number> {
  if (plan.steps.length === 0) {
    io.log('Nothing of buddi is installed here, so there is nothing to remove.');
    if (plan.last !== undefined) io.log(plan.last);
    return 0;
  }
  io.log(plan.heading);
  for (const step of plan.steps) io.log(`  - ${step.line}`);
  for (const note of plan.notes) io.log(note);
  if (!opts.yes) {
    const typed = await io.ask('Type yes to remove all of this: ');
    if (typed === undefined) {
      io.error('Nothing was removed: there is no terminal to ask. Run buddi uninstall --yes to remove it without asking.');
      return 1;
    }
    if (typed.trim().toLowerCase() !== 'yes') {
      io.log('Nothing was removed.');
      return 1;
    }
  }
  if (plan.prepare) {
    try {
      for (const line of await plan.prepare()) io.log(line);
    } catch (error) {
      io.error(`${sentence(error)} Nothing was removed.`);
      return 1;
    }
  }
  const failed: string[] = [];
  for (const step of plan.steps) {
    try {
      await step.run();
      io.log(`Removed ${step.line}.`);
    } catch (error) {
      if (step.bestEffort) io.log(`Could not remove ${step.line}: ${sentence(error)} Nothing else depends on it.`);
      else failed.push(`Could not remove ${step.line}: ${sentence(error)}`);
    }
  }
  for (const line of failed) io.error(line);
  if (failed.length > 0) io.error('Everything else was removed. Fix the above and run buddi uninstall again.');
  if (plan.last !== undefined) io.log(plan.last);
  return failed.length > 0 ? 1 : 0;
}

function sentence(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** `security`, as the caller runs it: an argv, an exit code, and never a shell. */
export type SecurityRun = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Delete every keychain entry under `service`: each name, then the index the
 * keychain vault keeps of them (`buddi.index`, see `vault/keychain.ts`).
 * Missing is fine (44); anything else — a locked keychain — throws, naming
 * the entry and never a value.
 */
export async function purgeKeychain(service: string, names: readonly string[], run: SecurityRun): Promise<void> {
  const refused: string[] = [];
  for (const name of [...names, 'buddi.index']) {
    const res = await run(['delete-generic-password', '-s', service, '-a', name]);
    if (res.code !== 0 && res.code !== 44) refused.push(`${name} (security exit ${res.code})`);
  }
  if (refused.length > 0) {
    throw new Error(`the keychain refused to delete ${refused.join(', ')}. Unlock it with: security unlock-keychain ~/Library/Keychains/login.keychain-db`);
  }
}

/** The slice of the shared HTTP transport (`@buddi/gateway`'s) the menu call needs. */
export type MenuTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Empty the Telegram bot's command menu: the default scope and each paired
 * chat, which is where buddi publishes it. An empty list is what Telegram
 * takes as "no menu". Throws on the first refusal. The caller passes the
 * shared transport: nothing here goes out through the global `fetch`.
 */
export async function clearTelegramMenu(token: string, chatIds: readonly string[], http: MenuTransport): Promise<void> {
  const scopes: Array<Record<string, unknown>> = [{ type: 'default' }, ...chatIds.map((id) => ({ type: 'chat', chat_id: id }))];
  for (const scope of scopes) {
    const response = await http(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands: [], scope }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Telegram answered ${response.status}`);
  }
}

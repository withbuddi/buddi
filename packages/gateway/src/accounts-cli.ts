/**
 * `buddi accounts` — the model accounts from a terminal (docs/cli.md).
 *
 * Accounts are added on the dashboard (Settings → Model accounts), because
 * most of them start with a sign-in or a pasted key that a terminal should not
 * see. What a terminal needs is the other half: each account's id, for
 * `buddi agents set <handle> --account <id>`, and whether it can run right now
 * — off, missing its credential, or held back by its provider until a time.
 *
 * Read through the same `ProviderAccounts` view the dashboard reads, and then
 * narrowed field by field: nothing here prints a key, a token, a vault name or
 * a sign-in in progress.
 */
import { getOwnerProfile, MLXH_BASE_URL, resetPhrase, timezoneFromEnv, type OwnerFormats } from '@buddi/core';
import type { AccountRateLimit } from './account-limits.js';
import { createWiringAsync, hydrateSecrets, loadEnvironment } from './bootstrap.js';
import { bold, dim, styleFor, type TerminalStyle } from './chat/terminal.js';

export const USAGE = `buddi accounts — the model accounts and where each one stands

  buddi accounts [list] [--json]   every account: id, provider, default model, state, agents
  buddi accounts show <id> [--json] one account in full (an id or a label)

Accounts are added on the dashboard: Settings → Model accounts → Add account.`;

export type AccountsCommand =
  | { action: 'help' }
  | { action: 'list'; json: boolean }
  | { action: 'show'; id: string; json: boolean };

export function parseAccountsArgs(argv: readonly string[]): AccountsCommand {
  const json = argv.includes('--json');
  const words = argv.filter((a) => a !== '--json');
  const unknown = words.find((w) => w.startsWith('-') && w !== '--help' && w !== '-h');
  if (unknown) throw new Error(`buddi accounts does not take ${unknown}`);
  if (words.includes('--help') || words.includes('-h') || words[0] === 'help') return { action: 'help' };
  const [verb, ...rest] = words;
  if (verb === undefined || verb === 'list') {
    if (rest.length > 0) throw new Error(`buddi accounts list takes no arguments (got ${rest[0]})`);
    return { action: 'list', json };
  }
  if (verb === 'show') {
    if (rest.length !== 1) throw new Error('buddi accounts show needs one account id or label');
    return { action: 'show', id: rest[0] as string, json };
  }
  throw new Error(`buddi accounts ${verb} is not a command. Try buddi accounts list or buddi accounts show <id>.`);
}

/** What the view says about one account; only the fields read here. */
export interface ViewAccount {
  id: string;
  label: string;
  kind: string;
  auth: string;
  baseUrl?: string | null;
  defaultModel: string;
  enabled: boolean;
  configured: boolean;
  contextWindowTokens?: number | null;
  detectedContextWindowTokens?: number;
  assignedAgents: string[];
  rateLimit?: AccountRateLimit | null;
  test?: { state: string; message: string; checkedAt: string } | null;
  reconnectRequired?: boolean;
}

export type AccountState = 'ready' | 'rate-limited' | 'needs-credential' | 'needs-sign-in' | 'disabled';

export interface AccountLine {
  id: string;
  label: string;
  kind: string;
  /** The provider in the owner's words: "Claude subscription", "Gemini". */
  provider: string;
  auth: string;
  defaultModel: string;
  enabled: boolean;
  configured: boolean;
  state: AccountState;
  rateLimit: AccountRateLimit | null;
  agents: Array<{ id: string; handle: string | null; model: string }>;
}

/** The provider in the owner's words, as Settings → Model accounts names it. */
export function providerLabel(a: Pick<ViewAccount, 'kind' | 'auth' | 'baseUrl'>): string {
  if (a.kind === 'codex') return 'ChatGPT subscription';
  if (a.kind === 'anthropic') return a.auth === 'anthropic-oauth' ? 'Claude subscription' : 'Anthropic API';
  if (a.kind === 'openai') return 'OpenAI API';
  if (a.auth === 'device-key') return 'Ollama Cloud';
  const base = (a.baseUrl ?? '').replace(/\/+$/, '');
  if (base.includes('generativelanguage.googleapis.com')) return 'Gemini';
  if (base === MLXH_BASE_URL.replace(/\/+$/, '')) return 'mlxh';
  return 'OpenAI-compatible';
}

/** One word for where an account stands, in the order that decides it. */
export function accountState(a: ViewAccount, now: number = Date.now()): AccountState {
  if (!a.enabled) return 'disabled';
  if (a.reconnectRequired) return 'needs-sign-in';
  if (!a.configured) return 'needs-credential';
  if (a.rateLimit && Date.parse(a.rateLimit.until) > now) return 'rate-limited';
  return 'ready';
}

export function accountLines(
  view: { accounts: readonly ViewAccount[]; bindings: ReadonlyArray<{ agentId: string; accountId: string; model: string }> },
  handleOf: (agentId: string) => string | null,
  now: number = Date.now(),
): AccountLine[] {
  return view.accounts.map((a) => {
    const state = accountState(a, now);
    return {
      id: a.id,
      label: a.label,
      kind: a.kind,
      provider: providerLabel(a),
      auth: a.auth,
      defaultModel: a.defaultModel,
      enabled: a.enabled,
      configured: a.configured,
      state,
      rateLimit: state === 'rate-limited' ? a.rateLimit ?? null : null,
      agents: a.assignedAgents.map((id) => ({
        id,
        handle: handleOf(id),
        model: view.bindings.find((b) => b.agentId === id)?.model ?? a.defaultModel,
      })),
    };
  });
}

/** "rate-limited until 14:20 · Gemini free tier, 20 requests a day". */
export function stateText(line: Pick<AccountLine, 'state' | 'rateLimit'>, timeZone: string, now: Date = new Date(), formats: OwnerFormats = {}): string {
  if (line.state === 'needs-credential') return 'needs a credential';
  if (line.state === 'needs-sign-in') return 'needs signing in again';
  if (line.state !== 'rate-limited' || !line.rateLimit) return line.state;
  const r = line.rateLimit;
  const when = resetPhrase(r.until, timeZone, now, formats).replace(/^on /, '');
  const quota = r.scope === 'day'
    ? r.limit !== null ? ` · ${r.freeTier ? 'free tier, ' : ''}${r.limit} ${r.unit ?? 'requests'} a day` : ' · daily quota used up'
    : '';
  return `rate-limited until ${when}${quota}`;
}

function agentsText(line: AccountLine): string {
  return line.agents.length === 0 ? 'no agents' : line.agents.map((a) => (a.handle ? `@${a.handle}` : a.id)).join(', ');
}

/** The listing, as text: label, provider, model, state and agents; the id under each. */
export function renderAccountLines(lines: readonly AccountLine[], style: Pick<TerminalStyle, 'color'>, timeZone: string, now: Date = new Date(), formats: OwnerFormats = {}): string {
  if (lines.length === 0) return 'No model accounts yet. Add one on the dashboard: Settings → Model accounts → Add account.';
  const color = style.color;
  const w = (pick: (l: AccountLine) => string): number => Math.max(...lines.map((l) => pick(l).length));
  const label = w((l) => l.label);
  const provider = w((l) => l.provider);
  const model = w((l) => l.defaultModel);
  const state = w((l) => stateText(l, timeZone, now, formats));
  const out: string[] = [];
  for (const line of lines) {
    out.push([
      bold(line.label.padEnd(label), color),
      line.provider.padEnd(provider),
      line.defaultModel.padEnd(model),
      stateText(line, timeZone, now, formats).padEnd(state),
      agentsText(line),
    ].join('  ').trimEnd());
    out.push(dim(`  ${line.id} · ${line.kind} · ${line.auth}`, color));
  }
  return out.join('\n');
}

/** One account in full, as text. */
export function renderAccount(line: AccountLine, extra: Pick<ViewAccount, 'baseUrl' | 'contextWindowTokens' | 'detectedContextWindowTokens' | 'test'>, style: Pick<TerminalStyle, 'color'>, timeZone: string, now: Date = new Date(), formats: OwnerFormats = {}): string {
  const color = style.color;
  const row = (name: string, value: string): string => `  ${dim(name.padEnd(15), color)}${value}`;
  const out = [`${bold(line.label, color)} ${dim(line.id, color)}`];
  out.push(row('provider', `${line.provider} (${line.kind})`));
  out.push(row('signs in with', line.auth));
  if (extra.baseUrl) out.push(row('address', extra.baseUrl));
  out.push(row('default model', line.defaultModel || '—'));
  const window = extra.contextWindowTokens ?? extra.detectedContextWindowTokens;
  if (window) out.push(row('context window', `${window.toLocaleString('en-US')} tokens${extra.contextWindowTokens ? '' : ' (detected)'}`));
  out.push(row('state', stateText(line, timeZone, now, formats)));
  out.push(row('agents', line.agents.length === 0 ? 'no agents' : line.agents.map((a) => `${a.handle ? `@${a.handle}` : a.id} (${a.model})`).join(', ')));
  if (extra.test) out.push(row('last test', `${extra.test.message} ${dim(`(${extra.test.checkedAt})`, color)}`));
  out.push('', dim(`  Put an agent on it: buddi agents set <handle> --account ${line.id}`, color));
  return out.join('\n');
}

export async function main(argv: string[] = process.argv.slice(3)): Promise<number> {
  let command: AccountsCommand;
  try {
    command = parseAccountsArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (command.action === 'help') {
    console.log(USAGE);
    return 0;
  }
  await loadEnvironment();
  await hydrateSecrets(process.env);
  const style = styleFor(process.env, process.stdout);
  const wiring = await createWiringAsync(process.env);
  try {
    // Times in the owner's Profile zone and formats, as the dashboard says them.
    const profile = await getOwnerProfile(wiring.pool).catch(() => null);
    const timeZone = profile?.timezone ?? timezoneFromEnv(process.env);
    const formats: OwnerFormats = { timeFormat: profile?.timeFormat ?? null, dateFormat: profile?.dateFormat ?? null };
    if (!wiring.providerAccounts) {
      console.error('Model accounts are unavailable here: buddi could not open the accounts table.');
      return 3;
    }
    const view = wiring.providerAccounts.view() as unknown as { accounts: ViewAccount[]; bindings: Array<{ agentId: string; accountId: string; model: string }> };
    const handleOf = (id: string): string | null => {
      try { return wiring.catalog.get(id)?.handle ?? null; } catch { return null; }
    };
    const lines = accountLines(view, handleOf);
    if (command.action === 'list') {
      console.log(command.json ? JSON.stringify(lines, null, 2) : renderAccountLines(lines, style, timeZone, new Date(), formats));
      return 0;
    }
    const wanted = command.id.trim().toLowerCase();
    const line = lines.find((l) => l.id.toLowerCase() === wanted) ?? lines.find((l) => l.label.toLowerCase() === wanted);
    if (!line) {
      console.error(`No model account has the id or label "${command.id}". buddi accounts list prints them.`);
      return 3;
    }
    const account = view.accounts.find((a) => a.id === line.id) as ViewAccount;
    const extra = {
      baseUrl: account.kind === 'codex' ? null : account.baseUrl ?? null,
      contextWindowTokens: account.contextWindowTokens ?? null,
      ...(account.detectedContextWindowTokens !== undefined ? { detectedContextWindowTokens: account.detectedContextWindowTokens } : {}),
      test: account.test ? { state: account.test.state, message: account.test.message, checkedAt: account.test.checkedAt } : null,
    };
    console.log(command.json ? JSON.stringify({ ...line, ...extra }, null, 2) : renderAccount(line, extra, style, timeZone, new Date(), formats));
    return 0;
  } finally {
    await wiring.pool.end();
  }
}

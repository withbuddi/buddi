/**
 * The finance advisor agent definition.
 *
 * Nothing here reads `process.env` ambiently: the caller passes `env`, and the
 * credential kind is chosen by `providerFromEnv` — an explicit, tested decision,
 * never something the adapter discovers for itself (ARCHITECTURE.md, "Runtime
 * provider port": no ambient credentials; provider is pinned per agent).
 */
import type { AgentDefinition, ProviderRef } from '@buddi/core';
import { manifest as financeManifest } from '@buddi/tool-finance';

/** Model used when the owner does not pin one in the environment. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * Every tool the finance plugin ships, by name — derived from the manifest, never
 * a hardcoded list. Families added to the plugin later (the spending baseline, the
 * liabilities tools) reach the agent the moment the manifest carries them, and are
 * absent until then; nothing here depends on how many there are.
 */
export const FINANCE_TOOLS: string[] = financeManifest.tools
  .map((t) => t.name)
  .filter((name) => name.startsWith('finance.'));

/**
 * Credential choice, made once and explicitly: a subscription token if the
 * owner ran `claude setup-token`, an API key otherwise. Empty strings do not
 * count as set — resolution would fail closed anyway, but the choice should not
 * silently land on the wrong kind.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv): ProviderRef {
  const hasSubscriptionToken = (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim() !== '';
  return {
    kind: 'anthropic',
    credential: hasSubscriptionToken
      ? { kind: 'subscription-token', env: 'CLAUDE_CODE_OAUTH_TOKEN' }
      : { kind: 'api-key', env: 'ANTHROPIC_API_KEY' },
    model: (env.BUDDI_MODEL ?? '').trim() || DEFAULT_MODEL,
  };
}

/** Tool names the liabilities family ships, when the finance plugin has it. */
export const LIABILITY_TOOLS: readonly string[] = [
  'finance.set_liability',
  'finance.list_liabilities',
  'finance.remove_liability',
  'finance.payoff_estimate',
];

/** Tool name for the variable-spending baseline, when the finance plugin has it. */
export const BASELINE_TOOL = 'finance.spending_baseline';

/**
 * The always-true part of the system prompt. `{{today}}` is substituted per run
 * from the tool context clock, so the agent never guesses the date and a resumed
 * conversation is not stuck on the day it started.
 */
const BASE_SECTION = `You are the owner's personal cash-flow advisor. There is exactly one owner: the person you are talking to. Today is {{today}}.

Your job is to keep the owner's financial picture accurate and to answer money questions from a computed projection — never from mental arithmetic.

## Never compute, always project
- You never do arithmetic on money. The tools compute; you explain.
- Before answering ANY question of the form "can I afford X", "is X wise", "should I buy X", "what if I spend X", "what happens if I ...", you MUST call finance.project_cashflow with that purchase as a hypothetical (negative amount, on the date it would happen). No exceptions, not even when the answer looks obvious.
- Read the verdict off the result: minBalance, minBalanceDate, breachesFloor, firstBreachDate, nextIncome and safetyFloor. Quote those numbers back.
- If breachesFloor is true: advise against it. Say how low the balance goes, on what date, and when the next income lands. Offer the earliest date that would work if you can get it from a further projection.
- If breachesFloor is false: say it is fine, and by what margin the minimum clears the floor.
- A follow-up with a different date or amount ("and if I wait until the 30th?") needs a NEW finance.project_cashflow call with the new hypothetical. Never reuse a previous projection for a new date or amount.
- Date arithmetic is yours: turn "next Saturday" or "the 30th" into a YYYY-MM-DD date using today's date above. Money arithmetic is never yours.

## What every verdict must state
Yes or no, a verdict always says, out loud and with the numbers:
- the minimum projected balance over the horizon and the exact date it happens (minBalance, minBalanceDate),
- whether the safety floor is breached — if yes, by how much and on what date; if no, by what margin the minimum clears it,
- when the next income lands.
If the safety floor is 0 or unset, say once — once in the conversation, not in every message — that no safety floor is set, and offer to set one with finance.set_preferences.

## Status and overview
When the owner asks for a "Status", an overview, a "point" or "where do I stand", report, from tool results only:
- the total cash across accounts, per account if there are several,
- the charges and incomes due in the next 14 days, with their dates and amounts,
- the safety floor, or the note that none is set.

## Record what the owner tells you
When the owner states a balance, an income, a fixed charge, a one-off expense, a currency or a safety floor, store it immediately with the matching tool, one call per item, then confirm in one line what you stored:
- current balance of an account -> finance.set_balance
- recurring income or charge -> finance.add_recurring (kind income|charge, positive amount, cadence, anchorDate = the next occurrence of that day)
- something that already happened once -> finance.record_transaction
- currency or safety floor -> finance.set_preferences
Store first, answer second.

## Ask before judging
If there is no recorded balance, or no recurring items yet, do not give a verdict. Check with finance.list_accounts, finance.list_recurring and finance.get_preferences, then ask for exactly what is missing: the current balance and its date, each income with its date, each fixed charge with its date, the currency, and the safety floor.`;

/** Appended only when the finance plugin ships the spending baseline. */
const BASELINE_SECTION = `## Typical variable spending
- finance.spending_baseline reports the owner's average monthly variable spending, derived from transaction history.
- finance.project_cashflow already applies that baseline by default, as a daily burn. You never add it yourself, and you never subtract it twice.
- Every verdict says which it is: state that the projection includes typical variable spending. If you passed includeBaseline:false — only ever because the owner asked for fixed items alone — say plainly that variable spending was excluded.
- includeP2P:'net' additionally applies the net of person-to-person transfers. Use it only when the owner asks, and say that you did.`;

/** Appended only when the finance plugin ships the liabilities tools. */
const LIABILITY_SECTION = `## Liabilities are debts, never cash
- A liability is money owed. Never add a liability balance to a cash total, and never let one raise a projected balance. Debt reduces net worth; it does not fund a purchase.
- When the owner mentions a loan, a credit balance, money owed to someone, store it with finance.set_liability, then confirm in one line what you stored. finance.list_liabilities reads them back; finance.remove_liability drops one.
- In a Status or overview, if any liability is recorded, add the total debt and the net worth (cash minus debt) alongside the cash total. If none is recorded, do not mention debt at all.
- For "when will this be paid off" or "what does it cost me to clear this", call finance.payoff_estimate. Never estimate a payoff yourself.`;

/** The closing section: always last, so the language rule is the final word. */
const STYLE_SECTION = `## Style
- Short and concrete. The verdict in the first line, then the two or three numbers it rests on.
- Reply in the language the owner's latest message is written in. English message → English reply. French → French. Never switch language on your own.
- Never invent a number. If you do not have it, say so or ask for it.
- Show amounts with the currency from the owner's preferences (default EUR).`;

/**
 * Assemble the prompt for the tools that actually exist at runtime. The finance
 * plugin grows on its own schedule; guidance for a tool family the manifest does
 * not ship would be an instruction to call something that is not there.
 */
export function buildSystemPromptTemplate(tools: readonly string[] = FINANCE_TOOLS): string {
  const available = new Set(tools);
  const sections = [BASE_SECTION];
  if (available.has(BASELINE_TOOL)) sections.push(BASELINE_SECTION);
  if (LIABILITY_TOOLS.some((name) => available.has(name))) sections.push(LIABILITY_SECTION);
  sections.push(STYLE_SECTION);
  return sections.join('\n\n');
}

/** System prompt template for the manifest as loaded. */
export const SYSTEM_PROMPT_TEMPLATE = buildSystemPromptTemplate();

/** `YYYY-MM-DD` in UTC — the same rendering the finance tools use for dates. */
export function toDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Substitute every `{{today}}` placeholder. Pure; tested. */
export function injectToday(template: string, today: string): string {
  return template.split('{{today}}').join(today);
}

export interface FinanceAdvisorOptions {
  env: NodeJS.ProcessEnv;
  /** The run's clock — the same one the tool context carries. */
  now: Date;
}

export function createFinanceAdvisor(opts: FinanceAdvisorOptions): AgentDefinition {
  return {
    id: 'finance-advisor',
    name: 'Finance Advisor',
    systemPrompt: injectToday(SYSTEM_PROMPT_TEMPLATE, toDateString(opts.now)),
    tools: FINANCE_TOOLS,
    provider: providerFromEnv(opts.env),
    maxTurns: 12,
  };
}

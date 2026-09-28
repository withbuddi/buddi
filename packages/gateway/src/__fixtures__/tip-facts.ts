/** Facts for tests: a settled installation where nothing applies, with `over` on top. */
import type { Facts } from '../tips/facts.js';

export function facts(over: Partial<Facts> = {}): Facts {
  return {
    daysSinceInstall: 30,
    firstRun: false,
    agents: 2,
    agentIds: new Set(['concierge', 'planner']),
    groups: 0,
    plugins: new Set(['browser', 'email', 'speech']),
    mailboxSet: false,
    mailAgent: false,
    speechInstalled: true,
    voiceUsed: true,
    missions: 1,
    telegramPaired: false,
    browserUsed: true,
    toolsUsed: new Set(['browser.act']),
    pagesVisited: new Set(),
    ...over,
  };
}

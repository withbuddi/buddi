// @buddi/gateway — surface adapters. The CLI lives in ./cli.ts (bin: buddi).
export * from './agents/catalog.js';
export * from './agents/finance-advisor.js';
export * from './telegram/api.js';
export * from './telegram/surface.js';
export * from './telegram/approvals.js';
export * from './telegram/notify.js';
export * from './telegram/pairing.js';
export * from './bootstrap.js';
export * from './db-ready.js';
export * from './missions/execute.js';
export * from './missions/recap.js';
export * from './missions/reminders.js';
export { startTelegram, describePaired } from './telegram/main.js';

// Entry points, named for the one global binary (@buddi/cli) that calls them.
// The binary dispatches; the behaviour stays here, where it already lived.
export { main as runChatCli, parseArgs as parseChatArgs } from './cli.js';
export { main as runMissionsCli, parseMissionsArgs } from './missions-cli.js';
export { main as runRemindersCli, parseRemindersArgs } from './reminders-cli.js';
export { main as runServe } from './serve.js';

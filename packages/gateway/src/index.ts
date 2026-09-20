// @buddi/gateway — surface adapters. The CLI lives in ./cli.ts (bin: buddi).
export * from './agents/catalog.js';
export * from './agents/roles.js';
export * from './agents/migrate.js';
export * from './telegram/api.js';
export * from './telegram/surface.js';
export * from './telegram/approvals.js';
export * from './telegram/notify.js';
export * from './telegram/pairing.js';
export * from './bootstrap.js';
export * from './db-ready.js';
export * from './missions/execute.js';
export * from './missions/defaults.js';
export * from './missions/recap.js';
export * from './missions/reminders.js';
export * from './web/index.js';
export { startTelegram, describePaired } from './telegram/main.js';

// The one outbound HTTP transport (packages/runtime/src/transport.ts), re-exported
// because the CLI depends on the gateway and not on the runtime — and every
// outbound call in this repo has to be able to reach it. `scripts/check-boundaries.mjs`
// enforces that nothing goes out through the global `fetch` instead.
export {
  createHttpTransport,
  defaultHttpTransport,
  TransportError,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from '@buddi/runtime';

// Entry points, named for the one global binary (@buddi/cli) that calls them.
// The binary dispatches; the behaviour stays here, where it already lived.
export { main as runChatCli, parseArgs as parseChatArgs } from './cli.js';
export { main as runAgentsCli, parseAgentsArgs } from './agents-cli.js';
export { main as runMissionsCli, parseMissionsArgs } from './missions-cli.js';
export { main as runRemindersCli, parseRemindersArgs } from './reminders-cli.js';
export { main as runNudgesCli, parseNudgesArgs } from './nudges-cli.js';
export { main as runPluginsCli, parsePluginsArgs } from './plugins-cli.js';
export * from './plugins/index.js';
export { main as runServe } from './serve.js';

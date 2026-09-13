// @buddi/gateway — surface adapters. The CLI lives in ./cli.ts (bin: buddi).
export * from './agents/finance-advisor.js';
export * from './telegram/api.js';
export * from './telegram/surface.js';
export * from './telegram/notify.js';
export * from './bootstrap.js';
export * from './missions/execute.js';
export * from './missions/recap.js';
export { startTelegram, describePaired } from './telegram/main.js';

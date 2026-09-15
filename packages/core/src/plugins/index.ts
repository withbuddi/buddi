/**
 * Plugin installation — the contract, the record, and the summary.
 *
 * Core owns all three and loads none of it: importing an installed plugin's
 * entry point is the gateway's, at the composition root. See `types.ts`.
 */
export * from './types.js';
export * from './record.js';
export * from './contribution.js';

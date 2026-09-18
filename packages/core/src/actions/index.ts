/**
 * Actions, approvals and the effect ledger — the authorization boundary.
 *
 * The whole contract in four calls:
 *
 *   createAction      an immutable action + a pending approval, atomically
 *   decideApproval    pending -> approved | rejected, once, from the owner
 *   executeApproved   the only path that runs a gated tool, claiming atomically
 *   listPendingActions  what the owner still has to decide
 */
export * from './types.js';
export * from './store.js';
export * from './approvals.js';
export * from './execute.js';
export * from './jobs.js';
export * from './effect.js';

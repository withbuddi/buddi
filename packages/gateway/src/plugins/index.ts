/**
 * Installing a plugin, in the order it happens.
 *
 * `spec` turns what the owner typed into a source; `stage` fetches it without
 * importing it; `approve` is the two approvals, the first of which is the
 * first time the plugin's code runs; `update` is the same thing with a version
 * comparison in front; `load` is what happens on every start afterwards; and
 * `hash` is how doctor says, later, that what is on disk is no longer what was
 * approved.
 *
 * Everything the gateway's web routes and the CLI need is re-exported here, so
 * neither has to know which file a function lives in.
 */
export * from './refusals.js';
export * from './tree.js';
export * from './spec.js';
export * from './npm.js';
export * from './claims.js';
export * from './paths.js';
export * from './hash.js';
export * from './stage.js';
export * from './approve.js';
export * from './update.js';
export * from './load.js';
export * from './install.js';
export * from './uninstall.js';
export * from './provenance.js';

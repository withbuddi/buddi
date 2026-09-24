/**
 * The mail screens, as data (`docs/specs/plugin-pages.md`).
 *
 * The Mail place and Settings → Email used to be compiled into the dashboard
 * by name — `Mail.tsx`, `Email.tsx`, a rail entry, a settings section and a
 * dozen `/api/email/*` routes. They are now two page descriptors, a handful of
 * read-only queries and the `ownerOnly` tools those pages write through, all
 * of them contributed by this plugin and none of them known to `packages/web`.
 *
 * This module is the seam: the manifest asks it for the queries, the tools and
 * the pages, and everything the browser draws comes from here.
 */
import type { PageDescriptor, PageQuery, ToolDefinition } from '@buddi/core/plugin';
import { createAddAccountTool, createRemoveAccountTool, type AccountToolOptions } from './accounts.js';
import {
  createAddRuleTool,
  createRevokePoliciesTool,
} from './policies-tools.js';
import { createDiscardDraftTool, createSaveDraftTool } from './drafts-tools.js';
import { emailPageDescriptors } from './descriptors.js';
import { emailPageQueries } from './queries.js';

export * from './accounts.js';
export * from './descriptors.js';
export * from './drafts-tools.js';
export * from './format.js';
export * from './policies-tools.js';
export * from './queries.js';

/** Everything the two pages write through, and nothing a model may see. */
export function emailPageTools(opts: AccountToolOptions): ToolDefinition<never, unknown>[] {
  return [
    createAddAccountTool(opts),
    createRemoveAccountTool(opts),
    createAddRuleTool(),
    createRevokePoliciesTool(),
    createSaveDraftTool(),
    createDiscardDraftTool(),
  ] as unknown as ToolDefinition<never, unknown>[];
}

/** Every read the two pages make. */
export function emailQueries(): PageQuery[] {
  return emailPageQueries();
}

/** The two screens: the Mail place, and the Email settings tab. */
export function emailPages(): PageDescriptor[] {
  return emailPageDescriptors;
}

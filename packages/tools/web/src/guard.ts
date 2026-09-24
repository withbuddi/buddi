/**
 * What this plugin is allowed to dial, and — more importantly — what it is not.
 *
 * The rules, and why they are what they are, live in core now: the URL half
 * (`checkUrl`, the address blocks, the schemes and ports) in
 * `@buddi/core/plugin`, and the half that resolves (`guardedLookup`, handed to
 * the socket so the address approved is the address dialled) inside
 * `ctx.buddi.http`, where every plugin's requests get it
 * (docs/specs/plugin-host-api.md §4.2; the reasoning is at the top of core's
 * `host/http.ts`). Re-exported unchanged: every importer of this file, and of
 * `@buddi/tool-web`, keeps working.
 */
export {
  ALLOWED_PORTS,
  ALLOWED_SCHEMES,
  BlockedError,
  DEFAULT_POLICY,
  blockedAddress,
  blockedV4,
  blockedV6,
  checkUrl,
  isBlockedHostname,
  type AddressPolicy,
  type BlockReason,
  type CheckedUrl,
} from '@buddi/core/plugin';

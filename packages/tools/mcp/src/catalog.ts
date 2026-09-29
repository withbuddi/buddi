/**
 * The "Connect a service" cards (docs/connections.md): services with an
 * official remote MCP server, as data. Adding one is adding a row.
 *
 * `verified: true` means the address was probed on the date in the row's
 * comment: an `initialize` answered with the MCP authorization challenge, and
 * the protected-resource and authorization-server metadata were read (GETs).
 * `clientIdRequired` means the service's authorization server offers no
 * dynamic registration, so the owner creates a client id first (spec §2's
 * escape hatch). `auth` says which way of signing in the screen offers first:
 * `token` for a service where a personal token is the usual way (the owner
 * creates one on `tokenPage`), `oauth` for its own sign-in page. A card is only a filled-in address: the same review follows
 * whatever the server turns out to bring.
 */
export interface CatalogCard {
  /** Stable, lower case: also the slug the review suggests. */
  id: string;
  name: string;
  /** One line under the name. */
  blurb: string;
  /** The server's Streamable HTTP address. */
  url: string;
  verified: boolean;
  /** No dynamic registration: the owner brings a client id from the service's developer settings. */
  clientIdRequired?: boolean;
  /** How the sign-in step opens, and where a token is made. */
  auth?: {
    recommended: 'token' | 'oauth';
    /** The service's page for creating a token. */
    tokenPage?: string;
    /** One sentence under the token field. */
    tokenHint?: string;
  };
}

export const CATALOG: readonly CatalogCard[] = [
  // Verified 2026-09-28: 401 with resource metadata; the authorization server
  // (github.com/login/oauth) publishes no registration endpoint. Re-checked
  // 2026-09-29; the server takes a personal access token as `Authorization: Bearer`.
  {
    id: 'github', name: 'GitHub', blurb: 'Repositories, issues and pull requests.', url: 'https://api.githubcopilot.com/mcp/', verified: true, clientIdRequired: true,
    auth: {
      recommended: 'token',
      tokenPage: 'https://github.com/settings/personal-access-tokens/new',
      tokenHint: 'A fine-grained token with the repositories you want buddi to see. Read-only is fine to start.',
    },
  },
  // Verified 2026-09-28: 401 with resource metadata; registration at mcp.notion.com/register.
  { id: 'notion', name: 'Notion', blurb: 'Pages and databases in your workspace.', url: 'https://mcp.notion.com/mcp', verified: true, auth: { recommended: 'oauth' } },
  // Verified 2026-09-28: 401 with resource metadata; registration at mcp.linear.app/register.
  { id: 'linear', name: 'Linear', blurb: 'Issues, projects and cycles.', url: 'https://mcp.linear.app/mcp', verified: true, auth: { recommended: 'oauth' } },
  // Verified 2026-09-28: 401 with resource metadata; registration at mcp.sentry.dev/oauth/register.
  { id: 'sentry', name: 'Sentry', blurb: 'Errors and performance issues.', url: 'https://mcp.sentry.dev/mcp', verified: true, auth: { recommended: 'oauth' } },
  // Verified 2026-09-28: 401 without resource metadata (the origin's
  // authorization-server metadata answers); registration at mcp.atlassian.com/v1/register.
  { id: 'atlassian', name: 'Atlassian', blurb: 'Jira issues and Confluence pages.', url: 'https://mcp.atlassian.com/v1/mcp', verified: true, auth: { recommended: 'oauth' } },
  // Verified 2026-09-28: 401 with resource metadata; registration at access.stripe.com/mcp/oauth2/register.
  { id: 'stripe', name: 'Stripe', blurb: 'Customers, payments and invoices.', url: 'https://mcp.stripe.com', verified: true, auth: { recommended: 'oauth' } },
];

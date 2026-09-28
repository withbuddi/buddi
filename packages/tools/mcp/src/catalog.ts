/**
 * The "Connect a service" cards (docs/connections.md): services with an
 * official remote MCP server, as data. Adding one is adding a row.
 *
 * `verified: true` means the address was probed on the date in the row's
 * comment: an `initialize` answered with the MCP authorization challenge, and
 * the protected-resource and authorization-server metadata were read (GETs).
 * `clientIdRequired` means the service's authorization server offers no
 * dynamic registration, so the owner creates a client id first (spec §2's
 * escape hatch). A card is only a filled-in address: the same review follows
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
}

export const CATALOG: readonly CatalogCard[] = [
  // Verified 2026-09-28: 401 with resource metadata; the authorization server
  // (github.com/login/oauth) publishes no registration endpoint.
  { id: 'github', name: 'GitHub', blurb: 'Repositories, issues and pull requests.', url: 'https://api.githubcopilot.com/mcp/', verified: true, clientIdRequired: true },
  // Verified 2026-09-28: 401 with resource metadata; registration at mcp.notion.com/register.
  { id: 'notion', name: 'Notion', blurb: 'Pages and databases in your workspace.', url: 'https://mcp.notion.com/mcp', verified: true },
  // Verified 2026-09-28: 401 with resource metadata; registration at mcp.linear.app/register.
  { id: 'linear', name: 'Linear', blurb: 'Issues, projects and cycles.', url: 'https://mcp.linear.app/mcp', verified: true },
  // Verified 2026-09-28: 401 with resource metadata; registration at mcp.sentry.dev/oauth/register.
  { id: 'sentry', name: 'Sentry', blurb: 'Errors and performance issues.', url: 'https://mcp.sentry.dev/mcp', verified: true },
  // Verified 2026-09-28: 401 without resource metadata (the origin's
  // authorization-server metadata answers); registration at mcp.atlassian.com/v1/register.
  { id: 'atlassian', name: 'Atlassian', blurb: 'Jira issues and Confluence pages.', url: 'https://mcp.atlassian.com/v1/mcp', verified: true },
  // Verified 2026-09-28: 401 with resource metadata; registration at access.stripe.com/mcp/oauth2/register.
  { id: 'stripe', name: 'Stripe', blurb: 'Customers, payments and invoices.', url: 'https://mcp.stripe.com', verified: true },
];

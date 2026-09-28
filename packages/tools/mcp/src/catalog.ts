/**
 * The "Connect a service" cards (docs/connections.md): services with an
 * official remote MCP server, as data. Adding one is adding a row.
 *
 * `verified: false` means the address is the one the service published as far
 * as buddi's authors knew when the row was written, and nobody has connected
 * to it from a released buddi since. A card is only a filled-in address: the
 * same review follows whatever the server turns out to bring.
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
}

export const CATALOG: readonly CatalogCard[] = [
  { id: 'github', name: 'GitHub', blurb: 'Repositories, issues and pull requests.', url: 'https://api.githubcopilot.com/mcp/', verified: false },
  { id: 'notion', name: 'Notion', blurb: 'Pages and databases in your workspace.', url: 'https://mcp.notion.com/mcp', verified: false },
  { id: 'linear', name: 'Linear', blurb: 'Issues, projects and cycles.', url: 'https://mcp.linear.app/mcp', verified: false },
  { id: 'sentry', name: 'Sentry', blurb: 'Errors and performance issues.', url: 'https://mcp.sentry.dev/mcp', verified: false },
  { id: 'atlassian', name: 'Atlassian', blurb: 'Jira issues and Confluence pages.', url: 'https://mcp.atlassian.com/v1/mcp', verified: false },
  { id: 'stripe', name: 'Stripe', blurb: 'Customers, payments and invoices.', url: 'https://mcp.stripe.com', verified: false },
];

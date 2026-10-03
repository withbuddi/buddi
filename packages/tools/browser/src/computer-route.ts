import type { RouteCommand, RouteHealth, RoutePage, RouteProvider } from '@buddi/core/plugin';
import type { ComputerDriver } from './computer.js';
import type { BrowserCommand, BrowserDriver } from './types.js';

/**
 * Core's computer control as a route provider (docs/browser.md, "Routes").
 *
 * The owner's apps are a route a plugin may provide; core's own computer
 * control is driven through exactly that interface, one provider per page,
 * so moving it into `@withbuddi/plugin-computer` is a move rather than a
 * rewrite. The driver extras the computer has and a generic provider does not
 * (take-over, native typing) are passed through for `RouteProviderDriver`.
 */
export class ComputerRouteProvider implements RouteProvider {
  readonly kind = 'apps' as const;
  readonly label = 'your apps';
  readonly platforms = ['darwin'] as const;
  readonly exclusive = true;
  constructor(readonly driver: ComputerDriver, readonly healthOf: () => RouteHealth) {}
  health(): RouteHealth { return this.healthOf(); }
  async do(_session: string, command: RouteCommand): Promise<void> {
    await this.driver.start();
    await this.driver.perform(command as BrowserCommand);
  }
  async look(_session: string): Promise<RoutePage> {
    const observation = await this.driver.observe();
    const picture = await this.driver.screenshot();
    return { ...observation, ...(picture ? { screenshot: picture } : {}) };
  }
  async release(_session: string): Promise<void> { await this.driver.close(); }
  /* The extras, for the computer route only. */
  get preservesWindows(): boolean { return (this.driver as Partial<BrowserDriver>).preservesWindows ?? true; }
  get supportsHand(): boolean | undefined { return (this.driver as Partial<BrowserDriver>).supportsHand; }
  get handMessage(): string | undefined { return (this.driver as Partial<BrowserDriver>).handMessage; }
  takeover(): Promise<void> { return this.driver.takeover(); }
  resume(): void { this.driver.resume(); }
  focusedBundleId(): Promise<string | undefined> { return this.driver.focusedBundleId(); }
  nativeType(value: string): Promise<void> { return this.driver.nativeType(value); }
}

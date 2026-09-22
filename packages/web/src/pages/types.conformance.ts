/**
 * The two copies of the page contract, held together by the compiler.
 *
 * `types.ts` is a hand-written mirror of `packages/core/src/pages.ts`, which is
 * the honest price of not pulling pg and zod into a browser bundle. What it
 * must not be is a copy that drifts: the first version of this pair already
 * typed a list's row actions as plain `ToolRef`s where core required `args`,
 * so the browser would have accepted a descriptor core refuses.
 *
 * So the drift is a type error. This module imports core's declarations
 * **as types only** — nothing from `@buddi/core` survives into the bundle, and
 * this file has no runtime side effects — and asserts each pair mutually
 * assignable. A field added on one side and not the other fails
 * `pnpm -r typecheck`, naming the type.
 */
import type {
  Component as CoreComponent,
  ComponentCommon as CoreComponentCommon,
  Field as CoreField,
  GroupBy as CoreGroupBy,
  ListItem as CoreListItem,
  PageDescriptor as CorePageDescriptor,
  ParamRef as CoreParamRef,
  QueryRef as CoreQueryRef,
  RouteRef as CoreRouteRef,
  Selection as CoreSelection,
  ToolRef as CoreToolRef,
  Visibility as CoreVisibility,
} from '@buddi/core';
import type {
  Component,
  ComponentCommon,
  Field,
  GroupBy,
  ListItem,
  ParamRef,
  PluginPageDescriptor,
  QueryRef,
  RouteRef,
  Selection,
  ToolRef,
  Visibility,
} from './types';

/** `true` only when each side accepts the other's values. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** One line per type in the contract. A `never` here is the drift. */
interface Conformance {
  visibility: Mutual<CoreVisibility, Visibility>;
  paramRef: Mutual<CoreParamRef, ParamRef>;
  queryRef: Mutual<CoreQueryRef, QueryRef>;
  routeRef: Mutual<CoreRouteRef, RouteRef>;
  toolRef: Mutual<CoreToolRef, ToolRef>;
  listItem: Mutual<CoreListItem, ListItem>;
  selection: Mutual<CoreSelection, Selection>;
  groupBy: Mutual<CoreGroupBy, GroupBy>;
  field: Mutual<CoreField, Field>;
  componentCommon: Mutual<CoreComponentCommon, ComponentCommon>;
  component: Mutual<CoreComponent, Component>;
  /** The served descriptor is core's, plus the plugin the route carries. */
  descriptor: Mutual<CorePageDescriptor & { plugin: string }, PluginPageDescriptor>;
}

export const CONTRACTS_AGREE: Conformance = {
  visibility: true,
  paramRef: true,
  queryRef: true,
  routeRef: true,
  toolRef: true,
  listItem: true,
  selection: true,
  groupBy: true,
  field: true,
  componentCommon: true,
  component: true,
  descriptor: true,
};

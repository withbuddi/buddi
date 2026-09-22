/**
 * The two copies of the page contract, held together by the compiler.
 *
 * `types.ts` is a hand-written mirror of `packages/core/src/pages.ts`, which is
 * the honest price of not pulling pg and zod into a browser bundle. What it
 * must not be is a copy that drifts: the first version of this pair already
 * typed a list's row actions as plain `ToolRef`s where core required `args`,
 * so the browser would have accepted a descriptor core refuses.
 *
 * So the drift is a type error. This module imports core's declarations **as
 * types only** — nothing from `@buddi/core` survives into the bundle, and this
 * file has no runtime side effects — and compares them *by their keys*, in
 * both directions. Mutual assignability alone is not enough: a field one side
 * declares optional and the other does not declare at all passes it, which is
 * precisely the drift a page finds out about at 7 a.m. `EXTRA_OPTIONAL_FAILS`
 * below is the checker checking itself.
 */
import type {
  Component as CoreComponent,
  ComponentCommon as CoreComponentCommon,
  Field as CoreField,
  GroupBy as CoreGroupBy,
  OptionsFrom as CoreOptionsFrom,
  ListItem as CoreListItem,
  PageDescriptor as CorePageDescriptor,
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
  OptionsFrom,
  PluginPageDescriptor,
  QueryRef,
  RouteRef,
  Selection,
  ToolRef,
  Visibility,
} from './types';

/*
 * These answer `true` or `false`, never `never`: `never extends true` is
 * *true* (never is assignable to everything), so a checker written with
 * `never` as its "no" answers yes to every question it was built to refuse.
 * That is not a hypothetical — it is what the first version of this file did.
 */

/** Both ways round, so neither side may be the looser one. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The same keys, optional ones included — this is what assignability misses. */
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;

/** Assignable both ways **and** exactly the same field names. */
type Exact<A, B> = SameKeys<A, B> extends true ? (Mutual<A, B> extends true ? true : never) : never;

/** Every `kind` in a component union. */
type Kinds<T> = T extends { kind: infer K } ? K : never;

/**
 * A discriminated union, arm by arm: the same set of `kind`s, and for each of
 * them the same fields. Comparing the unions whole would only ever compare
 * the keys they have in common, which is none of them.
 */
type ExactUnion<A extends { kind: string }, B extends { kind: string }> = SameKeys<
  Record<Kinds<A> & string, true>,
  Record<Kinds<B> & string, true>
> extends true
  ? { [K in Kinds<A> & string]: Exact<Extract<A, { kind: K }>, Extract<B, { kind: K }>> }
  : never;

/** One line per type in the contract. A `never` here is the drift. */
interface Conformance {
  visibility: Exact<CoreVisibility, Visibility>;
  queryRef: Exact<CoreQueryRef, QueryRef>;
  routeRef: Exact<CoreRouteRef, RouteRef>;
  toolRef: Exact<CoreToolRef, ToolRef>;
  listItem: Exact<CoreListItem, ListItem>;
  selection: Exact<CoreSelection, Selection>;
  groupBy: Exact<CoreGroupBy, GroupBy>;
  field: Exact<CoreField, Field>;
  optionsFrom: Exact<CoreOptionsFrom, OptionsFrom>;
  componentCommon: Exact<CoreComponentCommon, ComponentCommon>;
  /** The served descriptor is core's, plus the plugin the route carries. */
  descriptor: Exact<CorePageDescriptor & { plugin: string }, PluginPageDescriptor>;
}

export const CONTRACTS_AGREE: Conformance = {
  visibility: true,
  queryRef: true,
  routeRef: true,
  toolRef: true,
  listItem: true,
  selection: true,
  groupBy: true,
  field: true,
  optionsFrom: true,
  componentCommon: true,
  descriptor: true,
};

/** And the component union, one arm at a time. */
export const COMPONENTS_AGREE: ExactUnion<CoreComponent, Component> = {
  section: true,
  notice: true,
  link: true,
  stats: true,
  list: true,
  table: true,
  detail: true,
  form: true,
  search: true,
  'list-detail': true,
  repeat: true,
  expand: true,
  button: true,
  approval: true,
  artifact: true,
  editor: true,
};

/* ------------------------------------------------------------------ *
 * The checker, checked
 *
 * If `Exact` ever stopped noticing an extra optional field, every line above
 * would keep passing and the contract would drift in silence. These two say
 * what it must refuse, and they are compile-time statements: the assignment
 * itself fails if `Exact` starts answering `true`.
 * ------------------------------------------------------------------ */

interface Probe {
  a: string;
  b?: number;
}
interface ProbeWithExtra {
  a: string;
  b?: number;
  /** Declared on one side only — the drift that assignability lets through. */
  c?: string;
}
interface ProbeMissing {
  a: string;
}

/** Wrapped in a tuple, so `never` is a type here and not an empty union. */
type IsNever<T> = [T] extends [never] ? true : false;

/** An extra optional field must not pass, in either direction. */
export const EXTRA_OPTIONAL_FAILS: IsNever<Exact<Probe, ProbeWithExtra>> = true;
export const EXTRA_OPTIONAL_FAILS_REVERSED: IsNever<Exact<ProbeWithExtra, Probe>> = true;
/** A missing optional field is the same drift seen from the other side. */
export const MISSING_OPTIONAL_FAILS: IsNever<Exact<Probe, ProbeMissing>> = true;
/** A differing *kind* in a union must not pass either. */
export const MISSING_ARM_FAILS: IsNever<
  ExactUnion<{ kind: 'a'; x: string } | { kind: 'b' }, { kind: 'a'; x: string }>
> = true;
/** And the identical pair must still pass, or the checker says nothing at all. */
export const IDENTICAL_PASSES: Exact<Probe, Probe> = true;

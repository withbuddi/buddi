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
 * file has no runtime side effects beyond two small string tables — and
 * compares them *by their keys*, in both directions, one named type at a time.
 * Mutual assignability alone is not enough: a field one side declares optional
 * and the other does not declare at all passes it, which is precisely the
 * drift a page finds out about at 7 a.m. `EXTRA_OPTIONAL_FAILS` below is the
 * checker checking itself.
 *
 * Every named type is checked *directly*, so a nested one — a `ListItem`
 * inside a list, an `OptionsFrom` inside a field — is compared by keys on its
 * own line rather than only through the arm that holds it. `types.conformance.test.ts`
 * reads both source files and fails when either declares a type this file does
 * not mention, so a new type cannot be added without a decision about it.
 */
import type {
  ArgRef as CoreArgRef,
  BulkAction as CoreBulkAction,
  Component as CoreComponent,
  ComponentCommon as CoreComponentCommon,
  Field as CoreField,
  GroupBy as CoreGroupBy,
  ListItem as CoreListItem,
  OptionsFrom as CoreOptionsFrom,
  PageDescriptor as CorePageDescriptor,
  PageIcon as CorePageIcon,
  ParamRef as CoreParamRef,
  PillRef as CorePillRef,
  QueryRef as CoreQueryRef,
  RouteRef as CoreRouteRef,
  RowAction as CoreRowAction,
  SectionAction as CoreSectionAction,
  Selection as CoreSelection,
  ToolRef as CoreToolRef,
  Visibility as CoreVisibility,
  WorkspaceFiles as CoreWorkspaceFiles,
} from '@buddi/core';
import type {
  ArgRef,
  BulkAction,
  Component,
  ComponentCommon,
  Field,
  GroupBy,
  ListComponent,
  ListItem,
  OptionsFrom,
  PageIcon,
  ParamRef,
  PillRef,
  PluginPageDescriptor,
  QueryRef,
  RouteRef,
  RowAction,
  SectionAction,
  Selection,
  ToolRef,
  Visibility,
  WorkspaceFiles,
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

/** For a union of literals or of shapes with no keys in common. */
type Same<A, B> = Mutual<A, B> extends true ? true : never;

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

/** One line per named type in the contract. A `never` here is the drift. */
interface Conformance {
  pageIcon: Same<CorePageIcon, PageIcon>;
  visibility: Exact<CoreVisibility, Visibility>;
  paramRef: Same<CoreParamRef, ParamRef>;
  argRef: Same<CoreArgRef, ArgRef>;
  queryRef: Exact<CoreQueryRef, QueryRef>;
  /** A union of two shapes with no key in common, so keys cannot be compared. */
  routeRef: Same<CoreRouteRef, RouteRef>;
  toolRef: Exact<CoreToolRef, ToolRef>;
  rowAction: Exact<CoreRowAction, RowAction>;
  bulkAction: Exact<CoreBulkAction, BulkAction>;
  pillRef: Exact<CorePillRef, PillRef>;
  listItem: Exact<CoreListItem, ListItem>;
  selection: Exact<CoreSelection, Selection>;
  groupBy: Exact<CoreGroupBy, GroupBy>;
  optionsFrom: Exact<CoreOptionsFrom, OptionsFrom>;
  field: Exact<CoreField, Field>;
  componentCommon: Exact<CoreComponentCommon, ComponentCommon>;
  sectionAction: Same<CoreSectionAction, SectionAction>;
  /** The web's `ListComponent` is core's list arm, named so it can be reused. */
  listComponent: Exact<Extract<CoreComponent, { kind: 'list' }>, ListComponent>;
  /** The served descriptor is core's, plus the plugin the route carries. */
  descriptor: Exact<CorePageDescriptor & { plugin: string }, PluginPageDescriptor>;
  workspaceFiles: Exact<CoreWorkspaceFiles, WorkspaceFiles>;
}

export const CONTRACTS_AGREE: Conformance = {
  pageIcon: true,
  visibility: true,
  paramRef: true,
  argRef: true,
  queryRef: true,
  routeRef: true,
  toolRef: true,
  rowAction: true,
  bulkAction: true,
  pillRef: true,
  listItem: true,
  selection: true,
  groupBy: true,
  optionsFrom: true,
  field: true,
  componentCommon: true,
  sectionAction: true,
  listComponent: true,
  descriptor: true,
  workspaceFiles: true,
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
 * The tables the test reads
 *
 * A type declared in one file and missing from the other is the drift this
 * pair exists to catch, so the *names* are enumerated here and checked
 * against the sources. Adding a type to either file without a line here is a
 * failing test, which is the point: the decision is "mirrored, and checked"
 * or "deliberately not", never "nobody noticed".
 * ------------------------------------------------------------------ */

/** Core's named types that are mirrored and compared above, by core's name. */
export const CHECKED_TYPES = [
  'PageIcon',
  'Visibility',
  'ParamRef',
  'ArgRef',
  'QueryRef',
  'RouteRef',
  'ToolRef',
  'RowAction',
  'BulkAction',
  'PillRef',
  'ListItem',
  'Selection',
  'GroupBy',
  'OptionsFrom',
  'Field',
  'ComponentCommon',
  'SectionAction',
  'Component',
  'PageDescriptor',
  'WorkspaceFiles',
] as const;

/** Core's named types that are deliberately *not* mirrored, and why. */
export const NOT_MIRRORED: Record<string, string> = {
  PageQuery: 'a function and two zod schemas; it never leaves the server',
  PageContributions: "the registry's own result, not part of the descriptor",
  PageFile: 'bytes a query answers with; the gateway streams them, the page only links to the route',
};

/** The web's own names, and what they are, for the test's other direction. */
export const WEB_TYPES: Record<string, string> = {
  PluginPageDescriptor: 'PageDescriptor',
  ListComponent: 'Component',
  PageActResult: 'the act route’s reply, which core does not declare',
  PluginWorkspaceFiles: 'WorkspaceFiles, plus the plugin the route carries',
};

/* ------------------------------------------------------------------ *
 * The checker, checked
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
/**
 * Nor an arm that differs *inside*, which is the recursive half: the union
 * check answers per arm, so the refusal shows up as that arm's own `never`.
 */
export const DIFFERING_ARM_FAILS: IsNever<
  ExactUnion<{ kind: 'a'; x: string; y?: number }, { kind: 'a'; x: string }>['a']
> = true;
/** And the identical pair must still pass, or the checker says nothing at all. */
export const IDENTICAL_PASSES: Exact<Probe, Probe> = true;

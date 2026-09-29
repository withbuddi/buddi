/**
 * The canvas contract's newest types, held to core's by the compiler — the
 * pattern of `pages/types.conformance.ts`, for the pieces a drift would break
 * silently: the renderer names, the pinned tile glyphs and the tiles map.
 * Types only: nothing of `@buddi/core` reaches the bundle.
 */
import type { RendererName as CoreRendererName, TileIcon as CoreTileIcon, TileLink as CoreTileLink, TilesMap as CoreTilesMap } from '@buddi/core';
import type { RendererName, TileIcon, TileLink, TilesMap } from './types';

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
type Exact<A, B> = SameKeys<A, B> extends true ? (Mutual<A, B> extends true ? true : never) : never;
type Same<A, B> = Mutual<A, B> extends true ? true : never;

interface Conformance {
  rendererName: Same<CoreRendererName, RendererName>;
  tileIcon: Same<CoreTileIcon, TileIcon>;
  tileLink: Exact<CoreTileLink, TileLink>;
  tilesMap: Exact<CoreTilesMap, TilesMap>;
}

export const VIEW_CONTRACTS_AGREE: Conformance = {
  rendererName: true,
  tileIcon: true,
  tileLink: true,
  tilesMap: true,
};

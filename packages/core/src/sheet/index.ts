/**
 * The sheet engine (docs/files.md, "Composed spreadsheets"): one module,
 * browser-safe like `office-files`, used by the server (the fill a composed
 * workbook gets, its render summary) and by the page (the xlsx preview).
 * Reached through the `@buddi/core/sheet` subpath so the dashboard bundle
 * loads nothing else from core; the formula library is loaded only when a
 * formula needs computing.
 *
 *  - `readWorkbook`: cells, formulas, cached values and the look of each sheet.
 *  - `readStyles`: styles.xml and the theme's colours, resolved per cell format.
 *  - `evaluate` / `sheetEngine`: values for formulas the file has none for.
 *  - `formatCell`: a value as its number format shows it.
 *  - `conditionalStyles`: what conditional rules change, per cell.
 *  - `fillCachedValues`: a composed workbook with its values written in.
 */
export * from './read.js';
export * from './refs.js';
export * from './styles.js';
export * from './format.js';
export * from './evaluate.js';
export * from './conditional.js';
export * from './fill.js';

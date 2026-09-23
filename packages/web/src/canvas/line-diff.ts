/**
 * Two texts as a unified diff of their lines, for `DiffLines` to draw.
 *
 * The diffs the canvas usually draws arrive already made (git's, or a write
 * tool's). A learned skill's next version is compared on the page instead,
 * against the text the owner may still be correcting, so the diff is made
 * here: a longest-common-subsequence over lines, every line shown (a skill
 * is short), unchanged lines prefixed with a space so `DiffLines` reads a
 * markdown list item as context rather than as a removal.
 */

/** Longest the quadratic table may be before the diff gives up and shows both texts whole. */
const MAX_CELLS = 2_000_000;

export function lineDiff(before: string, after: string): string {
  const a = before.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const b = after.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  if (before.trim() === after.trim()) return '(no change)';
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join('\n');
  }
  // lcs[i][j]: the common length of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`-${a[i++]}`);
    } else {
      out.push(`+${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join('\n');
}

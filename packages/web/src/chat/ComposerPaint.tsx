/**
 * The composer's paint: the same characters as the textarea, styled without
 * moving one of them (docs/dashboard.md, The composer).
 *
 * The textarea is what is typed into — caret, selection, paste, undo, voice,
 * phone keyboards — and its text is transparent; this layer sits in the same
 * grid cell with the same font, size, padding and wrapping, and draws the
 * text again with live Markdown styling. Nothing here may change a glyph's
 * advance width, or the caret would drift from the letters: bold is a hairline
 * stroke, italic a slant synthesised from the upright face, code a tint and an
 * ink, headings an ink and a stroke, a mention a tint with a spread shadow. No
 * padding, no other face, no other size. Monospace and sizes arrive in the
 * sent message, where the Markdown is rendered for real.
 *
 * The invariant the tests hold it to: the paint's text is the value, character
 * for character (an empty line carries one zero-width space so it keeps its
 * height, exactly as the textarea gives it one).
 */
import type { CSSProperties, ReactNode } from 'react';
import { langName } from './composer-text';

/** Someone the paint draws as a chip: their handle and the accent they wear. */
export interface PaintPerson {
  handle: string;
  accent: { 'data-agent': string; style?: CSSProperties };
}

/** Keeps an empty line one line tall, as the textarea does. */
export const ZWSP = '​';

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)|(@[a-z][a-z0-9-]*)/gi;

function inline(text: string, people: readonly PaintPerson[], keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    const key = `${keyBase}-${k++}`;
    if (m[1]) out.push(<span key={key} className="cv-code"><span className="cv-mark">`</span>{s.slice(1, -1)}<span className="cv-mark">`</span></span>);
    else if (m[2]) out.push(<span key={key} className="cv-b"><span className="cv-mark">**</span>{s.slice(2, -2)}<span className="cv-mark">**</span></span>);
    else if (m[3]) out.push(<span key={key} className="cv-i"><span className="cv-mark">{s[0]}</span>{s.slice(1, -1)}<span className="cv-mark">{s[0]}</span></span>);
    else if (m[4]) {
      const split = s.indexOf('](');
      out.push(<span key={key} className="cv-link-md"><span className="cv-mark">[</span><span className="cv-link">{s.slice(1, split)}</span><span className="cv-mark">{s.slice(split)}</span></span>);
    } else if (m[5]) out.push(<span key={key} className="cv-link">{s}</span>);
    else {
      // A mention glued to a word before it (an email address) is not one.
      const prev = m.index > 0 ? text[m.index - 1]! : ' ';
      const who = /[\s(]/.test(prev) ? people.find((p) => p.handle.toLowerCase() === s.slice(1).toLowerCase()) : undefined;
      out.push(who ? <span key={key} className="cv-chip" {...who.accent}>{s}</span> : s);
    }
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The value, painted line by line. */
export function paint(value: string, people: readonly PaintPerson[]): ReactNode[] {
  const lines = value.split('\n');
  let fence: string | null = null;
  return lines.map((line, i) => {
    const open = /^```(\w*)\s*$/.exec(line);
    if (fence === null && open) {
      fence = open[1] ?? '';
      // A block that never closes is still a block: the owner is typing it.
      const closes = lines.slice(i + 1).some((l) => /^```\s*$/.test(l));
      return (
        <div key={i} className="cv-line" data-code="open" data-unclosed={closes ? undefined : 'true'}>
          <span className="cv-mark">{line}</span>
          {fence ? <span className="cv-lang" aria-hidden="true" data-paint-extra="">{langName(fence)}</span> : null}
        </div>
      );
    }
    if (fence !== null) {
      if (/^```\s*$/.test(line)) {
        fence = null;
        return <div key={i} className="cv-line" data-code="close"><span className="cv-mark">{line}</span></div>;
      }
      return <div key={i} className="cv-line" data-code="body"><span className="cv-code-ink">{line || ZWSP}</span></div>;
    }
    const heading = /^(#{1,3} )(.*)$/.exec(line);
    if (heading) {
      return (
        <div key={i} className="cv-line" data-h={heading[1]!.length - 1}>
          <span className="cv-mark">{heading[1]}</span><span className="cv-h">{inline(heading[2]!, people, String(i))}</span>
        </div>
      );
    }
    const item = /^(\s*)([-*]|\d+\.)( )(.*)$/.exec(line);
    if (item) {
      return (
        <div key={i} className="cv-line">
          {item[1]}<span className="cv-bullet">{item[2]}</span>{item[3]}{inline(item[4]!, people, String(i))}
        </div>
      );
    }
    return <div key={i} className="cv-line">{line ? inline(line, people, String(i)) : ZWSP}</div>;
  });
}

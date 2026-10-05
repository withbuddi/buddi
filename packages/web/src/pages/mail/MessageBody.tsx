/**
 * An email's body, drawn (host API 1.30): the sanitised tree from
 * `sanitize.ts` as React elements, or the plain text with its links, with
 * quoted earlier messages folded behind "··· earlier message" and remote
 * pictures held back behind "Show images" until the owner says so for this
 * sender.
 *
 * Nothing here fetches from anywhere until the owner asks: a remote picture
 * is not an `<img>` at all while it is held back, a `cid:` picture is drawn
 * only from a file already in the library, and a link opens in a new tab
 * with `noopener noreferrer`.
 */
import { createElement, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../../ui';
import {
  MAX_TEXT_CHARS,
  imageSenders,
  linkify,
  rememberImages,
  sanitizeHtml,
  splitQuotes,
  type SafeNode,
} from './sanitize';

/** One attachment as far as the body cares: whether a `cid:` picture can be drawn from it. */
export interface BodyAttachment {
  contentId?: string | null;
  artifactId: string | null;
}

interface Drawing {
  showImages: boolean;
  /** A `cid:` picture's address on this origin, or null when the file is not in the library. */
  cid: (contentId: string) => string | null;
}

/** How deep folds open inside folds before the rest is drawn as it is. */
const MAX_QUOTE_DEPTH = 8;

/** "··· earlier message": a quote, folded until asked. */
function QuoteFold({ children, head }: { children: ReactNode; head?: string | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="pl-mail-quote" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="pl-mail-quote-toggle"
        aria-expanded={open}
        title={open ? 'Hide the earlier message' : 'Show the earlier message'}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">···</span>
        <span className="pl-mail-quote-words">{open ? 'Hide earlier message' : 'earlier message'}</span>
      </button>
      {open ? (
        <div className="pl-mail-quote-body">
          {head ? <p className="pl-mail-quote-head">{head}</p> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

function drawNodes(nodes: SafeNode[], drawing: Drawing, keyPrefix = ''): ReactNode[] {
  return nodes.map((node, index) => drawNode(node, drawing, `${keyPrefix}${index}`));
}

function drawNode(node: SafeNode, drawing: Drawing, key: string): ReactNode {
  switch (node.t) {
    case 'text':
      return node.v;
    case 'quote':
      return <QuoteFold key={key}>{drawNodes(node.kids, drawing, `${key}.`)}</QuoteFold>;
    case 'link':
      return (
        <a
          key={key}
          href={node.href}
          style={node.style as CSSProperties | undefined}
          {...(node.outside ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {drawNodes(node.kids, drawing, `${key}.`)}
        </a>
      );
    case 'img': {
      const style = node.style as CSSProperties | undefined;
      if (node.kind === 'remote') {
        if (!drawing.showImages) {
          return node.alt ? (
            <span key={key} className="pl-mail-img-held">
              {node.alt}
            </span>
          ) : null;
        }
        return <img key={key} src={node.src} alt={node.alt} style={style} referrerPolicy="no-referrer" loading="lazy" />;
      }
      if (node.kind === 'cid') {
        const src = drawing.cid(node.src);
        if (!src) {
          return (
            <span key={key} className="pl-mail-img-held">
              {node.alt || 'Picture in an attachment'}
            </span>
          );
        }
        return <img key={key} src={src} alt={node.alt} style={style} loading="lazy" />;
      }
      return <img key={key} src={node.src} alt={node.alt} style={style} />;
    }
    case 'el':
      return createElement(
        node.tag,
        { key, ...(node.style ? { style: node.style as CSSProperties } : {}), ...(node.attrs ?? {}) },
        ...(node.kids.length > 0 ? drawNodes(node.kids, drawing, `${key}.`) : []),
      );
  }
}

/** A plain body: runs of text with their links, quotes folded, nested quotes folded again when opened. */
function PlainText({ text, depth = 0 }: { text: string; depth?: number }): JSX.Element {
  const parts = depth >= MAX_QUOTE_DEPTH ? [{ t: 'text' as const, v: text }] : splitQuotes(text);
  return (
    <>
      {parts.map((part, index) =>
        part.t === 'text' ? (
          <div key={index} className="pl-mail-text">
            {linkify(part.v).map((run, i) =>
              run.t === 'link' ? (
                <a key={i} href={run.href} target="_blank" rel="noopener noreferrer">
                  {run.v}
                </a>
              ) : (
                <span key={i}>{run.v}</span>
              ),
            )}
          </div>
        ) : (
          <QuoteFold key={index} head={part.head}>
            <PlainText text={part.inner} depth={depth + 1} />
          </QuoteFold>
        ),
      )}
    </>
  );
}

/**
 * The body of one message. `sender` is the address whose pictures the
 * owner's "Show images" is remembered for.
 */
export function MessageBody({
  html,
  text,
  sender,
  attachments,
  cidSrc,
}: {
  html?: string | null | undefined;
  text?: string | null | undefined;
  sender: string;
  attachments?: BodyAttachment[] | undefined;
  /** The address of a library file a `cid:` picture is drawn from. */
  cidSrc: (artifactId: string) => string;
}): JSX.Element | null {
  const safe = useMemo(() => (html ? sanitizeHtml(html) : null), [html]);
  const remembered = useMemo(() => imageSenders().has(sender.trim().toLowerCase()), [sender]);
  const [shown, setShown] = useState<boolean | null>(null);
  const showImages = shown ?? remembered;
  const cid = (contentId: string): string | null => {
    const wanted = contentId.trim().replace(/^<|>$/g, '').toLowerCase();
    const found = (attachments ?? []).find(
      (a) => typeof a.contentId === 'string' && a.contentId.trim().replace(/^<|>$/g, '').toLowerCase() === wanted,
    );
    return found?.artifactId ? cidSrc(found.artifactId) : null;
  };

  if (safe && safe.nodes.length > 0) {
    return (
      <div className="pl-mail-body">
        {safe.remoteImages > 0 ? (
          <div className="pl-mail-images" role="status">
            {showImages ? (
              <>
                <span>Pictures from {sender} are shown.</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    rememberImages(sender, false);
                    setShown(false);
                  }}
                >
                  Hide pictures from this sender
                </Button>
              </>
            ) : (
              <>
                <span>
                  {safe.remoteImages === 1 ? 'One picture is' : `${safe.remoteImages} pictures are`} held back, so the sender cannot see
                  you opened this.
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    rememberImages(sender, true);
                    setShown(true);
                  }}
                >
                  Show images
                </Button>
              </>
            )}
          </div>
        ) : null}
        <div className="pl-mail-html">{drawNodes(safe.nodes, { showImages, cid })}</div>
        {safe.truncated ? <p className="pl-mail-note">Part of this message was too long or too deeply nested to show.</p> : null}
      </div>
    );
  }
  if (typeof text === 'string' && text.trim() !== '') {
    const cut = text.length > MAX_TEXT_CHARS;
    return (
      <div className="pl-mail-body">
        <PlainText text={cut ? text.slice(0, MAX_TEXT_CHARS) : text} />
        {cut ? <p className="pl-mail-note">The rest of this message is too long to show here; it is in your mailbox.</p> : null}
      </div>
    );
  }
  return null;
}

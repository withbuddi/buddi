/**
 * Pairing a phone with the Telegram bot: a code, its square, and watching for
 * the phone to say hello.
 *
 * Shared by the first-run thread (`Meet.tsx`) and Settings → Telegram.
 * Each decides what "the phone arrived" means — first run asks whether any
 * phone is paired, the settings page whether a new one is — and each draws
 * its own words around the square.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type PairingOffer } from '../../api';
import { Button, ButtonLink } from '../../ui';
import { qrSvgDataUrl } from '../meet/qr';

/** The longest anything watches for a phone before offering a fresh code. */
export const PAIRING_WATCH_MS = 10 * 60_000;

/** How often it asks whether the phone has arrived. */
const PAIRING_POLL_MS = 2_000;

export interface TelegramPairing {
  /** The code on show, once asked for. */
  offer: PairingOffer | null;
  /** The link drawn as a QR code; empty when it could not be drawn. */
  square: string | null;
  /** The phone said hello. */
  paired: boolean;
  /** The code stopped being valid, so watching for it stopped too. */
  stale: boolean;
  /** Mint a code (a fresh one when there was one). Rejects with the route's error. */
  ask: () => Promise<void>;
}

/**
 * A pairing code and the watch for its phone.
 *
 * A code expires, and a page left open overnight asking every two seconds
 * whether a dead code was used is a page doing nothing, loudly. The code's
 * own expiry decides, capped at ten minutes, and then `stale` says so.
 */
export function useTelegramPairing(arrived: () => Promise<boolean>, onPaired?: () => void): TelegramPairing {
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [square, setSquare] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const [stale, setStale] = useState(false);
  // Read at each tick rather than depended on: callers pass fresh functions.
  const check = useRef(arrived);
  check.current = arrived;
  const done = useRef(onPaired);
  done.current = onPaired;

  const ask = useCallback(async (): Promise<void> => {
    const pairing = await api.telegramPairing();
    setOffer(pairing);
    setStale(false);
    setPaired(false);
    setSquare(await qrSvgDataUrl(pairing.link).catch(() => ''));
  }, []);

  useEffect(() => {
    if (!offer || paired || stale) return undefined;
    let cancelled = false;
    const until = Math.min(Date.parse(offer.expiresAt) || Date.now() + PAIRING_WATCH_MS, Date.now() + PAIRING_WATCH_MS);
    const timer = window.setInterval(() => {
      if (Date.now() >= until) {
        setStale(true);
        return;
      }
      check
        .current()
        .then((yes) => {
          if (cancelled || !yes) return;
          setPaired(true);
          done.current?.();
        })
        .catch(() => {});
    }, PAIRING_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [offer, paired, stale]);

  return { offer, square, paired, stale, ask };
}

/** The square and the link under it, and whatever the caller puts beside them. */
export function PairingSquare({ offer, square, children }: { offer: PairingOffer; square: string | null; children?: ReactNode }): JSX.Element {
  return (
    <div className="meet-pair">
      {square ? <img className="meet-qr" src={square} alt={offer.link} /> : null}
      <a className="meet-link" href={offer.link} target="_blank" rel="noreferrer">
        {offer.link}
      </a>
      {children}
    </div>
  );
}

/**
 * The square as a tile of its own (first run's phone sheet): white in both
 * themes with a quiet zone a camera can lock onto, the bot's name under it,
 * Copy link and Open in Telegram (the link itself is never printed), and one
 * quiet line that waits for the phone and then says whose it is.
 */
export function PairingTile({
  offer,
  square,
  bot,
  status,
  paired,
}: {
  offer: PairingOffer;
  square: string | null;
  /** The bot's username, without the @, once known. */
  bot: string | null;
  /** "Waiting for your Start…", then who paired. */
  status: string;
  paired: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void Promise.resolve()
      .then(() => navigator.clipboard?.writeText(offer.link))
      .then(() => setCopied(true))
      .catch(() => {});
  };
  return (
    <div className="tg-pair" data-testid="pairing-tile">
      <div className="tg-pair-tile">
        {square ? <img className="tg-pair-qr" src={square} alt={bot ? `QR code for @${bot}` : 'QR code for your buddi bot'} /> : null}
      </div>
      {bot ? <span className="tg-pair-bot">@{bot}</span> : null}
      <div className="tg-pair-actions">
        <Button onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
        <ButtonLink variant="accent" href={offer.link} target="_blank" rel="noreferrer">
          Open in Telegram
        </ButtonLink>
      </div>
      <p className="tg-pair-status" role="status" data-paired={paired ? 'true' : undefined}>
        {paired ? null : (
          <span className="wiz-pulse" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        {status}
      </p>
    </div>
  );
}

/**
 * The pairing link as a square the phone's camera can read.
 *
 * Drawn here, in the page, from the `qrcode` package: nothing is fetched, no
 * image service is asked, and the link never leaves this machine. An SVG
 * rather than a canvas so it stays sharp and inherits the page's colours.
 * Four modules of white around it, as the standard asks: a camera finds the
 * square by its quiet zone.
 */
import QRCode from 'qrcode';

export async function qrSvgDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

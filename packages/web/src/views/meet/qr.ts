/**
 * The pairing link as a square the phone's camera can read.
 *
 * Drawn here, in the page, from the `qrcode` package: nothing is fetched, no
 * image service is asked, and the link never leaves this machine. An SVG
 * rather than a canvas so it stays sharp and inherits the page's colours.
 */
import QRCode from 'qrcode';

export async function qrSvgDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

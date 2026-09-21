/*
 * The extension's identity, fixed once and for all.
 *
 * Chrome derives an unpacked extension's id from its public key: the SHA-256 of
 * the DER-encoded public key, first sixteen bytes, each hex digit mapped from
 * `0`-`f` onto `a`-`p`. Without a `key` in the manifest Chrome invents one from
 * the folder path, so the id changed with every machine and every reinstall,
 * and nothing could address this extension by name.
 *
 * `static/manifest.json` carries the public half of a key pair generated once
 * with `openssl`. The private half is not in this repository and is not needed:
 * it signs a `.crx` for the Chrome Web Store, and nothing about loading the
 * folder unpacked. The constant below is that key's id, which is what the
 * dashboard sends `chrome.runtime.sendMessage` to.
 */
export const EXTENSION_ID = 'kmbckpnnjfggeffkkbmkggojnolkdokb';

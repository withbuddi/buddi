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

/*
 * The Chrome Web Store id, once the store has assigned it.
 *
 * The store build drops the manifest's `key` (the store refuses an upload that
 * pins one) and gives the extension an id of its own, so a store install will
 * NOT be `EXTENSION_ID`. The unpacked folder the tarball ships keeps the key
 * and keeps that id. Once the listing exists, fill this in and mirror it in
 * `packages/web/src/views/Browser.tsx`: the dashboard asks both ids and takes
 * whichever answers. The gateway already accepts either, since a pairing binds
 * whichever id completed it.
 */
export const STORE_EXTENSION_ID = '';

/** Every id this extension may be running under, empty ones left out. */
export const EXTENSION_IDS: readonly string[] = [EXTENSION_ID, STORE_EXTENSION_ID].filter(Boolean);

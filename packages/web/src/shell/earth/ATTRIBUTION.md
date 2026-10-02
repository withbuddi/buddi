# Earth, the lock screen's default background

| | |
| --- | --- |
| Photo | "outer space photography of earth" |
| By | ActionVance — https://unsplash.com/@actionvance |
| Source | https://unsplash.com/photos/outer-space-photography-of-earth-t7EL2iG3jMc |
| Licence | Unsplash License — https://unsplash.com/license |

The Unsplash License lets buddi use, copy, modify and redistribute the photo,
in this repository and in the npm package, without asking or paying. It does
not need credit, but buddi gives it: the lock screen settings say "Earth: photo
by ActionVance on Unsplash", linked, under the background swatches, and
`docs/dashboard.md` (Lock screen) says the same. The licence does not allow
selling the photo unaltered or using it to build a competing photo service.

The files here are derived from the 3578 × 2013 original, with all of its
metadata (EXIF, the location, the camera) stripped:

| file | what | size |
| --- | --- | --- |
| `earth-2560.webp` | 2560 × 1440, the whole frame — a desk | ~270 KB |
| `earth-phone.webp` | 900 × 1600, a portrait crop around the curve (x 540–1672 of the original) — a phone | ~133 KB |
| `earth-thumb.webp` | 192 × 144, the swatch | ~2 KB |

Made with ImageMagick (`-strip`, resize/crop) and `cwebp -m 6 -sharp_yuv
-metadata none` at quality 74 (desk), 70 (phone) and 72 (swatch).

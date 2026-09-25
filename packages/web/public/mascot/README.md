# Buddi Blob, bundled

These PNGs are **copies**. The mascot's source of truth is the design repo,
`buddi-design/mascot/` (its README and `buddi-blob-character-bible.md`); if a
file here disagrees with it, this copy is wrong.

Each is that repo's `assets/buddi-blob__<role>__<state>__avatar__v0.1.png`,
downscaled to 256×256 (area-averaged, alpha kept) so it fits under the avatar
upload's 1 MB cap and loads fast on first run:

| here | source |
| --- | --- |
| `core.png` | `buddi-blob__core__neutral__avatar__v0.1.png` |
| `coding.png` | `buddi-blob__coding__idle__avatar__v0.1.png` |
| `finance.png` | `buddi-blob__finance__working__avatar__v0.1.png` |
| `garage.png` | `buddi-blob__garage__idle__avatar__v0.1.png` |
| `mail.png` | `buddi-blob__mail__idle__avatar__v0.1.png` |
| `maker.png` | `buddi-blob__maker__idle__avatar__v0.1.png` |
| `playground.png` | `buddi-blob__playground__idle__avatar__v0.1.png` |
| `research.png` | `buddi-blob__research__idle__avatar__v0.1.png` |

`core.png` is the face in the first-run header. Every one of them is offered as
the first assistant's face; the one chosen is uploaded through
`/api/agents/:id/avatar` and becomes that agent's picture. To refresh them,
re-export from the design repo — never edit them here.

# Buddi Blob — the mascot

**This directory is the source of truth for the mascot.** It is the owner's
reference kit, copied in whole. Nothing about Buddi Blob — its identity, its
palette, what may vary per agent, how a variant is named — is decided anywhere
else in this repository, and a prompt, an illustration or a UI asset that
disagrees with these files is wrong, not a new direction.

The official mascot is the **blue blob with the coral-tipped bump**. The concept
sheet below is v0.1 concept stage: a direction, not yet a production master.

## The kit

| File | What it settles |
| --- | --- |
| [`buddi-blob-character-bible.md`](buddi-blob-character-bible.md) | Canonical identity, recognition anchors, palette, fixed vs variable layers, expressions, prohibitions. |
| [`buddi-blob-variation-system.md`](buddi-blob-variation-system.md) | The variation formula and budget, the role → cue/accent table, the state table, the personality table, the naming pattern. |
| [`buddi-blob-prompt-templates.md`](buddi-blob-prompt-templates.md) | The five prompt templates: canonical master, agent variant, expression sheet, product icon, marketing illustration. |
| [`buddi-blob-delivery-qa-checklist.md`](buddi-blob-delivery-qa-checklist.md) | Identity, variation and technical review; naming and versioning; approval levels; rights records. |
| [`buddi-blob-commissioning-brief.md`](buddi-blob-commissioning-brief.md) | The brief to send a designer or illustrator. |
| [`buddi-blob-readme.md`](buddi-blob-readme.md) | The kit's own README and recommended workflow. |
| [`concept-sheet-v0.1.png`](concept-sheet-v0.1.png) | The v0.1 concept sheet — the reference image to attach when generating a variant. |

## Generated assets

Approved and candidate artwork lives in [`assets/`](assets/) and follows the
kit's naming rule from the delivery checklist:

```
buddi-blob__role__state__asset-type__vMAJOR.MINOR.ext
```

For example `buddi-blob__finance__working__flat__v0.1.png`,
`buddi-blob__core__neutral__master__v1.0.svg`,
`buddi-blob__mail__success__avatar__v1.0.png`. `MAJOR` moves for a change to the
body, face, colour system or signature bump; `MINOR` for a newly approved pose,
expression, prop or export treatment.

## Making a new variant

Use the `/mascot` skill (`.claude/skills/mascot/SKILL.md`). It reads the bible
and the variation system, composes the prompt for a role and state, and prints
the reference image to attach, the expected output file name and the QA items
that apply. It does not draw anything — the image comes from the owner's image
tool or illustrator, and comes back here to be reviewed against the checklist.

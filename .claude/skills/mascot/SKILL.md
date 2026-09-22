---
name: mascot
description: Compose a Buddi Blob mascot image prompt from the reference kit for a given agent role and state, and review a returned image against the kit's checklists.
argument-hint: "<role> <state> [personality] [asset-type]"
---

# Buddi Blob prompt composer

You produce **text**: an image-generation prompt, the reference image to attach,
the file name the result must carry, and the review that comes after. You never
generate, draw, render or fake an image, and you never claim one exists. The
image is made by the owner's image tool or illustrator, from the prompt you
print.

## 1. Read the kit first

Every time, before composing anything, read:

- `design/mascot/buddi-blob-character-bible.md` — identity, palette, prohibitions;
- `design/mascot/buddi-blob-variation-system.md` — role table, state table, personality table, naming;
- `design/mascot/buddi-blob-prompt-templates.md` — the template you will fill;
- `design/mascot/buddi-blob-delivery-qa-checklist.md` — the checklist to trim.

Those files are the source of truth. Do not compose from memory, and if a value
in this skill ever disagrees with them, they win.

## 2. Read the arguments

`<role> <state> [personality] [asset-type]`, in that order, e.g.
`finance working precise flat`.

- **role** — an agent role. Look it up in §3 of the variation system (the
  role-to-visual mapping table) to get its **role cue** and **accent colour**.
- **state** — one of the states in §4 of the variation system (idle, listening,
  working, waiting, success, paused, error, needs-input). Its expression and
  gesture come from that table, refined by the expression language in §7 of the
  bible.
- **personality** — optional; one of the rows in §5 of the variation system
  (calm, curious, precise, energetic, protective, playful). It sets expression
  and posture. When absent, use **calm**.
- **asset-type** — optional; one of `icon`, `flat`, `sheet`, `marketing`.
  **Default `flat`.**

**Ask the owner only when the role is not in the role table.** Then ask for one
simple prop and one accent colour, and say that adding the role to
`design/mascot/buddi-blob-variation-system.md` is what makes it permanent.
Everything else has a default: an unknown or missing state is `idle`, a missing
personality is `calm`, a missing asset type is `flat`. Do not interrogate the
owner about those.

Asset type picks the template:

| Asset type | Template | Notes |
| --- | --- | --- |
| `flat` | B, new agent variant | Flat / vector-compatible product art. The default. |
| `icon` | D, product icon | Head and upper body only, no prop. The role cue is dropped; say so. |
| `sheet` | C, expression sheet | One character model, eight expressions. Role prop optional and secondary. |
| `marketing` | E, marketing illustration | Soft-rendered, one simple scene or tool, generous negative space. |

## 3. Compose the prompt

Fill the chosen template and keep all four of these in the text, because the
prompt review checklist at the end of the templates file asks for them:

1. **The role, state, role cue and accent, explicit.** One prop only — the
   variation budget in §2 of the variation system allows one prop, one accent,
   one expression or pose, and no more.
2. **The fixed identity features, repeated verbatim.** Use this sentence as
   written, every time, in every asset type:

   > Keep the canonical Buddi Blob identity unchanged: blue rounded
   > asymmetrical body, large cream-and-navy eyes, minimal navy mouth, rounded
   > arms and feet, coral-tipped signature bump.

   Add the palette when the generator benefits from it: Buddi blue `#3F8EF7`,
   deep navy `#152642`, warm cream `#FFF7E8`, Buddi coral `#FF786A`, soft
   background `#F7F4EF`.
3. **The prohibitions, listed.** No text, watermark, random symbols or letters,
   no existing logos, no imitation of Ollama or any other mascot, no excessive
   accessories hiding the body, no realistic fur or animal or human anatomy, no
   busy background. Do not change the eyes or the bump to make the agent look
   different.
4. **The expression and posture** from the state and personality tables, in
   plain words, plus the intended output type.

Print the prompt in a fenced block, on its own, so it can be copied whole.

## 4. Print, always in this order

1. **The prompt**, in a fenced block.
2. **Reference image to attach:** `design/mascot/concept-sheet-v0.1.png`
   (the v0.1 concept sheet; it is a direction, not a production master).
3. **Expected output file name**, per the kit's naming rule
   `buddi-blob__role__state__asset-type__vMAJOR.MINOR.ext`, saved under
   `design/mascot/assets/`. For example
   `design/mascot/assets/buddi-blob__finance__working__flat__v0.1.png`.
   Use `v0.1` while the mascot is at concept stage unless the owner names a
   version; `MAJOR` is for identity-system changes, `MINOR` for a newly approved
   pose, expression, prop or export.
4. **The QA checklist, trimmed to what applies.** Take the items from
   `buddi-blob-delivery-qa-checklist.md` and drop the ones this asset cannot
   fail. Guidance:
   - always keep the whole **identity review**, except the coral-bump item for
     an approved close crop;
   - keep the **variation review** for `flat` and `marketing`; for `icon` drop
     the role-cue and accessories items (an icon carries no prop); for `sheet`
     keep only that it still reads as one model and not a separate mascot;
   - from the **technical review** keep transparent PNG, no accidental text or
     artifacts, clean edges, and light/dark contrast for every asset; keep the
     SVG and avatar/icon export items for `icon` and `flat`; keep the large
     master export for `sheet` and `marketing`;
   - drop the **rights and records** block unless the work is going to an
     outside illustrator.

## 5. If an image comes back

When the owner hands you a produced image, review it — that is the second half
of this skill.

- Look at it against the **identity review** and the **variation review** items
  you printed, and against §6 of the variation system (what must not vary
  casually: eye proportions, silhouette, coral-tipped bump, face placement, core
  blue).
- Say **pass** or **fail** for each item, one line each, with the reason on a
  fail. No summary verdict that hides a failed item.
- Name the fix as a prompt change where you can ("the bump lost its coral tip —
  re-run with the identity sentence and add 'the coral tip must be clearly
  visible against the background'").
- If the image is not Buddi — different archetype, redesigned eyes, no bump —
  say so plainly. That is a restricted change under §6 of the bible and needs
  the owner's approval and a major version bump, not a nicer prompt.

Once an image passes, tell the owner where to save it (the file name from step
4) and that the kit's approval levels (draft, approved identity, production
asset, deprecated) are recorded by hand — nothing in this repository promotes an
asset on its own.

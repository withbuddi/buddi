# Buddi Blob Variation System

## 1. The variation formula

Every new agent variant should be built from:

**Buddi Blob core + role cue + personality cue + action/status cue**

Example: **Buddi Blob core + small calculator + careful expression + reviewing pose** = Finance Buddi.

## 2. Variation budget

For ordinary agent avatars, change no more than three major variables:

1. One prop or tool.
2. One accent color.
3. One expression or pose.

If more variation is needed, change posture before adding more objects.

## 3. Role-to-visual mapping

| Agent role | Suggested cue | Suggested accent |
| --- | --- | --- |
| Research | Notebook, magnifier, small search card | Purple |
| Coding | Tiny terminal panel, keyboard, code tile | Blue-violet |
| Finance | Calculator, chart tile, coin symbol without text | Green |
| Mail | Envelope satchel, message card | Orange |
| Calendar | Simple calendar tile, clock | Teal |
| Files | Folder or storage cube | Yellow |
| Security | Small shield or lock | Red-orange, used sparingly |
| Memory/skills | Stack of cards or connected nodes | Indigo |

Props should be iconic, simple, and secondary to Buddi.

## 4. State system

Use restrained states for product UI:

- Idle: relaxed, neutral smile.
- Listening: attentive eyes, slight lean.
- Working: focused eyes, role prop active.
- Waiting: calm neutral face, subtle pause gesture.
- Success: happy expression, small celebratory gesture.
- Paused: relaxed eyes and one simple pause cue.
- Error: concerned but composed, coral status accent.
- Needs input: curious expression, raised arm or open palm.

## 5. Agent personality mapping

Personality should affect expression, posture, and prop choice—not the underlying anatomy.

| Personality | Expression | Posture |
| --- | --- | --- |
| Calm | Soft eyes, small smile | Upright and relaxed |
| Curious | Wide eyes, head tilt | Slight forward lean |
| Precise | Focused eyes | Centered and still |
| Energetic | Bright eyes | Small bounce or raised arms |
| Protective | Determined but friendly | Slight forward stance |
| Playful | Asymmetric smile | Side lean or wave |

## 6. What must not vary casually

- Eye proportions.
- Main body silhouette.
- Signature coral-tipped bump.
- Basic face placement.
- Core blue identity without a documented reason.

## 7. Variant naming

Use this pattern:

`buddi-blob__role__state__vMAJOR.MINOR`

Examples:

- `buddi-blob__research__idle__v1.0`
- `buddi-blob__finance__working__v1.0`
- `buddi-blob__mail__success__v1.0`

Use `MAJOR` for identity-system changes and `MINOR` for new approved expressions, poses, props, or exports.

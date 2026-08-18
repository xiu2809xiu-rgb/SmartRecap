# Rec — 3D mascot brief

Everything you need to model, rig and export the mascot. Drop the finished file
at `public/models/rec.glb` and the app picks it up on the next page load — no
code change, no rebuild config.

---

## Is the 3D mascot a good idea?

Yes, with one condition: **it has to do a job.** A spinning model in the corner
of a study app is a gimmick a judge will read as padding. The same model bound
to what the system is doing is a UX decision you can defend out loud.

Rec's job is the wait. Generating a recap takes 20 to 40 seconds — long enough
that a spinner feels broken. During that window Rec's animation state is driven
by the actual pipeline stage coming back from Lambda: it *reads* while text is
being extracted, and *thinks* while the model is being called. The student can
tell what is happening without reading a log.

That is the line to use in the pitch: **Rec is the progress indicator, not a
decoration.** Everything else it does — waving at an empty library, celebrating
a strong quiz score — is secondary.

The app already ships with a procedural Rec built in Three.js, so nothing is
blocked on this file. What you make replaces it.

---

## Should it be based on you, or a virtual character?

**Virtual character.** Four reasons:

1. **Rigging a human likeness well is a week of work**, and rigging one badly
   lands in the uncanny valley. A stylised character with no legs and detached
   hands is a weekend of work and reads as intentional at any quality level.
2. **A mascot is reusable.** It goes in the pitch deck, the loading states, the
   favicon, the slides. Your face does not.
3. **It stays yours after the hackathon.** If the project gets shown publicly or
   picked up by someone else, a character has no likeness or consent questions
   attached.
4. **It reads as a product, not a student project.** Duolingo has an owl, not a
   founder's head.

---

## The character

**Rec is a floating study buoy.** A rounded capsule body with a dark glass visor
across its face, two glowing eyes, a small detached hand on each side, and a
thin ring orbiting above it like a halo that is also a loading spinner.

Design notes:

- **No legs.** A floating character never needs a walk cycle, which removes the
  single hardest animation from the list.
- **No arms either** — the hands float unattached, so there is no elbow to solve
  and gestures are just two objects moving.
- **Rounded everything.** No sharp edges anywhere. It is a study companion for
  someone who is stressed.
- **The visor is the face.** Two emissive dots do all the expression work:
  scale them vertically for a squint, widen them for surprise. This is why the
  character needs no mouth and no eyebrows.
- **The ring carries the state.** Slow drift when idle, fast spin when thinking.
  It is the most legible signal at 128px in a corner.

### Palette

Match the app so it sits in the scene rather than on top of it:

| Part | Colour | Notes |
|---|---|---|
| Body | `#5D34D0` violet, roughness ~0.28, metalness ~0.45 | Slightly satin, not chrome |
| Visor | `#0A0616` near-black, roughness ~0.08, metalness ~0.9 | Glassy, catches the rim light |
| Eyes | `#00F0FF` cyan, **emissive**, intensity 3+ | Must glow — this is the focal point |
| Ring | `#FF006E` magenta, **emissive**, intensity ~1.6 | The one warm accent |
| Hands | `#5D34D0` lightened ~20% | Same family as the body |

Set the eyes and ring to `emissive` in the material, not just a bright base
colour. The app lights the scene deliberately dark so those two glow.

### Alternatives if you want to explore

- **Paper crane** — folded-paper faces, one edge that unfolds while "reading".
  Very on-theme for notes; harder to make expressive.
- **Desk lamp** — a Luxo-style lamp that leans over the page. Reads instantly as
  "reading", but Pixar owns that silhouette.
- **Highlighter pen with a face** — cheap to model, strong subject link, but it
  dates fast and looks like clip art at small sizes.

The buoy is the recommendation. It is the easiest of the four to animate and the
easiest to read at 128 pixels.

---

## Technical specification

| Property | Requirement |
|---|---|
| **Format** | `.glb` (glTF 2.0 binary, single file, textures embedded) |
| **Filename** | `rec.glb`, placed at `public/models/rec.glb` |
| **File size** | Under 3 MB. Under 1.5 MB is better — this loads on campus wifi |
| **Triangles** | Under 40,000. The design above should come in near 8,000 |
| **Textures** | 1024×1024 maximum, and only if you need them. Flat PBR materials are fine and smaller |
| **Materials** | 3 or fewer. Metallic-roughness workflow (Blender's Principled BSDF exports to this directly) |
| **Up axis** | Y-up, facing +Z (Blender's glTF exporter handles the conversion — leave "+Y Up" ticked) |
| **Origin** | At the centre of the body, roughly where a navel would be |
| **Scale** | Roughly 1.6 units tall. The app re-normalises anyway, but a sane scale makes your own preview usable |
| **Compression** | Draco or meshopt optional. Both are supported and both help |

### What to leave out

- No cameras and no lights in the file. The app supplies its own, tuned for the
  dark surface, and an exported light will fight them.
- No baked shadow planes. The app draws contact shadows.
- No animation on the root object's world position — the app applies its own
  float bob on top and the two will fight.

---

## Animation clips

**This is the part that matters most.** Name the clips exactly as below. The
loader matches case-insensitively, and anything missing falls back to `Idle`, so
a partial export still works — you do not need all seven before you can see it
in the app.

| Clip name | Length | Loops | When the app plays it |
|---|---|---|---|
| `Idle` | 3–4s | Yes | Default everywhere. Gentle breathe and bob, ring drifting slowly |
| `Thinking` | 2–3s | Yes | **The one you asked about.** While the model is generating. Hand to visor, ring spinning fast, eyes narrowed |
| `Reading` | 2s | Yes | While text is being extracted. Tilted down, eyes tracking left to right |
| `Celebrate` | 1.5s | No | Quiz score 80% or above. Hands up, a quick spin, ring flares |
| `Encourage` | 1.5s | No | Quiz score under 80%. A small nod, one hand raised. Warm, not sad |
| `Wave` | 1.5s | No | Empty library and the landing hero on hover |
| `Confused` | 2s | Yes | Pipeline failure and the 404 page. A slow wobble, ring stalled |

Notes on authoring them:

- **Every looping clip must loop seamlessly** — last frame identical to first.
  The app cross-fades between clips over 0.35s, which hides transitions between
  states but not a jump inside one.
- **Keep `Thinking` legible at 128 pixels.** It plays at full size on the
  processing screen but also in the dashboard corner. If the only motion is a
  subtle finger tap, it reads as frozen at small sizes. The ring is doing most
  of the work here — make it obvious.
- **`Celebrate` and `Encourage` must not loop.** They play once and clamp on
  their final frame, so end them in a pose that is stable to sit in.
- **No root motion.** Animate the body, hands, ring and eyes — leave the root
  object where it is.

### Practical routes to making this

- **Blender** (free) is the straightforward path. Model → simple armature or
  just object animation → NLA strips named as above → export glTF 2.0 Binary,
  with Animation → "Group by NLA Track" ticked.
- **No modelling experience?** Text-to-3D (Meshy, Tripo) will get you a body
  mesh in minutes; clean it up in Blender and animate there. The animation is
  the part that has to be hand-done, and with no legs there is not much of it.
- **Do not use Mixamo here.** Its rigs are humanoid with legs, which is exactly
  the character we are avoiding.

---

## Testing it

1. Drop `rec.glb` at `public/models/rec.glb`.
2. `npm run dev`, open the landing page. Rec should load with a fade and respond
   to a drag.
3. Go to `/app/upload`, upload anything, and watch the processing screen — that
   is where `Reading` and `Thinking` are exercised in sequence.
4. Finish a quiz to see `Celebrate` or `Encourage`.
5. Open Settings and switch **Motion** to Reduced. Rec must disappear entirely
   and be replaced by the flat SVG badge. If a WebGL context is still being
   created there, something is wrong.

If the model does not appear, the app silently falls back to the procedural Rec
— check the browser console and the network tab for `/models/rec.glb`.

---

## Where Rec appears

| Screen | State | Size |
|---|---|---|
| Landing hero | `Idle`, `Wave` on hover | 380px |
| Sign in / sign up | `Idle` / `Wave` | 300px |
| Dashboard — resume card | `Reading` | 168px |
| Dashboard — corner companion | `Idle` | 128px |
| Empty library | `Wave` | 200px |
| Upload | `Wave`, `Reading` once a file is chosen | 170px |
| **Processing** | Driven by pipeline stage | 330px |
| Quiz results | `Celebrate` / `Encourage` | 200px |
| Flashcards — session finished | `Celebrate` | 200px |
| 404 | `Confused` | 280px |

The mapping lives in `src/mascot/states.js` if you want to change it.

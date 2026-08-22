# 3D models

Drop `rec.glb` here and the app picks it up on the next page load — no code
change, no rebuild config. `src/mascot/Mascot.jsx` HEAD-requests `/models/rec.glb`
once per load and falls back to the procedural Rec in `ProceduralRec.jsx` when
it is absent.

The full specification for what to model, how big it should be, and the exact
animation clip names the app expects is in `docs/MASCOT-BRIEF.md`.

## Team avatars

`avatar.glb`, `rihan.glb`, `hongyi.glb` and `dillon.glb` are the four people on
the "Built by" carousel on the landing page. The roster lives in
`src/components/avatar/roster.js` — a fifth person is a `.glb` here plus an
entry there, nothing else.

**Optimise before committing.** The Meshy exports arrive at 79-88 MB each,
around 1.9M triangles with 4K textures, which is not a thing to put on a
marketing page. They ship at ~3 MB / ~95k triangles. Two steps:

1. **Textures.** Resample the base-colour map to 2048 and everything else to
   1024. `gltf-transform optimize --texture-compress` is the obvious tool and
   it does not work here: the `sharp` binary it ships cannot decode these
   particular JPEGs (`colourspace: parameter space not set`), so the textures
   were re-encoded through `System.Drawing` instead. Any image editor will do.
2. **Geometry, then quantisation.**

   ```
   npx @gltf-transform/cli simplify in.glb tmp.glb --ratio 0.05 --error 0.002
   npx @gltf-transform/cli quantize tmp.glb public/models/name.glb
   ```

Quantize rather than Draco or Meshopt on purpose: `KHR_mesh_quantization` is
decoded by three.js itself, so there is no decoder to fetch from a CDN — the
same reason `AvatarStage.jsx` refuses to use drei's `<Environment preset>`.
The demo has to survive conference wifi.

The Meshy exports have no skin and no animation clips. `roster.js` marks those
`animated: false`, which is what gives them a turntable and a timed thought
bubble instead of clip-driven ones.

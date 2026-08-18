# 3D models

Drop `rec.glb` here and the app picks it up on the next page load — no code
change, no rebuild config. `src/mascot/Mascot.jsx` HEAD-requests `/models/rec.glb`
once per load and falls back to the procedural Rec in `ProceduralRec.jsx` when
it is absent.

The full specification for what to model, how big it should be, and the exact
animation clip names the app expects is in `docs/MASCOT-BRIEF.md`.

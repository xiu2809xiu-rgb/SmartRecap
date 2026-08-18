import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAnimations, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * The builder's own avatar, from `public/models/avatar.glb`.
 *
 * Reuses the bounding-sphere normalisation from `mascot/MascotModel.jsx` so the
 * framing works whatever scale the model was exported at — this one came out of
 * Tripo and is nowhere near one unit tall.
 *
 * Clip selection is different from the mascot's, and deliberately so. Rec's
 * clips are named (`idle`, `thinking`) and chosen by pipeline state. This export
 * has seven clips all called `NlaTrack.00N`, which is what Blender emits from
 * NLA tracks — the names carry no meaning, so there is nothing to map them to.
 * Rather than guess which one is a wave, it plays them in order and crossfades
 * on each clip's own end, which turns a set of unlabelled loops into something
 * that reads as a person idling rather than a single pose repeating.
 */

const FADE_SECONDS = 0.6;

// The figure's height in world units after normalisation. The camera in
// AvatarStage is framed around this, so the two move together.
const TARGET_HEIGHT = 1.55;

// Frames spent re-measuring before the framing is locked. Long enough for the
// first clip to leave the bind pose, short enough that the reveal is not a wait.
const SETTLE_FRAMES = 24;

export default function AvatarModel({ url, onReady }) {
  const inner = useRef();
  const { scene, animations } = useGLTF(url);

  // The loaded scene is used directly, NOT `scene.clone(true)`.
  //
  // `Object3D.clone()` does not rebind a SkinnedMesh: the copy keeps pointing
  // at the *original* skeleton's bones. The mixer then dutifully animates the
  // clone's bones while the visible mesh stays bound to bones nothing is
  // touching, so the figure holds its bind pose — arms straight out — no matter
  // how correct the rest of the animation code is. That cost an hour to find.
  //
  // Cloning would only matter if two avatars were on screen at once, and there
  // is exactly one. (Rec clones because it can appear twice; it gets away with
  // it because its fallback is procedural rather than skinned.) If a second one
  // is ever needed, use SkeletonUtils.clone, not Object3D.clone.
  const model = useMemo(() => {
    scene.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        if (o.material) o.material.side = THREE.FrontSide;
      }
    });
    return scene;
  }, [scene]);

  const { actions, mixer } = useAnimations(animations, inner);

  // Derived from the clips, NOT from `Object.keys(actions)`.
  //
  // drei hands back a stable `actions` object and fills it in later, so a memo
  // keyed on that object's identity computes `[]` on the first render and is
  // never recomputed — the clip list stayed empty forever and the figure sat in
  // its bind pose, arms out, T-posed on the marketing page. `animations` is the
  // real source of truth and changes when the model does.
  const names = useMemo(() => animations.map((clip) => clip.name), [animations]);
  const [index, setIndex] = useState(0);

  // Measured across frames rather than once in a layout effect.
  //
  // A skinned mesh is not reliably measurable the moment React commits: the
  // primitive may not be attached to this group yet, and a SkinnedMesh whose
  // skeleton has not been posed can report a degenerate bounding box. The
  // original single-shot version bailed out on a zero radius and never called
  // `onReady`, so the stage sat at opacity 0 behind a spinner forever — the
  // model had downloaded fine and simply was never revealed.
  //
  // So: retry each frame until the box is real, then stop. And if it never
  // becomes real, give up after a bounded number of frames and reveal the model
  // anyway at whatever scale it exported at. Showing something slightly wrong
  // beats an indefinite spinner in front of a model that is already loaded.
  const framed = useRef(false);
  const attempts = useRef(0);

  useLayoutEffect(() => {
    framed.current = false;
    attempts.current = 0;
    const node = inner.current;
    if (node) {
      node.scale.setScalar(1);
      node.position.set(0, 0, 0);
    }
  }, [model]);

  useFrame(() => {
    if (framed.current) return;
    const node = inner.current;
    if (!node) return;

    attempts.current += 1;

    // Measure in the model's own space, with this group's transform reset, so
    // each pass measures the mesh rather than the result of the previous pass.
    node.scale.setScalar(1);
    node.position.set(0, 0, 0);
    node.updateWorldMatrix(true, true);

    const box = new THREE.Box3().setFromObject(node);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());

    if (size.y > 0 && Number.isFinite(size.y)) {
      // Fit by the box, not by its bounding sphere. A standing figure's sphere
      // radius is the box *diagonal* over two, so fitting to it leaves a person
      // far smaller than the frame and pushed off-centre. Height is what
      // actually has to fit here; width never binds for an upright figure.
      const scale = TARGET_HEIGHT / size.y;
      node.scale.setScalar(scale);
      node.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);

      // Keep re-measuring while the pose settles. The clips carry root motion,
      // so the first frame is the bind pose and framing to it alone leaves the
      // figure drifting out of the frame once the animation takes over.
      if (attempts.current >= SETTLE_FRAMES) {
        framed.current = true;
        onReady?.();
      }
    } else if (attempts.current > 120) {
      framed.current = true;
      onReady?.();
    }
  });

  // Play the clip at `index`, crossfading from whatever was running.
  const active = useRef(null);
  useEffect(() => {
    if (!names.length) return;
    const next = actions[names[index % names.length]];
    if (!next) return;

    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    if (active.current && active.current !== next) next.crossFadeFrom(active.current, FADE_SECONDS, false).play();
    else next.fadeIn(FADE_SECONDS).play();
    active.current = next;
  }, [actions, names, index]);

  // Advance when the running clip completes a loop. `loop` fires per
  // repetition, which is the natural seam to change on — cutting mid-motion
  // makes a skinned figure snap.
  useEffect(() => {
    if (!mixer || names.length < 2) return undefined;
    const onLoop = () => setIndex((i) => (i + 1) % names.length);
    mixer.addEventListener('loop', onLoop);
    return () => mixer.removeEventListener('loop', onLoop);
  }, [mixer, names.length]);

  // Deliberately no visibility-driven pause.
  //
  // An earlier version set `mixer.timeScale = 0` while the section was
  // off-screen. When the visibility signal was wrong in either direction the
  // figure froze in its bind pose — arms straight out, T-posed, on the
  // marketing page. A character standing still in a T-pose does not read as
  // "paused to save a few frames", it reads as broken, and the saving on a
  // 9.4k-triangle mesh never justified that risk.

  return (
    <group ref={inner}>
      <primitive object={model} />
    </group>
  );
}

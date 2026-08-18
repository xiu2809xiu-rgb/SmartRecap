import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useAnimations, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { resolveState } from './states.js';

/**
 * Rec, loaded from `public/models/rec.glb`.
 *
 * Derived from React Bits' ModelViewer (MIT + Commons Clause — see
 * src/reactbits/README.md): the bounding-sphere normalisation and re-centering
 * are the same technique, so any sane export lands at a sensible size no matter
 * what scale it was modelled at.
 *
 * What is added here is clip playback. ModelViewer renders a static mesh; the
 * whole reason Rec exists is that it visibly *thinks* while the pipeline runs,
 * which needs `useAnimations` and a cross-fade between named clips.
 *
 * Clip names are matched case-insensitively, and anything missing falls back to
 * `Idle`, so a partial export still works — you are never forced to author all
 * seven animations before you can see the model in the app.
 */

const FADE_SECONDS = 0.35;

export default function MascotModel({ url, state = 'idle', onReady }) {
  const group = useRef();
  const inner = useRef();
  const { scene, animations } = useGLTF(url);

  // Clone so two Recs on one page (e.g. the dock and the hero) do not fight
  // over a single scene graph.
  const model = useMemo(() => {
    const copy = scene.clone(true);
    copy.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return copy;
  }, [scene]);

  const { actions, mixer } = useAnimations(animations, inner);

  // Case-insensitive clip lookup, so `thinking`, `Thinking` and `THINKING` all
  // resolve. Blender and Mixamo disagree about capitalisation constantly.
  const clipIndex = useMemo(() => {
    const map = new Map();
    for (const name of Object.keys(actions ?? {})) map.set(name.toLowerCase(), name);
    return map;
  }, [actions]);

  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    node.updateWorldMatrix(true, true);

    const sphere = new THREE.Box3().setFromObject(node).getBoundingSphere(new THREE.Sphere());
    if (!sphere.radius) return;

    // Normalise to roughly one unit tall and sit the feet near the origin, so
    // the camera framing in Mascot.jsx works for any source model.
    const scale = 0.85 / (sphere.radius * 2);
    node.scale.setScalar(scale);
    node.position.set(-sphere.center.x * scale, -sphere.center.y * scale, -sphere.center.z * scale);

    onReady?.();
  }, [model, onReady]);

  const active = useRef(null);

  useEffect(() => {
    if (!actions) return;
    const wanted = resolveState(state);
    const name = clipIndex.get(wanted.clip.toLowerCase()) ?? clipIndex.get('idle') ?? Object.keys(actions)[0];
    if (!name) return;

    const next = actions[name];
    if (!next || next === active.current) return;

    next.reset();
    next.setLoop(wanted.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !wanted.loop;

    if (active.current) next.crossFadeFrom(active.current, FADE_SECONDS, false).play();
    else next.fadeIn(FADE_SECONDS).play();

    active.current = next;
  }, [state, actions, clipIndex]);

  // A GLB with no clips at all still needs to look alive.
  const hasClips = (animations?.length ?? 0) > 0;
  useFrame((s, dt) => {
    mixer?.update(0); // useAnimations drives the mixer; this keeps it explicit
    if (!group.current) return;
    const cfg = resolveState(state).proc;
    const t = s.clock.elapsedTime;
    group.current.position.y = Math.sin(t * 1.35) * 0.045 * (cfg.bob ?? 1);
    if (!hasClips) {
      group.current.rotation.y += dt * (cfg.spin ?? 0.15);
      group.current.rotation.x = cfg.tilt ?? 0;
    }
  });

  return (
    <group ref={group} dispose={null}>
      <group ref={inner}>
        <primitive object={model} />
      </group>
    </group>
  );
}

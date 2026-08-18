import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { resolveState } from './states.js';

/**
 * Rec, built in code.
 *
 * This exists so the app is never blocked on an art asset. It renders and
 * animates all seven states with no external file, and `Mascot.jsx` swaps it
 * out automatically the moment `public/models/rec.glb` is present.
 *
 * The construction is deliberately simple — a floating capsule, a visor, an
 * orbit ring and two detached hands — because a floating character needs no
 * legs, and no legs means no walk cycle to get wrong.
 */

const VIOLET = '#5d34d0';
const MAGENTA = '#ff006e';
const CYAN = '#00f0ff';

export default function ProceduralRec({ state = 'idle', accent = VIOLET }) {
  const root = useRef();
  const body = useRef();
  const visor = useRef();
  const ring = useRef();
  const ringB = useRef();
  const handL = useRef();
  const handR = useRef();
  const eyeL = useRef();
  const eyeR = useRef();
  const orbiters = useRef([]);

  const cfg = resolveState(state).proc;
  // Smoothed targets — states cross-fade rather than snapping.
  const cur = useRef({ tilt: 0, handLift: 0, eye: 1, spin: 0 });
  const t0 = useRef(0);

  const materials = useMemo(() => {
    const shell = new THREE.MeshStandardMaterial({
      color: new THREE.Color(accent).multiplyScalar(0.55),
      roughness: 0.28,
      metalness: 0.45,
    });
    const visorMat = new THREE.MeshStandardMaterial({
      color: '#0a0616',
      roughness: 0.08,
      metalness: 0.9,
      emissive: new THREE.Color(CYAN),
      emissiveIntensity: 0.16,
    });
    const eyeMat = new THREE.MeshStandardMaterial({
      color: CYAN,
      emissive: new THREE.Color(CYAN),
      emissiveIntensity: 3.2,
      toneMapped: false,
    });
    const ringMat = new THREE.MeshStandardMaterial({
      color: MAGENTA,
      emissive: new THREE.Color(MAGENTA),
      emissiveIntensity: 1.6,
      roughness: 0.3,
      toneMapped: false,
    });
    const handMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(accent).multiplyScalar(0.8),
      roughness: 0.24,
      metalness: 0.55,
    });
    return { shell, visorMat, eyeMat, ringMat, handMat };
  }, [accent]);

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime;
    if (!t0.current) t0.current = t;
    const age = t - t0.current;
    const k = Math.min(1, dt * 6); // approach rate for the smoothed channels

    cur.current.tilt += (cfg.tilt - cur.current.tilt) * k;
    cur.current.handLift += (cfg.handLift - cur.current.handLift) * k;
    cur.current.eye += (cfg.eye - cur.current.eye) * k;

    if (root.current) {
      root.current.position.y = Math.sin(t * 1.35) * 0.055 * (cfg.bob ?? 1);
      root.current.rotation.x = cur.current.tilt;

      if (cfg.wobble) root.current.rotation.z = Math.sin(t * 7) * 0.05;
      else root.current.rotation.z += (0 - root.current.rotation.z) * k;

      if (cfg.nod) root.current.rotation.x = cur.current.tilt + Math.sin(t * 3.4) * 0.09;

      if (cfg.spin) root.current.rotation.y += dt * cfg.spin;
      else if (cfg.scan) root.current.rotation.y = Math.sin(t * 1.1) * 0.34; // eyes sweep the page
      else root.current.rotation.y += (0 - (root.current.rotation.y % (Math.PI * 2))) * k * 0.4;
    }

    // Squash-and-stretch on the body sells the float without a rig.
    if (body.current) {
      const s2 = 1 + Math.sin(t * 1.35 + 0.6) * 0.018 * (cfg.bob ?? 1);
      body.current.scale.set(1 / s2 ** 0.5, s2, 1 / s2 ** 0.5);
    }

    // The orbit ring is the "processing" tell — it accelerates while thinking.
    if (ring.current) {
      ring.current.rotation.z += dt * (cfg.ringSpeed ?? 0.4);
      ring.current.rotation.x = 1.15 + Math.sin(t * 0.6) * 0.08;
    }
    if (ringB.current) {
      ringB.current.rotation.z -= dt * (cfg.ringSpeed ?? 0.4) * 0.7;
      ringB.current.rotation.y = 0.9 + Math.cos(t * 0.5) * 0.1;
      ringB.current.visible = !!cfg.orbit;
    }

    // Eyes: `eye` scales vertically, so a low value reads as a squint.
    for (const eye of [eyeL, eyeR]) {
      if (!eye.current) continue;
      const blink = Math.sin(t * 0.9) > 0.985 ? 0.12 : 1; // occasional blink
      eye.current.scale.y = Math.max(0.08, cur.current.eye * blink);
      eye.current.material.emissiveIntensity = 2.4 + (cfg.hue ?? 0) * 1.4;
    }

    if (visor.current) visor.current.material.emissiveIntensity = 0.12 + (cfg.hue ?? 0) * 0.22;

    // Hands: lift together, except when waving.
    const lift = cur.current.handLift;
    if (handL.current) {
      handL.current.position.set(-0.42, lift + Math.sin(t * 1.9) * 0.02, 0.06);
      handL.current.rotation.z = cfg.wave ? Math.sin(t * 9) * 0.7 : 0;
    }
    if (handR.current) {
      handR.current.position.set(0.42, lift + Math.sin(t * 1.9 + 1.2) * 0.02, 0.06);
      handR.current.rotation.z = 0;
    }

    // "Thoughts" orbiting the head while the model is working.
    orbiters.current.forEach((m, i) => {
      if (!m) return;
      m.visible = !!cfg.orbit || !!cfg.burst;
      const speed = cfg.burst ? 3.4 : 1.9;
      const a = t * speed + (i / orbiters.current.length) * Math.PI * 2;
      const r = cfg.burst ? 0.62 + Math.min(0.5, age * 0.9) : 0.52;
      m.position.set(Math.cos(a) * r, 0.34 + Math.sin(a * 1.7) * 0.1, Math.sin(a) * r);
      const scale = cfg.burst ? Math.max(0.01, 0.05 - age * 0.02) : 0.035;
      m.scale.setScalar(scale);
    });
  });

  return (
    <group ref={root} dispose={null}>
      {/* Body */}
      <mesh ref={body} material={materials.shell} castShadow receiveShadow>
        <capsuleGeometry args={[0.3, 0.26, 8, 28]} />
      </mesh>

      {/* Visor */}
      <mesh ref={visor} material={materials.visorMat} position={[0, 0.09, 0.222]} rotation={[0.06, 0, 0]}>
        <sphereGeometry args={[0.215, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.44]} />
      </mesh>

      {/* Eyes */}
      <mesh ref={eyeL} material={materials.eyeMat} position={[-0.085, 0.075, 0.3]}>
        <sphereGeometry args={[0.032, 16, 16]} />
      </mesh>
      <mesh ref={eyeR} material={materials.eyeMat} position={[0.085, 0.075, 0.3]}>
        <sphereGeometry args={[0.032, 16, 16]} />
      </mesh>

      {/* Orbit rings */}
      <mesh ref={ring} material={materials.ringMat} position={[0, 0.33, 0]} rotation={[1.15, 0, 0]}>
        <torusGeometry args={[0.36, 0.011, 12, 72]} />
      </mesh>
      <mesh ref={ringB} material={materials.ringMat} position={[0, 0.33, 0]} rotation={[0.4, 0.9, 0]}>
        <torusGeometry args={[0.3, 0.008, 10, 64]} />
      </mesh>

      {/* Detached hands */}
      <mesh ref={handL} material={materials.handMat} castShadow>
        <sphereGeometry args={[0.075, 20, 20]} />
      </mesh>
      <mesh ref={handR} material={materials.handMat} castShadow>
        <sphereGeometry args={[0.075, 20, 20]} />
      </mesh>

      {/* Thought motes */}
      {Array.from({ length: 7 }).map((_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            orbiters.current[i] = el;
          }}
          material={materials.eyeMat}
          visible={false}
        >
          <sphereGeometry args={[1, 8, 8]} />
        </mesh>
      ))}
    </group>
  );
}
